/**
 * Resumidor de pliegos: requisitos juridicos, financieros y tecnicos.
 *
 * Sin LLM y sin red, a proposito (es la misma decision que dejo el score en
 * TF-IDF): todo sale de dos fuentes que se pueden comprobar.
 *
 *   1. **Extraido.** Frases del objeto, la descripcion y la justificacion de la
 *      modalidad que nombran un requisito (RUP, garantia, indicadores
 *      financieros, experiencia, certificaciones...). Se citan tal cual.
 *   2. **Habitual.** Lo que el Estatuto General de Contratacion (Ley 80 de 1993,
 *      Ley 1150 de 2007, Decreto 1082 de 2015) exige para la modalidad del
 *      proceso. Va marcado como habitual: es lo que normalmente pide la ley, y
 *      el pliego concreto puede pedir mas.
 *
 * Lo que NO hace: leer el PDF del pliego. Los documentos viven en
 * community.secop.gov.co / contratos.gov.co, que no dejan descargarlos desde
 * otra pagina (CORS), y datos.gov.co solo publica los metadatos. El resumen lo
 * dice en sus advertencias y enlaza al proceso.
 */

import { diasHasta, formatDate, formatMoney } from './format'
import { digitosUnspsc } from './score'
import { norm } from './texto'
import type { CategoriaRequisito, Proceso, Requisito, ResumenPliego } from './tipos'

/** Patrones por categoria. Sobre texto normalizado: sin tildes y en minusculas. */
const PATRONES: Record<CategoriaRequisito, RegExp> = {
  juridico:
    /\b(rup|registro unico de proponentes|inhabilidad|incompatibilidad|consorcio|union temporal|existencia y representacion|representante legal|camara de comercio|antecedentes|paz y salvo|seguridad social|parafiscales|garantia|poliza|seriedad|cumplimiento|ley 80|ley 1150|decreto 1082|mipyme|habilitante|requisitos habilitantes|personeria|sarlaft)\b/,
  financiero:
    /\b(indicador|indice de liquidez|liquidez|endeudamiento|capital de trabajo|patrimonio|rentabilidad|cobertura de intereses|estados financieros|forma de pago|anticipo|pago anticipado|desembolso|disponibilidad presupuestal|cdp|smmlv|iva|retencion|facturacion|capacidad financiera|capacidad organizacional)\b/,
  tecnico:
    /\b(experiencia|certificacion|certificado|iso|especificacion|especificaciones tecnicas|ficha tecnica|personal|profesional|ingeniero|tecnico|equipo de trabajo|metodologia|cronograma|entregable|soporte|licencia|licenciamiento|norma|estandar|capacitacion|mantenimiento|instalacion|implementacion|garantia tecnica|acuerdo de nivel de servicio|ans|sla)\b/,
}

const MAX_POR_CATEGORIA = 6
const LARGO_FRASE = 280

/** Parte el texto en frases utiles. SECOP separa mucho con `;` y saltos. */
function frases(texto: string): string[] {
  return texto
    .split(/(?<=[.;:])\s+|\n+|•|\s-\s/)
    .map((f) => f.replace(/\s+/g, ' ').trim())
    .filter((f) => f.length >= 25)
}

function recortarFrase(f: string): string {
  return f.length > LARGO_FRASE ? `${f.slice(0, LARGO_FRASE - 1).trimEnd()}…` : f
}

/** Frases del texto publicado, clasificadas por la primera categoria que nombran. */
export function extraerRequisitos(texto: string): Record<CategoriaRequisito, Requisito[]> {
  const out: Record<CategoriaRequisito, Requisito[]> = { juridico: [], financiero: [], tecnico: [] }
  const vistas = new Set<string>()
  for (const f of frases(texto)) {
    const n = norm(f)
    if (vistas.has(n)) continue
    vistas.add(n)
    for (const categoria of ['juridico', 'financiero', 'tecnico'] as const) {
      if (PATRONES[categoria].test(n)) {
        if (out[categoria].length < MAX_POR_CATEGORIA) out[categoria].push({ texto: recortarFrase(f), origen: 'extraido' })
        break
      }
    }
  }
  return out
}

type Habituales = Partial<Record<CategoriaRequisito, string[]>>

/**
 * Lo que la ley pide segun la modalidad. Se compara por fragmentos porque cada
 * dataset escribe la modalidad a su manera ("Licitación pública",
 * "Licitacion publica Obra Publica", "Contratación Mínima Cuantía"...).
 */
const POR_MODALIDAD: { patron: RegExp; requisitos: Habituales }[] = [
  {
    patron: /minima cuantia/,
    requisitos: {
      juridico: [
        'No se exige RUP para participar (Decreto 1082 de 2015, art. 2.2.1.2.1.5.1 y ss.).',
        'La entidad decide si pide garantías; si las pide, lo dice la invitación.',
      ],
      financiero: ['Se adjudica a la oferta de menor precio que cumpla los requisitos de la invitación.'],
      tecnico: ['Cumplimiento de las especificaciones técnicas de la invitación pública.'],
    },
  },
  {
    patron: /concurso de meritos/,
    requisitos: {
      juridico: ['RUP vigente y en firme.', 'Garantía de seriedad de la oferta (mínimo 10% del presupuesto oficial).'],
      financiero: ['Indicadores de capacidad financiera y organizacional verificados en el RUP.'],
      tecnico: [
        'La experiencia y la formación del equipo de trabajo son factores de calificación.',
        'El precio no puede ser factor de escogencia (Ley 1150 de 2007, art. 5 num. 4).',
      ],
    },
  },
  {
    patron: /subasta/,
    requisitos: {
      juridico: ['RUP vigente y en firme.', 'Garantía de seriedad de la oferta (mínimo 10% del presupuesto oficial).'],
      financiero: ['El precio es el factor decisivo: se adjudica en la subasta inversa al menor lance.'],
      tecnico: ['Ficha técnica del bien o servicio de características uniformes.'],
    },
  },
  {
    patron: /seleccion abreviada/,
    requisitos: {
      juridico: ['RUP vigente y en firme.', 'Garantía de seriedad de la oferta (mínimo 10% del presupuesto oficial).'],
      financiero: ['Indicadores de capacidad financiera y organizacional verificados en el RUP.'],
      tecnico: ['Experiencia acreditada en el RUP con los códigos UNSPSC del proceso.'],
    },
  },
  {
    patron: /licitacion publica/,
    requisitos: {
      juridico: [
        'RUP vigente y en firme (Ley 1150 de 2007, art. 6).',
        'Garantía de seriedad de la oferta (mínimo 10% del presupuesto oficial).',
        'Audiencias de asignación de riesgos y de adjudicación.',
      ],
      financiero: ['Indicadores de capacidad financiera y organizacional verificados en el RUP.'],
      tecnico: ['Experiencia acreditada en el RUP con los códigos UNSPSC del proceso.'],
    },
  },
  {
    patron: /contratacion directa|directa/,
    requisitos: {
      juridico: ['No hay convocatoria abierta: la entidad invita directamente al contratista.'],
    },
  },
  {
    patron: /regimen especial/,
    requisitos: {
      juridico: ['Rige el manual de contratación propio de la entidad, no el Estatuto General.'],
    },
  },
]

/** Lo que piden todos los procesos con contrato, sea cual sea la modalidad. */
const COMUNES: Habituales = {
  juridico: [
    'Certificado de existencia y representación legal (personas jurídicas).',
    'Pagos de seguridad social y aportes parafiscales al día (Ley 789 de 2002, art. 50).',
  ],
}

export function habitualesDe(modalidad: string | null): Record<CategoriaRequisito, Requisito[]> {
  const out: Record<CategoriaRequisito, Requisito[]> = { juridico: [], financiero: [], tecnico: [] }
  const m = norm(modalidad)
  const regla = POR_MODALIDAD.find((r) => r.patron.test(m))
  for (const fuente of [COMUNES, regla?.requisitos ?? {}]) {
    for (const categoria of ['juridico', 'financiero', 'tecnico'] as const) {
      for (const texto of fuente[categoria] ?? []) out[categoria].push({ texto, origen: 'habitual' })
    }
  }
  return out
}

function plazo(p: Proceso): string | null {
  if (!p.duracion) return null
  return `${p.duracion} ${(p.unidad_de_duracion || 'días').toLowerCase()}`
}

/** Resume un proceso. Determinista: el mismo proceso da el mismo resumen. */
export function resumirPliego(p: Proceso, ahora: number = Date.now()): ResumenPliego {
  const texto = [p.nombre_del_procedimiento, p.descripcion, p.justificacion_modalidad].filter(Boolean).join('\n')
  const extraidos = extraerRequisitos(texto)
  const habituales = habitualesDe(p.modalidad_de_contratacion)
  const dias = diasHasta(p.fecha_apertura_respuesta, ahora)

  const datos: { etiqueta: string; valor: string | null }[] = [
    { etiqueta: 'Entidad', valor: p.entidad },
    { etiqueta: 'Fuente', valor: p.fuente },
    { etiqueta: 'Modalidad', valor: p.modalidad_de_contratacion },
    { etiqueta: 'Tipo de contrato', valor: [p.tipo_contrato, p.subtipo_contrato].filter(Boolean).join(' · ') || null },
    { etiqueta: 'Presupuesto oficial', valor: p.precio_base ? formatMoney(p.precio_base) : null },
    {
      etiqueta: 'Garantía de seriedad estimada (10%)',
      // Ni en minima cuantia (la entidad decide), ni en directa (no hay oferta
      // que garantizar), ni en regimen especial (rige el manual de la entidad).
      valor:
        p.precio_base && !/minima cuantia|directa|regimen especial/.test(norm(p.modalidad_de_contratacion))
          ? formatMoney(p.precio_base * 0.1)
          : null,
    },
    { etiqueta: 'Plazo de ejecución', valor: plazo(p) },
    { etiqueta: 'Cierre / presentación de ofertas', valor: p.fecha_apertura_respuesta ? formatDate(p.fecha_apertura_respuesta) : null },
    // SECOP II publica `UNSPECIFIED` cuando no hay codigo: eso no es un dato.
    { etiqueta: 'UNSPSC', valor: digitosUnspsc(p.codigo_principal_categoria) ? p.codigo_principal_categoria : null },
    { etiqueta: 'Ubicación', valor: [p.ciudad_entidad, p.departamento_entidad].filter(Boolean).join(', ') || null },
  ]

  const advertencias = [
    'Resumen generado con el objeto y la descripción publicados en datos.gov.co. Los pliegos completos (PDF) están en SECOP: verifica allí los requisitos antes de ofertar.',
  ]
  if (dias !== null && dias >= 0 && dias <= 3) advertencias.unshift(`Cierra en ${dias} día${dias === 1 ? '' : 's'}: queda muy poco tiempo para preparar la oferta.`)
  if (dias !== null && dias < 0) advertencias.unshift('El plazo para presentar ofertas ya cerró.')
  if (!p.descripcion) advertencias.push('El proceso no publica descripción: solo se pudo resumir el objeto.')

  const requisitos = { juridico: [] as Requisito[], financiero: [] as Requisito[], tecnico: [] as Requisito[] }
  for (const categoria of ['juridico', 'financiero', 'tecnico'] as const) {
    requisitos[categoria] = [...extraidos[categoria], ...habituales[categoria]]
  }

  return {
    tender_id: p.id_del_proceso,
    objeto: p.descripcion || p.nombre_del_procedimiento || 'Sin objeto publicado',
    datos_clave: datos.filter((d): d is { etiqueta: string; valor: string } => Boolean(d.valor)),
    requisitos,
    advertencias,
    generado_en: new Date(ahora).toISOString(),
  }
}
