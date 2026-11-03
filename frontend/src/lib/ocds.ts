/**
 * Mapeo a OCDS (Open Contracting Data Standard) 1.1.
 *
 * Puerto de `backend/app/ocds.py`. Se conserva entero porque el panel muestra el
 * JSON en una pestaña y los nombres de campo son los mismos que consultaba
 * cualquier otra herramienta del proyecto: si aqui se renombrara una clave, los
 * releases exportados dejan de ser comparables con los del backend.
 */

import type { Contrato, Proceso } from './tipos'

/** Un release OCDS. Es JSON para mostrar y exportar: no se lee campo a campo. */
export type ReleaseOcds = Record<string, unknown>

type Diccionario = Record<string, string>

export const OCDS_VERSION = '1.1'
export const SECOP_DOMAIN = 'https://www.datos.gov.co'

const OCDS_STATUS: Diccionario = {
  borrador: 'planning',
  planeado: 'planning',
  convocado: 'active',
  publicado: 'active',
  abierto: 'active',
  'en curso': 'active',
  adjudicado: 'active',
  presentado: 'active',
  celebrado: 'complete',
  liquidado: 'complete',
  'adjudicado fechado': 'complete',
  descartado: 'withdrawn',
  cancelado: 'cancelled',
  anulado: 'cancelled',
  suspendido: 'cancelled',
  'terminado sin contrato': 'withdrawn',
  noEvaluable: 'withdrawn',
}

const OCDS_METHOD: Diccionario = {
  'licitación pública': 'open',
  'licitacion publica': 'open',
  'selección directa': 'direct',
  'seleccion directa': 'direct',
  subasta: 'open',
  'consulta directa': 'direct',
  'contratación directa': 'direct',
  'contratacion directa': 'direct',
  'acuerdo marco': 'limited',
  concurso: 'selective',
  'open bidding': 'open',
  'competitive dialogue': 'selective',
  'direct contracting': 'direct',
}

const DURATION_UNIT: Diccionario = {
  dias: 'day',
  'días': 'day',
  dia: 'day',
  'día': 'day',
  meses: 'month',
  mes: 'month',
  anios: 'year',
  'años': 'year',
  'año': 'year',
  ano: 'year',
}

const sinNull = (objeto: Record<string, unknown>): ReleaseOcds => Object.fromEntries(Object.entries(objeto).filter(([, v]) => v !== null && v !== undefined))

export function ocdsStatus(estado: string | null | undefined): string {
  if (!estado) return 'active'
  return OCDS_STATUS[String(estado).trim().toLowerCase()] || 'active'
}

export function procurementMethod(modalidad: string | null | undefined): string {
  if (!modalidad) return 'open'
  return OCDS_METHOD[String(modalidad).trim().toLowerCase()] || 'open'
}

export function durationUnit(unidad: string | null | undefined): string {
  if (!unidad) return 'day'
  return DURATION_UNIT[String(unidad).trim().toLowerCase()] || 'day'
}

const dinero = (amount: number | null | undefined): { amount: number; currency: string } | null =>
  amount === null || amount === undefined ? null : { amount: Math.round(Number(amount) * 100) / 100, currency: 'COP' }

/** Release OCDS `tender` a partir de un proceso guardado en el navegador. */
export function tenderToOcds(t: Proceso | null): ReleaseOcds | null {
  if (!t) return null

  const address =
    t.ciudad_entidad || t.departamento_entidad
      ? { locality: t.ciudad_entidad, region: t.departamento_entidad, countryName: 'Colombia' }
      : null

  const organization = t.entidad
    ? {
        name: t.entidad,
        identifier: t.nit_entidad ? { scheme: 'NIT', id: t.nit_entidad } : null,
        address,
      }
    : null

  let items = null
  if (t.nombre_del_procedimiento || t.codigo_principal_categoria) {
    items = [
      {
        description: t.nombre_del_procedimiento || '',
        classification: t.codigo_principal_categoria
          ? {
              scheme: 'UNSPSC',
              id: t.codigo_principal_categoria,
              description: t.nombre_del_procedimiento,
            }
          : null,
        additionalClassifications: t.categorias_adicionales
          ? t.categorias_adicionales
              .split(',')
              .map((c) => c.trim())
              .filter(Boolean)
              .map((c) => ({ scheme: 'UNSPSC', id: c }))
          : null,
      },
    ]
  }

  return sinNull({
    uri: `${SECOP_DOMAIN}/resource/${t.id_del_proceso}`,
    scheme: 'ocds-colombia',
    version: OCDS_VERSION,
    ocid: `ocds-colombia-${t.id_del_proceso}`,
    id: t.id_del_proceso,
    tag: ['tender'],
    date: t.fecha_publicacion || null,
    title: t.nombre_del_procedimiento,
    description: t.descripcion || t.objeto_contrato,
    status: ocdsStatus(t.estado_del_procedimiento),
    value: dinero(t.precio_base),
    procurementMethod: procurementMethod(t.modalidad_de_contratacion),
    procurementMethodDetails: t.modalidad_de_contratacion,
    procurementMethodRationale: t.justificacion_modalidad,
    items,
    organization,
    tenderPeriod: { startDate: t.fecha_publicacion || null, endDate: t.fecha_apertura_respuesta || null },
    enquiryPeriod: { startDate: t.fecha_publicacion || null, endDate: t.fecha_recepcion || null },
    lotDetails: t.numero_de_lotes ? Array.from({ length: t.numero_de_lotes }, (_, i) => ({ id: String(i + 1) })) : null,
    legalBasis: t.justificacion_modalidad,
    extensions: {
      referenciaDelProceso: t.referencia_del_proceso,
      duracion: t.duracion,
      unidadDuracion: durationUnit(t.unidad_de_duracion),
      estadoSecop: t.estado_del_procedimiento,
      adjudicado: t.adjudicado,
      tipoContrato: t.tipo_contrato,
      subtipoContrato: t.subtipo_contrato,
      urlProceso: t.url_proceso,
      noticeUid: t.notice_uid,
      fuente: `${SECOP_DOMAIN}/resource/${t.id_del_proceso}`,
    },
  })
}

/** Release OCDS `award` + `contract` a partir de un contrato. */
export function contractToOcds(c: Contrato | null): ReleaseOcds | null {
  if (!c) return null
  const address =
    c.ciudad || c.departamento ? { locality: c.ciudad, region: c.departamento, countryName: 'Colombia' } : null

  return sinNull({
    uri: `${SECOP_DOMAIN}/resource/${c.id_contrato}`,
    scheme: 'ocds-colombia',
    version: OCDS_VERSION,
    ocid: `ocds-colombia-contract-${c.id_contrato}`,
    id: c.id_contrato,
    tag: ['award', 'contract'],
    date: c.fecha_de_firma || null,
    title: c.objeto_del_contrato || c.descripcion_del_proceso,
    description: c.descripcion_del_proceso,
    status: c.estado_contrato ? 'active' : 'unknown',
    value: dinero(c.valor_del_contrato),
    organization: c.nombre_entidad
      ? {
          name: c.nombre_entidad,
          identifier: c.nit_entidad ? { scheme: 'NIT', id: c.nit_entidad } : null,
          address,
        }
      : null,
    awardId: c.proceso_de_compra,
    period: { startDate: c.fecha_de_inicio || null, endDate: c.fecha_de_fin || null },
    suppliers: c.proveedor_adjudicado ? [{ name: c.proveedor_adjudicado, identifier: null }] : null,
    items:
      c.descripcion_del_proceso || c.objeto_del_contrato
        ? [
            {
              description: c.descripcion_del_proceso || c.objeto_del_contrato || '',
              classification: c.codigo_de_categoria_principal
                ? { scheme: 'UNSPSC', id: c.codigo_de_categoria_principal }
                : null,
            },
          ]
        : null,
    extensions: {
      referenciaDelContrato: c.referencia_del_contrato,
      estadoContrato: c.estado_contrato,
      valorPagado: c.valor_pagado,
      esPyme: c.es_pyme,
      localizacion: c.localizacion,
      urlProceso: c.urlproceso,
      noticeUid: c.notice_uid,
      fuente: `${SECOP_DOMAIN}/resource/${c.id_contrato}`,
    },
  })
}