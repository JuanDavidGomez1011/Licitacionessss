import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { notificacionesDisponibles, pedirPermisoNotificaciones, suscribirseAlertas } from '../lib/alertas'
import { formatDateTime } from '../lib/format'
import type { Alerta, Config } from '../lib/tipos'

/**
 * Campana de alertas: oportunidades que entraron con un score por encima del
 * umbral (80 por defecto). La lista vive en el navegador; la notificacion del
 * sistema es opcional y pide permiso con un clic.
 */
export default function PanelAlertas({ onDetalle }: { onDetalle: (id: string) => void }) {
  const [alertas, setAlertas] = useState<Alerta[]>([])
  const [abierto, setAbierto] = useState(false)
  const [cfg, setCfg] = useState<Pick<Config, 'alertas' | 'alertaUmbral' | 'alertaNotificacion'> | null>(null)
  const [mensaje, setMensaje] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    Promise.resolve(api.alertas?.())
      .then((a) => {
        if (vivo) setAlertas(a ?? [])
      })
      .catch(() => {
        /* sin alertas no se rompe nada */
      })
    const desuscribir = suscribirseAlertas(setAlertas)
    return () => {
      vivo = false
      desuscribir()
    }
  }, [])

  useEffect(() => {
    if (!abierto || cfg) return
    api
      .configuracion()
      .then((c) =>
        setCfg({
          alertas: c.alertas ?? true,
          alertaUmbral: c.alertaUmbral ?? 80,
          alertaNotificacion: c.alertaNotificacion ?? false,
        }),
      )
      .catch(() => setCfg({ alertas: true, alertaUmbral: 80, alertaNotificacion: false }))
  }, [abierto, cfg])

  const sinLeer = alertas.filter((a) => !a.leida).length

  const guardar = async (parcial: Partial<Pick<Config, 'alertas' | 'alertaUmbral' | 'alertaNotificacion'>>) => {
    if (!cfg) return
    const siguiente = { ...cfg, ...parcial }
    setCfg(siguiente)
    await api.guardarConfig(parcial)
    setMensaje('Guardado. Se aplica en la próxima descarga.')
  }

  const alternarNotificaciones = async (activar: boolean) => {
    if (activar) {
      const permiso = await pedirPermisoNotificaciones()
      if (permiso !== 'granted') {
        setMensaje(
          permiso === 'no-disponible'
            ? 'Este navegador no tiene notificaciones.'
            : 'El navegador no dio permiso para notificar; las alertas siguen saliendo aquí.',
        )
        return
      }
    }
    await guardar({ alertaNotificacion: activar })
  }

  const abrir = (a: Alerta) => {
    void api.marcarAlertasLeidas([a.tender_id])
    setAbierto(false)
    onDetalle(a.tender_id)
  }

  return (
    <div className="alertas">
      <button
        type="button"
        className={`btn fantasma campana${sinLeer ? ' con-alertas' : ''}`}
        aria-expanded={abierto}
        onClick={() => setAbierto((v) => !v)}
        title="Licitaciones nuevas con score alto"
      >
        Alertas{sinLeer ? ` (${sinLeer})` : ''}
      </button>

      {abierto && (
        <div className="alertas-panel" role="dialog" aria-label="Alertas de score alto">
          <div className="alertas-head">
            <strong>Alertas</strong>
            {alertas.length > 0 && (
              <>
                <button type="button" className="btn fantasma mini" onClick={() => void api.marcarAlertasLeidas()}>
                  Marcar leídas
                </button>
                <button type="button" className="btn fantasma mini" onClick={() => void api.borrarAlertas()}>
                  Vaciar
                </button>
              </>
            )}
          </div>

          {alertas.length === 0 ? (
            <p className="vacio-nota">
              Sin alertas. Cuando una descarga traiga licitaciones por encima de {cfg?.alertaUmbral ?? 80} pts,
              aparecerán aquí.
            </p>
          ) : (
            <ul className="alertas-lista">
              {alertas.map((a) => (
                <li key={`${a.tender_id}-${a.creada_en}`} className={a.leida ? 'leida' : ''}>
                  <span className="score-mini">{a.score}</span>
                  <button type="button" className="linkish" onClick={() => abrir(a)}>
                    {a.titulo}
                  </button>
                  <small>
                    {a.entidad || '—'} · {formatDateTime(a.creada_en)}
                  </small>
                </li>
              ))}
            </ul>
          )}

          {cfg && (
            <div className="alertas-config">
              <label className="config-check">
                <input type="checkbox" checked={cfg.alertas} onChange={(e) => void guardar({ alertas: e.target.checked })} />
                <span>Avisar de licitaciones con score superior a</span>
                <input
                  type="number"
                  aria-label="Umbral de alerta"
                  min={0}
                  max={100}
                  value={cfg.alertaUmbral}
                  onChange={(e) => setCfg({ ...cfg, alertaUmbral: Number(e.target.value) })}
                  onBlur={(e) => void guardar({ alertaUmbral: Math.min(100, Math.max(0, Number(e.target.value) || 80)) })}
                />
                <span>pts</span>
              </label>
              {notificacionesDisponibles() && (
                <label className="config-check">
                  <input
                    type="checkbox"
                    checked={cfg.alertaNotificacion}
                    onChange={(e) => void alternarNotificaciones(e.target.checked)}
                  />
                  <span>Notificación del sistema</span>
                </label>
              )}
              {mensaje && <small className="ok">{mensaje}</small>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
