/**
 * Ingesta: baja de Socrata y escribe en el almacen del navegador.
 *
 * Sustituye a `secop_procesos.py` + `secop_contratos.py` + `sync.py`. La
 * diferencia de fondo es donde se escribe: antes era un `INSERT` en PostgreSQL
 * desde un servidor; ahora es un `put` en IndexedDB desde la pestana que esta
 * abierta. No hay nada que apagar ni nada que este corriendo entre sesiones.
 *
 * Lo que en el backend era gratis y aqui hay que hacer a mano:
 *
 *   1. **Deduplicar.** `INSERT ... ON CONFLICT DO UPDATE` fallaba con "ON
 *      CONFLICT DO UPDATE command cannot affect row a second time" cuando una
 *      pagina traia dos veces el mismo id (bug #8). Aqui se deduplica por clave
 *      antes de escribir.
 *   2. **Recortar.** Los anchos de columna de `models.py` venian del schema de
 *      Postgres; se reproducen en `mapper.js`.
 *   3. **Ceder el hilo.** En el servidor no hacia falta porque el proceso no
 *      tenia interfaz. Aqui, entre pagina y pagina, para que la barra de
 *      progreso se mueva y el boton de cancelar responda.
 *
 * El enlazado de contratos con procesos se hace AQUI, en la misma pagina que se
 * acaba de bajar, y no en una pasada posterior. La version anterior recorría las
 * 235.540 filas del almacen para cruzarlas contra los procesos: en el navegador
 * eso son cientos de MB de RAM y justo lo que se queria evitar.
 */

import { config as leerConfig } from './config'
import { construirIndice } from './indice'
import {
  guardarContratos,
  guardarMatches,
  guardarProcesos,
  noticeUidAProceso,
  escribirMeta,
  leerMeta,
  procesosPorIds,
} from './db'
import {
  FECHA_INCREMENTAL_CONTRATOS,
  FECHA_INCREMENTAL_PROCESOS,
  FECHA_ORDEN_PROCESOS,
  SELECT_CONTRATOS,
  SELECT_PROCESOS,
  deduplicar,
  mapearContrato,
  mapearProceso,
} from './mapper'
import { soqlDate } from './socrata'
import { puntuarCorpus } from './score'

const CLAVE_PROGRESO = 'progreso_sync'

/**
 * Estado de la ingesta.
 *
 * Vive fuera del componente de React a proposito: la ingesta tarda minutos y el
 * panel se puede recargar mientras corre. Si esto estuviera en un `useState`, al
 * recargar se perderia el progreso y la descarga seguiria sin poder cancelar.
 * Con `suscribirseIngesta` cualquier parte de la pagina se engancha.
 */
let actual = {
  corriendo: false,
  fase: null,
  dataset: null,
  hechos: 0,
  total: 0,
  nuevas: 0,
  actualizadas: 0,
  repetidas: 0,
  enlazados: 0,
  puntuados: 0,
  iniciada: null,
  terminada: null,
  error: null,
}

const oyentes = new Set()

export function estadoIngesta() {
  return { ...actual }
}

/** Se llama al suscribirse, para pintar el estado actual sin esperar un evento. */
export function suscribirseIngesta(fn) {
  oyentes.add(fn)
  fn(estadoIngesta())
  return () => oyentes.delete(fn)
}

function emitir(parcial) {
  actual = { ...actual, ...parcial }
  const copia = estadoIngesta()
  for (const fn of oyentes) fn(copia)
}

async function persistirProgreso() {
  await escribirMeta(CLAVE_PROGRESO, { ...actual, corriendo: false })
}

class Cancelada extends Error {
  constructor() {
    super('ingesta cancelada')
    this.name = 'AbortError'
  }
}

const dormir = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener?.(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Cancelada())
      },
      { once: true },
    )
  })

/**
 * Ventana de fechas de una pasada.
 *
 * `lookbackDays` por defecto. Con `modo: 'incremental'` se parte de la ultima
 * sincronizacion guardada, solapando un dia. El solape es deliberado: con solo
 * `fecha_de_ultima_publicaci` hay procesos que se republican el mismo dia, y sin
 * holgura se perderian. Un dia de retrabajo sale mas barato que perder
 * oportunidades.
 */
export async function ventanaDeSincronizacion({ modo = 'lookback', lookbackDays = 7, hasta = null } = {}) {
  const fin = hasta ? new Date(hasta) : new Date()
  if (modo === 'incremental') {
    const ultima = await leerMeta('ultima_sync', null)
    if (ultima) {
      const desde = new Date(ultima)
      desde.setUTCDate(desde.getUTCDate() - 1)
      return { desde: desde.toISOString(), hasta: fin.toISOString(), incremental: true }
    }
  }
  const desde = new Date(fin)
  desde.setUTCDate(desde.getUTCDate() - (lookbackDays || 7))
  return { desde: desde.toISOString(), hasta: fin.toISOString(), incremental: false }
}

/** Un `count` primero, para saber cuanto hay y poder pintar una barra real. */
async function contar(cliente, dataset, where, fase, signal, alProgresar) {
  const total = await cliente.count(dataset, where, { signal })
  emitir({ fase, dataset, total, hechos: 0, iniciada: new Date().toISOString() })
  alProgresar?.({ fase, total, hechos: 0 })
  return total
}

/**
 * Baja una dataset pagina a pagina y escribe en el almacen.
 *
 * `resolverProceso` se aplica antes de deduplicar, para que los contratos
 * lleguen ya con su `proceso_id` puesto y no haya que volver a tocarlos.
 */
async function bajar({
  cliente,
  dataset,
  select,
  orden,
  campoFecha,
  desde,
  hasta,
  mapear,
  escribir,
  clave,
  tope,
  fase,
  alProgresar,
  signal,
  resolverProceso,
}) {
  const where = soqlDate(campoFecha, desde, hasta)
  const total = await contar(cliente, dataset, where, fase, signal, alProgresar)
  if (!total) return { leidas: 0, repetidas: 0, nuevas: 0, actualizadas: 0, total: 0, ids: [] }

  const destino = Math.min(total, tope)
  const ids = []
  let nuevas = 0
  let actualizadas = 0
  let repetidas = 0
  let leidas = 0

  await cliente.iterRows(
    { dataset, where, order: orden, select, limit: cliente.pageSize, maxRows: destino },
    {
      signal,
      alPagina: async (filas) => {
        let registros = filas.map(mapear).filter(Boolean)
        if (resolverProceso) registros = await resolverProceso(registros)

        const limpio = deduplicar(registros, clave)
        repetidas += limpio.repetidas
        for (const registro of limpio) ids.push(registro[clave])

        const res = await escribir(limpio)
        nuevas += res.nuevas
        actualizadas += res.actualizadas
        leidas += filas.length

        emitir({ hechos: Math.min(leidas, destino), nuevas, actualizadas, repetidas, total })
        alProgresar?.({ fase, hechos: leidas, total, nuevas, actualizadas, repetidas })

        // Ceder entre paginas: sin esto la pestana no responde durante toda la
        // descarga, que es justo lo que hace que parezca el PC colgado.
        await dormir(0, signal)
      },
    },
  )

  return { leidas, repetidas, nuevas, actualizadas, total, ids }
}

/**
 * Rellena `proceso_id` en los contratos de la pagina, por `notice_uid`.
 *
 * Va por lotes: son 235.540 contratos, y cruzar uno a uno contra los procesos
 * serian 235.540 consultas. `noticeUidAProceso` ya trocea el `notice_uid` en
 * bloques de 400 para no abrir 235.540 cursores.
 */
function makeResolverContratos() {
  return async (contratos) => {
    const uids = contratos.map((c) => c.notice_uid).filter(Boolean)
    if (!uids.length) return contratos
    const mapa = await noticeUidAProceso(uids)
    if (!mapa.size) return contratos
    return contratos.map((c) => {
      const procesoId = c.notice_uid ? mapa.get(c.notice_uid) : null
      return procesoId && !c.proceso_id ? { ...c, proceso_id: procesoId } : c
    })
  }
}

/**
 * Sincronizacion completa: procesos, contratos opcionales y puntuacion.
 *
 * Devuelve el resumen que el panel pinta como "ultima sincronizacion".
 */
export async function sincronizar({
  cliente,
  config = null,
  perfil,
  modo = 'lookback',
  soloProcesos = false,
  signal,
  alProgresar,
  alListo,
}) {
  if (actual.corriendo) throw new Error('ya hay una sincronizacion en curso')
  const cfg = config || (await leerConfig())

  emitir({
    corriendo: true,
    error: null,
    nuevas: 0,
    actualizadas: 0,
    repetidas: 0,
    enlazados: 0,
    puntuados: 0,
  })

  const v = await ventanaDeSincronizacion({ modo, lookbackDays: cfg.lookbackDays })
  const resumen = { ...v, procesos: null, contratos: null, puntuados: null }

  try {
    const resProcesos = await bajar({
      cliente,
      dataset: cfg.datasetProcesos,
      select: SELECT_PROCESOS,
      orden: `${FECHA_ORDEN_PROCESOS} DESC`,
      campoFecha: FECHA_INCREMENTAL_PROCESOS,
      desde: v.desde,
      hasta: v.hasta,
      mapear: mapearProceso,
      escribir: guardarProcesos,
      clave: 'id_del_proceso',
      tope: cfg.maxProcesos,
      fase: 'procesos',
      alProgresar,
      signal,
    })
    resumen.procesos = { ...resProcesos, ids: undefined }
    await persistirProgreso()

    if (cfg.includeContracts && !soloProcesos) {
      const resolver = makeResolverContratos()
      let enlazados = 0
      const resContratos = await bajar({
        cliente,
        dataset: cfg.datasetContratos,
        select: SELECT_CONTRATOS,
        orden: `${FECHA_INCREMENTAL_CONTRATOS} DESC`,
        campoFecha: FECHA_INCREMENTAL_CONTRATOS,
        desde: v.desde,
        hasta: v.hasta,
        mapear: mapearContrato,
        escribir: guardarContratos,
        clave: 'id_contrato',
        tope: cfg.maxContratos,
        fase: 'contratos',
        alProgresar,
        signal,
        resolverProceso: async (contratos) => {
          const conProceso = await resolver(contratos)
          enlazados += conProceso.filter((c) => c.proceso_id).length
          emitir({ enlazados })
          return conProceso
        },
      })
      resumen.contratos = { ...resContratos, ids: undefined, enlazados }
    }

    // Solo se puntua lo recien bajado, nunca todo el almacen: repuntuar 118.000
    // fichas porque el perfil haya cambiado es una operacion explicita y aparte
    // (el boton de "repuntuar"), no un efecto secundario de descargar.
    if (cfg.puntuarEnLaDescarga && perfil && resProcesos.ids.length) {
      resumen.puntuados = await puntuarNuevos(resProcesos.ids, cfg, perfil, alProgresar, signal)
    }

    await escribirMeta('ultima_sync', new Date().toISOString())
    await escribirMeta('ultima_sync_resumen', resumen)
    // `alListo` va ANTES de emitir `listo`: quien recibe el evento da por hecho que
    // todo esta listo y recarga la lista. Si aqui se emitiera ya, la recarga
    // leeria el indice de antes de la descarga y veria cero oportunidades, y no
    // habria ningun evento posterior que lo arreglara.
    await alListo?.()
    emitir({ corriendo: false, fase: 'listo', terminada: new Date().toISOString() })
    await persistirProgreso()
    return resumen
  } catch (error) {
    const cancelado = error?.name === 'AbortError' || error instanceof Cancelada
    emitir({
      corriendo: false,
      fase: cancelado ? 'cancelado' : 'error',
      error: cancelado ? null : String(error?.message || error),
      terminada: new Date().toISOString(),
    })
    await persistirProgreso()
    if (!cancelado) throw error
    return { ...resumen, cancelado: true }
  }
}

/**
 * Puntua los ids indicados y guarda los matches en el almacen.
 *
 * Los ids son los de esta descarga, asi que el coste es proporcional a lo
 * nuevo. `guardarMatches` va por lotes para no abrir una transaccion con miles
 * de `put` encima.
 */
export async function puntuarNuevos(ids, cfg, perfil, alProgresar, signal) {
  const unicos = [...new Set(ids)]
  emitir({ fase: 'puntuacion', hechos: 0, total: unicos.length })
  alProgresar?.({ fase: 'puntuacion', hechos: 0, total: unicos.length })

  // `puntuarCorpus` necesita el proceso completo (con descripcion), no solo el
  // id: el texto es lo que se compara con el perfil. Los ids vienen de la
  // descarga, asi que tambien hay que traer los textos.
  const procesos = await procesosPorIds(unicos)
  if (!procesos.length) return 0

  const matches = await puntuarCorpus({
    procesos,
    perfil,
    pesoSemantico: cfg.semanticWeight,
    simFloor: cfg.simFloor,
    simCeil: cfg.simCeil,
    signal,
    alProgresar: (p) => {
      emitir({ hechos: p.hechos, total: p.total })
      alProgresar?.({ fase: 'puntuacion', hechos: p.hechos, total: p.total, ms: p.ms })
    },
    alLote: (lote) => guardarMatches(lote),
  })

  return matches.size
}

/**
 * Los procesos COMPLETOS de una lista de filas ligeras.
 *
 * Existe por un motivo concreto: el indice de consulta se construye con `ligeros`,
 * que no llevan la descripcion, y puntuar con esas filas daria un score solo por
 * titulo. Sin error, sin aviso: todos los scores bajarian un poco y nadie sabria
 * por que. Los textos solo estan en la store `procesos`.
 *
 * Va por trozos porque `obtenerVarios` abre una transaccion: pedir los 118.000 de
 * golpe son 118.000 peticiones dentro de la misma transaccion, que el navegador
 * puede dejar colgada. Con 2.000 por trozo va lineal y avisa del progreso.
 */
const TROZO_COMPLETOS = 2000
async function procesosCompletos(ligeros, alProgresar) {
  const out = []
  const total = ligeros.length
  for (let i = 0; i < total; i += TROZO_COMPLETOS) {
    const trozo = ligeros.slice(i, i + TROZO_COMPLETOS).map((p) => p.id_del_proceso)
    out.push(...(await procesosPorIds(trozo)))
    alProgresar?.({ cargados: out.length, total })
  }
  return out
}

/**
 * Repuntua TODO lo que hay en el almacen.
 *
 * Es la operacion larga: 118.000 fichas, unos segundos, con la interfaz
 * bloqueada a ratos. Se llama solo desde un boton explicito, y devuelve el
 * indice ya actualizado para que el panel no tenga que reconstruirlo.
 */
export async function repuntuarTodo({ perfil, cfg = null, signal, alProgresar } = {}) {
  const config = cfg || (await leerConfig())
  const indice = await construirIndice()
  if (!indice.procesos.length) return { total: 0, indice }

  // `corriendo` tambien se emite aqui, no solo en `sincronizar`: es lo que hace
  // que `Sincronizador` enseñe el progreso y, sobre todo, que recargue la lista
  // al terminar. Sin esto, repuntuar funcionaba pero el panel seguia enseñando
  // los scores anteriores sin avisar de nada.
  emitir({ corriendo: true, fase: 'repuntuando', hechos: 0, total: indice.procesos.length })
  try {
    const procesos = await procesosCompletos(indice.procesos, (p) => {
      emitir({ hechos: p.cargados, total: p.total })
      alProgresar?.({ fase: 'repuntuando', cargados: p.cargados, total: p.total })
    })
    if (signal?.aborted) throw new DOMException('puntuacion cancelada', 'AbortError')
    if (!procesos.length) {
      emitir({ corriendo: false, fase: 'listo', hechos: 0, total: 0 })
      return { total: 0, indice }
    }

    const matches = await puntuarCorpus({
      procesos,
      perfil,
      pesoSemantico: config.semanticWeight,
      simFloor: config.simFloor,
      simCeil: config.simCeil,
      signal,
      alProgresar: (p) => {
        emitir({ fase: 'repuntuando', hechos: p.hechos, total: p.total })
        alProgresar?.({ fase: 'repuntuando', ...p })
      },
      alLote: (lote) => guardarMatches(lote),
    })

    indice.matches = matches
    emitir({
      corriendo: false,
      fase: 'repuntuado',
      hechos: matches.size,
      total: matches.size,
      terminada: new Date().toISOString(),
    })
    return { total: matches.size, indice }
  } catch (error) {
    const cancelado = error?.name === 'AbortError'
    emitir({
      corriendo: false,
      fase: cancelado ? 'cancelado' : 'error',
      error: cancelado ? null : String(error?.message || error),
      terminada: new Date().toISOString(),
    })
    throw error
  }
}