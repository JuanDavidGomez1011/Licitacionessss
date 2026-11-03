import { beforeEach, describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'

/**
 * Tests de la logica pura del panel.
 *
 * Se prueban los modulos, no la pagina: es donde estaban los bugs de verdad
 * (el cap que se reescalaba, el `notice_uid` que no cuadraba, las filas que
 * reventaban el lote) y es lo que se puede comprobar sin montar React.
 *
 * El almacen se fuerza a memoria con `fijarAlmacen('memoria')`: jsdom no trae
 * IndexedDB, y probarlo de verdad haria que estos tests dependieran del
 * navegador.
 */
import {
  accionesDe,
  contarProcesos,
  escribirMeta,
  fijarAlmacen,
  guardarMatches,
  guardarProcesos,
  leerMeta,
  noticeUidAProceso,
  ponerAccion,
} from '../lib/db'
import { evaluarAlertas, leerAlertas } from '../lib/alertas'
import { buscarEnSecop, consultasPara, tipoDeBusqueda } from '../lib/busquedaRemota'
import { Indice } from '../lib/indice'
import { api } from '../lib/api'
import { aCsv, aXlsx } from '../lib/exportar'
import { deduplicar, mapearProceso, mapearProcesoSecopI, ligeroProceso } from '../lib/mapper'
import { noticeUid, isoDia, soqlDate, soqlQuote, socrataDate, socrataUrl, SocrataClient } from '../lib/socrata'
import { CAP_BUDGET, CAP_EXCLUSION, aplicar, evaluate } from '../lib/reglas'
import { resumirPliego } from '../lib/resumidor'
import { norm, textoFicha, tokenize } from '../lib/texto'
import {
  construirIndiceCorpus,
  cosenoContraDoc,
  digitosUnspsc,
  mezclar,
  puntajePalabras,
  puntajePresupuesto,
  puntajeTiempo,
  puntajeUnspsc,
  puntuarProceso,
  vectorizarPerfil,
} from '../lib/score'
import { PERFIL_POR_DEFECTO, normalizarPerfil } from '../lib/perfil'
import { PESOS_POR_DEFECTO } from '../lib/config'
import { descargar, importar, perfilDeCabecera, recorrerParaExportar } from '../lib/snapshot'
import type { FilaSocrata, Match, Oportunidad, Proceso, ProcesoLigero } from '../lib/tipos'

/**
 * Fila CRUDA de Socrata: los nombres son los del dataset (`p6dx-8zbt`), con los
 * acentos rotos por el nombre corto de columna (`urlproceso`,
 * `descripci_n_del_procedimiento`). `mapearProceso` es la que los traduce a los
 * nombres con los que se guarda.
 *
 * Confundir los dos niveles fue el error al escribir este test: un fixture con
 * `descripcion` y `url_proceso` mapea a `null` sin avisar, porque son columnas
 * que en Socrata no existen.
 */
const FILA_CRUDA = (over: FilaSocrata = {}): FilaSocrata => ({
  id_del_proceso: 'CO1.REQ.1',
  nombre_del_procedimiento: 'PRESTAR SERVICIOS DE DESARROLLO DE SOFTWARE',
  descripci_n_del_procedimiento: 'Desarrollo y mantenimiento de un sistema de informacion, soporte y capacitacion.',
  entidad: 'MINISTERIO DE TECNOLOGIAS DE LA INFORMACION',
  nit_entidad: '830123456',
  departamento_entidad: 'Bogotá D.C.',
  ciudad_entidad: 'Bogotá',
  modalidad_de_contratacion: 'Licitacion publica',
  estado_del_procedimiento: 'Convocado',
  codigo_principal_de_categoria: '43232107',
  numero_de_lotes: 1,
  precio_base: 150000000,
  fecha_de_publicacion_del: '2026-09-20T00:00:00',
  fecha_de_apertura_de_respuesta: '2026-10-05T00:00:00',
  tipo_de_contrato: 'Prestacion de servicios',
  urlproceso: 'https://community.secop.gov.co/Public/Tendering/ContractNotice/Notice?noticeUID=CO1.NTC.9988776',
  ...over,
})

/** Proceso ya MAPEADO: la forma que hay en la store y la que ve el indice. */
const PROCESO = (over: Partial<Proceso> = {}): Proceso => ({
  id_del_proceso: 'CO1.REQ.1',
  referencia_del_proceso: 'REQ-1',
  nombre_del_procedimiento: 'PRESTAR SERVICIOS DE DESARROLLO DE SOFTWARE',
  descripcion: 'Desarrollo y mantenimiento de un sistema de informacion, soporte y capacitacion.',
  entidad: 'MINISTERIO DE TECNOLOGIAS DE LA INFORMACION',
  nit_entidad: '830123456',
  departamento_entidad: 'Bogotá D.C.',
  ciudad_entidad: 'Bogotá',
  modalidad_de_contratacion: 'Licitacion publica',
  justificacion_modalidad: null,
  duracion: null,
  unidad_de_duracion: null,
  estado_del_procedimiento: 'Convocado',
  codigo_principal_categoria: '43232107',
  categorias_adicionales: null,
  numero_de_lotes: 1,
  precio_base: 150000000,
  adjudicado: null,
  fecha_publicacion: '2026-09-20T00:00:00.000Z',
  fecha_recepcion: null,
  fecha_apertura_respuesta: '2026-10-05T00:00:00.000Z',
  fecha_ultima_publicacion: null,
  tipo_contrato: 'Prestacion de servicios',
  subtipo_contrato: null,
  url_proceso: 'https://community.secop.gov.co/Public/Tendering/ContractNotice/Notice?noticeUID=CO1.NTC.9988776',
  estado_resumen: null,
  notice_uid: 'CO1.NTC.9988776',
  origen: 'socrata',
  fuente: 'SECOP II',
  ...over,
})

const LIGERO = (over: Partial<Proceso> = {}): ProcesoLigero => ligeroProceso(PROCESO(over))

const MATCH = (over: Partial<Match> & { tender_id: string; score: number }): Match => ({
  score_semantico: null,
  score_reglas: null,
  bullets: [],
  razones_semanticas: [],
  penalizaciones: [],
  calculado_en: '2026-10-29T00:00:00.000Z',
  ...over,
})

/** Una respuesta de `fetch` minima, con lo que lee el cliente de Socrata. */
function respuesta(status: number, cuerpo: unknown, retryAfter: string | null = null): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h === 'Retry-After' ? retryAfter : null) },
    json: async () => cuerpo,
  } as unknown as Response
}

/** Sustituye `fetch` mientras dura `fn`. */
async function conFetch(falso: () => Promise<Response>, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = falso as typeof fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

const DIA = 86400000

beforeEach(async () => {
  await fijarAlmacen('memoria')
})

describe('texto', () => {
  it('norm quita acentos y colapsa espacios', () => {
    expect(norm(' Bogotá   D.C.  ')).toBe('bogota d.c.')
    expect(norm('  MÚLTIPLES   ESPACIOS ')).toBe('multiples espacios')
  })

  it('norm no rompe el texto ya normalizado', () => {
    expect(norm('')).toBe('')
    expect(norm(null)).toBe('')
  })

  it('tokenize saca palabras sin acentos', () => {
    expect(tokenize('Software, soporte y REDES')).toEqual(['software', 'soporte', 'y', 'redes'])
  })

  it('textoFicha usa la descripcion si no hay objeto', () => {
    expect(textoFicha(PROCESO())).toContain('sistema de informacion')
  })
})

describe('reglas', () => {
  const perfil = normalizarPerfil(PERFIL_POR_DEFECTO)

  it('una exclusion descarta con el tope, aunque la similitud sea maxima', () => {
    // Este es el bug #14: si el cap se aplicara antes de mezclar, el 100 del
    // similitud reescalaba el 5 hacia arriba y el proceso no salia descartado.
    const v = evaluate(
      { ...perfil, exclusiones: ['desarrollo de software'] },
      {
        text: 'DESARROLLO DE SOFTWARE a medida',
        precio: 100000000,
        modalidad: 'Licitacion publica',
        departamento: 'Bogotá D.C.',
      },
    )
    expect(v.maxScore).toBe(CAP_EXCLUSION)
    expect(v.descartado).toBe(true)
    // Aunque el score de entrada sea 100, la salida no puede pasar de 5.
    expect(aplicar(v, 100)).toBeLessThanOrEqual(CAP_EXCLUSION)
  })

  it('el presupuesto fuera de rango deja el tope en 20, sin descartar', () => {
    const v = evaluate(perfil, { text: 'algo', precio: 999999999999, modalidad: null, departamento: null })
    expect(v.maxScore).toBe(CAP_BUDGET)
    expect(v.descartado).toBe(false)
  })

  it('modalidad y territorio no preferidos restan, pero no descartan', () => {
    const v = evaluate(
      { ...perfil, modalidades_preferidas: ['Subasta'], departamentos_preferidos: ['Antioquia'] },
      { text: 'algo', precio: null, modalidad: 'Licitacion publica', departamento: 'Bogotá D.C.' },
    )
    expect(v.penalizacion).toBe(25)
    expect(v.descartado).toBe(false)
    expect(aplicar(v, 100)).toBe(75)
  })

  it('un proceso sin texto puntua 0 y queda descartado', () => {
    const v = evaluate(perfil, { text: '', precio: null, modalidad: null, departamento: null })
    expect(v.maxScore).toBe(0)
    expect(aplicar(v, 90)).toBe(0)
  })
})

describe('score', () => {
  const perfil = normalizarPerfil({
    ...PERFIL_POR_DEFECTO,
    exclusiones: [],
    presupuesto_minimo: null,
    presupuesto_maximo: null,
  })

  it('el corpus se indexa y la similitud del propio documento es la maxima', () => {
    const procesos = [
      PROCESO(),
      PROCESO({
        id_del_proceso: 'CO1.REQ.2',
        nombre_del_procedimiento: 'COMPRA DE COMPUTADORES',
        descripcion: 'Adquisicion de equipos de computo para la entidad.',
      }),
    ]
    const indice = construirIndiceCorpus(procesos)
    expect(indice.docs).toHaveLength(2)

    const vector = vectorizarPerfil(perfil, indice.idf)
    const propio = cosenoContraDoc(vector, indice, 0)
    const otro = cosenoContraDoc(vector, indice, 1)
    // El software puntua mas alto que la compra de computers, pero no es 0:
    // comparten terminos genericos del sector.
    expect(propio).toBeGreaterThan(otro)
    expect(propio).toBeGreaterThan(0)
  })

  it('la exclusion manda sobre el score final del proceso', () => {
    const procesos = [PROCESO()]
    const indice = construirIndiceCorpus(procesos)
    const vector = vectorizarPerfil(perfil, indice.idf)
    const conExclusion = { ...perfil, exclusiones: ['software'] }
    const proceso = procesos[0]!
    const match = puntuarProceso({
      proceso,
      ficha: {
        id: proceso.id_del_proceso,
        text: textoFicha(proceso),
        precio: 150000000,
        modalidad: 'Licitacion publica',
        departamento: 'Bogotá D.C.',
      },
      vector,
      indice,
      indicePos: 0,
      perfil: conExclusion,
      banda: { floor: 0.03, ceil: 0.35 },
    })
    expect(match.penalizaciones).toContain('exclusion')
    expect(match.score).toBeLessThanOrEqual(CAP_EXCLUSION)
    expect(match.score).toBeGreaterThanOrEqual(0)
  })

  it('el score siempre cae entre 0 y 100 y trae el desglose por componente', () => {
    const procesos = [PROCESO()]
    const indice = construirIndiceCorpus(procesos)
    const vector = vectorizarPerfil(perfil, indice.idf)
    const proceso = procesos[0]!
    const match = puntuarProceso({
      proceso,
      ficha: { id: 'x', text: textoFicha(proceso), precio: null, modalidad: null, departamento: null },
      vector,
      indice,
      indicePos: 0,
      perfil,
      banda: { floor: 0.03, ceil: 0.35 },
    })
    expect(match.score).toBeGreaterThanOrEqual(0)
    expect(match.score).toBeLessThanOrEqual(100)
    expect(match.calculado_en).toBeTruthy()
    expect(Object.keys(match.componentes!).sort()).toEqual(['objeto', 'palabras', 'presupuesto', 'tiempo', 'unspsc'])
    expect(['alta', 'media', 'baja']).toContain(match.nivel)
  })

  it('el UNSPSC dentro de un codigo del perfil es coincidencia plena; cerca en el arbol, parcial', () => {
    // SECOP II publica `V1.43232107`: el `V1` no es parte del codigo.
    expect(digitosUnspsc('V1.43232107')).toBe('43232107')
    expect(digitosUnspsc('UNSPECIFIED')).toBe('')
    const proceso = { codigo_principal_categoria: 'V1.43232107', categorias_adicionales: null }
    expect(puntajeUnspsc(['4323'], proceso).valor).toBe(100)
    expect(puntajeUnspsc(['432321'], proceso).valor).toBe(100)
    expect(puntajeUnspsc(['43232200'], proceso).valor).toBe(60) // misma familia (4323), otra clase
    expect(puntajeUnspsc(['43210000'], proceso).valor).toBe(30) // mismo segmento (43)
    expect(puntajeUnspsc(['8111'], proceso).valor).toBe(0)
    // Sin codigos en el perfil o en el proceso no se sabe: no cuenta como 0.
    expect(puntajeUnspsc([], proceso).valor).toBeNull()
    expect(puntajeUnspsc(['4323'], { codigo_principal_categoria: null, categorias_adicionales: null }).valor).toBeNull()
  })

  it('el presupuesto puntua 100 dentro del rango y decae fuera', () => {
    const p = { presupuesto_minimo: 100, presupuesto_maximo: 1000 }
    expect(puntajePresupuesto(p, 500)).toBe(100)
    expect(puntajePresupuesto(p, 50)).toBe(50)
    expect(puntajePresupuesto(p, 2000)).toBe(50)
    expect(puntajePresupuesto(p, null)).toBeNull()
    expect(puntajePresupuesto({ presupuesto_minimo: null, presupuesto_maximo: null }, 500)).toBeNull()
  })

  it('el tiempo restante castiga lo cerrado y lo que cierra ya, y no inventa sin fecha', () => {
    const ahora = Date.UTC(2026, 10, 3)
    const en = (dias: number) => new Date(ahora + dias * DIA).toISOString()
    expect(puntajeTiempo(en(-1), ahora)).toBe(0)
    expect(puntajeTiempo(en(1), ahora)).toBe(25)
    expect(puntajeTiempo(en(4), ahora)).toBe(60)
    expect(puntajeTiempo(en(20), ahora)).toBe(100)
    expect(puntajeTiempo(en(90), ahora)).toBe(80)
    // SECOP I no publica fecha de cierre.
    expect(puntajeTiempo(null, ahora)).toBeNull()
  })

  it('las palabras clave saturan en 4 coincidencias', () => {
    const p = { palabras_clave: ['software', 'redes', 'nube', 'datos', 'licencias', 'soporte'] }
    expect(puntajePalabras(p, 'software y redes').valor).toBe(50)
    expect(puntajePalabras(p, 'software redes nube datos licencias').valor).toBe(100)
    expect(puntajePalabras({ palabras_clave: [] }, 'software').valor).toBeNull()
  })

  it('explica la similitud en una linea legible, sin idf ni palabras vacias', () => {
    // "con" esta en el perfil ("...con sistemas de informacion externos") y en
    // la ficha: antes salia como motivo "Perfil: 'con' (idf 2.85)".
    const procesos = [PROCESO({ descripcion: 'Desarrollo de software con soporte y capacitacion.' })]
    const indice = construirIndiceCorpus(procesos)
    const proceso = procesos[0]!
    const match = puntuarProceso({
      proceso,
      ficha: { id: 'x', text: textoFicha(proceso), precio: null, modalidad: null, departamento: null },
      vector: vectorizarPerfil(perfil, indice.idf),
      indice,
      indicePos: 0,
      perfil,
    })
    expect(match.bullets.some((b) => /idf/.test(b))).toBe(false)
    expect(match.razones_semanticas.map((t) => t.termino)).not.toContain('con')
    const linea = match.bullets.find((b) => b.startsWith('Coincide con tu perfil en:'))
    expect(linea).toMatch(/software/)
    expect(linea).not.toMatch(/\bcon\b,|, con\b/)
  })

  it('la mezcla reparte el peso de los componentes sin datos', () => {
    const componentes = { objeto: 80, unspsc: null, presupuesto: 100, palabras: null, tiempo: null }
    // Solo cuentan objeto (30) y presupuesto (20): (80*30 + 100*20) / 50 = 88.
    expect(mezclar(componentes, PESOS_POR_DEFECTO)).toBe(88)
    expect(mezclar({ objeto: null, unspsc: null, presupuesto: null, palabras: null, tiempo: null }, PESOS_POR_DEFECTO)).toBe(0)
  })
})

describe('mapper', () => {
  it('saca el notice_uid de la URL, que es la clave de union con contratos', () => {
    const p = mapearProceso(FILA_CRUDA())!
    expect(p.notice_uid).toBe('CO1.NTC.9988776')
    expect(p.fuente).toBe('SECOP II')
  })

  it('traduce los nombres cortos de columna a los del panel', () => {
    const p = mapearProceso(FILA_CRUDA())!
    expect(p.descripcion).toContain('sistema de informacion')
    expect(p.fecha_publicacion).toBe('2026-09-20T00:00:00.000Z')
    expect(p.codigo_principal_categoria).toBe('43232107')
    expect(p.precio_base).toBe(150000000)
  })

  it('descarta filas sin id, que en Socrata hay por redondeos', () => {
    expect(mapearProceso({ ...FILA_CRUDA(), id_del_proceso: null })).toBeNull()
    expect(mapearProceso({ ...FILA_CRUDA(), id_del_proceso: '   ' })).toBeNull()
  })

  it('recorta los textos que no caben en el ancho de columna', () => {
    const largo = 'X'.repeat(900)
    const p = mapearProceso(FILA_CRUDA({ referencia_del_proceso: largo }))!
    expect(p.referencia_del_proceso).toHaveLength(120)
    // El recorte es solo del campo acotado, no de todo.
    expect(p.nombre_del_procedimiento).toContain('SOFTWARE')
  })

  it('deduplicar deja la primera y cuenta las repetidas', () => {
    const r = [FILA_CRUDA(), FILA_CRUDA({ entidad: 'OTRA' }), FILA_CRUDA()]
    const limpio = deduplicar(r.map(mapearProceso), 'id_del_proceso')
    expect(limpio).toHaveLength(1)
    expect(limpio.repetidas).toBe(2)
  })

  it('el registro ligero conserva el titulo y suelta los textos largos', () => {
    const ligero = ligeroProceso(PROCESO()) as ProcesoLigero & { descripcion?: string }
    expect(ligero.nombre_del_procedimiento).toContain('SOFTWARE')
    expect(ligero.descripcion).toBeUndefined()
    expect(ligero.notice_uid).toBe('CO1.NTC.9988776')
    expect(ligero.id_del_proceso).toBe('CO1.REQ.1')
    // La URL va en el ligero: sin ella la lista no podia enlazar a SECOP.
    expect(ligero.url_proceso).toContain('noticeUID')
  })

  it('una fila de SECOP I acaba en el mismo registro, con su fuente y su clase UNSPSC', () => {
    // Fila real de `f789-7hwg` (recortada), del 1/11/2026.
    const p = mapearProcesoSecopI({
      uid: '26-12-14833276',
      numero_de_proceso: '287 DE 2026',
      nombre_entidad: 'TOLIMA - ALCALDÍA MUNICIPIO DE CAJAMARCA',
      nit_de_la_entidad: '890700859-2',
      departamento_entidad: 'Tolima',
      municipio_entidad: 'Cajamarca',
      detalle_del_objeto_a_contratar: 'PRESTACION DE SERVICIOS PROFESIONALES COMO POLITOLOGA',
      cuantia_proceso: '12000000',
      modalidad_de_contratacion: 'Contratación Directa (Ley 1150 de 2007)',
      plazo_de_ejec_del_contrato: '0',
      rango_de_ejec_del_contrato: 'N',
      id_clase: '931415',
      estado_del_proceso: 'Convocado',
      fecha_de_cargue_en_el_secop: '2026-11-01T00:00:00.000',
      ruta_proceso_en_secop_i: { url: 'https://www.contratos.gov.co/consultas/detalleProceso.do?numConstancia=26-12-14833276' },
    })!
    expect(p.id_del_proceso).toBe('26-12-14833276')
    expect(p.fuente).toBe('SECOP I')
    expect(p.entidad).toContain('CAJAMARCA')
    expect(p.ciudad_entidad).toBe('Cajamarca')
    expect(p.precio_base).toBe(12000000)
    expect(p.codigo_principal_categoria).toBe('931415')
    expect(p.fecha_publicacion).toBe('2026-11-01T00:00:00.000Z')
    expect(p.fecha_apertura_respuesta).toBeNull()
    expect(p.url_proceso).toContain('contratos.gov.co')
    // Plazo 0 es "sin plazo", no cero dias.
    expect(p.duracion).toBeNull()
    expect(mapearProcesoSecopI({ uid: null })).toBeNull()
  })
})

describe('socrata', () => {
  it('las fechas sin zona se interpretan en UTC, no en la del navegador', () => {
    expect(socrataDate('2026-09-24T00:00:00')).toBe('2026-09-24T00:00:00.000Z')
    expect(socrataDate('2026-09-24T00:00:00.000Z')).toBe('2026-09-24T00:00:00.000Z')
    expect(socrataDate('2026-09-24')).toBe('2026-09-24T00:00:00.000Z')
  })

  it('acepta epoch en segundos y en milisegundos', () => {
    expect(socrataDate(1760000000)).toBe(new Date(1760000000000).toISOString())
    expect(socrataDate(1760000000000)).toBe(new Date(1760000000000).toISOString())
  })

  it('aplana el objeto url que llega en algunos campos', () => {
    expect(socrataUrl({ url: 'https://x.test/a' })).toBe('https://x.test/a')
    expect(socrataUrl('https://x.test/b')).toBe('https://x.test/b')
    expect(socrataUrl(null)).toBeNull()
  })

  it('noticeUid saca el identificador de la URL y tolera las que no lo tienen', () => {
    expect(noticeUid('https://x.test/Notice?noticeUID=CO1.NTC.1')).toBe('CO1.NTC.1')
    expect(noticeUid('https://x.test/sin-uid')).toBeNull()
    expect(noticeUid(null)).toBeNull()
  })

  it('soqlDate escapa comillas y trunca a dia, que es lo que acepta calendar_date', () => {
    const where = soqlDate('fecha_de_publicacion_del', '2026-01-01T12:34:00', '2026-01-31T23:00:00')
    // Sin truncar, una ventana con hora puede devolver cero filas de un dia con datos.
    expect(where).toBe("fecha_de_publicacion_del >= '2026-01-01' AND fecha_de_publicacion_del <= '2026-01-31'")
    expect(soqlQuote("O'Brien")).toBe("'O''Brien'")
  })

  it('el dia no se desplaza por la zona horaria', () => {
    // El fallo era de estos dos, y en UTC-5 (Bogotá) los dos fallaban:
    // 23:00 local se iba a UTC y el cierre cogia un dia de mas; 02:00 local
    // retrocedia y el primer dia de la ventana se quedaba fuera.
    expect(isoDia('2026-01-31T23:00:00')).toBe('2026-01-31')
    expect(isoDia('2026-01-01T02:00:00')).toBe('2026-01-01')
    expect(isoDia('2026-01-01')).toBe('2026-01-01')
    expect(isoDia('2026-01-01T00:00:00Z')).toBe('2026-01-01')
    // Un instante sin ambiguedad (epoch, `Date`) si se resuelve en UTC.
    expect(isoDia(new Date(Date.UTC(2026, 0, 15)))).toBe('2026-01-15')
    expect(isoDia(Date.UTC(2026, 0, 15))).toBe('2026-01-15')
  })

  it('sin rango no inventa un filtro que dejaria fuera casi todo', () => {
    // `new Date(null)` es la epoca: sin el guarda de `isoDia`, esto devolvia
    // "col >= '1970-01-01'" en vez de null.
    expect(soqlDate('col', null, null)).toBeNull()
    expect(isoDia(null)).toBeNull()
    expect(isoDia('')).toBeNull()
    expect(isoDia('no-es-una-fecha')).toBeNull()
  })

  it('iterRows respeta el tope sin pasarse una pagina entera', async () => {
    // El bug: el tope se comprobaba DESPUES de leer la pagina, asi que un
    // `maxRows: 120` con paginas de 500 pedia 500 filas y guardaba 492 de mas.
    const pedidas: { limit: number; offset: number }[] = []
    const cliente = new SocrataClient({ pageSize: 500, requestDelay: 0 })
    cliente.pagina = async ({ limit = 500, offset = 0 }) => {
      pedidas.push({ limit, offset })
      const total = 1000
      const filas: FilaSocrata[] = []
      for (let i = offset; i < Math.min(offset + limit, total); i += 1) {
        filas.push({ n: i })
      }
      return { rows: filas, hayMas: filas.length >= limit }
    }

    const { leidas } = await cliente.iterRows({ dataset: 'x', maxRows: 120 }, { alPagina: (f) => f.length })
    expect(leidas).toBe(120)
    // 120 + 480: la ultima pagina se pide justa, no de 500 en 500.
    expect(pedidas).toEqual([{ limit: 120, offset: 0 }])

    const { leidas: leidas2 } = await cliente.iterRows({ dataset: 'x', maxRows: 900 }, {})
    expect(leidas2).toBe(900)
    expect(pedidas.slice(1)).toEqual([
      { limit: 500, offset: 0 },
      { limit: 400, offset: 500 },
    ])

    // Sin tope, pagina hasta que el servidor se queda sin filas.
    const { leidas: leidas3 } = await cliente.iterRows({ dataset: 'x' }, {})
    expect(leidas3).toBe(1000)
  })

  it('al agotar los reintentos contra un 429 dice cual es el arreglo', async () => {
    // El caso del usuario: una descarga que choca con el limite de peticiones
    // de Socrata aterriza en una pagina vacia, y sin la pista no hay manera de
    // saber que era eso y no una caida de red.
    await conFetch(
      async () => respuesta(429, { message: 'Too Many Requests' }, '0'),
      async () => {
        // `maxRetries: 1` para que no espere entre intentos: lo que se comprueba
        // es el mensaje final, no la politica de esperas.
        const cliente = new SocrataClient({ requestDelay: 0, maxRetries: 1 })
        await expect(cliente.count('p6dx-8zbt', null)).rejects.toThrow(/app-config\.json/)
      },
    )
  })

  it('respeta el Retry-After del servidor en vez de la espera creciente', async () => {
    let llamadas = 0
    await conFetch(
      async () => {
        llamadas += 1
        return llamadas === 1 ? respuesta(429, { message: 'Too Many Requests' }, '0') : respuesta(200, [{ n: 5 }])
      },
      async () => {
        const t0 = Date.now()
        const cliente = new SocrataClient({ requestDelay: 0, maxRetries: 2 })
        const n = await cliente.count('p6dx-8zbt', null)
        const ms = Date.now() - t0
        expect(n).toBe(5)
        // Sin el Retry-After la espera del primer reintento seria 1.000 ms.
        expect(ms).toBeLessThan(800)
      },
    )
  })

  it('el 429 persistente concede dos reintentos extra antes de rendirse', async () => {
    // El limite casi siempre se levanta si se espera: rendirse a los 4
    // intentos de siempre (1/2/4 s) es morir por prisa, no por limite.
    let llamadas = 0
    await conFetch(
      async () => {
        llamadas += 1
        return respuesta(429, { message: 'Too Many Requests' }, '0')
      },
      async () => {
        const cliente = new SocrataClient({ requestDelay: 0, maxRetries: 1 })
        await expect(cliente.count('p6dx-8zbt', null)).rejects.toThrow(/tras 3 intentos/)
        expect(llamadas).toBe(3) // 1 del maxRetries + 2 de limite
      },
    )
  })

  it('tras un 429 la pagina siguiente ya espera mas (ritmo x3)', async () => {
    // El refuerzo no es solo esperar dentro del reintento: si el portal acaba
    // de limitarnos, seguir paginando a la misma velocidad acaba en el segundo
    // 429 y ahi si que no hay reintentos de sobra.
    let llamadas = 0
    await conFetch(
      async () => {
        llamadas += 1
        return llamadas === 1 ? respuesta(429, { message: 'Too Many Requests' }, '0') : respuesta(200, [{ n: 5 }])
      },
      async () => {
        const cliente = new SocrataClient({ requestDelay: 350, maxRetries: 4 })
        expect(cliente.ritmo).toBe(350)
        expect(await cliente.count('p6dx-8zbt', null)).toBe(5)
        expect(cliente.ritmo).toBe(1050) // 350 x 3
      },
    )
  })
})

describe('db en memoria', () => {
  it('guarda, cuenta y deduplica por clave natural', async () => {
    await guardarProcesos([PROCESO()])
    await guardarProcesos([PROCESO()])
    expect(await contarProcesos()).toBe(1)
  })

  it('resuelve notice_uid -> id_del_proceso para enlazar los contratos', async () => {
    await guardarProcesos([PROCESO(), PROCESO({ id_del_proceso: 'OTRO', notice_uid: 'CO1.NTC.777' })])
    const mapa = await noticeUidAProceso(['CO1.NTC.9988776', 'CO1.NTC.777', 'CO1.NTC.999'])
    expect(mapa.get('CO1.NTC.9988776')).toBe('CO1.REQ.1')
    expect(mapa.get('CO1.NTC.777')).toBe('OTRO')
    expect(mapa.has('CO1.NTC.999')).toBe(false)
  })

  it('las acciones se guardan como id + accion, y las dos pueden convivir', async () => {
    await ponerAccion({ tender_id: 'CO1.REQ.1', accion: 'guardar' })
    await ponerAccion({ tender_id: 'CO1.REQ.1', accion: 'ocultar' })
    const acciones = await accionesDe('CO1.REQ.1')
    expect(acciones.map((a) => a.accion).sort()).toEqual(['guardar', 'ocultar'])
  })
})

describe('estado de la descarga', () => {
  // `estadoIngesta()` en memoria solo cubre la pestana actual: al recargar, el
  // modulo arranca de cero. Estos tests fijan que lo que se persistio en
  // `progreso_sync` se recupere, que es lo que hace que una descarga fallida
  // siga explicandose (y una cortada a mitad, avisando) tras pulsar F5.
  it('el error de una descarga fallida sobrevive a recargar', async () => {
    await escribirMeta('progreso_sync', {
      corriendo: false,
      fase: 'error',
      error: 'no se pudo consultar /resource/x.json tras 4 intentos: HTTP 429',
      hechos: 0,
      total: 120,
      nuevas: 0,
    })

    const e = await api.estadoSync()
    expect(e.en_curso).toBe(false)
    expect(e.fase).toBe('error')
    expect(e.error).toContain('HTTP 429')
    expect(e.ultimo).toBeNull()
  })

  it('una descarga recortada en mitad se marca interrumpida', async () => {
    await escribirMeta('progreso_sync', {
      corriendo: false,
      fase: 'procesos',
      error: null,
      hechos: 300,
      total: 5000,
      nuevas: 300,
    })

    const e = await api.estadoSync()
    expect(e.fase).toBe('interrumpida')
    expect(e.hechos).toBe(300)
    expect(e.error).toBeNull()
  })

  it('una descarga terminada no se pinta ni fallida ni interrumpida', async () => {
    await escribirMeta('progreso_sync', {
      corriendo: false,
      fase: 'listo',
      error: null,
      hechos: 120,
      total: 120,
      nuevas: 120,
    })
    await escribirMeta('ultima_sync', '2026-10-05T10:00:00Z')

    const e = await api.estadoSync()
    expect(e.fase).toBe('listo')
    expect(e.error).toBeNull()
    expect(e.ultimo?.status).toBe('ok')
    expect(e.ultimo?.rows_inserted).toBe(120)
  })
})

describe('indice', () => {
  const procesos = [
    LIGERO({
      id_del_proceso: 'A',
      departamento_entidad: 'Bogotá D.C.',
      modalidad_de_contratacion: 'Licitacion publica',
      precio_base: 100,
      fecha_publicacion: '2026-09-01T00:00:00.000Z',
      fecha_apertura_respuesta: '2099-01-01T00:00:00.000Z',
    }),
    LIGERO({
      id_del_proceso: 'B',
      nombre_del_procedimiento: 'SUMINISTRO DE ALIMENTOS PARA COMEDOR',
      departamento_entidad: 'Antioquia',
      modalidad_de_contratacion: 'Subasta',
      precio_base: 900,
      fecha_publicacion: '2026-08-01T00:00:00.000Z',
      fecha_apertura_respuesta: '2020-01-01T00:00:00.000Z',
      fuente: 'SECOP I',
    }),
  ]
  const matches = new Map<string, Match>([
    ['A', MATCH({ tender_id: 'A', score: 80, bullets: ['x'], razones_semanticas: [{ termino: 'software', idf: 3, peso: 1 }] })],
    ['B', MATCH({ tender_id: 'B', score: 40 })],
  ])

  it('pagina y ordena por score por defecto', () => {
    const ind = new Indice({ procesos, matches })
    const r = ind.consultar({}, { limite: 1, offset: 0 })
    expect(r.total).toBe(2)
    expect(r.pagina[0]!.id_del_proceso).toBe('A')
    expect(r.hayMas).toBe(true)
    expect(ind.consultar({}, { limite: 1, offset: 1 }).pagina[0]!.id_del_proceso).toBe('B')
  })

  it('acepta varias modalidades marcadas a la vez', () => {
    const ind = new Indice({ procesos, matches })
    expect(ind.filtrar({ modalidades: ['Subasta'] }).size).toBe(1)
    expect(ind.filtrar({ modalidades: ['Subasta', 'Licitacion publica'] }).size).toBe(2)
  })

  it('el rango de precio no descarta lo que no tiene precio', () => {
    const sinPrecio = LIGERO({ id_del_proceso: 'C', precio_base: null })
    const ind = new Indice({ procesos: [...procesos, sinPrecio], matches })
    expect(ind.filtrar({ precioMin: 1000, precioMax: 2000 }).has('C')).toBe(true)
  })

  it('descartado y oculto salen de la vista; guardado, solo con ese filtro', () => {
    const acciones = new Map([
      ['A', new Set(['descartar'])],
      ['B', new Set(['guardar'])],
    ])
    const ind = new Indice({ procesos, matches })
    // A esta descartado: sale de la vista aunque no se pida el filtro.
    expect(ind.filtrar({ acciones }).has('A')).toBe(false)
    expect([...ind.filtrar({ acciones })]).toEqual(['B'])
    // Con `soloGuardadas` solo entra el guardado; el descartado tampoco.
    expect([...ind.filtrar({ acciones, soloGuardadas: true })]).toEqual(['B'])
    // Un oculto tampoco sale: sale de la vista igual que descartado.
    const oculto = new Map([['B', new Set(['ocultar'])]])
    expect([...ind.filtrar({ acciones: oculto })]).toEqual(['A'])
  })

  it('solo guardadas sin nada guardado deja la lista vacia, no entera', () => {
    // El bug: con el mapa de acciones vacio se saltaba el filtro entero.
    const ind = new Indice({ procesos, matches })
    expect(ind.filtrar({ acciones: new Map(), soloGuardadas: true }).size).toBe(0)
  })

  it('las facetas se calculan sobre el conjunto filtrado, no sobre todo', () => {
    const ind = new Indice({ procesos, matches })
    const ids = ind.filtrar({ modalidades: ['Subasta'] })
    const fac = ind.facetas(ids)
    expect(fac.departamentos.map((d) => d.valor)).toEqual(['Antioquia'])
    expect(fac.fuentes.map((d) => d.valor)).toEqual(['SECOP I'])
    expect(fac.total).toBe(1)
  })

  it('solo_por_vencer deja fuera lo que ya cerro', () => {
    const ind = new Indice({ procesos, matches })
    expect([...ind.filtrar({ soloPorVencer: true })]).toEqual(['A'])
  })

  it('incluir es "cualquiera de" y excluir es "ninguna de"', () => {
    const ind = new Indice({ procesos, matches })
    expect([...ind.filtrar({ incluir: ['software', 'computadores'] })]).toEqual(['A'])
    expect([...ind.filtrar({ incluir: ['software', 'alimentos'] })].sort()).toEqual(['A', 'B'])
    expect([...ind.filtrar({ excluir: ['alimentos'] })]).toEqual(['A'])
    // Una frase cuenta entera, con tildes o sin ellas.
    expect([...ind.filtrar({ excluir: ['Suministro de alimentos'] })]).toEqual(['A'])
  })

  it('el buscador encuentra una licitacion por su numero, su aviso, su referencia o su municipio', () => {
    const ind = new Indice({ procesos, matches })
    // Los ids de los fixtures son 'A' y 'B'; uno con id de verdad:
    const real = LIGERO({ id_del_proceso: 'CO1.REQ.11094154', referencia_del_proceso: 'FFDS-CD-1116-2026', notice_uid: 'CO1.NTC.555' })
    const conReal = new Indice({ procesos: [...procesos, real], matches })
    expect([...conReal.filtrar({ q: 'CO1.REQ.11094154' })]).toEqual(['CO1.REQ.11094154'])
    expect([...conReal.filtrar({ q: 'co1.ntc.555' })]).toEqual(['CO1.REQ.11094154'])
    expect([...conReal.filtrar({ q: 'FFDS-CD-1116' })]).toEqual(['CO1.REQ.11094154'])
    // Departamento, municipio y UNSPSC tambien cuentan, sin tildes.
    expect([...ind.filtrar({ q: 'antioquia' })]).toEqual(['B'])
    expect(ind.filtrar({ q: 'bogota' }).size).toBe(2)
    expect(ind.filtrar({ q: '43232107' }).size).toBe(2)
  })

  it('las comillas buscan la frase exacta', () => {
    const ind = new Indice({ procesos, matches })
    expect([...ind.filtrar({ q: '"alimentos para comedor"' })]).toEqual(['B'])
    expect(ind.filtrar({ q: '"comedor para alimentos"' }).size).toBe(0)
    // Sin comillas basta con que esten todas las palabras, en cualquier orden.
    expect([...ind.filtrar({ q: 'comedor alimentos' })]).toEqual(['B'])
  })

  it('filtra por fuente, municipio y score minimo combinados', () => {
    const ind = new Indice({ procesos, matches })
    expect([...ind.filtrar({ fuentes: ['SECOP I'] })]).toEqual(['B'])
    expect([...ind.filtrar({ ciudades: ['Bogotá'], minScore: 50 })]).toEqual(['A'])
    expect(ind.filtrar({ fuentes: ['SECOP I'], minScore: 50 }).size).toBe(0)
  })

  it('la lista de la fachada trae el match completo, no solo el score suelto', async () => {
    // El bug: `filaDe` devolvia `score`, pero `aOportunidad` lee `fila.match`.
    // La lista pintaba "—" en todas las tarjetas aunque hubiera matches.
    await guardarProcesos([PROCESO({ id_del_proceso: 'CO1.REQ.1' })])
    await guardarMatches([
      MATCH({
        tender_id: 'CO1.REQ.1',
        score: 80,
        bullets: ['Encaja con software'],
        razones_semanticas: [{ termino: 'software', idf: 3, peso: 1 }],
        score_semantico: 0.8,
      }),
    ])
    await api.invalidarCache()

    const { items } = await api.licitaciones({ limit: 24 })
    expect(items[0]!.match).toMatchObject({ score: 80, semantic_similarity: 0.8, nivel: 'alta' })
    expect(items[0]!.match!.bullets).toEqual(['Encaja con software'])
    expect(items[0]!.url_proceso).toContain('noticeUID')
  })
})

describe('buscar en SECOP', () => {
  const CFG = { datasetProcesos: 'p6dx-8zbt', datasetSecopI: 'f789-7hwg', incluirSecopI: true }

  it('un numero de proceso va por $where exacto y solo a su fuente', () => {
    expect(tipoDeBusqueda('co1.req.11094154')).toBe('proceso')
    expect(tipoDeBusqueda('26-12-14833088')).toBe('constancia')
    expect(tipoDeBusqueda('software antiplagio')).toBe('texto')

    const [proceso] = consultasPara('co1.req.11094154', CFG)
    expect(proceso).toMatchObject({ fuente: 'SECOP II', where: "id_del_proceso = 'CO1.REQ.11094154'" })
    expect(proceso!.q).toBeUndefined()
    expect(consultasPara('26-12-14833088', CFG)).toMatchObject([{ fuente: 'SECOP I', where: "uid = '26-12-14833088'" }])
  })

  it('el texto va por $q a las dos fuentes, sin comillas', () => {
    const consultas = consultasPara('"gestion documental"', CFG)
    expect(consultas.map((c) => [c.fuente, c.q])).toEqual([
      ['SECOP II', 'gestion documental'],
      ['SECOP I', 'gestion documental'],
    ])
    expect(consultasPara('software', { ...CFG, incluirSecopI: false })).toHaveLength(1)
  })

  it('guarda, puntua y devuelve los ids; avisa de lo que no se puede buscar', async () => {
    const pedidas: { dataset: string; q?: string }[] = []
    const cliente = new SocrataClient({ requestDelay: 0 })
    cliente.pagina = async ({ dataset, q }) => {
      pedidas.push({ dataset, q })
      const rows = dataset === 'p6dx-8zbt' ? [FILA_CRUDA(), FILA_CRUDA()] : [{ uid: '26-12-1', detalle_del_objeto_a_contratar: 'Software de gestion' }]
      return { rows, hayMas: false }
    }
    const cfg = { ...(await api.configuracion()), ...CFG }
    const perfil = normalizarPerfil(PERFIL_POR_DEFECTO)

    const res = await buscarEnSecop('software', { cliente, cfg, perfil })
    expect(pedidas.map((p) => p.dataset).sort()).toEqual(['f789-7hwg', 'p6dx-8zbt'])
    // La fila repetida del portal cuenta una vez.
    expect(res.ids).toEqual(['CO1.REQ.1', '26-12-1'])
    expect(res.porFuente).toEqual({ 'SECOP II': 1, 'SECOP I': 1 })
    expect(res.nuevas).toBe(2)
    expect(await contarProcesos()).toBe(2)

    // Y la lista los enseña filtrando por esos ids.
    await api.invalidarCache()
    const { items } = await api.licitaciones({ ids: ['26-12-1'] })
    expect(items.map((o) => o.id_del_proceso)).toEqual(['26-12-1'])
    expect(items[0]!.match).not.toBeNull()

    const aviso = await buscarEnSecop('CO1.NTC.555', { cliente, cfg, perfil })
    expect(aviso.aviso).toMatch(/CO1\.REQ/)
    expect((await buscarEnSecop('ab', { cliente, cfg, perfil })).aviso).toMatch(/3 caracteres/)
    expect(pedidas).toHaveLength(2)
  })
})

describe('scores guardados con el formato viejo', () => {
  it('se pintan con la linea nueva sin tener que repuntuar', async () => {
    await guardarProcesos([PROCESO()])
    await guardarMatches([
      MATCH({
        tender_id: 'CO1.REQ.1',
        score: 60,
        bullets: ['Modalidad no preferida: X', "Perfil: 'software' (idf 5.47)", "Perfil: 'con' (idf 2.85)"],
        razones_semanticas: [
          { termino: 'software', idf: 5.47, peso: 2 },
          { termino: 'con', idf: 2.85, peso: 1 },
        ],
      }),
    ])
    await api.invalidarCache()
    const m = (await api.licitaciones({})).items[0]!.match!
    expect(m.bullets).toEqual(['Modalidad no preferida: X', 'Coincide con tu perfil en: software'])
    expect(m.matched_keywords).toEqual(['software'])
  })
})

describe('CRM y busquedas guardadas', () => {
  it('mover al tablero guarda la tarjeta y la refleja en la lista', async () => {
    await guardarProcesos([PROCESO()])
    await api.invalidarCache()
    const tarjeta = await api.moverCRM('CO1.REQ.1', 'evaluacion')
    expect(tarjeta.titulo).toContain('SOFTWARE')
    expect(tarjeta.fecha_cierre).toBe('2026-10-05T00:00:00.000Z')

    await api.moverCRM('CO1.REQ.1', 'presentada')
    const tablero = await api.tablero()
    expect(tablero).toHaveLength(1)
    expect(tablero[0]!.estado).toBe('presentada')
    // La fecha de alta no cambia al mover.
    expect(tablero[0]!.creado_en).toBe(tarjeta.creado_en)

    const { items } = await api.licitaciones({})
    expect(items[0]!.crm).toBe('presentada')

    await api.notaCRM('CO1.REQ.1', 'Pedir aclaracion del anexo 3')
    expect((await api.tablero())[0]!.nota).toBe('Pedir aclaracion del anexo 3')

    await api.quitarCRM('CO1.REQ.1')
    expect(await api.tablero()).toHaveLength(0)
  })

  it('las busquedas se guardan por nombre y el mismo nombre sobrescribe', async () => {
    const filtros = {
      q: '',
      incluir: 'software',
      excluir: 'obra',
      score_min: 60,
      precio_min: '' as const,
      precio_max: 500000000,
      solo_por_vencer: false,
      dias_por_vencer: '' as const,
      solo_guardadas: false,
      departamentos: ['Antioquia'],
      ciudades: [],
      modalidades: [],
      entidades: [],
      estados: [],
      fuentes: [],
      orden: 'score' as const,
    }
    await api.guardarBusqueda('Software Antioquia', filtros)
    const lista = await api.guardarBusqueda('software antioquia', { ...filtros, score_min: 70 })
    expect(lista).toHaveLength(1)
    expect(lista[0]!.filtros.score_min).toBe(70)
    expect(await api.borrarBusqueda(lista[0]!.id)).toHaveLength(0)
    await expect(api.guardarBusqueda('   ', filtros)).rejects.toThrow(/nombre/)
  })
})

describe('alertas', () => {
  it('avisa una sola vez de lo que supera el umbral', async () => {
    const procesos = new Map([
      ['A', { nombre_del_procedimiento: 'Software', entidad: 'MinTIC' }],
      ['B', { nombre_del_procedimiento: 'Redes', entidad: 'Alcaldia' }],
    ])
    const cfg = { alertas: true, alertaUmbral: 80, alertaNotificacion: false }
    const nuevas = await evaluarAlertas(
      [MATCH({ tender_id: 'A', score: 92 }), MATCH({ tender_id: 'B', score: 80 }), MATCH({ tender_id: 'C', score: 10 })],
      procesos,
      cfg,
    )
    // "Superior a 80": el 80 justo no avisa.
    expect(nuevas.map((a) => a.tender_id)).toEqual(['A'])
    expect(nuevas[0]!.titulo).toBe('Software')

    // Repuntuar o volver a bajar la misma ventana no repite el aviso.
    expect(await evaluarAlertas([MATCH({ tender_id: 'A', score: 95 })], procesos, cfg)).toHaveLength(0)
    expect(await leerAlertas()).toHaveLength(1)

    expect(await evaluarAlertas([MATCH({ tender_id: 'B', score: 99 })], procesos, { ...cfg, alertas: false })).toHaveLength(0)
  })
})

describe('resumidor de pliegos', () => {
  it('clasifica las frases del texto y anade lo habitual de la modalidad', () => {
    const r = resumirPliego(
      PROCESO({
        descripcion:
          'Implementacion de software de gestion documental. El proponente debe estar inscrito en el RUP y acreditar experiencia en tres contratos similares. ' +
          'Indice de liquidez mayor o igual a 1,5 y nivel de endeudamiento menor al 60%. Forma de pago: mensual contra entregables.',
        precio_base: 200000000,
        modalidad_de_contratacion: 'Licitación pública',
      }),
      Date.UTC(2026, 8, 1),
    )
    const textos = (c: 'juridico' | 'financiero' | 'tecnico') => r.requisitos[c].map((q) => q.texto).join(' | ')
    expect(textos('juridico')).toMatch(/RUP/)
    expect(textos('financiero')).toMatch(/liquidez/)
    expect(textos('tecnico')).toMatch(/experiencia|Implementacion/)
    // Lo habitual de la licitacion publica va marcado como tal.
    expect(r.requisitos.juridico.some((q) => q.origen === 'habitual' && /seriedad/.test(q.texto))).toBe(true)
    expect(r.datos_clave.find((d) => d.etiqueta.startsWith('Garantía'))?.valor).toMatch(/20\.000\.000/)
    expect(r.advertencias.join(' ')).toMatch(/SECOP/)
  })

  it('en minima cuantia no pide RUP ni estima garantia', () => {
    const r = resumirPliego(PROCESO({ modalidad_de_contratacion: 'Mínima cuantía', descripcion: null }))
    expect(r.requisitos.juridico.some((q) => /No se exige RUP/.test(q.texto))).toBe(true)
    expect(r.datos_clave.find((d) => d.etiqueta.startsWith('Garantía'))).toBeUndefined()
    expect(r.advertencias.join(' ')).toMatch(/no publica descripción/)
  })
})

describe('exportar', () => {
  const OP: Oportunidad = {
    id_del_proceso: 'CO1.REQ.1',
    titulo: 'Software; "nube" y redes',
    entidad: 'MinTIC',
    referencia_del_proceso: 'REQ-1',
    estado: 'Convocado',
    modalidad: 'Licitación pública',
    departamento: 'Bogotá D.C.',
    ciudad: 'Bogotá',
    categoria: 'V1.43232107',
    lotes: 1,
    precio_base: 150000000,
    fecha_publicacion: '2026-09-20T00:00:00.000Z',
    fecha_apertura_respuesta: '2026-10-05T00:00:00.000Z',
    dias_restantes: 5,
    url_proceso: 'https://community.secop.gov.co/x',
    fuente: 'SECOP II',
    acciones: [],
    crm: null,
    match: null,
  }

  it('el CSV lleva BOM, separa con punto y coma y escapa comillas', () => {
    const csv = aCsv([OP])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const [cabecera, fila] = csv.slice(1).split('\r\n')
    expect(cabecera!.split(';')[0]).toBe('Score')
    expect(fila).toContain('"Software; ""nube"" y redes"')
    expect(fila).toContain('150000000')
  })

  it('el XLSX es un zip con la hoja y las celdas tipadas', () => {
    const archivos = unzipSync(aXlsx([OP]))
    expect(Object.keys(archivos)).toContain('xl/worksheets/sheet1.xml')
    const hoja = strFromU8(archivos['xl/worksheets/sheet1.xml']!)
    expect(hoja).toContain('Software; &quot;nube&quot; y redes')
    // El presupuesto va como numero, no como texto.
    expect(hoja).toMatch(/<c r="I2" s="2"><v>150000000<\/v><\/c>/)
  })
})

describe('snapshot', () => {
  it('exportar e importar deja el mismo numero de filas', async () => {
    await guardarProcesos([PROCESO(), PROCESO({ id_del_proceso: 'OTRO' })])
    await ponerAccion({ tender_id: 'CO1.REQ.1', accion: 'guardar' })

    const lineas: string[] = []
    const res = await recorrerParaExportar({ alLinea: (obj) => lineas.push(JSON.stringify(obj)) })
    // Cabecera + 2 procesos + 1 accion. La cabecera no cuenta como fila de dato.
    expect(res.total).toBe(3)
    expect(lineas).toHaveLength(4)

    await fijarAlmacen('memoria')
    expect(await contarProcesos()).toBe(0)

    const r = await importar(lineas.join('\n'))
    expect(r.leidas).toBe(4)
    expect(r.ignoradas).toBe(0)
    expect(r.cabecera?._formato).toBe('licitaciones-ndjson')
    expect(await contarProcesos()).toBe(2)
    expect((await accionesDe('CO1.REQ.1')).map((a) => a.accion)).toEqual(['guardar'])
  })

  it('el tablero viaja en el respaldo', async () => {
    await guardarProcesos([PROCESO()])
    await api.invalidarCache()
    await api.moverCRM('CO1.REQ.1', 'ganada')
    const lineas: string[] = []
    await recorrerParaExportar({ alLinea: (obj) => lineas.push(JSON.stringify(obj)) })

    await fijarAlmacen('memoria')
    await importar(lineas.join('\n'))
    expect((await api.tablero()).map((t) => t.estado)).toEqual(['ganada'])
  })

  it('el perfil de la cabecera se devuelve sin aplicarse solo', async () => {
    await escribirMeta('perfil', { nombre: 'Otra Empresa S.A.S.', palabras_clave: 'a, b' })
    const lineas: string[] = []
    await recorrerParaExportar({ alLinea: (obj) => lineas.push(JSON.stringify(obj)) })
    const { cabecera: cab } = await importar(lineas.join('\n'))
    expect(perfilDeCabecera(cab)?.nombre).toBe('Otra Empresa S.A.S.')
    expect(perfilDeCabecera(cab)?.palabras_clave).toEqual(['a', 'b'])
    // Importar no debe cambiar el perfil con el que puntua el panel.
    expect((await leerMeta<{ nombre: string } | null>('perfil', null))?.nombre).toBe('Otra Empresa S.A.S.')
  })

  it('una linea corrupta no tumba la importacion entera', async () => {
    const r = await importar(
      [
        JSON.stringify({ _formato: 'licitaciones-ndjson', _version: 1 }),
        '{esto no es json',
        JSON.stringify({ _store: 'procesos', ...PROCESO() }),
        JSON.stringify({ _store: 'inventado', id: 1 }),
      ].join('\n'),
    )
    expect(r.ignoradas).toBe(2)
    expect(r.leidas).toBe(3)
    expect(await contarProcesos()).toBe(1)
  })

  it('un fichero de otro formato se rechaza con un mensaje claro', async () => {
    await expect(importar(JSON.stringify({ _formato: 'otra-cosa' }))).rejects.toThrow(/otra-cosa/)
  })

  it('escribe en orden y espera a vaciar la cola antes de cerrar', async () => {
    await guardarProcesos([PROCESO({ id_del_proceso: 'A' }), PROCESO({ id_del_proceso: 'B' })])

    // `write()` se resuelve en el proximo turno, como el de verdad: si `descargar`
    // no encadena las escrituras, el orden del fichero seria el del scheduler.
    const escritas: string[] = []
    let pendientes = 0
    let pendientesAlCerrar = -1
    const writable = {
      write: (texto: string) => {
        escritas.push(texto)
        pendientes += 1
        return Promise.resolve().then(() => {
          pendientes -= 1
        })
      },
      // Si se cerrara con escrituras en vuelo, el navegador las descartaria y el
      // fichero saldria truncado. Se anota el estado para poder comprobarlo.
      close: () => {
        pendientesAlCerrar = pendientes
        return Promise.resolve()
      },
    }
    const ventana = window as Window & { showSaveFilePicker?: unknown }
    const original = ventana.showSaveFilePicker
    ventana.showSaveFilePicker = async () => ({ name: 'prueba.ndjson', createWritable: async () => writable })
    try {
      const r = await descargar()
      expect(r.streamed).toBe(true)
      const lineas = escritas
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { _formato?: string; _store?: string; id_del_proceso?: string })
      expect(lineas[0]!._formato).toBeDefined()
      expect(lineas.filter((l) => l._store === 'procesos').map((l) => l.id_del_proceso)).toEqual(['A', 'B'])
      expect(pendientesAlCerrar).toBe(0)
    } finally {
      ventana.showSaveFilePicker = original
    }
  })
})
