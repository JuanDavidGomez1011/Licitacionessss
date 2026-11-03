/**
 * "Buscar en SECOP": una licitacion concreta, directamente en datos.gov.co.
 *
 * El buscador de la lista solo mira lo descargado en este navegador, que es una
 * ventana de dias con topes. Esto pregunta al portal sin limite de fechas, guarda
 * y puntua solo lo que encuentra, y la lista lo enseña como cualquier otro
 * proceso. Sirve para "me dijeron que salio la licitacion X" sin bajarse 24.000.
 *
 * Como se pregunta, medido contra el portal el 3/11/2026:
 *
 *   - Un numero de proceso (`CO1.REQ.*`) o una constancia de SECOP I
 *     (`26-12-14833088`) van por `$where` exacto: ~1 s.
 *   - El texto va por `$q`, la busqueda de texto completo de Socrata: mira el
 *     objeto Y la descripcion, exige todas las palabras y tarda ~1-2 s. Un
 *     `LIKE` sobre la descripcion tardaba ~70 s, asi que no es una opcion.
 *   - El `CO1.NTC.*` del aviso no se puede buscar: vive dentro de la URL del
 *     proceso, que `$q` no indexa. Se dice en vez de devolver cero sin mas.
 *
 * SECOP I se busca sin filtrar por estado: si alguien busca un proceso concreto,
 * lo quiere ver aunque ya este celebrado.
 */

import { evaluarAlertas } from './alertas'
import { guardarMatches, guardarProcesos } from './db'
import {
  FECHA_ORDEN_PROCESOS,
  FECHA_SECOP_I,
  SELECT_PROCESOS,
  SELECT_SECOP_I,
  deduplicar,
  mapearProceso,
  mapearProcesoSecopI,
} from './mapper'
import { puntuarCorpus } from './score'
import { soqlQuote, type SocrataClient } from './socrata'
import type { Config, FilaSocrata, Fuente, Perfil, Proceso } from './tipos'

/** Cuantos resultados se traen por fuente, los mas recientes primero. */
export const LIMITE_POR_FUENTE = 100

const RE_PROCESO_SECOP_II = /^CO1\.REQ\.\d+$/i
const RE_AVISO = /^CO1\.NTC\.\d+$/i
const RE_CONSTANCIA_SECOP_I = /^\d{2}-\d{1,2}-\d{5,}$/

export type TipoBusqueda = 'proceso' | 'constancia' | 'texto'

/** Que se esta buscando, segun la forma del texto. */
export function tipoDeBusqueda(texto: string): TipoBusqueda {
  const t = texto.trim()
  if (RE_PROCESO_SECOP_II.test(t)) return 'proceso'
  if (RE_CONSTANCIA_SECOP_I.test(t)) return 'constancia'
  return 'texto'
}

interface ConsultaFuente {
  fuente: Fuente
  dataset: string
  select: string
  order: string
  where?: string
  q?: string
  mapear: (fila: FilaSocrata) => Proceso | null
}

/**
 * Las consultas a lanzar. Un numero de proceso solo existe en una de las dos
 * fuentes, asi que solo se pregunta a esa.
 */
export function consultasPara(texto: string, cfg: Pick<Config, 'datasetProcesos' | 'datasetSecopI' | 'incluirSecopI'>): ConsultaFuente[] {
  const t = texto.trim()
  const secopII = (extra: Partial<ConsultaFuente>): ConsultaFuente => ({
    fuente: 'SECOP II',
    dataset: cfg.datasetProcesos,
    select: SELECT_PROCESOS,
    order: `${FECHA_ORDEN_PROCESOS} DESC`,
    mapear: mapearProceso,
    ...extra,
  })
  const secopI = (extra: Partial<ConsultaFuente>): ConsultaFuente => ({
    fuente: 'SECOP I',
    dataset: cfg.datasetSecopI,
    select: SELECT_SECOP_I,
    order: `${FECHA_SECOP_I} DESC`,
    mapear: mapearProcesoSecopI,
    ...extra,
  })

  switch (tipoDeBusqueda(t)) {
    case 'proceso':
      return [secopII({ where: `id_del_proceso = ${soqlQuote(t.toUpperCase())}` })]
    case 'constancia':
      return [secopI({ where: `uid = ${soqlQuote(t)}` })]
    default: {
      // Las comillas del buscador local no significan nada para `$q`, que ya
      // exige todas las palabras: se quitan para no mandarlas como texto.
      const q = t.replace(/"/g, ' ').replace(/\s+/g, ' ').trim()
      const out = [secopII({ q })]
      if (cfg.incluirSecopI && cfg.datasetSecopI) out.push(secopI({ q }))
      return out
    }
  }
}

export interface ResultadoBusquedaRemota {
  /** Ids encontrados, en el orden en que los devolvio el portal. */
  ids: string[]
  nuevas: number
  porFuente: Partial<Record<Fuente, number>>
  /** Alguna fuente devolvio el maximo: puede haber mas, mas antiguos. */
  recortado: boolean
  alertas: number
  /** Explicacion para el usuario cuando no hay nada que buscar o no se puede. */
  aviso: string | null
}

export interface OpcionesBusquedaRemota {
  cliente: SocrataClient
  cfg: Config
  perfil: Perfil
  signal?: AbortSignal | null
}

export async function buscarEnSecop(
  texto: string,
  { cliente, cfg, perfil, signal }: OpcionesBusquedaRemota,
): Promise<ResultadoBusquedaRemota> {
  const vacio: ResultadoBusquedaRemota = { ids: [], nuevas: 0, porFuente: {}, recortado: false, alertas: 0, aviso: null }
  const t = texto.trim()
  if (t.replace(/"/g, '').trim().length < 3) {
    return { ...vacio, aviso: 'Escribe al menos 3 caracteres para buscar en SECOP.' }
  }
  if (RE_AVISO.test(t)) {
    return {
      ...vacio,
      aviso:
        'El número de aviso (CO1.NTC…) no se puede buscar en datos.gov.co: va dentro de la URL del proceso. Busca por el número de proceso (CO1.REQ…), la referencia o el objeto.',
    }
  }

  // Las dos fuentes a la vez: son independientes y cada una tarda 1-2 s.
  const respuestas = await Promise.all(
    consultasPara(t, cfg).map(async (c) => {
      const { rows } = await cliente.pagina(
        { dataset: c.dataset, select: c.select, order: c.order, where: c.where ?? null, q: c.q, limit: LIMITE_POR_FUENTE, offset: 0 },
        { signal },
      )
      return { consulta: c, rows }
    }),
  )

  const porFuente: Partial<Record<Fuente, number>> = {}
  const procesos: Proceso[] = []
  let recortado = false
  for (const { consulta, rows } of respuestas) {
    if (rows.length >= LIMITE_POR_FUENTE) recortado = true
    const mapeados = deduplicar(rows.map(consulta.mapear), 'id_del_proceso')
    porFuente[consulta.fuente] = mapeados.length
    procesos.push(...mapeados)
  }
  if (!procesos.length) return { ...vacio, porFuente }

  const { nuevas } = await guardarProcesos(procesos)

  // Se puntuan como en una descarga, y entran en las alertas igual: un proceso
  // encontrado asi es tan "nuevo" para el panel como uno de la descarga.
  const matches = await puntuarCorpus({
    procesos,
    perfil,
    pesos: cfg.pesos,
    simFloor: cfg.simFloor,
    simCeil: cfg.simCeil,
    signal,
    alLote: (lote) => guardarMatches(lote),
  })
  const alertas = await evaluarAlertas(matches.values(), new Map(procesos.map((p) => [p.id_del_proceso, p])), cfg)

  return {
    ids: procesos.map((p) => p.id_del_proceso),
    nuevas,
    porFuente,
    recortado,
    alertas: alertas.length,
    aviso: null,
  }
}
