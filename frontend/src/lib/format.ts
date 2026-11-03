import type { Nivel } from './tipos'

const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
})

const NUM = new Intl.NumberFormat('es-CO')

type Num = number | null | undefined
type Fecha = string | number | Date | null | undefined

export function formatMoney(value: Num): string {
  if (value === null || value === undefined) return 'Sin presupuesto'
  return COP.format(value)
}

export function formatCompact(value: Num): string {
  if (value === null || value === undefined) return '—'
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1).replace('.0', '')} mil M`
  if (value >= 1e6) return `$${Math.round(value / 1e6)} M`
  if (value >= 1e3) return `$${Math.round(value / 1e3)} K`
  return COP.format(value)
}

export function formatDate(value: Fecha): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function formatDateTime(value: Fecha): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('es-CO', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatNumber(value: Num): string {
  if (value === null || value === undefined) return '—'
  return NUM.format(value)
}

/** Cortes del semaforo. Los usan la tarjeta, las estadisticas y las alertas. */
export const CORTE_ALTO = 70
export const CORTE_MEDIO = 40

/** Semaforo del score: Alto >= 70, Medio 40-69, Bajo < 40. */
export function nivelDe(score: Num): Nivel | null {
  if (score === null || score === undefined) return null
  if (score >= CORTE_ALTO) return 'alta'
  if (score >= CORTE_MEDIO) return 'media'
  return 'baja'
}

export function scoreColor(score: Num): Nivel | 'none' {
  return nivelDe(score) ?? 'none'
}

export function scoreLabel(score: Num): string {
  const nivel = nivelDe(score)
  if (nivel === 'alta') return 'Alto'
  if (nivel === 'media') return 'Medio'
  if (nivel === 'baja') return 'Bajo'
  return 'Sin puntuar'
}

export interface Cuenta {
  texto: string
  clase: 'cerrada' | 'urgente' | 'proximo' | 'lejano'
}

/** Texto de la cuenta regresiva; null si no hay fecha de apertura. */
export function countdown(diasRestantes: Num): Cuenta | null {
  if (diasRestantes === null || diasRestantes === undefined) return null
  if (diasRestantes < 0) return { texto: 'Cerrada', clase: 'cerrada' }
  if (diasRestantes === 0) return { texto: 'Cierra hoy', clase: 'urgente' }
  if (diasRestantes === 1) return { texto: 'Cierra mañana', clase: 'urgente' }
  if (diasRestantes <= 3) return { texto: `Cierra en ${diasRestantes} días`, clase: 'urgente' }
  if (diasRestantes <= 10) return { texto: `${diasRestantes} días`, clase: 'proximo' }
  return { texto: `${diasRestantes} días`, clase: 'lejano' }
}

/** Dias que faltan hasta una fecha (redondeando hacia arriba), o null. */
export function diasHasta(fecha: string | null | undefined, ahora: number = Date.now()): number | null {
  if (!fecha) return null
  const ms = Date.parse(fecha)
  if (Number.isNaN(ms)) return null
  return Math.ceil((ms - ahora) / 86400000)
}
