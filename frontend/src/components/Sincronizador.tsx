import { useEffect, useRef, useState } from 'react'
import { api, type EstadoSync } from '../lib/api'
import { detenerAutoSync, programarAutoSync, suscribirseAutoSync, type EstadoAutoSync } from '../lib/autosync'
import { suscribirseIngesta, type EstadoIngesta, type FaseIngesta, type ModoVentana } from '../lib/ingesta'
import { formatDateTime, formatNumber } from '../lib/format'
import type { Config } from '../lib/tipos'

/**
 * Boton "Descargar SECOP" con progreso real y opcion de cancelar.
 *
 * Sustituye a `EstadoSync.jsx`, que estaba escrito para un backend: lanzaba un
 * `POST /api/sync/background` y se quedaba mirando un polling cada 4 s a la
 * espera de que un proceso de Python cogiera un lock. Todo eso sobra. Ahora:
 *
 *   - el progreso viene de un `suscribirse` al modulo de ingesta, no de polling
 *   - se puede cancelar, cosa que antes no habia: la descarga corria en el
 *     servidor y no habia quien la parara
 *   - la sincronizacion periodica es opt-in (panel Datos) y solo corre con la
 *     pestana abierta
 */

const FASES: Partial<Record<FaseIngesta, string>> = {
  procesos: 'procesos',
  secop1: 'SECOP I',
  contratos: 'contratos',
  puntuacion: 'puntuando',
  repuntuando: 'repuntuando',
  listo: 'listo',
  repuntuado: 'repuntuando',
  cancelado: 'cancelado',
  error: 'error',
}

/** Lo que se dice al acabar, segun como haya acabado. */
const FIN_DE: Partial<Record<FaseIngesta, string | null>> = {
  cancelado: 'Descarga cancelada',
  repuntuado: 'Repuntuación terminada',
  listo: 'Descarga terminada',
  interrumpida: 'Descarga interrumpida',
  error: null,
}

/** Lo que pinta el componente: el estado vivo de la ingesta mas lo persistido. */
type Estado = Partial<EstadoIngesta> & Partial<EstadoSync>

export default function Sincronizador({ alTerminar }: { alTerminar?: () => void | Promise<void> }) {
  const [estado, setEstado] = useState<Estado | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mensaje, setMensaje] = useState<string | null>(null)
  const [modo, setModo] = useState<ModoVentana>('lookback')
  const [dias, setDias] = useState(7)
  const [auto, setAuto] = useState<EstadoAutoSync | null>(null)
  const antesCorriendo = useRef(false)

  useEffect(() => suscribirseIngesta((e) => setEstado((prev) => ({ ...(prev || {}), ...e }))), [])
  useEffect(() => suscribirseAutoSync(setAuto), [])

  // Una sola peticion al ultimo estado guardado, para pintar "ultima: ..." al
  // abrir la pagina sin tener que lanzar nada.
  useEffect(() => {
    let vivo = true
    api
      .estadoSync()
      .then((e) => {
        if (vivo) setEstado((prev) => ({ ...(prev || {}), ...e }))
      })
      .catch(() => {
        /* el panel funciona igual sin el dato */
      })
    return () => {
      vivo = false
    }
  }, [])

  // La ventana por defecto y la sincronizacion periodica se configuran en el
  // panel Datos. Se leen al montar y se escucha el aviso de `guardarConfig`
  // para que el selector no siga diciendo "ultimos 7 dias" cuando el usuario
  // acaba de poner 30, y para (re)programar el autosync sin recargar.
  useEffect(() => {
    let vivo = true
    const aplicar = (c: Partial<Config> | null | undefined) => {
      setDias(Number(c?.lookbackDays) || 7)
      if (c?.autoSync) {
        programarAutoSync(Number(c.autoSyncMinutos) || 60, () => api.sincronizar({ modo: 'incremental' }))
      } else {
        detenerAutoSync()
      }
    }
    Promise.resolve(api.configuracion?.())
      .then((c) => {
        if (vivo) aplicar(c)
      })
      .catch(() => {})
    const alCambiar = (e: Event) => aplicar((e as CustomEvent<Config>).detail)
    window.addEventListener('licitaciones:config', alCambiar)
    return () => {
      vivo = false
      window.removeEventListener('licitaciones:config', alCambiar)
      detenerAutoSync()
    }
  }, [])

  // Cuando la ingesta pasa de en curso a terminada, la lista y los totales del
  // panel ya no valen: se recarga todo en bloque.
  useEffect(() => {
    const corriendo = Boolean(estado?.corriendo)
    if (antesCorriendo.current && !corriendo) {
      const fase = estado?.fase
      // Una descarga fallida no es una descarga terminada: el error ya se pinta
      // aparte y decir "terminada" al lado seria untrue.
      setMensaje(fase && fase in FIN_DE ? (FIN_DE[fase] ?? null) : 'Descarga terminada')
      void alTerminar?.()
    }
    antesCorriendo.current = corriendo
  }, [estado, alTerminar])

  const lanzar = async () => {
    setError(null)
    setMensaje(null)
    try {
      const r = await api.sincronizar({ modo })
      if (!r.lanzado) {
        setMensaje(r.mensaje || null)
        return
      }
      setMensaje('Descargando en esta pestaña… puedes seguir usando el panel')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const cancelar = async () => {
    try {
      await api.cancelarSync()
      setMensaje('Cancelando…')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const corriendo = Boolean(estado?.corriendo)
  const hechos = Number(estado?.hechos) || 0
  const total = Number(estado?.total) || 0
  const pct = total ? Math.min(100, Math.round((hechos / total) * 100)) : 0
  const fase = estado?.fase ?? null
  const etiquetaFase = (fase && FASES[fase]) || '…'

  return (
    <div className="sync">
      <button
        type="button"
        className="btn fantasma"
        onClick={lanzar}
        disabled={corriendo}
        title={corriendo ? 'Ya hay una descarga en curso' : 'Descargar SECOP II y SECOP I y puntuar en tu navegador'}
      >
        {corriendo ? 'Descargando…' : 'Descargar SECOP'}
      </button>

      {corriendo && (
        <button type="button" className="btn cancelar" onClick={cancelar} title="Parar la descarga">
          Cancelar
        </button>
      )}

      {corriendo && (
        <div className="sync-barra" title={`${hechos} de ${total} en ${etiquetaFase}`}>
          <div className="sync-fill" style={{ width: `${pct}%` }} />
          <span className="sync-texto">
            {etiquetaFase} {formatNumber(hechos)}
            {total ? ` / ${formatNumber(total)}` : ''}
            {estado?.nuevas ? ` · ${formatNumber(estado.nuevas)} nuevas` : ''}
            {estado?.repetidas ? ` · ${formatNumber(estado.repetidas)} repetidas` : ''}
          </span>
        </div>
      )}

      {!corriendo && estado?.ultimo?.started_at && (
        <span className="sync-ultima" title={estado.ultimo.error || 'Última descarga'}>
          última: {formatNumber(estado.ultimo.rows_inserted || 0)} nuevas · {formatDateTime(estado.ultimo.started_at)}
        </span>
      )}

      {!corriendo && auto?.activo && (
        <span className="sync-ultima" title="Sincronización periódica activada en el panel Datos">
          auto cada {auto.minutos} min · próxima {formatDateTime(auto.proxima)}
        </span>
      )}

      {fase === 'error' && estado?.error && <span className="sync-error">{estado.error}</span>}

      {/* Solo aparece tras recargar: la fase persistida sigue en una fase
          intermedia, cosa que significa que la pestana se cerro o recargo en
          mitad de la descarga. Sin este aviso, la pagina simplemente salia
          rara (con datos a medias o vacia) sin decir por que. */}
      {fase === 'interrumpida' && (
        <span
          className="sync-error"
          title="La descarga se cortó al recargar o cerrar la pestaña; lo ya descargado está guardado"
        >
          interrumpida ({formatNumber(hechos)}
          {total ? ` / ${formatNumber(total)}` : ''}) · pulsa Descargar para retomar
        </span>
      )}

      {!corriendo && (
        <select
          className="sync-modo"
          value={modo}
          onChange={(e) => setModo(e.target.value as ModoVentana)}
          title="Ventana de fechas a descargar"
        >
          <option value="lookback">últimos {dias} días</option>
          <option value="incremental">desde la última</option>
        </select>
      )}

      {mensaje && !error && <span className="sync-mensaje">{mensaje}</span>}
      {error && <span className="sync-error">{error}</span>}
    </div>
  )
}
