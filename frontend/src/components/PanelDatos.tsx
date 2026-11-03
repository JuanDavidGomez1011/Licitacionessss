import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { Config } from '../lib/tipos'

/**
 * Ajustes de la descarga.
 *
 * El token y los topes vivian solo en `public/app-config.json`: para cambiarlos
 * habia que editar el fichero y, en el build, volver a compilar. Eso hacia que
 * "baja maxProcesos" fuese un consejo imposible para quien usa la pagina
 * publicada. Aqui se guardan en localStorage, que manda sobre el fichero, y se
 * aplican en la siguiente descarga sin recargar.
 *
 * La decision de producto es explicita: por defecto se bajan 5.000 procesos y
 * 2.000 contratos (rapido y sin token), y la ventana completa de 7 dias es un
 * preset opt-in que pide appToken. Sin token, Socrata puede cortar la descarga
 * a mitad con 429/503.
 */

const RAPIDA = { maxProcesos: 5000, maxContratos: 2000 }
const COMPLETA = { maxProcesos: 50000, maxContratos: 50000 }

/** Lo que edita el formulario: los numeros llegan como texto de los inputs. */
type Borrador = Omit<
  Config,
  'lookbackDays' | 'maxProcesos' | 'maxContratos' | 'maxProcesosSecopI' | 'autoSyncMinutos'
> & {
  lookbackDays: number | string
  maxProcesos: number | string
  maxContratos: number | string
  maxProcesosSecopI: number | string
  autoSyncMinutos: number | string
}

function entero(valor: number | string, minimo = 1): number | null {
  const n = Number(valor)
  return Number.isFinite(n) && n >= minimo ? Math.floor(n) : null
}

export default function PanelDatos({
  onCerrar,
  onGuardado,
}: {
  onCerrar: () => void
  onGuardado?: (c: Config) => void | Promise<void>
}) {
  const [borrador, setBorrador] = useState<Borrador | null>(null)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mensaje, setMensaje] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    api
      .configuracion()
      .then((c) => {
        if (vivo) setBorrador({ ...c, appToken: c.appToken || '' })
      })
      .catch((e: unknown) => {
        if (vivo) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      vivo = false
    }
  }, [])

  const cambiar = <K extends keyof Borrador>(campo: K, valor: Borrador[K]) =>
    setBorrador((b) => (b ? { ...b, [campo]: valor } : b))

  const preset = (valores: Partial<Borrador>) => {
    setBorrador((b) => (b ? { ...b, ...valores } : b))
    setMensaje(null)
  }

  const guardar = async () => {
    if (!borrador) return
    setError(null)
    setMensaje(null)

    const maxProcesos = entero(borrador.maxProcesos)
    const maxContratos = entero(borrador.maxContratos, 0)
    const lookbackDays = entero(borrador.lookbackDays)
    const maxProcesosSecopI = entero(borrador.maxProcesosSecopI ?? 2000, 0)
    const autoSyncMinutos = entero(borrador.autoSyncMinutos ?? 60, 5)
    if (!maxProcesos || maxContratos === null || !lookbackDays || maxProcesosSecopI === null) {
      setError('Los dias y los topes tienen que ser numeros enteros (los contratos pueden ser 0).')
      return
    }
    if (borrador.autoSync && !autoSyncMinutos) {
      setError('La sincronización periódica necesita un intervalo de 5 minutos o más.')
      return
    }

    setGuardando(true)
    try {
      const guardado = await api.guardarConfig({
        appToken: String(borrador.appToken || '').trim(),
        lookbackDays,
        maxProcesos,
        maxContratos,
        includeContracts: Boolean(borrador.includeContracts),
        incluirSecopI: borrador.incluirSecopI !== false,
        maxProcesosSecopI,
        autoSync: Boolean(borrador.autoSync),
        autoSyncMinutos: autoSyncMinutos ?? 60,
      })
      setBorrador({ ...guardado, appToken: guardado.appToken || '' })
      setMensaje('Guardado. Se aplica en la proxima descarga.')
      await onGuardado?.(guardado)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGuardando(false)
    }
  }

  const cerrar = (
    <button type="button" className="cerrar" onClick={onCerrar} aria-label="Cerrar">
      ×
    </button>
  )

  if (!borrador) {
    return (
      <div className="overlay" onClick={onCerrar}>
        <div className="modal perfil-modal" onClick={(e) => e.stopPropagation()}>
          <header className="modal-head">
            <div>
              <h2>Datos y descarga</h2>
              <p className="entidad">Ajustes de Socrata para este navegador.</p>
            </div>
            {cerrar}
          </header>
          <div className="perfil-form">
            <p className="cargando">{error || 'Cargando ajustes…'}</p>
          </div>
        </div>
      </div>
    )
  }

  const sinToken = !String(borrador.appToken || '').trim()
  const topeAlto = Number(borrador.maxProcesos) > RAPIDA.maxProcesos

  return (
    <div className="overlay" onClick={onCerrar}>
      <div className="modal perfil-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Datos y descarga</h2>
            <p className="entidad">
              Se guardan en este navegador y mandan sobre <code>app-config.json</code>.
            </p>
          </div>
          {cerrar}
        </header>

        <div className="perfil-form">
          <label>
            <span>App token de Socrata (opcional)</span>
            <input
              aria-label="App token de Socrata"
              value={borrador.appToken || ''}
              onChange={(e) => cambiar('appToken', e.target.value)}
              placeholder="Pégalo aquí"
              autoComplete="off"
              spellCheck={false}
            />
            <small>
              Se obtiene en datos.gov.co. Sin token, Socrata puede devolver 429/503 y cortar la
              descarga; con él, el límite es mucho más alto.
            </small>
          </label>

          <div className="config-presets">
            <button type="button" className="btn fantasma" onClick={() => preset(RAPIDA)}>
              Rápida · 5.000 procesos
            </button>
            <button type="button" className="btn fantasma" onClick={() => preset(COMPLETA)}>
              Ventana completa · 7 días
            </button>
          </div>

          <div className="perfil-dinero">
            <label>
              <span>Días hacia atrás</span>
              <input
                type="number"
                min="1"
                value={borrador.lookbackDays ?? 7}
                onChange={(e) => cambiar('lookbackDays', e.target.value)}
              />
            </label>
            <label>
              <span>Máximo de procesos</span>
              <input
                type="number"
                min="1"
                value={borrador.maxProcesos ?? 5000}
                onChange={(e) => cambiar('maxProcesos', e.target.value)}
              />
            </label>
            <label>
              <span>Máximo de contratos</span>
              <input
                type="number"
                min="0"
                value={borrador.maxContratos ?? 2000}
                onChange={(e) => cambiar('maxContratos', e.target.value)}
              />
            </label>
          </div>
          <small className="perfil-nota">
            La ventana completa de 7 días ronda los 24.000 procesos y 14.000 contratos (medido el
            29/10). Con topes altos y sin token, la descarga puede morir a mitad; con token es la
            opción recomendada.
          </small>

          <label className="config-check">
            <input
              type="checkbox"
              checked={Boolean(borrador.includeContracts)}
              onChange={(e) => cambiar('includeContracts', e.target.checked)}
            />
            <span>Descargar también contratos electrónicos</span>
          </label>

          <label className="config-check">
            <input
              type="checkbox"
              checked={borrador.incluirSecopI !== false}
              onChange={(e) => cambiar('incluirSecopI', e.target.checked)}
            />
            <span>Incluir procesos convocados de SECOP I</span>
            <input
              type="number"
              min="0"
              aria-label="Máximo de procesos de SECOP I"
              value={borrador.maxProcesosSecopI ?? 2000}
              onChange={(e) => cambiar('maxProcesosSecopI', e.target.value)}
            />
            <span>máx.</span>
          </label>

          <label className="config-check">
            <input
              type="checkbox"
              checked={Boolean(borrador.autoSync)}
              onChange={(e) => cambiar('autoSync', e.target.checked)}
            />
            <span>Sincronizar solo cada</span>
            <input
              type="number"
              min="5"
              aria-label="Minutos entre sincronizaciones"
              value={borrador.autoSyncMinutos ?? 60}
              onChange={(e) => cambiar('autoSyncMinutos', e.target.value)}
            />
            <span>minutos mientras la pestaña esté abierta</span>
          </label>
          <small className="perfil-nota">
            Cada pasada automática es incremental (desde la última descarga) y no duplica registros: los
            procesos se guardan por su id.
          </small>

          {sinToken && topeAlto && (
            <p className="config-aviso">
              Estás por encima de 5.000 procesos sin appToken. Si Socrata devuelve 429/503, vuelve
              a «Rápida» o registra el token.
            </p>
          )}

          {error && <p className="error">{error}</p>}
          {mensaje && <p className="ok">{mensaje}</p>}
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn" disabled={guardando} onClick={guardar}>
            {guardando ? 'Guardando…' : 'Guardar ajustes'}
          </button>
          <button type="button" className="btn fantasma" onClick={onCerrar}>
            Cerrar
          </button>
        </footer>
      </div>
    </div>
  )
}
