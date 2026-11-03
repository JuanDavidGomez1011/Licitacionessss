import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { suscribirseIngesta } from '../lib/ingesta'
import { formatDateTime, formatNumber } from '../lib/format'

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
 *   - no hay ventana de gracia ni "cron desactivado", porque no hay cron
 *
 * El polling que queda es solo para "ultima sincronizacion", y son 4 s contra un
 * `localStorage`, que es instantaneo.
 */

const FASES = {
  procesos: 'procesos',
  contratos: 'contratos',
  puntuacion: 'puntuando',
  repuntuando: 'repuntuando',
  listo: 'listo',
  repuntuado: 'repuntuando',
  cancelado: 'cancelado',
  error: 'error',
}

/** Lo que se dice al acabar, segun como haya acabado. */
const FIN_DE = {
  cancelado: 'Descarga cancelada',
  repuntuado: 'Repuntuación terminada',
  listo: 'Descarga terminada',
  interrumpida: 'Descarga interrumpida',
  error: null,
}

export default function Sincronizador({ alTerminar }) {
  const [estado, setEstado] = useState(null)
  const [error, setError] = useState(null)
  const [mensaje, setMensaje] = useState(null)
  const [modo, setModo] = useState('lookback')
  const [dias, setDias] = useState(7)
  // El `AbortController` vive aqui: es lo unico que puede parar la descarga, y
  // tiene que sobrevivir a los renders.
  const control = useRef(null)
  const antesCorriendo = useRef(false)

  useEffect(() => suscribirseIngesta(setEstado), [])

  // Una sola peticion al ultimo estado guardado, para pintar "ultima: ..." al
  // abrir la pagina sin tener que lanzar nada.
  const refrescarUltima = useCallback(async () => {
    try {
      const e = await api.estadoSync()
      setEstado((prev) => ({ ...(prev || {}), ...e }))
    } catch {
      /* el panel funciona igual sin el dato */
    }
  }, [])

  useEffect(() => {
    refrescarUltima()
  }, [refrescarUltima])

  // La ventana por defecto se configura en el panel Datos. Se lee al montar y
  // se escucha el aviso de `guardarConfig` para que el selector no siga
  // diciendo "ultimos 7 dias" cuando el usuario acaba de poner 30.
  useEffect(() => {
    let vivo = true
    Promise.resolve(api.configuracion?.())
      .then((c) => {
        if (vivo) setDias(Number(c?.lookbackDays) || 7)
      })
      .catch(() => {})
    const alCambiar = (e) => setDias(Number(e.detail?.lookbackDays) || 7)
    window.addEventListener('licitaciones:config', alCambiar)
    return () => {
      vivo = false
      window.removeEventListener('licitaciones:config', alCambiar)
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
      setMensaje(fase in FIN_DE ? FIN_DE[fase] : 'Descarga terminada')
      alTerminar?.()
    }
    antesCorriendo.current = corriendo
  }, [estado, alTerminar])

  const lanzar = async () => {
    setError(null)
    setMensaje(null)
    try {
      const r = await api.sincronizar({ modo })
      if (!r.lanzado) {
        setMensaje(r.mensaje)
        return
      }
      setMensaje('Descargando en esta pestaña… puedes seguir usando el panel')
    } catch (e) {
      setError(e.message)
    }
  }

  const cancelar = async () => {
    try {
      await api.cancelarSync()
      setMensaje('Cancelando…')
    } catch (e) {
      setError(e.message)
    }
  }

  const corriendo = Boolean(estado?.corriendo)
  const hechos = Number(estado?.hechos) || 0
  const total = Number(estado?.total) || 0
  const pct = total ? Math.min(100, Math.round((hechos / total) * 100)) : 0

  return (
    <div className="sync">
      <button
        type="button"
        className="btn fantasma"
        onClick={lanzar}
        disabled={corriendo}
        title={corriendo ? 'Ya hay una descarga en curso' : 'Descargar SECOP II y puntuar en tu navegador'}
      >
        {corriendo ? 'Descargando…' : 'Descargar SECOP'}
      </button>

      {corriendo && (
        <button type="button" className="btn cancelar" onClick={cancelar} title="Parar la descarga">
          Cancelar
        </button>
      )}

      {corriendo && (
        <div className="sync-barra" title={`${hechos} de ${total} en ${FASES[estado?.fase] || estado?.fase || '…'}`}>
          <div className="sync-fill" style={{ width: `${pct}%` }} />
          <span className="sync-texto">
            {FASES[estado?.fase] || '…'} {formatNumber(hechos)}
            {total ? ` / ${formatNumber(total)}` : ''}
            {estado?.nuevas ? ` · ${formatNumber(estado.nuevas)} nuevas` : ''}
            {estado?.repetidas ? ` · ${formatNumber(estado.repetidas)} repetidas` : ''}
          </span>
        </div>
      )}

      {!corriendo && estado?.ultimo?.started_at && (
        <span className="sync-ultima" title={estado.ultimo.error || 'Última descarga'}>
          última: {formatNumber(estado.ultimo.rows_inserted || 0)} nuevas ·{' '}
          {formatDateTime(estado.ultimo.started_at)}
        </span>
      )}

      {estado?.fase === 'error' && estado.error && <span className="sync-error">{estado.error}</span>}

      {/* Solo aparece tras recargar: la fase persistida sigue en una fase
          intermedia, cosa que significa que la pestana se cerro o recargo en
          mitad de la descarga. Sin este aviso, la pagina simplemente salia
          rara (con datos a medias o vacia) sin decir por que. */}
      {estado?.fase === 'interrumpida' && (
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
          onChange={(e) => setModo(e.target.value)}
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