const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
})

const NUM = new Intl.NumberFormat('es-CO')

export function formatMoney(value) {
  if (value === null || value === undefined) return 'Sin presupuesto'
  return COP.format(value)
}

export function formatCompact(value) {
  if (value === null || value === undefined) return '—'
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1).replace('.0', '')} mil M`
  if (value >= 1e6) return `$${Math.round(value / 1e6)} M`
  if (value >= 1e3) return `$${Math.round(value / 1e3)} K`
  return COP.format(value)
}

export function formatDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function formatDateTime(value) {
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

export function formatNumber(value) {
  if (value === null || value === undefined) return '—'
  return NUM.format(value)
}

/** Semáforo del score: verde >= 70, amarillo 40-69, rojo < 40. */
export function scoreColor(score) {
  if (score === null || score === undefined) return 'none'
  if (score >= 70) return 'alta'
  if (score >= 40) return 'media'
  return 'baja'
}

export function scoreLabel(score) {
  if (score === null || score === undefined) return 'Sin puntuar'
  if (score >= 70) return 'Alta'
  if (score >= 40) return 'Media'
  return 'Baja'
}

/** Texto de la cuenta regresiva; null si no hay fecha de apertura. */
export function countdown(diasRestantes) {
  if (diasRestantes === null || diasRestantes === undefined) return null
  if (diasRestantes < 0) return { texto: 'Cerrada', clase: 'cerrada' }
  if (diasRestantes === 0) return { texto: 'Cierra hoy', clase: 'urgente' }
  if (diasRestantes === 1) return { texto: 'Cierra mañana', clase: 'urgente' }
  if (diasRestantes <= 3) return { texto: `Cierra en ${diasRestantes} días`, clase: 'urgente' }
  if (diasRestantes <= 10) return { texto: `${diasRestantes} días`, clase: 'proximo' }
  return { texto: `${diasRestantes} días`, clase: 'lejano' }
}
