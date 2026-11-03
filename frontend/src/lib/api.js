/**
 * Fachada local de la API.
 *
 * Antes esto era `fetch` a `http://localhost:8000/api`. Ahora cada metodo
 * resuelve contra el almacen del navegador. Se conserva la MISMA superficie de
 * metodos y las mismas formas de respuesta (`{items, total}`, `{licitacion, match,
 * ocds, contratos, acciones}`, ...) para que `Oportunidades.jsx`, `Tarjeta`,
 * `Detalle`, `PanelFiltros` y `EstadoSync` no-tuvieran que cambiar. Si algun dia
 * se quiere volver al backend, esta fachada es el unico punto que tocaria.
 *
 * Lo que cambia de verdad:
 *
 *   - `salud()` ya no puede decir "ollama ok": no hay ni servidor ni modelo. Dice
 *     como esta el almacen del navegador, que es la unica cosa que puede fallar.
 *   - `sincronizar()` devuelve enseguida y la ingesta sigue en la propia pestana.
 *     El panel sigue consultando `estadoSync()` cada 4 s, asi que la interfaz no
 *     cambia; lo que cambia es que se puede cancelar, cosa que con el backend en
 *     segundo plano no se podia.
 *   - `procesarLicitaciones()` calcula el indice la primera vez que se llama, a
 *     partir de lo que haya en IndexedDB, y lo reutiliza hasta que hay una
 *     ingesta nueva.
 */

import { config as leerConfig, guardarConfig } from './config'
import {
  abrirAlmacen,
  accionesDe,
  borrarAccionesDe,
  borrarTodo,
  contratosDeProceso,
  guardarMatches,
  escribirMeta,
  leerMeta,
  obtenerProceso,
  ponerAccion,
  resumenAlmacen,
  todasLasAcciones,
} from './db'
import { construirIndice } from './indice'
import { estadoIngesta, repuntuarTodo, sincronizar } from './ingesta'
import { contractToOcds, tenderToOcds } from './ocds'
import { normalizarPerfil, PERFIL_POR_DEFECTO } from './perfil'
import {
  construirIndiceCorpus,
  cosenoContraDoc,
  puntuarProceso,
  resumenPuntuacion,
  vectorizarPerfil,
} from './score'
import { SocrataClient } from './socrata'
import { textoFicha } from './texto'

class ApiError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// --- estado de la pagina -----------------------------------------------------

let indice = null
let perfilActual = null
let accionesPorId = new Map()
let cfg = null
let cliente = null
/** El indice de texto del corpus, para "similares". Se construye una sola vez. */
let indiceCorpus = null
/** Se sube con cada ingesta para invalidar lo que este cacheado. */
let versionDatos = 0

const clienteSocrata = () => {
  if (!cliente) cliente = new SocrataClient(cfg)
  return cliente
}

/** Perfil: primero el del almacen, y si no hay, el de ejemplo. */
async function perfil() {
  if (perfilActual) return perfilActual
  const guardado = await leerMeta('perfil', null)
  perfilActual = guardado ? normalizarPerfil(guardado) : { ...PERFIL_POR_DEFECTO }
  return perfilActual
}

async function accionesIndexadas() {
  const todas = await todasLasAcciones()
  const mapa = new Map()
  for (const a of todas) {
    if (!mapa.has(a.tender_id)) mapa.set(a.tender_id, new Set())
    mapa.get(a.tender_id).add(a.accion)
  }
  accionesPorId = mapa
  return mapa
}

/**
 * El indice de consulta, construido una vez.
 *
 * Se reconstruye cuando `versionDatos` ha cambiado (tras una ingesta o un
 * repuntuado) o cuando no existe. Sin este cache, cada cambio de filtro
 * releeria las 118.000 filas ligeras de IndexedDB, que son segundos por pulsación.
 */
async function asegurarIndice({ forzar = false } = {}) {
  if (!cfg) cfg = await leerConfig()
  // La version se compara de verdad: `versionDatos` sube con cada ingesta, y
  // algunas rutas (una accion guardada, un repuntuado) no pasan por `forzar`.
  if (indice && !forzar && indice.versionDatos === versionDatos) return indice
  await abrirAlmacen()
  await accionesIndexadas()
  indice = await construirIndice()
  indice.versionDatos = versionDatos
  return indice
}

/** Traduce los parametros que manda el panel a los filtros del indice. */
function aFiltros(params = {}) {
  const numero = (v) => {
    if (v === undefined || v === null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return {
    q: params.q || '',
    entidades: params.entidades || null,
    departamentos: params.departamentos || null,
    modalidades: params.modalidades || null,
    precioMax: numero(params.precio_max),
    precioMin: numero(params.precio_min),
    soloPorVencer: Boolean(params.solo_por_vencer),
    diasPorVencer: numero(params.dias_por_vencer),
    soloGuardadas: Boolean(params.solo_guardadas),
    acciones: accionesPorId,
    minScore: numero(params.score_min) || null,
  }
}

const ORDEN = { score: 'score', fecha: 'fecha', precio: 'precio_desc', cierre: 'cierre' }

/**
 * Un registro como lo consume `Tarjeta`.
 *
 * Los nombres (`titulo`, `modalidad`, `departamento`, ...) son los del backend, no
 * los de las columnas de SECOP: son los que pintan los componentes. La traduccion
 * va aqui y no mas abajo para que el resto de la pagina no sepa de SECOP.
 */
function aOportunidad(fila) {
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
    dias_restantes: diasRestantes(fila.fecha_apertura_respuesta),
    url_proceso: fila.url_proceso,
    acciones: [...(accionesPorId.get(fila.id_del_proceso) || [])],
    match: fila.match ? aMatch(fila.match) : null,
  }
}

function diasRestantes(fecha) {
  if (!fecha) return null
  const ms = Date.parse(fecha)
  if (Number.isNaN(ms)) return null
  return Math.ceil((ms - Date.now()) / 86400000)
}

/** El match con los nombres del backend, para `Tarjeta` y `Detalle`. */
function aMatch(m) {
  return {
    score: m.score,
    bullets: m.bullets || [],
    rationale: m.razones?.[0] || null,
    matched_keywords: (m.razones_semanticas || []).map((t) => t.termino),
    gaps: (m.penalizaciones || []).map((p) => (p === 'exclusion' ? 'perfil lo excluye' : 'fuera de presupuesto')),
    model: `tf-idf/coseno (banda ${m.peso_semantico ?? '—'})`,
    semantic_similarity: m.score_semantico,
    scored_at: m.calculado_en,
    penalizaciones: m.penalizaciones || [],
  }
}

/** `perfil`, con los mismos campos que el backend devolvia. */
function aPerfil(p) {
  return {
    nombre: p.nombre,
    descripcion: p.descripcion,
    actividades: p.actividades,
    palabras_clave: p.palabras_clave,
    modalidades_preferidas: p.modalidades_preferidas,
    exclusiones: p.exclusiones,
    departamentos_preferidos: p.departamentos_preferidos,
    presupuesto_minimo: p.presupuesto_minimo,
    presupuesto_maximo: p.presupuesto_maximo,
    version: p.version,
    activo: p.activo,
    actualizado_en: p.actualizado_en || null,
  }
}

// --- API ---------------------------------------------------------------------

export const api = {
  /**
   * Como el panel lee `salud.estado`, `salud.base_datos` y `salud.ollama`, el
   * chip de la cabecera no necesita cambios: ahora informa del almacen.
   */
  async salud() {
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
  async estadisticas() {
    const ind = await asegurarIndice()
    const resumen = await resumenAlmacen()
    let suma = 0
    let n = 0
    let alto = 0
    let newest = null
    for (const m of ind.matches.values()) {
      suma += Number(m.score) || 0
      n += 1
      if ((Number(m.score) || 0) >= 75) alto += 1
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

  async scheduler() {
    return { activo: false, tarea: null, intervalo_horas: null, motivo: 'el panel no programa tareas' }
  },

  async perfil() {
    return aPerfil(await perfil())
  },

  /** Guarda el perfil editado. Lo consume el panel de perfil. */
  async guardarPerfil(bruto) {
    const limpio = normalizarPerfil(bruto)
    limpio.actualizado_en = new Date().toISOString()
    await escribirMeta('perfil', limpio)
    perfilActual = limpio
    return aPerfil(limpio)
  },

  /**
   * Facetas para los desplegables. Solo las tres que pinta `PanelFiltros`;
   * calcularlas es una pasada por el indice, no una consulta.
   */
  async facetas(params = {}) {
    const ind = await asegurarIndice()
    const f = aFiltros(params)
    const fac = ind.facetas(ind.filtrar(f))
    const limite = Number(params.limite) || 30
    return {
      departamentos: fac.departamentos.slice(0, limite),
      modalidades: fac.modalidades.slice(0, limite),
      entidades: fac.entidades.slice(0, limite),
      estados: fac.estados.slice(0, limite),
      conPrecio: fac.conPrecio,
      total: fac.total,
    }
  },

  /** La lista del panel: `{items, total}`. */
  async licitaciones(params = {}) {
    const ind = await asegurarIndice()
    const res = ind.consultar(aFiltros(params), {
      limite: Number(params.limit) || 24,
      offset: Number(params.offset) || 0,
      orden: ORDEN[params.orden] || 'score',
    })
    return {
      items: res.pagina.map((fila) => aOportunidad(fila)),
      total: res.total,
      offset: res.offset,
      limit: res.limite,
      ms: res.ms,
    }
  },

  /** Ficha completa: proceso, match, OCDS, contratos y acciones. */
  async detalle(id) {
    const proceso = await obtenerProceso(id)
    if (!proceso) throw new ApiError(`No hay ninguna licitacion con id ${id} en este navegador`, 404)
    // El indice se pide aqui y no con `ind()`: abrir la ficha puede ser lo
    // primero que hace el panel, y `ind()` lanzaba 409 si aun no se habia
    // construido (indice null hasta la primera consulta de la lista).
    const ind = await asegurarIndice()
    const match = ind.matches.get(id) || null
    const [contratos, acciones] = await Promise.all([contratosDeProceso(id, 5), accionesDe(id)])
    return {
      licitacion: {
        ...aOportunidad({ ...ligeroDe(proceso), match: null }),
        descripcion: proceso.descripcion || null,
        objeto_contrato: proceso.objeto_contrato || null,
        justificacion_modalidad: proceso.justificacion_modalidad || null,
        nit_entidad: proceso.nit_entidad || null,
        duracion: proceso.duracion,
        unidad_de_duracion: proceso.unidad_de_duracion || null,
      },
      match: match ? aMatch(match) : null,
      ocds: tenderToOcds(proceso),
      contratos: contratos.map((c) => ({
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
    }
  },

  /**
   * Similares por coseno de TF-IDF.
   *
   * Aqui se construye el indice de texto del corpus entero, que son unos segundos
   * la primera vez; se cachea hasta que entren datos nuevos. Antes era una query
   * a PostgreSQL con `pgvector`, y era instantanea, pero a cambio de un servidor y
   * ~1 GB de RAM para el modelo.
   */
  async similares(id, limite = 5) {
    const ind = await asegurarIndice()
    const proceso = await obtenerProceso(id)
    if (!proceso) return { items: [] }

    if (!indiceCorpus || indiceCorpus.versionDatos !== versionDatos) {
      const completos = await todosLosProcesosCompletos()
      const construido = construirIndiceCorpus(completos)
      construido.versionDatos = versionDatos
      indiceCorpus = construido
    }

    const posicion = indiceCorpus.docs.findIndex((d) => d.id === id)
    if (posicion < 0) return { items: [] }

    const doc = indiceCorpus.docs[posicion]
    // El propio proceso se usa como "consulta": sus terminos contra el indice.
    const consulta = vectorizarPerfil(textoFicha(doc.proceso), indiceCorpus.idf)

    const out = []
    for (let i = 0; i < indiceCorpus.docs.length; i++) {
      if (i === posicion) continue
      const s = cosenoContraDoc(consulta, indiceCorpus, i)
      if (s > 0.02) out.push({ i, similitud: Math.round(s * 1000) / 1000 })
    }
    out.sort((a, b) => b.similitud - a.similitud)
    return {
      items: out.slice(0, limite).map((x) => ({
        oportunidad: aOportunidad(ind.filaDe(indiceCorpus.docs[x.i].proceso)),
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
  async accion(id, accion, nota = null) {
    if (accion === 'restaurar') {
      await borrarAccionesDe([id], ['guardar', 'ocultar', 'descartar'])
    } else {
      await ponerAccion({ tender_id: id, accion, nota })
    }
    await accionesIndexadas()
    return accionesDe(id)
  },

  /** Recalcula el score de una sola ficha. */
  async recalcular(id) {
    const proceso = await obtenerProceso(id)
    if (!profilActual) await perfil()
    if (!proceso) throw new ApiError(`No hay ninguna licitacion con id ${id}`, 404)

    if (!indiceCorpus || indiceCorpus.versionDatos !== versionDatos) {
      indiceCorpus = construirIndiceCorpus(await todosLosProcesosCompletos())
      indiceCorpus.versionDatos = versionDatos
    }
    const posicion = indiceCorpus.docs.findIndex((d) => d.id === id)
    if (posicion < 0) throw new ApiError('El proceso no esta en el indice de texto', 404)

    const vector = vectorizarPerfil(await perfil(), indiceCorpus.idf)
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
      vector,
      indice: indiceCorpus,
      indicePos: posicion,
      perfil: await perfil(),
      peso: cfg?.semanticWeight ?? 0.35,
      banda: { floor: cfg?.simFloor, ceil: cfg?.simCeil },
    })
    await guardarMatches([match])
    if (indice) indice.matches.set(id, match)
    return aMatch(match)
  },

  /**
   * Estado de la ingesta, con la forma que `EstadoSync` ya sabe leer
   * (`en_curso`, `ultimo`, `proximo`, `cron_activo`, `alerta`).
   */
  async estadoSync() {
    const memoria = estadoIngesta()
    const progreso = await leerMeta('progreso_sync', null)
    const resumen = await leerMeta('ultima_sync_resumen', null)
    const ultima = await leerMeta('ultima_sync', null)

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
    const FINES = ['listo', 'cancelado', 'error', 'repuntuado']
    const interrumpida = !enMemoria && progreso?.fase && !FINES.includes(progreso.fase)

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
      // `cron_activo: false` es lo que hace que el componente legacy pinte el
      // chip rojo de "cron desactivado". Aqui no hay cron que activar, asi que se
      // informa distinto mas abajo; el componente se reescribe en el mismo cambio.
      cron_activo: true,
      proximo: null,
      ultimo: ultima
        ? {
            status: e.error ? 'error' : 'ok',
            started_at: ultima,
            finished_at: e.terminada,
            rows_inserted: e.nuevas,
            rows_updated: e.actualizadas,
            error: e.error,
            resumen: resumen || null,
          }
        : null,
      alerta: null,
    }
  },

  /**
   * Lanza la ingesta y devuelve enseguida.
   *
   * El panel no espera: lanza, y luego `EstadoSync` va leyendo `estadoSync()` cada
   * 4 s. La promesa se guarda en `cayoEnVuelo` para poder cancelarla y para que
   * `cancelarSync()` sepa a quien llamar.
   */
  async sincronizar(params = {}) {
    if (!cfg) cfg = await leerConfig()
    await perfil()
    if (estadoIngesta().corriendo) return { lanzado: false, mensaje: 'Ya hay una descarga en curso' }

    const control = new AbortController()
    controlActual = control
    cayoEnVuelo = sincronizar({
      cliente: clienteSocrata(),
      config: cfg,
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
      .catch((error) => {
        // Un fallo de red no debe tumbar el panel: se refleja en `estadoSync`.
        console.error('sincronizar:', error)
        return { error: String(error?.message || error) }
      })
      .finally(() => {
        if (controlActual === control) controlActual = null
      })

    return { lanzado: true, mensaje: 'Descarga lanzada en esta pestana' }
  },

  /** Cancela la ingesta en curso. El backend no tenia equivalente. */
  async cancelarSync() {
    if (!controlActual) return { cancelado: false }
    controlActual.abort()
    return { cancelado: true }
  },

  /** Historial de descargas, del `meta` del navegador. */
  async historialSync(limite = 10) {
    const resumen = await leerMeta('ultima_sync_resumen', null)
    const ultima = await leerMeta('ultima_sync', null)
    if (!ultima) return { items: [] }
    return {
      items: [
        {
          started_at: ultima,
          status: estadoIngesta().error ? 'error' : 'ok',
          rows_inserted: estadoIngesta().nuevas,
          rows_updated: estadoIngesta().actualizadas,
          repetidas: estadoIngesta().repetidas,
          resumen,
        },
      ].slice(0, limite),
    }
  },

  /** Puntos hasta las que llega la puntuacion, para pintar el corte del panel. */
  async scoreCortes() {
    const ind = await asegurarIndice()
    return resumenPuntuacion(ind.matches)
  },

  /** Repuntua todo lo almacenado. Operacion larga y explicita. */
  async repuntuar() {
    const cfgLocal = cfg || (await leerConfig())
    const p = await perfil()
    const control = new AbortController()
    controlActual = control
    cayoEnVuelo = repuntuarTodo({ perfil: p, cfg: cfgLocal, signal: control.signal })
      .then((res) => {
        versionDatos += 1
        indice = res.indice
        // Sin esto, el chequeo de version de `asegurarIndice` lo daria por viejo en
        // la siguiente consulta y releeria las 118.000 filas ligeras de nuevo.
        if (indice) indice.versionDatos = versionDatos
        indiceCorpus = null
        return res
      })
      .finally(() => {
        if (controlActual === control) controlActual = null
      })
    return { lanzado: true }
  },

  /** Configuracion editable desde el panel. */
  async configuracion() {
    return { ...(cfg || (await leerConfig())) }
  },

  async guardarConfig(parcial) {
    cfg = guardarConfig(parcial)
    // El token y los datasets cambian el cliente, y el pageSize el ritmo.
    cliente = null
    return cfg
  },

  /** Limpia el almacen del navegador entero. */
  async borrarTodo() {
    await borrarTodo()
    indice = null
    indiceCorpus = null
    accionesPorId = new Map()
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
  async invalidarCache() {
    indice = null
    indiceCorpus = null
    accionesPorId = new Map()
    versionDatos += 1
    return { ok: true }
  },
}

let controlActual = null
let cayoEnVuelo = null

/** La promesa de la ingesta en curso, para esperar a que termine en los tests. */
export function ingestaEnVuelo() {
  return cayoEnVuelo
}

function ind() {
  if (!indice) throw new ApiError('El indice no esta construido todavia', 409)
  return indice
}

/** El proceso completo reducido a lo que necesita el indice ligero. */
function ligeroDe(proceso) {
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
  }
}

/** Los procesos completos, para el indice de texto. */
async function todosLosProcesosCompletos() {
  const almacen = await abrirAlmacen()
  const out = []
  await almacen.recorrer('procesos', (fila) => {
    out.push(fila)
    return true
  })
  return out
}

export { ApiError }