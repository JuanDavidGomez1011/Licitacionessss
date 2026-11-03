import { useRef, useState } from 'react'
import { api } from '../lib/api'
import { descargar, importar, perfilDeCabecera } from '../lib/snapshot'
import { formatNumber } from '../lib/format'

/**
 * Botones de "exportar / importar" y "borrar todo".
 *
 * Estan en la cabecera porque son operaciones sobre los datos de esta
 * maquina, no sobre el panel: lo que se guarda o se borra es el IndexedDB de este
 * navegador, y conviene que el boton lo diga.
 *
 * Borrar pide confirmacion doble a proposito. Con el backend esto era "borrar
 * tablas de PostgreSQL" y se podia rehacer descargando; aqui no: si alguien
 * limpia el almacen sin haber exportado, se ha perdido el trabajo de descarga.
 * Por eso el boton de borrar esta desactivado mientras la descarga esta en curso y
 * avisa de lo que se va a perder.
 */
export default function Respaldo({ alCambiar }) {
  const [mensaje, setMensaje] = useState(null)
  const [error, setError] = useState(null)
  const [ocupado, setOcupado] = useState(false)
  const [confirmando, setConfirmando] = useState(false)
  const archivo = useRef(null)
  const control = useRef(null)

  const run = async (fn) => {
    setOcupado(true)
    setError(null)
    setMensaje(null)
    control.current = new AbortController()
    try {
      await fn()
    } catch (e) {
      if (e?.name !== 'AbortError') setError(e.message)
      else setMensaje('Cancelado')
    } finally {
      setOcupado(false)
      control.current = null
    }
  }

  const exportarTodo = () =>
    run(async () => {
      setMensaje('Exportando…')
      const r = await descargar({ alProgresar: (p) => setMensaje(`Exportando ${formatNumber(p.hechos)} filas…`), signal: control.current.signal })
      setMensaje(
        `Guardado ${r.nombre}: ${formatNumber(r.total)} filas` +
          `${r.streamed ? '' : ' (sin escritura directa, tamaño limitado por la memoria)'}`,
      )
    })

  const importarArchivo = () => archivo.current?.click()

  const alElegir = (e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    run(async () => {
      setMensaje(`Importando ${f.name}…`)
      const r = await importar(f, {
        alProgresar: (p) => setMensaje(`Importadas ${formatNumber(p.guardadas)} filas…`),
        signal: control.current.signal,
      })
      const perfil = perfilDeCabecera(r.cabecera)
      let extra = ''
      if (perfil && perfil.nombre) {
        // El perfil NO se aplica solo: puntuaria contra otra empresa.
        extra = ` El fichero venía con el perfil "${perfil.nombre}", que no se ha aplicado.`
      }
      setMensaje(
        `Importadas ${formatNumber(r.leidas)} filas` +
          (r.ignoradas ? ` (${formatNumber(r.ignoradas)} descartadas)` : '') +
          extra,
      )
      // La importacion escribe en el almacen por fuera de la ingesta, asi que el
      // indice y el indice de texto de la pagina siguen siendo los de antes:
      // hay que olvidarlos o el panel ensenaria los datos viejos.
      await api.invalidarCache?.()
      alCambiar?.()
    })
  }

  const borrar = () =>
    run(async () => {
      setMensaje('Borrando los datos de este navegador…')
      await api.borrarTodo()
      setConfirmando(false)
      setMensaje('Datos borrados')
      alCambiar?.()
    })

  return (
    <div className="respaldo">
      <input ref={archivo} type="file" accept=".ndjson,.json,.txt" hidden onChange={alElegir} />

      <button type="button" className="btn fantasma" onClick={exportarTodo} disabled={ocupado}>
        Exportar
      </button>
      <button type="button" className="btn fantasma" onClick={importarArchivo} disabled={ocupado}>
        Importar
      </button>

      {confirmando ? (
        <>
          <span className="respaldo-aviso">
            Se borran procesos, puntuaciones y contratos de este navegador. Sin copia, no hay vuelta atrás.
          </span>
          <button type="button" className="btn borrar" onClick={borrar} disabled={ocupado}>
            Sí, borrar todo
          </button>
          <button type="button" className="btn fantasma" onClick={() => setConfirmando(false)}>
            Cancelar
          </button>
        </>
      ) : (
        <button type="button" className="btn fantasma" onClick={() => setConfirmando(true)} disabled={ocupado}>
          Borrar datos
        </button>
      )}

      {ocupado && control.current && (
        <button type="button" className="btn cancelar" onClick={() => control.current?.abort()}>
          Cancelar
        </button>
      )}

      {mensaje && <span className="sync-mensaje">{mensaje}</span>}
      {error && <span className="sync-error">{error}</span>}
    </div>
  )
}