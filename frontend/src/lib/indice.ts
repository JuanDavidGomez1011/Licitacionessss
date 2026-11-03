/**
 * Indice de consulta en memoria.
 *
 * El backend paginaba en SQL con indices. En el navegador no hay SQL, asi que el
 * panel carga una vez las filas ligeras (sin textos) en estructuras planas y de
 * ahi salen el filtrado, las facetas y el orden.
 *
 * Por que se puede: `ligeros` quita las descripciones, que son el 95% del peso.
 * Un objeto de proceso completo pesa entre 2 y 4 KB; el ligero, unos 400 bytes.
 * Con 118.000 procesos son ~45 MB, que es lo que cabe de sobra en una pestana,
 * frente a los ~350 MB que daria traerse las descripciones. Las descripciones se
 * piden solo al abrir la ficha de una oportunidad.
 *
 * Los indices son columnas invertidas (mapa valor -> lista de ids) para no
 * recorrer 118.000 filas por cada faceta. La consulta si las recorre, pero sobre
 * ids: partir el filtro mas selectivo primero reduce el trabajo a una pasada
 * corta en vez de doce.
 */

import { norm, STOPWORDS } from './texto'
import { recorrerLigeros, recorrerMatches } from './db'
import type { Facetas, FiltrosIndice, Match, Orden, ProcesoLigero, ValorFaceta } from './tipos'

const MAX_FACETAS = 200

/**
 * Columnas por las que se puede filtrar sin recorrer nada.
 * `id_del_proceso` esta a proposito: es un termino de busqueda mas.
 */
const CAMPOS_FILTRABLES = [
  'departamento_entidad',
  'ciudad_entidad',
  'modalidad_de_contratacion',
  'estado_del_procedimiento',
  'entidad',
  'fuente',
] as const

type CampoFiltrable = (typeof CAMPOS_FILTRABLES)[number]

/** Una fila del resultado: el proceso ligero con su match pegado. */
export interface FilaIndice extends ProcesoLigero {
  score: number | null
  bullets: string[]
  score_semantico: number | null
  ya_accion: string | null
  match: Match | null
}

export interface ResultadoConsulta {
  total: number
  pagina: FilaIndice[]
  offset: number
  limite: number
  ms: number
  hayMas: boolean
  vacio: boolean
  scoreMaximo: number
}

type ListaFiltro = FiltrosIndice['entidades']

/** Texto en el que buscan incluir y excluir: titulo, entidad y referencia. */
function textoBuscable(p: ProcesoLigero): string {
  return norm(`${p.nombre_del_procedimiento || ''} ${p.entidad || ''} ${p.referencia_del_proceso || ''}`)
}

/**
 * Texto del buscador (`q`): lo de arriba mas todo lo que sirve para encontrar
 * una licitacion concreta. Los identificadores (`CO1.REQ.*`, el `CO1.NTC.*` del
 * aviso, la constancia de SECOP I), el lugar, la modalidad y el UNSPSC. Incluir
 * y excluir no lo usan a proposito: excluir "bogota" tiene que quitar procesos
 * que hablan de Bogota, no todos los de las entidades de Bogota.
 */
function textoBuscador(p: ProcesoLigero): string {
  return norm(
    [
      p.nombre_del_procedimiento,
      p.entidad,
      p.referencia_del_proceso,
      p.id_del_proceso,
      p.notice_uid,
      p.ciudad_entidad,
      p.departamento_entidad,
      p.modalidad_de_contratacion,
      p.codigo_principal_categoria,
    ]
      .filter(Boolean)
      .join(' '),
  )
}

/** Terminos normalizados de una lista de palabras clave. Una frase vale entera. */
function terminos(lista: string[] | undefined): string[] {
  return (lista || []).map((t) => norm(t)).filter((t) => t.length >= 2)
}

/**
 * Estado compartido del indice. Se construye una vez tras la ingesta y se
 * reutiliza en cada cambio de filtro, que es cuando mas se nota: el backend
 * tardaba 300-800 ms por consulta y aqui es instantaneo.
 */
export class Indice {
  procesos: ProcesoLigero[]
  matches: Map<string, Match>
  entidades: string[]
  versionDatos?: number

  constructor({ procesos = [], matches = new Map() }: { procesos?: ProcesoLigero[]; matches?: Map<string, Match> } = {}) {
    this.procesos = procesos
    this.matches = matches
    this.entidades = [...new Set(procesos.map((p) => p.entidad).filter((e): e is string => Boolean(e)))].sort()
  }

  /** `Match` de un proceso, o `null` si aun no se ha puntuado. */
  matchDe(id: string): Match | null {
    return this.matches.get(id) || null
  }

  scoreDe(id: string): number | null {
    const m = this.matches.get(id)
    return m ? Number(m.score) || 0 : null
  }

  /** Ids que pasan todos los filtros, como Set para intersectarlos rapido. */
  filtrar(filtros: FiltrosIndice = {}): Set<string> {
    const {
      ids = null,
      q = '',
      incluir = [],
      excluir = [],
      entidades = null,
      departamentos = null,
      ciudades = null,
      modalidades = null,
      estados = null,
      fuentes = null,
      precioMin = null,
      precioMax = null,
      desde = '',
      hasta = '',
      soloPorVencer = false,
      diasPorVencer = null,
      acciones = null,
      soloGuardadas = false,
      soloConMatch = false,
      minScore = null,
      maxScore = null,
    } = filtros

    // El panel manda listas (se pueden marcar varias modalidades a la vez), no
    // valores sueltos. Un Set aqui evita un `.includes` por fila y por valor.
    const aSet = (v: ListaFiltro): Set<string> | null => {
      if (v instanceof Set) return v.size ? v : null
      if (Array.isArray(v)) return v.length ? new Set(v) : null
      if (v) return new Set([v])
      return null
    }
    const ent = aSet(entidades)
    const dep = aSet(departamentos)
    const ciu = aSet(ciudades)
    const mod = aSet(modalidades)
    const est = aSet(estados)
    const fue = aSet(fuentes)

    // Se normaliza el texto de busqueda con el mismo `norm` del indice de texto,
    // para que "Bogota D.C." y "bogota dc" den el mismo resultado.
    // Lo que va entre comillas se busca como frase exacta ("gestion documental");
    // el resto, palabra a palabra y todas tienen que estar.
    const frases = [...q.matchAll(/"([^"]+)"/g)].map((m) => norm(m[1])).filter(Boolean)
    const palabras = [
      ...frases,
      ...norm(q.replace(/"[^"]*"?/g, ' '))
        .split(/\s+/)
        .filter((p) => p.length >= 3 && !STOPWORDS.has(p)),
    ]
    // Incluir es "cualquiera de": lo normal es marcar sinonimos ("software",
    // "aplicativo", "sistema de informacion") y quedarse con lo que nombre uno.
    // Excluir es "ninguna de".
    const conAlguna = terminos(incluir)
    const sinNinguna = terminos(excluir)
    const desdeMs = desde ? Date.parse(desde.length <= 10 ? `${desde}T00:00:00Z` : desde) : null
    const hastaMs = hasta ? Date.parse(hasta.length <= 10 ? `${hasta}T23:59:59Z` : hasta) : null
    const ahora = Date.now()
    const limiteVencer = diasPorVencer ? ahora + Number(diasPorVencer) * 86400000 : null

    const soloIds = ids ? new Set(ids) : null

    const acepta = (p: ProcesoLigero): boolean => {
      if (soloIds && !soloIds.has(p.id_del_proceso)) return false
      if (ent && !ent.has(p.entidad || '')) return false
      if (dep && !dep.has(p.departamento_entidad || '')) return false
      if (ciu && !ciu.has(p.ciudad_entidad || '')) return false
      if (mod && !mod.has(p.modalidad_de_contratacion || '')) return false
      if (est && !est.has(p.estado_del_procedimiento || '')) return false
      if (fue && !fue.has(p.fuente || 'SECOP II')) return false

      if (precioMin !== null || precioMax !== null) {
        const precio = p.precio_base
        // Sin `precio_base` no se puede afirmar que este fuera de rango, asi que
        // no se descarta: el panel lo muestra como "sin precio", no como "fuera".
        if (precio !== null && precio !== undefined) {
          if (precioMin !== null && precio < precioMin) return false
          if (precioMax !== null && precio > precioMax) return false
        }
      }

      if (desdeMs !== null || hastaMs !== null) {
        if (!p.fecha_publicacion) return false
        const ms = Date.parse(p.fecha_publicacion)
        if (desdeMs !== null && ms < desdeMs) return false
        if (hastaMs !== null && ms > hastaMs) return false
      }

      if (soloPorVencer || limiteVencer !== null) {
        if (!p.fecha_apertura_respuesta) return false
        const ms = Date.parse(p.fecha_apertura_respuesta)
        if (ms < ahora) return false
        if (limiteVencer !== null && ms > limiteVencer) return false
      }

      if (palabras.length && !palabras.every((p2) => textoBuscador(p).includes(p2))) return false
      if (conAlguna.length || sinNinguna.length) {
        const texto = textoBuscable(p)
        if (conAlguna.length && !conAlguna.some((t) => texto.includes(t))) return false
        if (sinNinguna.some((t) => texto.includes(t))) return false
      }

      if (acciones?.size) {
        const hechas = acciones.get(p.id_del_proceso)
        if (soloGuardadas) {
          if (!hechas || !hechas.has('guardar')) return false
        } else if (hechas && (hechas.has('descartar') || hechas.has('ocultar'))) {
          // Descartado u oculto sale de la vista, igual que hacia el backend.
          return false
        }
      } else if (soloGuardadas) {
        return false
      }

      if (soloConMatch || minScore !== null || maxScore !== null) {
        const m = this.matches.get(p.id_del_proceso)
        if (!m) return false
        const s = Number(m.score) || 0
        if (minScore !== null && s < minScore) return false
        if (maxScore !== null && s > maxScore) return false
      }
      return true
    }

    return new Set(this.procesos.filter(acepta).map((p) => p.id_del_proceso))
  }

  /**
   * Fila de la tabla, con el score ya pegado.
   *
   * `match` va completo ademas de los campos sueltos: `aOportunidad` (la
   * fachada que consume `Tarjeta`) lee `fila.match`, igual que el detalle. Sin
   * esto la lista pintaba "—" en todas las tarjetas aunque el score estuviera
   * calculado y guardado; los tests de componentes no lo veian porque mockean
   * `api.licitaciones` con fixtures que ya traen `match`.
   */
  filaDe(proceso: ProcesoLigero): FilaIndice {
    const m = this.matches.get(proceso.id_del_proceso)
    return {
      ...proceso,
      score: m ? Number(m.score) || 0 : null,
      bullets: m?.bullets || [],
      score_semantico: m ? Number(m.score_semantico) || 0 : null,
      ya_accion: m?.ya_accion || null,
      match: m || null,
    }
  }

  /**
   * Facetas para los desplegables. Se calculan sobre el conjunto ya filtrado, no
   * sobre todo el store: si no, marcar "Bogota" no dejaria nada mas seleccionable
   * y el usuario veria Facetas que ya no se pueden aplicar.
   */
  facetas(ids: Set<string> | string[]): Facetas {
    const conjunto = ids instanceof Set ? ids : new Set(ids)
    const porCampo = Object.fromEntries(CAMPOS_FILTRABLES.map((c) => [c, new Map<string, number>()])) as Record<
      CampoFiltrable,
      Map<string, number>
    >
    let conPrecio = 0
    let total = 0

    for (const p of this.procesos) {
      if (!conjunto.has(p.id_del_proceso)) continue
      total += 1
      if (p.precio_base !== null && p.precio_base !== undefined) conPrecio += 1
      for (const campo of CAMPOS_FILTRABLES) {
        const valor = campo === 'fuente' ? p.fuente || 'SECOP II' : p[campo]
        if (!valor) continue
        const mapa = porCampo[campo]
        mapa.set(valor, (mapa.get(valor) || 0) + 1)
      }
    }

    const faceta = (mapa: Map<string, number>): ValorFaceta[] =>
      [...mapa.entries()]
        .map(([valor, n]) => ({ valor, n }))
        .sort((a, b) => b.n - a.n || String(a.valor).localeCompare(String(b.valor)))
        .slice(0, MAX_FACETAS)

    return {
      entidades: faceta(porCampo.entidad),
      departamentos: faceta(porCampo.departamento_entidad),
      ciudades: faceta(porCampo.ciudad_entidad),
      modalidades: faceta(porCampo.modalidad_de_contratacion),
      estados: faceta(porCampo.estado_del_procedimiento),
      fuentes: faceta(porCampo.fuente),
      conPrecio,
      total,
    }
  }

  /**
   * Consulta principal: filtra, ordena y corta en una pagina.
   *
   * `limite` y `offset` existen para que el panel use paginacion real y no una
   * lista gigante: 118.000 filas en el DOM hunden cualquier navegador, y el
   * backend ya paginaba a 25.
   */
  consultar(
    filtros: FiltrosIndice = {},
    { limite = 25, offset = 0, orden = 'score' }: { limite?: number; offset?: number; orden?: Orden } = {},
  ): ResultadoConsulta {
    const t0 = performance.now?.() ?? Date.now()
    const ids = this.filtrar(filtros)
    const filas: FilaIndice[] = []
    for (const p of this.procesos) {
      if (ids.has(p.id_del_proceso)) filas.push(this.filaDe(p))
    }

    filas.sort(comparadores(orden))

    const total = filas.length
    const pagina = filas.slice(offset, offset + limite)
    const ms = (performance.now?.() ?? Date.now()) - t0

    return {
      total,
      pagina,
      offset,
      limite,
      ms,
      /** El panel pinta "de X a Y de Z" y avisa si el filtro deja la lista vacia. */
      hayMas: offset + pagina.length < total,
      vacio: total === 0,
      /** Si el corte cae en un lote, avisar en vez de dejar paginas vacias. */
      scoreMaximo: filas.length ? Math.max(...filas.slice(0, 200).map((f) => f.score || 0)) : 0,
    }
  }
}

type Comparador = (a: FilaIndice, b: FilaIndice) => number

/**
 * Ordenes. El `score` va primero, que es lo que casi siempre se quiere, y los
 * demas tienen la direccion invertida para que el orden estable caiga bien.
 */
function comparadores(orden: Orden): Comparador {
  const porFecha: Comparador = (a, b) =>
    String(b.fecha_publicacion || '').localeCompare(String(a.fecha_publicacion || ''))
  switch (orden) {
    case 'fecha':
      return (a, b) => porFecha(a, b) || String(a.id_del_proceso).localeCompare(String(b.id_del_proceso))
    case 'precio':
      return (a, b) => (a.precio_base ?? Infinity) - (b.precio_base ?? Infinity) || porFecha(a, b)
    case 'precio_desc':
      return (a, b) => (b.precio_base ?? -Infinity) - (a.precio_base ?? -Infinity) || porFecha(a, b)
    case 'entidad':
      return (a, b) => String(a.entidad || '').localeCompare(String(b.entidad || '')) || porFecha(a, b)
    case 'cierre': {
      // Lo que cierra antes, primero; lo ya cerrado y lo que no tiene fecha, al final.
      const ahora = new Date().toISOString()
      const clave = (f: FilaIndice) =>
        f.fecha_apertura_respuesta && f.fecha_apertura_respuesta >= ahora ? f.fecha_apertura_respuesta : '9999'
      return (a, b) => clave(a).localeCompare(clave(b)) || porFecha(a, b)
    }
    default:
      // Sin score (aun no se ha puntuado) van al final, no mezclados con un 0
      // que parece "malo": todavia no se sabe.
      return (a, b) => (b.score ?? -1) - (a.score ?? -1) || porFecha(a, b)
  }
}

/**
 * Construye el indice desde el almacen. Recorre `ligeros` y `matches` una vez.
 * Se llama tras la ingesta y al arrancar (si ya habia datos de una sesion
 * anterior), no en cada render.
 */
export async function construirIndice(): Promise<Indice> {
  const procesos: ProcesoLigero[] = []
  await recorrerLigeros((fila) => {
    procesos.push(fila)
    return true
  })
  const matches = new Map<string, Match>()
  await recorrerMatches((fila) => {
    matches.set(fila.tender_id, fila)
    return true
  })
  return new Indice({ procesos, matches })
}

/** Reemplaza solo la parte de matches, que es lo unico que cambia al recalcular. */
export function actualizarMatches(indice: Indice, matches: Map<string, Match> | Record<string, Match>): Indice {
  indice.matches = matches instanceof Map ? matches : new Map(Object.entries(matches))
  return indice
}
