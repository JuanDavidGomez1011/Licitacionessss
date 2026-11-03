/**
 * Mapeo de las filas de Socrata a los registros que guarda la pagina.
 *
 * Puerto de `backend/app/ingest/secop_procesos.py` y `secop_contratos.py`. Las
 * listas de columnas son las mismas y en el mismo orden, porque el orden define
 * el `$select` que se manda a Socrata: si cambiara una aqui y no en el otro
 * sitio, cada fila traeria el valor de la columna equivocada sin ningun error.
 *
 * Se conservan los tres detalles que costaron un bug cada uno:
 *   - el `noticeUID` de la URL es la clave de union con los contratos (bug #10)
 *   - los campos `url` llegan como objeto y hay que aplanarlos (bug #3)
 *   - los textos se recortan al ancho de la columna, para que una fila rarita
 *     no tumbe la carga entera (bug #9)
 *
 * SECOP I (`f789-7hwg`) tiene otro esquema entero. Se mapea al mismo registro
 * de proceso para que el indice, la puntuacion y la UI no sepan de donde vino;
 * lo unico que lo distingue es `fuente: 'SECOP I'`.
 */

import { noticeUid, socrataDate, socrataFloat, socrataInt, socrataText, socrataUrl } from './socrata'
import type { Contrato, FilaSocrata, Proceso, ProcesoLigero } from './tipos'

type Columnas<T> = readonly (readonly [string, keyof T])[]

// --- procesos: dataset p6dx-8zbt -------------------------------------------

export const COLUMNAS_PROCESOS: Columnas<Proceso> = [
  ['id_del_proceso', 'id_del_proceso'],
  ['referencia_del_proceso', 'referencia_del_proceso'],
  ['entidad', 'entidad'],
  ['nit_entidad', 'nit_entidad'],
  ['departamento_entidad', 'departamento_entidad'],
  ['ciudad_entidad', 'ciudad_entidad'],
  ['nombre_del_procedimiento', 'nombre_del_procedimiento'],
  ['descripci_n_del_procedimiento', 'descripcion'],
  ['precio_base', 'precio_base'],
  ['modalidad_de_contratacion', 'modalidad_de_contratacion'],
  ['justificaci_n_modalidad_de', 'justificacion_modalidad'],
  ['duracion', 'duracion'],
  ['unidad_de_duracion', 'unidad_de_duracion'],
  ['numero_de_lotes', 'numero_de_lotes'],
  ['codigo_principal_de_categoria', 'codigo_principal_categoria'],
  ['categorias_adicionales', 'categorias_adicionales'],
  ['estado_del_procedimiento', 'estado_del_procedimiento'],
  ['adjudicado', 'adjudicado'],
  ['fecha_de_publicacion_del', 'fecha_publicacion'],
  ['fecha_de_recepcion_de', 'fecha_recepcion'],
  ['fecha_de_apertura_de_respuesta', 'fecha_apertura_respuesta'],
  ['fecha_de_ultima_publicaci', 'fecha_ultima_publicacion'],
  ['tipo_de_contrato', 'tipo_contrato'],
  ['subtipo_de_contrato', 'subtipo_contrato'],
  ['urlproceso', 'url_proceso'],
  ['estado_resumen', 'estado_resumen'],
]

export const SELECT_PROCESOS = COLUMNAS_PROCESOS.map(([origen]) => origen).join(',')

// Se filtra por `fecha_de_ultima_publicaci` porque es la que Colombia Compra
// Eficiente actualiza al re-publicar un proceso; se ordena por la de publicacion
// para que lo mas reciente llegue primero.
export const FECHA_INCREMENTAL_PROCESOS = 'fecha_de_ultima_publicaci'
export const FECHA_ORDEN_PROCESOS = 'fecha_de_publicacion_del'

// --- procesos SECOP I: dataset f789-7hwg -----------------------------------
//
// No hay fecha de cierre en el dataset: SECOP I solo publica la fecha de cargue.
// Por eso el componente "tiempo" del score queda sin datos en estos procesos y
// reparte su peso, en vez de puntuarlos como si ya hubieran cerrado.

export const SELECT_SECOP_I = [
  'uid',
  'numero_de_proceso',
  'nombre_entidad',
  'nit_de_la_entidad',
  'departamento_entidad',
  'municipio_entidad',
  'detalle_del_objeto_a_contratar',
  'objeto_a_contratar',
  'cuantia_proceso',
  'modalidad_de_contratacion',
  'causal_de_otras_formas_de',
  'plazo_de_ejec_del_contrato',
  'rango_de_ejec_del_contrato',
  'id_clase',
  'nombre_clase',
  'estado_del_proceso',
  'fecha_de_cargue_en_el_secop',
  'ultima_actualizacion',
  'tipo_de_contrato',
  'ruta_proceso_en_secop_i',
].join(',')

export const FECHA_SECOP_I = 'fecha_de_cargue_en_el_secop'

/**
 * Solo los convocados: el dataset de SECOP I mezcla procesos abiertos con
 * contratos ya celebrados y liquidados (en una semana de octubre de 2026 eran
 * 2.537 convocados frente a 5.084 celebrados), y estos ultimos no son
 * oportunidades.
 */
export const FILTRO_SECOP_I = "estado_del_proceso = 'Convocado'"

// --- contratos: dataset jbjy-vk9h ------------------------------------------

export const COLUMNAS_CONTRATOS: Columnas<Contrato> = [
  ['id_contrato', 'id_contrato'],
  ['proceso_de_compra', 'proceso_de_compra'],
  ['referencia_del_contrato', 'referencia_del_contrato'],
  ['nombre_entidad', 'nombre_entidad'],
  ['nit_entidad', 'nit_entidad'],
  ['departamento', 'departamento'],
  ['ciudad', 'ciudad'],
  ['localizaci_n', 'localizacion'],
  ['estado_contrato', 'estado_contrato'],
  ['descripcion_del_proceso', 'descripcion_del_proceso'],
  ['objeto_del_contrato', 'objeto_del_contrato'],
  ['valor_del_contrato', 'valor_del_contrato'],
  ['valor_pagado', 'valor_pagado'],
  ['valor_facturado', 'valor_facturado'],
  ['valor_pendiente_de_pago', 'valor_pendiente_de_pago'],
  ['fecha_de_firma', 'fecha_de_firma'],
  ['fecha_de_inicio_del_contrato', 'fecha_de_inicio'],
  ['fecha_de_fin_del_contrato', 'fecha_de_fin'],
  ['tipo_de_contrato', 'tipo_de_contrato'],
  ['modalidad_de_contratacion', 'modalidad_de_contratacion'],
  ['proveedor_adjudicado', 'proveedor_adjudicado'],
  ['es_pyme', 'es_pyme'],
  ['codigo_de_categoria_principal', 'codigo_de_categoria_principal'],
  ['urlproceso', 'urlproceso'],
  ['ultima_actualizacion', 'ultima_actualizacion'],
]

export const SELECT_CONTRATOS = COLUMNAS_CONTRATOS.map(([origen]) => origen).join(',')
export const FECHA_INCREMENTAL_CONTRATOS = 'fecha_de_firma'

// --- anchos de columna (los de `backend/app/models.py`) ---------------------
//
// Se recortan, no se pierden: hay filas del dataset oficial que meten el objeto
// entero en un campo `varchar` (181 filas en `referencia_del_contrato`), y en
// Postgres eso tumbaba el lote entero con `value too long for character varying`.

const ANCHOS_PROCESO: Partial<Record<keyof Proceso, number>> = {
  id_del_proceso: 80,
  referencia_del_proceso: 120,
  entidad: 400,
  nit_entidad: 40,
  departamento_entidad: 120,
  ciudad_entidad: 120,
  codigo_principal_categoria: 80,
  estado_del_procedimiento: 80,
  adjudicado: 20,
  tipo_contrato: 120,
  subtipo_contrato: 120,
  notice_uid: 40,
  estado_resumen: 80,
  origen: 40,
}

const ANCHOS_CONTRATO: Partial<Record<keyof Contrato, number>> = {
  id_contrato: 120,
  referencia_del_contrato: 600,
  proceso_de_compra: 40,
  proceso_id: 80,
  notice_uid: 40,
  nombre_entidad: 400,
  nit_entidad: 40,
  departamento: 120,
  ciudad: 120,
  estado_contrato: 80,
  tipo_de_contrato: 160,
  modalidad_de_contratacion: 200,
  proveedor_adjudicado: 400,
  es_pyme: 20,
  codigo_de_categoria_principal: 80,
}

/** Largo maximo del titulo en SECOP I, donde el "titulo" es el objeto entero. */
const ANCHO_TITULO_SECOP_I = 300

const INT_PROCESO = new Set<keyof Proceso>(['duracion', 'numero_de_lotes'])
const FLOAT_PROCESO = new Set<keyof Proceso>(['precio_base'])
const FECHA_PROCESO = new Set<keyof Proceso>([
  'fecha_publicacion',
  'fecha_recepcion',
  'fecha_apertura_respuesta',
  'fecha_ultima_publicacion',
])
const URL_PROCESO = new Set<keyof Proceso>(['url_proceso'])

const FLOAT_CONTRATO = new Set<keyof Contrato>([
  'valor_del_contrato',
  'valor_pagado',
  'valor_facturado',
  'valor_pendiente_de_pago',
])
const FECHA_CONTRATO = new Set<keyof Contrato>(['fecha_de_firma', 'fecha_de_inicio', 'fecha_de_fin', 'ultima_actualizacion'])
const URL_CONTRATO = new Set<keyof Contrato>(['urlproceso'])

function recortar<T extends object>(registro: T, anchos: Partial<Record<keyof T, number>>): T {
  const editable = registro as Record<keyof T, unknown>
  for (const campo of Object.keys(anchos) as (keyof T)[]) {
    const ancho = anchos[campo]
    const valor = editable[campo]
    if (ancho !== undefined && typeof valor === 'string' && valor.length > ancho) {
      editable[campo] = valor.slice(0, ancho)
    }
  }
  return registro
}

/** Un proceso con todos los campos a `null`, para rellenar por columnas. */
function procesoVacio(id: string): Proceso {
  return {
    id_del_proceso: id,
    referencia_del_proceso: null,
    entidad: null,
    nit_entidad: null,
    departamento_entidad: null,
    ciudad_entidad: null,
    nombre_del_procedimiento: null,
    descripcion: null,
    precio_base: null,
    modalidad_de_contratacion: null,
    justificacion_modalidad: null,
    duracion: null,
    unidad_de_duracion: null,
    numero_de_lotes: null,
    codigo_principal_categoria: null,
    categorias_adicionales: null,
    estado_del_procedimiento: null,
    adjudicado: null,
    fecha_publicacion: null,
    fecha_recepcion: null,
    fecha_apertura_respuesta: null,
    fecha_ultima_publicacion: null,
    tipo_contrato: null,
    subtipo_contrato: null,
    url_proceso: null,
    estado_resumen: null,
    origen: 'socrata',
    fuente: 'SECOP II',
    notice_uid: null,
  }
}

/** Convierte una fila cruda de `p6dx-8zbt` en un registro de proceso. */
export function mapearProceso(fila: FilaSocrata): Proceso | null {
  const id = socrataText(fila.id_del_proceso)
  if (!id) return null
  const out = procesoVacio(id)
  const editable = out as unknown as Record<keyof Proceso, string | number | null>
  for (const [origen, destino] of COLUMNAS_PROCESOS) {
    const valor = fila[origen]
    if (INT_PROCESO.has(destino)) editable[destino] = socrataInt(valor)
    else if (FLOAT_PROCESO.has(destino)) editable[destino] = socrataFloat(valor)
    else if (FECHA_PROCESO.has(destino)) editable[destino] = socrataDate(valor)
    else if (URL_PROCESO.has(destino)) editable[destino] = socrataUrl(valor)
    else editable[destino] = socrataText(valor)
  }
  out.id_del_proceso = id
  out.origen = 'socrata'
  out.fuente = 'SECOP II'
  out.notice_uid = noticeUid(out.url_proceso)
  return recortar(out, ANCHOS_PROCESO)
}

/**
 * Convierte una fila de SECOP I (`f789-7hwg`) en el mismo registro de proceso.
 *
 * - `uid` es la clave (es el numero de constancia, p. ej. `26-12-14833276`): no
 *   se cruza con los `CO1.REQ.*` de SECOP II.
 * - El titulo es el objeto detallado, recortado: SECOP I no tiene un "nombre
 *   del procedimiento" corto. La descripcion lleva el objeto entero.
 * - `id_clase` es la clase UNSPSC (6 digitos), que es lo que necesita el score.
 */
export function mapearProcesoSecopI(fila: FilaSocrata): Proceso | null {
  const id = socrataText(fila.uid)
  if (!id) return null
  const objeto = socrataText(fila.detalle_del_objeto_a_contratar)
  const out = procesoVacio(id)
  out.referencia_del_proceso = socrataText(fila.numero_de_proceso)
  out.entidad = socrataText(fila.nombre_entidad)
  out.nit_entidad = socrataText(fila.nit_de_la_entidad)
  out.departamento_entidad = socrataText(fila.departamento_entidad)
  out.ciudad_entidad = socrataText(fila.municipio_entidad)
  out.nombre_del_procedimiento = objeto ? objeto.slice(0, ANCHO_TITULO_SECOP_I) : socrataText(fila.objeto_a_contratar)
  out.descripcion = objeto
  out.precio_base = socrataFloat(fila.cuantia_proceso)
  out.modalidad_de_contratacion = socrataText(fila.modalidad_de_contratacion)
  out.justificacion_modalidad = socrataText(fila.causal_de_otras_formas_de)
  out.duracion = socrataInt(fila.plazo_de_ejec_del_contrato) || null
  out.unidad_de_duracion = unidadSecopI(socrataText(fila.rango_de_ejec_del_contrato))
  out.codigo_principal_categoria = socrataText(fila.id_clase)
  out.categorias_adicionales = socrataText(fila.nombre_clase)
  out.estado_del_procedimiento = socrataText(fila.estado_del_proceso)
  out.fecha_publicacion = socrataDate(fila.fecha_de_cargue_en_el_secop)
  out.fecha_ultima_publicacion = socrataDate(fila.ultima_actualizacion) || out.fecha_publicacion
  out.tipo_contrato = socrataText(fila.tipo_de_contrato)
  out.url_proceso = socrataUrl(fila.ruta_proceso_en_secop_i)
  out.fuente = 'SECOP I'
  return recortar(out, ANCHOS_PROCESO)
}

/** SECOP I codifica el plazo con una letra: D (dias) o M (meses). */
function unidadSecopI(letra: string | null): string | null {
  if (letra === 'D') return 'Dias'
  if (letra === 'M') return 'Meses'
  return null
}

/** Un contrato con todos los campos a `null`. */
function contratoVacio(id: string): Contrato {
  const out = { id_contrato: id, notice_uid: null } as Partial<Contrato>
  for (const [, destino] of COLUMNAS_CONTRATOS) if (!(destino in out)) (out as Record<string, null>)[destino] = null
  return out as Contrato
}

/** Convierte una fila cruda de `jbjy-vk9h` en un registro de contrato. */
export function mapearContrato(fila: FilaSocrata): Contrato | null {
  const id = socrataText(fila.id_contrato)
  if (!id) return null
  const out = contratoVacio(id)
  const editable = out as unknown as Record<keyof Contrato, string | number | null>
  for (const [origen, destino] of COLUMNAS_CONTRATOS) {
    const valor = fila[origen]
    if (FLOAT_CONTRATO.has(destino)) editable[destino] = socrataFloat(valor)
    else if (FECHA_CONTRATO.has(destino)) editable[destino] = socrataDate(valor)
    else if (URL_CONTRATO.has(destino)) editable[destino] = socrataUrl(valor)
    else editable[destino] = socrataText(valor)
  }
  out.id_contrato = id
  out.notice_uid = noticeUid(out.urlproceso)
  return recortar(out, ANCHOS_CONTRATO)
}

/** El resultado de `deduplicar`: la lista limpia y cuantas se quitaron. */
export type Deduplicado<T> = T[] & { repetidas: number }

/**
 * Una fila por clave natural, conservando la primera.
 *
 * El dataset de procesos publica el mismo `id_del_proceso` varias veces (144.341
 * filas eran 118.817 ids distintos), y en `INSERT ... ON CONFLICT` eso revienta
 * con `ON CONFLICT DO UPDATE command cannot affect row a second time`. Aqui se
 * resuelve antes de escribir, que es donde se resolvio alli (bug #8). Las
 * repetidas son copias exactas, asi que da igual cual se elija.
 */
export function deduplicar<T>(registros: (T | null)[], clave: keyof T): Deduplicado<T> {
  const vistos = new Set<unknown>()
  const out = [] as unknown as Deduplicado<T>
  let repetidas = 0
  for (const registro of registros) {
    if (!registro) continue
    const k = registro[clave]
    if (vistos.has(k)) {
      repetidas += 1
      continue
    }
    vistos.add(k)
    out.push(registro)
  }
  out.repetidas = repetidas
  return out
}

/**
 * Version ligera de un proceso: lo unico que el panel necesita para filtrar,
 * ordenar y facetas.
 *
 * El store guarda tambien el proceso completo (con descripcion larga), pero
 * construir el indice de consulta con los textos de 340.000 registros sonaria
 * cientos de megabytes en RAM. Los textos no hacen falta para filtrar por
 * score, precio, territorio o modalidad.
 */
export function ligeroProceso(p: Proceso): ProcesoLigero {
  return {
    id_del_proceso: p.id_del_proceso,
    // El titulo va si: sin el, el buscador `q` no tiene nada que mirar y el
    // panel salen cero resultados para cualquier texto. Son ~100 caracteres, no
    // la descripcion entera, que es lo que si multiplicaba el peso.
    nombre_del_procedimiento: p.nombre_del_procedimiento,
    referencia_del_proceso: p.referencia_del_proceso,
    entidad: p.entidad,
    departamento_entidad: p.departamento_entidad,
    ciudad_entidad: p.ciudad_entidad,
    modalidad_de_contratacion: p.modalidad_de_contratacion,
    estado_del_procedimiento: p.estado_del_procedimiento,
    codigo_principal_categoria: p.codigo_principal_categoria,
    numero_de_lotes: p.numero_de_lotes,
    precio_base: p.precio_base,
    fecha_publicacion: p.fecha_publicacion,
    fecha_apertura_respuesta: p.fecha_apertura_respuesta,
    notice_uid: p.notice_uid,
    // Los procesos guardados antes de anadir SECOP I no traen `fuente`: todos
    // eran de SECOP II.
    fuente: p.fuente || 'SECOP II',
    url_proceso: p.url_proceso,
  }
}
