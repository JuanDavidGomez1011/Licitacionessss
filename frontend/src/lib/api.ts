/**
 * Fachada local de la API.
 *
 * Antes esto era `fetch` a `http://localhost:8000/api`. Ahora cada metodo
 * resuelve contra el almacen del navegador. Se conserva la MISMA superficie de
 * metodos y las mismas formas de respuesta (`{items, total}`, `{licitacion, match,
 * ocds, contratos, acciones}`, ...) para que los componentes no tuvieran que
 * cambiar. Si algun dia se quiere volver al backend, esta fachada es el unico
 * punto que tocaria.
 *
 * Lo que cambia de verdad:
 *
 *   - `salud()` ya no puede decir "ollama ok": no hay ni servidor ni modelo. Dice
 *     como esta el almacen del navegador, que es la unica cosa que puede fallar.
 *   - `sincronizar()` devuelve enseguida y la ingesta sigue en la propia pestana.
 *     Se puede cancelar, cosa que con el backend en segundo plano no se podia.
 *   - El indice de consulta se calcula la primera vez que se pide, a partir de
 *     lo que haya en IndexedDB, y se reutiliza hasta que hay una ingesta nueva.
 */

import { borrarAlertas, leerAlertas, marcarLeidas } from './alertas'
import { buscarEnSecop, type ResultadoBusquedaRemota } from './busquedaRemota'
import { config as leerConfig, guardarConfig } from './config'
import {
  abrirAlmacen,
  accionesDe,
  borrarAccionesDe,
  borrarTarjetaCRM,
  borrarTodo,
  contratosDeProceso,
  escribirMeta,
  estadosCRM,
  guardarMatches,
  guardarTarjetaCRM,
  leerMeta,
  obtenerProceso,
  obtenerTarjetaCRM,
  ponerAccion,
  recorrerProcesos,
  resumenAlmacen,
  todasLasAcciones,
  todasLasTarjetasCRM,
} from './db'
import { nivelDe, CORTE_ALTO, diasHasta } from './format'
import { construirIndice, type FilaIndice, type Indice } from './indice'
import { estadoIngesta, repuntuarTodo, sincronizar, type FaseIngesta, type ModoVentana, type ResumenSync } from './ingesta'
import { contractToOcds, tenderToOcds, type ReleaseOcds } from './ocds'
import { normalizarPerfil, PERFIL_POR_DEFECTO, type PerfilBruto } from './perfil'
import { resumirPliego } from './resumidor'
import {
  bulletPerfil,
  construirIndiceCorpus,
  cosenoContraDoc,
  esTerminoUtil,
  puntuarProceso,
  resumenPuntuacion,
  vectorizarPerfil,
  type IndiceCorpus,
  type ResumenScores,
} from './score'
import { SocrataClient } from './socrata'
import { textoFicha } from './texto'
import type {
  Accion,
  Alerta,
  BusquedaGuardada,
  Config,
  Contrato,
  EstadoCRM,
  Facetas,
  FiltrosIndice,
  FiltrosUI,
  Match,
  MatchVista,
  Oportunidad,
  OportunidadDetalle,
  Orden,
  ParamsConsulta,
  Perfil,
  Proceso,
  ProcesoLigero,
  ResumenPliego,
  TarjetaCRM,
  TipoAccion,
} from './tipos'

export class ApiError extends Error {
  status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// --- formas de respuesta -------------------------------------------------------

export interface Salud {
  estado: 'ok' | 'degradado'
  base_datos: string
  ollama: string
  procesos: number
  contracts: number
  scored: number
  cuota: { usado: number; total: number } | null
  mensaje: string | null
}

export interface Estadisticas {
  tenders: number
  scored: number
  contracts: number
  avg_score: number | null
  high_matches: number
  newest_tender_at: string | null
  promedio_dias_publicados?: number | null
}

export interface PaginaOportunidades {
  items: Oportunidad[]
  total: number
  offset?: number
  limit?: number
  ms?: number
}

export interface ContratoVista {
  id_contrato: string
  proveedor: string | null
  valor: number | null
  valor_pagado: number | null
  fecha_firma: string | null
  estado: string | null
  es_pyme: string | null
  ocds: ReleaseOcds | null
}

export interface Detalle {
  licitacion: OportunidadDetalle
  match: MatchVista | null
  ocds: ReleaseOcds | null
  contratos: ContratoVista[]
  acciones: Accion[]
  crm: TarjetaCRM | null
}

export interface Similar {
  oportunidad: Oportunidad
  similitud: number
}

export interface UltimaSync {
  status: 'ok' | 'error'
  started_at: string
  finished_at: string | null
  rows_inserted: number
  rows_updated: number
  error: string | null
  resumen: ResumenSync | null
}

export interface EstadoSync {
  en_curso: boolean
  fase: FaseIngesta | null
  hechos: number
  total: number
  nuevas: number
  repetidas: number
  enlazados: number
  puntuados: number
  error: string | null
  iniciado: string | null
  cron_activo: boolean
  proximo: string | null
  ultimo: UltimaSync | null
  alerta: string | null
}

export interface Lanzamiento {
  lanzado: boolean
  mensaje?: string
}

// --- estado de la pagina -----------------------------------------------------

let indice: Indice | null = null
let perfilActual: Perfil | null = null
let accionesPorId = new Map<string, Set<string>>()
let crmPorId = new Map<string, EstadoCRM>()
let cfg: Config | null = null
let cliente: SocrataClient | null = null
/** El indice de texto del corpus, para "similares". Se construye una sola vez. */
let indiceCorpus: IndiceCorpus | null = null
/** Se sube con cada ingesta para invalidar lo que este cacheado. */
let versionDatos = 0

const clienteSocrata = (): SocrataClient => {
  if (!cliente) cliente = new SocrataClient(cfg)
  return cliente
}

async function configuracionActual(): Promise<Config> {
  if (!cfg) cfg = await leerConfig()
  return cfg
}

/** Perfil: primero el del almacen, y si no hay, el de ejemplo. */
async function perfil(): Promise<Perfil> {
  if (perfilActual) return perfilActual
  const guardado = await leerMeta<PerfilBruto | null>('perfil', null)
  perfilActual = guardado ? normalizarPerfil(guardado) : { ...PERFIL_POR_DEFECTO }
  return perfilActual
}

async function accionesIndexadas(): Promise<Map<string, Set<string>>> {
  const todas = await todasLasAcciones()
  const mapa = new Map<string, Set<string>>()
  for (const a of todas) {
    let conjunto = mapa.get(a.tender_id)
    if (!conjunto) {
      conjunto = new Set()
      mapa.set(a.tender_id, conjunto)
    }
    conjunto.add(a.accion)
  }
  accionesPorId = mapa
  return mapa
}

async function crmIndexado(): Promise<Map<string, EstadoCRM>> {
  crmPorId = await estadosCRM()
  return crmPorId
}

/**
 * El indice de consulta, construido una vez.
 *
 * Se reconstruye cuando `versionDatos` ha cambiado (tras una ingesta o un
 * repuntuado) o cuando no existe. Sin este cache, cada cambio de filtro
 * releeria las 118.000 filas ligeras de IndexedDB, que son segundos por pulsación.
 */
async function asegurarIndice({ forzar = false }: { forzar?: boolean } = {}): Promise<Indice> {
  await configuracionActual()
  // La version se compara de verdad: `versionDatos` sube con cada ingesta, y
  // algunas rutas (una accion guardada, un repuntuado) no pasan por `forzar`.
  if (indice && !forzar && indice.versionDatos === versionDatos) return indice
  await abrirAlmacen()
  await Promise.all([accionesIndexadas(), crmIndexado()])
  indice = await construirIndice()
  indice.versionDatos = versionDatos
  return indice
}

const numero = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Traduce los parametros que manda el panel a los filtros del indice. */
function aFiltros(params: ParamsConsulta = {}): FiltrosIndice {
  return {
    ids: params.ids || null,
    q: params.q || '',
    incluir: params.incluir || [],
    excluir: params.excluir || [],
    entidades: params.entidades || null,
    departamentos: params.departamentos || null,
    ciudades: params.ciudades || null,
    modalidades: params.modalidades || null,
    estados: params.estados || null,
    fuentes: params.fuentes || null,
    precioMax: numero(params.precio_max),
    precioMin: numero(params.precio_min),
    soloPorVencer: Boolean(params.solo_por_vencer),
    diasPorVencer: numero(params.dias_por_vencer),
    soloGuardadas: Boolean(params.solo_guardadas),
    acciones: accionesPorId,
    minScore: numero(params.score_min) || null,
  }
}

const ORDENES: Record<string, Orden> = {
  score: 'score',
  fecha: 'fecha',
  precio: 'precio_desc',
  precio_desc: 'precio_desc',
  precio_asc: 'precio',
  cierre: 'cierre',
  entidad: 'entidad',
}

/**
 * Un registro como lo consume `Tarjeta`.
 *
 * Los nombres (`titulo`, `modalidad`, `departamento`, ...) son los del backend, no
 * los de las columnas de SECOP: son los que pintan los componentes. La traduccion
 * va aqui y no mas abajo para que el resto de la pagina no sepa de SECOP.
 */
function aOportunidad(fila: ProcesoLigero & { match?: Match | null }): Oportunidad {
  return {
    id_del_proceso: fila.id_del_proceso,
    titulo: fila.nombre_del_procedimiento || 'Sin titulo',
    entidad: fila.entidad,
    referencia_del_proceso: fila.referencia_del_proceso,
    estado: fila.estado_del_procedimiento,
    modalidad: fila.modalidad_de_contratacion,
    departamento: fila.departamento_entidad,
    ciudad: fila.ciudad_entidad,
    categoria: fila.codigo_principal_categoria,
    lotes: fila.numero_de_lotes,
    precio_base: fila.precio_base,
    fecha_publicacion: fila.fecha_publicacion,
    fecha_apertura_respuesta: fila.fecha_apertura_respuesta,
    dias_restantes: diasHasta(fila.fecha_apertura_respuesta),
    url_proceso: fila.url_proceso ?? null,
    fuente: fila.fuente || 'SECOP II',
    acciones: [...(accionesPorId.get(fila.id_del_proceso) || [])],
    crm: crmPorId.get(fila.id_del_proceso) ?? null,
    match: fila.match ? aMatch(fila.match) : null,
  }
}

/** Las vinetas del formato viejo: una por termino, con su idf. */
const RE_BULLET_VIEJO = /^Perfil: '.*' \(idf [\d.]+\)$/

/**
 * Vinetas para pintar. Los matches guardados antes del 03/11 traen una linea
 * por termino ("Perfil: 'software' (idf 5.47)"), incluidas palabras vacias
 * como "con". Se reescriben aqui en la linea nueva, para que se vean bien sin
 * tener que repuntuar todo el almacen.
 */
function bulletsVisibles(m: Match): string[] {
  const bullets = m.bullets || []
  if (!bullets.some((b) => RE_BULLET_VIEJO.test(b))) return bullets
  const linea = bulletPerfil(m.razones_semanticas || [])
  return [...bullets.filter((b) => !RE_BULLET_VIEJO.test(b)), ...(linea ? [linea] : [])]
}

/** El match con los nombres que pintan `Tarjeta` y `Detalle`. */
function aMatch(m: Match): MatchVista {
  return {
    score: m.score,
    nivel: m.nivel ?? nivelDe(m.score) ?? 'baja',
    componentes: m.componentes ?? null,
    bullets: bulletsVisibles(m),
    rationale: m.razones?.[0] || null,
    matched_keywords: (m.razones_semanticas || []).map((t) => t.termino).filter(esTerminoUtil),
    gaps: (m.penalizaciones || []).map((p) => (p === 'exclusion' ? 'perfil lo excluye' : 'fuera de presupuesto')),
    model: m.componentes ? 'compuesto: objeto, UNSPSC, presupuesto, palabras clave y plazo' : 'tf-idf/coseno (score anterior: repuntúa)',
    semantic_similarity: m.score_semantico,
    scored_at: m.calculado_en,
    penalizaciones: m.penalizaciones || [],
  }
}

/** El proceso completo reducido a lo que necesita el indice ligero. */
function ligeroDe(proceso: Proceso): ProcesoLigero {
  return {
    id_del_proceso: proceso.id_del_proceso,
    nombre_del_procedimiento: proceso.nombre_del_procedimiento,
    referencia_del_proceso: proceso.referencia_del_proceso,
    entidad: proceso.entidad,
    departamento_entidad: proceso.departamento_entidad,
    ciudad_entidad: proceso.ciudad_entidad,
    modalidad_de_contratacion: proceso.modalidad_de_contratacion,
    estado_del_procedimiento: proceso.estado_del_procedimiento,
    codigo_principal_categoria: proceso.codigo_principal_categoria,
    numero_de_lotes: proceso.numero_de_lotes,
    precio_base: proceso.precio_base,
    fecha_publicacion: proceso.fecha_publicacion,
    fecha_apertura_respuesta: proceso.fecha_apertura_respuesta,
    notice_uid: proceso.notice_uid,
    fuente: proceso.fuente || 'SECOP II',
    url_proceso: proceso.url_proceso,
  }
}

/** Los procesos completos, para el indice de texto. */
async function todosLosProcesosCompletos(): Promise<Proceso[]> {
  const out: Proceso[] = []
  await recorrerProcesos((fila) => {
    out.push(fila)
    return true
  })
  return out
}

async function asegurarIndiceCorpus(): Promise<IndiceCorpus> {
  if (!indiceCorpus || indiceCorpus.versionDatos !== versionDatos) {
    const construido = construirIndiceCorpus(await todosLosProcesosCompletos())
    construido.versionDatos = versionDatos
    indiceCorpus = construido
  }
  return indiceCorpus
}

let controlActual: AbortController | null = null
let cayoEnVuelo: Promise<unknown> | null = null

const CLAVE_BUSQUEDAS = 'busquedas_guardadas'

// --- API ---------------------------------------------------------------------

export const api = {
  /**
   * Como el panel lee `salud.estado`, `salud.base_datos` y `salud.ollama`, el
   * chip de la cabecera no necesita cambios: ahora informa del almacen.
   */
  async salud(): Promise<Salud> {
    const resumen = await resumenAlmacen()
    return {
      estado: resumen.persistente ? 'ok' : 'degradado',
      base_datos: resumen.tipo,
      ollama: 'no se usa',
      procesos: resumen.procesos,
      contracts: resumen.contratos,
      scored: resumen.matches,
      cuota: resumen.cuota,
      mensaje: resumen.persistente
        ? null
        : 'Los datos viven solo en memoria: se pierden al cerrar. Abre la pagina con un servidor local (start.ps1).',
    }
  },

  /** Las mismas claves que consume la cabecera del panel. */
  async estadisticas(): Promise<Estadisticas> {
    const ind = await asegurarIndice()
    const resumen = await resumenAlmacen()
    let suma = 0
    let n = 0
    let alto = 0
    let newest: string | null = null
    for (const m of ind.matches.values()) {
      const s = Number(m.score) || 0
      suma += s
      n += 1
      if (s >= CORTE_ALTO) alto += 1
    }
    for (const p of ind.procesos) {
      if (p.fecha_publicacion && (!newest || p.fecha_publicacion > newest)) newest = p.fecha_publicacion
    }
    return {
      tenders: ind.procesos.length,
      scored: n,
      contracts: resumen.contratos,
      avg_score: n ? Math.round((suma / n) * 10) / 10 : null,
      high_matches: alto,
      newest_tender_at: newest,
      promedio_dias_publicados: null,
    }
  },

  async perfil(): Promise<Perfil> {
    return { ...(await perfil()) }
  },

  /** Guarda el perfil editado. Lo consume el panel de perfil. */
  async guardarPerfil(bruto: PerfilBruto): Promise<Perfil> {
    const limpio = normalizarPerfil(bruto)
    limpio.actualizado_en = new Date().toISOString()
    await escribirMeta('perfil', limpio)
    perfilActual = limpio
    return { ...limpio }
  },

  /**
   * Facetas para los desplegables. Calcularlas es una pasada por el indice, no
   * una consulta.
   */
  async facetas(params: ParamsConsulta = {}): Promise<Facetas> {
    const ind = await asegurarIndice()
    const fac = ind.facetas(ind.filtrar(aFiltros(params)))
    const limite = Number(params.limite) || 30
    return {
      departamentos: fac.departamentos.slice(0, limite),
      ciudades: fac.ciudades.slice(0, limite),
      modalidades: fac.modalidades.slice(0, limite),
      entidades: fac.entidades.slice(0, limite),
      estados: fac.estados.slice(0, limite),
      fuentes: fac.fuentes,
      conPrecio: fac.conPrecio,
      total: fac.total,
    }
  },

  /** La lista del panel: `{items, total}`. */
  async licitaciones(params: ParamsConsulta = {}): Promise<PaginaOportunidades> {
    const ind = await asegurarIndice()
    const res = ind.consultar(aFiltros(params), {
      limite: Number(params.limit) || 24,
      offset: Number(params.offset) || 0,
      orden: ORDENES[params.orden || 'score'] || 'score',
    })
    return {
      items: res.pagina.map((fila: FilaIndice) => aOportunidad(fila)),
      total: res.total,
      offset: res.offset,
      limit: res.limite,
      ms: res.ms,
    }
  },

  /**
   * TODAS las que pasan los filtros, en el orden de la lista: es lo que se
   * exporta. Tope de 50.000 para no colgar la pestana armando un PDF imposible.
   */
  async licitacionesParaExportar(params: ParamsConsulta = {}): Promise<Oportunidad[]> {
    const ind = await asegurarIndice()
    const res = ind.consultar(aFiltros(params), {
      limite: 50_000,
      offset: 0,
      orden: ORDENES[params.orden || 'score'] || 'score',
    })
    return res.pagina.map((fila) => aOportunidad(fila))
  },

  /** Ficha completa: proceso, match, OCDS, contratos, acciones y CRM. */
  async detalle(id: string): Promise<Detalle> {
    const proceso = await obtenerProceso(id)
    if (!proceso) throw new ApiError(`No hay ninguna licitacion con id ${id} en este navegador`, 404)
    // El indice se pide aqui: abrir la ficha puede ser lo primero que hace el
    // panel, antes de que la lista lo haya construido.
    const ind = await asegurarIndice()
    const match = ind.matches.get(id) || null
    const [contratos, acciones, crm] = await Promise.all([
      contratosDeProceso(id, 5),
      accionesDe(id),
      obtenerTarjetaCRM(id),
    ])
    return {
      licitacion: {
        ...aOportunidad({ ...ligeroDe(proceso), match: null }),
        descripcion: proceso.descripcion || null,
        objeto_contrato: proceso.objeto_contrato || null,
        justificacion_modalidad: proceso.justificacion_modalidad || null,
        nit_entidad: proceso.nit_entidad || null,
        duracion: proceso.duracion,
        unidad_de_duracion: proceso.unidad_de_duracion || null,
        tipo_contrato: proceso.tipo_contrato || null,
      },
      match: match ? aMatch(match) : null,
      ocds: tenderToOcds(proceso),
      contratos: contratos.map((c: Contrato) => ({
        id_contrato: c.id_contrato,
        proveedor: c.proveedor_adjudicado,
        valor: c.valor_del_contrato,
        valor_pagado: c.valor_pagado,
        fecha_firma: c.fecha_de_firma,
        estado: c.estado_contrato,
        es_pyme: c.es_pyme,
        ocds: contractToOcds(c),
      })),
      acciones,
      crm,
    }
  },

  /**
   * Busca en datos.gov.co sin limite de fechas, guarda y puntua lo encontrado.
   * La lista lo enseña despues pidiendo `licitaciones({ ids })`.
   *
   * Cliente propio y mas impaciente que el de la descarga: alguien esta mirando
   * la pantalla esperando, y cuatro reintentos de 90 s no son una respuesta.
   */
  async buscarEnSecop(texto: string, signal?: AbortSignal | null): Promise<ResultadoBusquedaRemota> {
    const c = await configuracionActual()
    const p = await perfil()
    const clienteBusqueda = new SocrataClient({ ...c, timeoutMs: 45_000, maxRetries: 2 })
    const res = await buscarEnSecop(texto, { cliente: clienteBusqueda, cfg: c, perfil: p, signal })
    if (res.ids.length) {
      // Entraron procesos y scores: el indice en memoria ya no vale.
      versionDatos += 1
      indiceCorpus = null
    }
    return res
  },

  /** Resumen de requisitos juridicos, financieros y tecnicos del proceso. */
  async resumenPliego(id: string): Promise<ResumenPliego> {
    const proceso = await obtenerProceso(id)
    if (!proceso) throw new ApiError(`No hay ninguna licitacion con id ${id} en este navegador`, 404)
    return resumirPliego(proceso)
  },

  /**
   * Similares por coseno de TF-IDF.
   *
   * Aqui se construye el indice de texto del corpus entero, que son unos segundos
   * la primera vez; se cachea hasta que entren datos nuevos.
   */
  async similares(id: string, limite = 5): Promise<{ items: Similar[] }> {
    const ind = await asegurarIndice()
    const proceso = await obtenerProceso(id)
    if (!proceso) return { items: [] }

    const corpus = await asegurarIndiceCorpus()
    const posicion = corpus.docs.findIndex((d) => d.id === id)
    if (posicion < 0) return { items: [] }

    const doc = corpus.docs[posicion]!
    // El propio proceso se usa como "consulta": sus terminos contra el indice.
    const consulta = vectorizarPerfil(textoFicha(doc.proceso), corpus.idf)

    const out: { i: number; similitud: number }[] = []
    for (let i = 0; i < corpus.docs.length; i++) {
      if (i === posicion) continue
      const s = cosenoContraDoc(consulta, corpus, i)
      if (s > 0.02) out.push({ i, similitud: Math.round(s * 1000) / 1000 })
    }
    out.sort((a, b) => b.similitud - a.similitud)
    return {
      items: out.slice(0, limite).map((x) => ({
        oportunidad: aOportunidad(ind.filaDe(ligeroDe(corpus.docs[x.i]!.proceso))),
        similitud: x.similitud,
      })),
    }
  },

  /**
   * `guardar` / `ocultar` / `descartar` / `restaurar`.
   *
   * `restaurar` borra las tres, que es lo que hacia el endpoint. Se devuelven las
   * acciones resultantes porque `Oportunidades` las pinta como botones activos.
   */
  async accion(id: string, accion: TipoAccion | 'restaurar', nota: string | null = null): Promise<Accion[]> {
    if (accion === 'restaurar') {
      await borrarAccionesDe([id], ['guardar', 'ocultar', 'descartar'])
    } else {
      await ponerAccion({ tender_id: id, accion, nota })
    }
    await accionesIndexadas()
    return accionesDe(id)
  },

  /** Recalcula el score de una sola ficha. */
  async recalcular(id: string): Promise<MatchVista> {
    const proceso = await obtenerProceso(id)
    if (!proceso) throw new ApiError(`No hay ninguna licitacion con id ${id}`, 404)
    const p = await perfil()
    const c = await configuracionActual()

    const corpus = await asegurarIndiceCorpus()
    const posicion = corpus.docs.findIndex((d) => d.id === id)
    if (posicion < 0) throw new ApiError('El proceso no esta en el indice de texto', 404)

    const match = puntuarProceso({
      proceso,
      ficha: {
        id,
        text: textoFicha(proceso),
        modalidad: proceso.modalidad_de_contratacion,
        departamento: proceso.departamento_entidad,
        precio: proceso.precio_base,
        ya_accion: [...(accionesPorId.get(id) || [])][0] || null,
      },
      vector: vectorizarPerfil(p, corpus.idf),
      indice: corpus,
      indicePos: posicion,
      perfil: p,
      pesos: c.pesos,
      banda: { floor: c.simFloor, ceil: c.simCeil },
    })
    await guardarMatches([match])
    if (indice) indice.matches.set(id, match)
    return aMatch(match)
  },

  // --- CRM (tablero Kanban) ---------------------------------------------------

  async tablero(): Promise<TarjetaCRM[]> {
    const tarjetas = await todasLasTarjetasCRM()
    return tarjetas.sort((a, b) => b.actualizado_en.localeCompare(a.actualizado_en))
  },

  /**
   * Pone una oportunidad en una columna del tablero (o la mueve). Copia lo
   * minimo del proceso para que el tablero se pinte sin abrir cada ficha.
   */
  async moverCRM(id: string, estado: EstadoCRM): Promise<TarjetaCRM> {
    const ahora = new Date().toISOString()
    const previa = await obtenerTarjetaCRM(id)
    let tarjeta: TarjetaCRM
    if (previa) {
      tarjeta = { ...previa, estado, actualizado_en: ahora }
    } else {
      const proceso = await obtenerProceso(id)
      if (!proceso) throw new ApiError(`No hay ninguna licitacion con id ${id} en este navegador`, 404)
      const ind = await asegurarIndice()
      tarjeta = {
        tender_id: id,
        estado,
        nota: '',
        titulo: proceso.nombre_del_procedimiento || 'Sin titulo',
        entidad: proceso.entidad,
        precio_base: proceso.precio_base,
        fecha_cierre: proceso.fecha_apertura_respuesta,
        url_proceso: proceso.url_proceso,
        score: ind.scoreDe(id),
        creado_en: ahora,
        actualizado_en: ahora,
      }
    }
    await guardarTarjetaCRM(tarjeta)
    crmPorId.set(id, estado)
    return tarjeta
  },

  async notaCRM(id: string, nota: string): Promise<TarjetaCRM> {
    const previa = await obtenerTarjetaCRM(id)
    if (!previa) throw new ApiError('La oportunidad no esta en el tablero', 404)
    return guardarTarjetaCRM({ ...previa, nota, actualizado_en: new Date().toISOString() })
  },

  async quitarCRM(id: string): Promise<{ ok: true }> {
    await borrarTarjetaCRM(id)
    crmPorId.delete(id)
    return { ok: true }
  },

  // --- busquedas guardadas ------------------------------------------------------

  /**
   * Las busquedas guardadas son de este navegador: no hay cuentas porque el
   * panel no tiene servidor, asi que "por usuario" es "por navegador". Viven en
   * `meta`, que el respaldo NDJSON no exporta, y la UI lo dice.
   */
  async busquedasGuardadas(): Promise<BusquedaGuardada[]> {
    return leerMeta<BusquedaGuardada[]>(CLAVE_BUSQUEDAS, [])
  },

  async guardarBusqueda(nombre: string, filtros: FiltrosUI): Promise<BusquedaGuardada[]> {
    const limpio = nombre.trim()
    if (!limpio) throw new ApiError('La busqueda necesita un nombre', 400)
    const actuales = await leerMeta<BusquedaGuardada[]>(CLAVE_BUSQUEDAS, [])
    // Mismo nombre = se sobrescribe, que es lo que se espera al "guardar otra vez".
    const resto = actuales.filter((b) => b.nombre.toLowerCase() !== limpio.toLowerCase())
    const nueva: BusquedaGuardada = {
      id: `b-${Date.now().toString(36)}`,
      nombre: limpio,
      filtros: { ...filtros },
      creada_en: new Date().toISOString(),
    }
    return escribirMeta(CLAVE_BUSQUEDAS, [nueva, ...resto])
  },

  async borrarBusqueda(id: string): Promise<BusquedaGuardada[]> {
    const actuales = await leerMeta<BusquedaGuardada[]>(CLAVE_BUSQUEDAS, [])
    return escribirMeta(
      CLAVE_BUSQUEDAS,
      actuales.filter((b) => b.id !== id),
    )
  },

  // --- alertas ----------------------------------------------------------------

  async alertas(): Promise<Alerta[]> {
    return leerAlertas()
  },

  async marcarAlertasLeidas(ids: string[] | null = null): Promise<Alerta[]> {
    return marcarLeidas(ids)
  },

  async borrarAlertas(): Promise<Alerta[]> {
    return borrarAlertas()
  },

  // --- descarga ---------------------------------------------------------------

  /**
   * Estado de la ingesta, con la forma que el sincronizador ya sabe leer
   * (`en_curso`, `ultimo`, `proximo`, `cron_activo`, `alerta`).
   */
  async estadoSync(): Promise<EstadoSync> {
    const memoria = estadoIngesta()
    const progreso = await leerMeta<Partial<ReturnType<typeof estadoIngesta>> | null>('progreso_sync', null)
    const resumen = await leerMeta<ResumenSync | null>('ultima_sync_resumen', null)
    const ultima = await leerMeta<string | null>('ultima_sync', null)

    // El estado de la ingesta en memoria solo cubre ESTA pestana: al recargar,
    // el modulo arranca de cero y el error de la descarga que acaba de fallar
    // desaparecia, dejando la pagina vacia sin explicacion. El progreso ya se
    // persiste en cada pagina (y al fallar y al cancelar), asi que hay que
    // leerlo: una descarga fallida tiene que seguir viendose despues de
    // recargar, que es justo cuando mas vacia se ve la pagina.
    const enMemoria = memoria.corriendo || Boolean(memoria.fase)
    const e = enMemoria ? memoria : { ...memoria, ...(progreso || {}) }
    // Fases con las que un ciclo termina. Si lo persistido sigue en una fase
    // intermedia, la pestana se cerro o recargo en mitad de la descarga.
    const FINES: FaseIngesta[] = ['listo', 'cancelado', 'error', 'repuntuado']
    const interrumpida = !enMemoria && Boolean(progreso?.fase) && !FINES.includes(progreso!.fase as FaseIngesta)

    return {
      en_curso: Boolean(e.corriendo),
      fase: interrumpida ? 'interrumpida' : e.fase || null,
      hechos: e.hechos || 0,
      total: e.total || 0,
      nuevas: e.nuevas || 0,
      repetidas: e.repetidas || 0,
      enlazados: e.enlazados || 0,
      puntuados: e.puntuados || 0,
      error: e.error || null,
      iniciado: e.iniciada || null,
      cron_activo: true,
      proximo: null,
      ultimo: ultima
        ? {
            status: e.error ? 'error' : 'ok',
            started_at: ultima,
            finished_at: e.terminada || null,
            rows_inserted: e.nuevas || 0,
            rows_updated: e.actualizadas || 0,
            error: e.error || null,
            resumen: resumen || null,
          }
        : null,
      alerta: null,
    }
  },

  /**
   * Lanza la ingesta y devuelve enseguida.
   *
   * El panel no espera: lanza, y el sincronizador sigue el progreso por
   * suscripcion. La promesa se guarda en `cayoEnVuelo` para poder cancelarla y
   * para que los tests puedan esperarla.
   */
  async sincronizar(params: { modo?: ModoVentana; solo_procesos?: boolean } = {}): Promise<Lanzamiento> {
    const c = await configuracionActual()
    await perfil()
    if (estadoIngesta().corriendo) return { lanzado: false, mensaje: 'Ya hay una descarga en curso' }

    const control = new AbortController()
    controlActual = control
    cayoEnVuelo = sincronizar({
      cliente: clienteSocrata(),
      config: c,
      perfil: perfilActual,
      modo: params.modo || 'lookback',
      soloProcesos: Boolean(params.solo_procesos),
      signal: control.signal,
      // Los totales del panel cambiaron, asi que hay que rehacer el indice. Va
      // en `alListo` y no en un `.then` de aqui, porque el evento `listo` lo
      // consume el panel para recargar la lista, y tiene que encontrar el indice
      // ya al dia: si se recarga contra el anterior, ve cero filas y se queda
      // asi hasta que se pulse "Actualizar".
      alListo: async () => {
        versionDatos += 1
        await asegurarIndice({ forzar: true })
        indiceCorpus = null
      },
    })
      .catch((error: unknown) => {
        // Un fallo de red no debe tumbar el panel: se refleja en `estadoSync`.
        console.error('sincronizar:', error)
        return { error: error instanceof Error ? error.message : String(error) }
      })
      .finally(() => {
        if (controlActual === control) controlActual = null
      })

    return { lanzado: true, mensaje: 'Descarga lanzada en esta pestana' }
  },

  /** Cancela la ingesta en curso. El backend no tenia equivalente. */
  async cancelarSync(): Promise<{ cancelado: boolean }> {
    if (!controlActual) return { cancelado: false }
    controlActual.abort()
    return { cancelado: true }
  },

  /** Cuantos hay en cada nivel del semaforo. */
  async scoreCortes(): Promise<ResumenScores> {
    const ind = await asegurarIndice()
    return resumenPuntuacion(ind.matches)
  },

  /** Repuntua todo lo almacenado. Operacion larga y explicita. */
  async repuntuar(): Promise<Lanzamiento> {
    const c = await configuracionActual()
    const p = await perfil()
    const control = new AbortController()
    controlActual = control
    cayoEnVuelo = repuntuarTodo({ perfil: p, cfg: c, signal: control.signal })
      .then((res) => {
        versionDatos += 1
        indice = res.indice
        // Sin esto, el chequeo de version de `asegurarIndice` lo daria por viejo en
        // la siguiente consulta y releeria las 118.000 filas ligeras de nuevo.
        indice.versionDatos = versionDatos
        indiceCorpus = null
        return res
      })
      .catch((error: unknown) => {
        console.error('repuntuar:', error)
        return null
      })
      .finally(() => {
        if (controlActual === control) controlActual = null
      })
    return { lanzado: true }
  },

  /** Configuracion editable desde el panel. */
  async configuracion(): Promise<Config> {
    return { ...(await configuracionActual()) }
  },

  async guardarConfig(parcial: Partial<Config>): Promise<Config> {
    cfg = guardarConfig(parcial)
    // El token y los datasets cambian el cliente, y el pageSize el ritmo.
    cliente = null
    return cfg
  },

  /** Limpia el almacen del navegador entero. */
  async borrarTodo(): Promise<{ ok: true }> {
    await borrarTodo()
    indice = null
    indiceCorpus = null
    accionesPorId = new Map()
    crmPorId = new Map()
    perfilActual = null
    versionDatos += 1
    return { ok: true }
  },

  /**
   * Olvida lo cacheado, sin borrar nada.
   *
   * Lo necesita quien escriba en el almacen por fuera de la ingesta: importar un
   * NDJSON. Sin esto, el indice en memoria seguiria siendo el anterior y el panel
   * pintaria los datos de antes de importar aunque se recargue la lista.
   */
  async invalidarCache(): Promise<{ ok: true }> {
    indice = null
    indiceCorpus = null
    accionesPorId = new Map()
    crmPorId = new Map()
    versionDatos += 1
    return { ok: true }
  },
}

export type Api = typeof api

/** La promesa de la ingesta en curso, para esperar a que termine en los tests. */
export function ingestaEnVuelo(): Promise<unknown> | null {
  return cayoEnVuelo
}
