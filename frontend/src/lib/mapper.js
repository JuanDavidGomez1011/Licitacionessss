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
 */

import {
  noticeUid,
  socrataDate,
  socrataFloat,
  socrataInt,
  socrataText,
  socrataUrl,
} from './socrata'

// --- procesos: dataset p6dx-8zbt -------------------------------------------

export const COLUMNAS_PROCESOS = [
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

// --- contratos: dataset jbjy-vk9h ------------------------------------------

export const COLUMNAS_CONTRATOS = [
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

const ANCHOS_PROCESO = {
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

const ANCHOS_CONTRATO = {
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

const INT_PROCESO = new Set(['duracion', 'numero_de_lotes'])
const FLOAT_PROCESO = new Set(['precio_base'])
const FECHA_PROCESO = new Set([
  'fecha_publicacion',
  'fecha_recepcion',
  'fecha_apertura_respuesta',
  'fecha_ultima_publicacion',
])
const URL_PROCESO = new Set(['url_proceso'])

const FLOAT_CONTRATO = new Set([
  'valor_del_contrato',
  'valor_pagado',
  'valor_facturado',
  'valor_pendiente_de_pago',
])
const FECHA_CONTRATO = new Set(['fecha_de_firma', 'fecha_de_inicio', 'fecha_de_fin', 'ultima_actualizacion'])
const URL_CONTRATO = new Set(['urlproceso'])

function recortar(registro, anchos) {
  for (const [campo, ancho] of Object.entries(anchos)) {
    const valor = registro[campo]
    if (typeof valor === 'string' && valor.length > ancho) {
      registro[campo] = valor.slice(0, ancho)
    }
  }
  return registro
}

/** Convierte una fila cruda de `p6dx-8zbt` en un registro de proceso. */
export function mapearProceso(fila) {
  const id = socrataText(fila.id_del_proceso)
  if (!id) return null
  const out = {}
  for (const [origen, destino] of COLUMNAS_PROCESOS) {
    const valor = fila[origen]
    if (INT_PROCESO.has(destino)) out[destino] = socrataInt(valor)
    else if (FLOAT_PROCESO.has(destino)) out[destino] = socrataFloat(valor)
    else if (FECHA_PROCESO.has(destino)) out[destino] = socrataDate(valor)
    else if (URL_PROCESO.has(destino)) out[destino] = socrataUrl(valor)
    else out[destino] = socrataText(valor)
  }
  out.origen = 'socrata'
  out.notice_uid = noticeUid(out.url_proceso)
  return recortar(out, ANCHOS_PROCESO)
}

/** Convierte una fila cruda de `jbjy-vk9h` en un registro de contrato. */
export function mapearContrato(fila) {
  const id = socrataText(fila.id_contrato)
  if (!id) return null
  const out = {}
  for (const [origen, destino] of COLUMNAS_CONTRATOS) {
    const valor = fila[origen]
    if (FLOAT_CONTRATO.has(destino)) out[destino] = socrataFloat(valor)
    else if (FECHA_CONTRATO.has(destino)) out[destino] = socrataDate(valor)
    else if (URL_CONTRATO.has(destino)) out[destino] = socrataUrl(valor)
    else out[destino] = socrataText(valor)
  }
  out.notice_uid = noticeUid(out.urlproceso)
  return recortar(out, ANCHOS_CONTRATO)
}

/**
 * Una fila por clave natural, conservando la primera.
 *
 * El dataset de procesos publica el mismo `id_del_proceso` varias veces (144.341
 * filas eran 118.817 ids distintos), y en `INSERT ... ON CONFLICT` eso revienta
 * con `ON CONFLICT DO UPDATE command cannot affect row a second time`. Aqui se
 * resuelve antes de escribir, que es donde se resolvio alli (bug #8). Las
 * repetidas son copias exactas, asi que da igual cual se elija.
 */
export function deduplicar(registros, clave) {
  const vistos = new Set()
  const out = []
  let repetidas = 0
  for (const registro of registros) {
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
export function ligeroProceso(p) {
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
  }
}