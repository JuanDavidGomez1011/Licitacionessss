/**
 * Sincronizacion periodica, mientras la pestana este abierta.
 *
 * El proyecto quito a proposito el cron del backend (se lanzaba solo cada media
 * hora y se comia la maquina). Esto es su sustituto opt-in: apagado por
 * defecto, se activa en el panel Datos, y solo corre mientras la pagina esta
 * abierta, porque no hay servidor que lo sostenga cuando se cierra. Cada disparo
 * es una descarga incremental (desde la ultima, con un dia de solape), asi que
 * no vuelve a bajar la ventana entera.
 */

type Disparo = () => Promise<unknown> | unknown

export interface EstadoAutoSync {
  activo: boolean
  minutos: number
  proxima: string | null
}

let temporizador: ReturnType<typeof setTimeout> | null = null
let estado: EstadoAutoSync = { activo: false, minutos: 0, proxima: null }
const oyentes = new Set<(e: EstadoAutoSync) => void>()

function emitir(parcial: Partial<EstadoAutoSync>): void {
  estado = { ...estado, ...parcial }
  for (const fn of oyentes) fn({ ...estado })
}

export function estadoAutoSync(): EstadoAutoSync {
  return { ...estado }
}

export function suscribirseAutoSync(fn: (e: EstadoAutoSync) => void): () => void {
  oyentes.add(fn)
  fn({ ...estado })
  return () => {
    oyentes.delete(fn)
  }
}

/** Para el temporizador, si lo hay. */
export function detenerAutoSync(): void {
  if (temporizador) clearTimeout(temporizador)
  temporizador = null
  emitir({ activo: false, proxima: null })
}

/**
 * Programa el siguiente disparo. Se re-programa tras cada uno (no
 * `setInterval`): si una descarga tarda mas que el intervalo, no se apilan.
 * El minimo es 5 minutos, para no martillear a Socrata sin token.
 */
export function programarAutoSync(minutos: number, disparar: Disparo): void {
  detenerAutoSync()
  const m = Math.max(5, Math.round(Number(minutos) || 0))
  const siguiente = () => {
    const ms = m * 60_000
    emitir({ activo: true, minutos: m, proxima: new Date(Date.now() + ms).toISOString() })
    temporizador = setTimeout(async () => {
      try {
        await disparar()
      } catch (error) {
        // Un fallo de red no apaga el ciclo: el error ya se ve en el sincronizador.
        console.warn('autosync:', error)
      }
      if (temporizador) siguiente()
    }, ms)
  }
  siguiente()
}
