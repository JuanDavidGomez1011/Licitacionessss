/**
 * Alertas de oportunidades con score alto.
 *
 * Cuando una descarga puntua un proceso por encima del umbral (80 por defecto)
 * se apunta una alerta en `meta:alertas`. Cada proceso avisa una sola vez: el
 * conjunto de ids ya avisados vive en `meta:alertas_vistas`, para que repuntuar
 * o volver a bajar la misma ventana no repita el aviso.
 *
 * La notificacion del sistema es opcional y necesita el permiso del navegador,
 * que solo se puede pedir desde un clic (`pedirPermisoNotificaciones`). Sin
 * permiso, la alerta igual queda en la campana del panel.
 */

import { escribirMeta, leerMeta } from './db'
import type { Alerta, Config, Match, Proceso } from './tipos'

const CLAVE = 'alertas'
const CLAVE_VISTAS = 'alertas_vistas'
/** Las alertas viejas se recortan: es un aviso, no un historial. */
const MAX_ALERTAS = 200

type Oyente = (alertas: Alerta[]) => void
const oyentes = new Set<Oyente>()

export async function leerAlertas(): Promise<Alerta[]> {
  return leerMeta<Alerta[]>(CLAVE, [])
}

async function escribir(alertas: Alerta[]): Promise<Alerta[]> {
  await escribirMeta(CLAVE, alertas)
  for (const fn of oyentes) fn(alertas)
  return alertas
}

/** Avisa cuando cambian las alertas (para la campana de la cabecera). */
export function suscribirseAlertas(fn: Oyente): () => void {
  oyentes.add(fn)
  return () => {
    oyentes.delete(fn)
  }
}

export interface ConfigAlertas {
  alertas: Config['alertas']
  alertaUmbral: Config['alertaUmbral']
  alertaNotificacion: Config['alertaNotificacion']
}

/**
 * Apunta una alerta por cada match nuevo por encima del umbral.
 *
 * Devuelve las alertas creadas en esta llamada, que son las que se notifican.
 * `procesos` hace falta para el titulo y la entidad: el match solo tiene el id.
 */
export async function evaluarAlertas(
  matches: Iterable<Match>,
  procesos: Map<string, Pick<Proceso, 'nombre_del_procedimiento' | 'entidad'>>,
  cfg: ConfigAlertas,
): Promise<Alerta[]> {
  if (!cfg.alertas) return []
  const umbral = Number(cfg.alertaUmbral) || 80
  const vistas = new Set(await leerMeta<string[]>(CLAVE_VISTAS, []))
  const nuevas: Alerta[] = []
  const ahora = new Date().toISOString()

  for (const m of matches) {
    // "Superior a 80": estrictamente por encima del umbral.
    if (m.score <= umbral || vistas.has(m.tender_id)) continue
    vistas.add(m.tender_id)
    const p = procesos.get(m.tender_id)
    nuevas.push({
      tender_id: m.tender_id,
      titulo: p?.nombre_del_procedimiento || m.tender_id,
      entidad: p?.entidad || null,
      score: m.score,
      creada_en: ahora,
      leida: false,
    })
  }
  if (!nuevas.length) return []

  nuevas.sort((a, b) => b.score - a.score)
  await escribirMeta(CLAVE_VISTAS, [...vistas])
  await escribir([...nuevas, ...(await leerAlertas())].slice(0, MAX_ALERTAS))
  if (cfg.alertaNotificacion) notificar(nuevas, umbral)
  return nuevas
}

export async function marcarLeidas(ids: string[] | null = null): Promise<Alerta[]> {
  const todas = await leerAlertas()
  const cuales = ids ? new Set(ids) : null
  return escribir(todas.map((a) => (!cuales || cuales.has(a.tender_id) ? { ...a, leida: true } : a)))
}

export async function borrarAlertas(): Promise<Alerta[]> {
  // Las "vistas" se conservan: borrar la lista no tiene que volver a avisar de
  // lo mismo en la siguiente descarga.
  return escribir([])
}

export function notificacionesDisponibles(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

/** Pide el permiso de notificaciones. Tiene que llamarse desde un clic. */
export async function pedirPermisoNotificaciones(): Promise<NotificationPermission | 'no-disponible'> {
  if (!notificacionesDisponibles()) return 'no-disponible'
  if (Notification.permission !== 'default') return Notification.permission
  return Notification.requestPermission()
}

function notificar(nuevas: Alerta[], umbral: number): void {
  if (!notificacionesDisponibles() || Notification.permission !== 'granted') return
  const primera = nuevas[0]
  if (!primera) return
  const cuerpo =
    nuevas.length === 1
      ? `${primera.score} pts · ${primera.titulo}`
      : `${nuevas.length} licitaciones nuevas por encima de ${umbral} pts. La mejor: ${primera.score} pts · ${primera.titulo}`
  try {
    new Notification('Licitaciones: oportunidad de score alto', { body: cuerpo.slice(0, 240), tag: 'licitaciones-alerta' })
  } catch {
    /* algunos navegadores solo dejan notificar desde un service worker */
  }
}
