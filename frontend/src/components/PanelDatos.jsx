import { useEffect, useState } from 'react'
import { api } from '../lib/api'

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

function entero(valor, minimo = 1) {
  const n = Number(valor)
  return Number.isFinite(n) && n >= minimo ? Math.floor(n) : null
}

export default function PanelDatos({ onCerrar, onGuardado }) {
  const [borrador, setBorrador] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)
  const [mensaje, setMensaje] = useState(null)

  useEffect(() => {
    let vivo = true
    api
      .configuracion()
      .then((c) => {
        if (vivo) setBorrador({ ...c, appToken: c.appToken || '' })
      })
      .catch((e) => {
        if (vivo) setError(e.message)
      })
    return () => {
      vivo = false
    }
  }, [])

  const cambiar = (campo, valor) => setBorrador((b) => ({ ...b, [campo]: valor }))

  const preset = (valores) => {
    setBorrador((b) => ({ ...b, ...valores }))
    setMensaje(null)
  }

  const guardar = async () => {
    setError(null)
    setMensaje(null)

    const maxProcesos = entero(borrador.maxProcesos)
    const maxContratos = entero(borrador.maxContratos, 0)
    const lookbackDays = entero(borrador.lookbackDays)
    if (!maxProcesos || maxContratos === null || !lookbackDays) {
      setError('Los dias y los topes tienen que ser numeros enteros (los contratos pueden ser 0).')
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
      })
      setBorrador({ ...guardado, appToken: guardado.appToken || '' })
      setMensaje('Guardado. Se aplica en la proxima descarga.')
      onGuardado?.(guardado)
    } catch (e) {
      setError(e.message)
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
