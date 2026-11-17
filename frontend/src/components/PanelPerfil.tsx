import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { PESOS_POR_DEFECTO } from '../lib/config'
import { PERFIL_POR_DEFECTO } from '../lib/perfil'
import type { Perfil, PesosScore } from '../lib/tipos'
import { NOMBRES_COMPONENTES } from './Tarjeta'

/**
 * Editor del perfil de empresa y de los pesos del score.
 *
 * Antes el perfil vivia en `backend/app/seed/profile.yaml` y se cambiaba
 * reescribiendo ese fichero y relanzando (`bootstrap.py --perfil`). Era el paso
 * que mas ahuyentaba de usar la herramienta: para corregir una palabra clave
 * habia que editar YAML y reiniciar. Ahora se edita aqui y se guarda en el
 * navegador (`meta:perfil`).
 *
 * Las listas se escriben separadas por comas a proposito: un `textarea` por
 * lista sale mas comodo que 16 casillas sueltas, y el error de teclear una coma
 * de mas no rompe nada (`normalizarPerfil` filtra vacios).
 */

type CampoLista = 'palabras_clave' | 'codigos_unspsc' | 'actividades' | 'modalidades_preferidas' | 'exclusiones' | 'departamentos_preferidos'

const CAMPOS_LISTA: { clave: CampoLista; etiqueta: string; ayuda: string }[] = [
  { clave: 'palabras_clave', etiqueta: 'Palabras clave', ayuda: 'Las estratégicas. Con 4 coincidencias el componente llega a 100.' },
  {
    clave: 'codigos_unspsc',
    etiqueta: 'Códigos UNSPSC',
    ayuda:
      'Segmento (2 dígitos), familia (4), clase (6) o producto (8). Ej.: 8010 asesoría y gestión, 8110 ingeniería y diseño, 8214 diseño gráfico.',
  },
  { clave: 'actividades', etiqueta: 'Actividades', ayuda: 'A qué se dedica la empresa, en frases.' },
  { clave: 'modalidades_preferidas', etiqueta: 'Modalidades preferidas', ayuda: 'Las que no estén aquí pierden 15 puntos.' },
  { clave: 'exclusiones', etiqueta: 'Exclusiones', ayuda: 'Cada coincidencia baja el score a 5 como máximo.' },
  { clave: 'departamentos_preferidos', etiqueta: 'Departamentos preferidos', ayuda: 'Los que no estén aquí pierden 10 puntos.' },
]

function listaATexto(lista: string[] | undefined): string {
  return (lista || []).join(', ')
}

/** El formulario relleno con un perfil. */
function borradorDe(perfil: Perfil): Borrador {
  return {
    nombre: perfil.nombre,
    descripcion: perfil.descripcion,
    presupuesto_minimo: perfil.presupuesto_minimo,
    presupuesto_maximo: perfil.presupuesto_maximo,
    listas: Object.fromEntries(CAMPOS_LISTA.map((c) => [c.clave, listaATexto(perfil[c.clave])])) as Record<CampoLista, string>,
  }
}

interface Borrador {
  nombre: string
  descripcion: string
  presupuesto_minimo: number | string | null
  presupuesto_maximo: number | string | null
  listas: Record<CampoLista, string>
}

export default function PanelPerfil({
  perfil,
  onGuardado,
  onCerrar,
}: {
  perfil: Perfil
  onGuardado?: (p: Perfil) => void | Promise<void>
  onCerrar: () => void
}) {
  const [borrador, setBorrador] = useState<Borrador>(() => borradorDe(perfil))
  const [pesos, setPesos] = useState<PesosScore>({ ...PESOS_POR_DEFECTO })
  const [guardando, setGuardando] = useState(false)
  const [repuntuando, setRepuntuando] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mensaje, setMensaje] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    api
      .configuracion()
      .then((c) => vivo && c?.pesos && setPesos({ ...PESOS_POR_DEFECTO, ...c.pesos }))
      .catch(() => {})
    return () => {
      vivo = false
    }
  }, [])

  const cambiar = <K extends keyof Borrador>(campo: K, valor: Borrador[K]) => setBorrador((b) => ({ ...b, [campo]: valor }))
  const cambiarLista = (clave: CampoLista, valor: string) =>
    setBorrador((b) => ({ ...b, listas: { ...b.listas, [clave]: valor } }))

  const guardar = async () => {
    setGuardando(true)
    setError(null)
    setMensaje(null)
    try {
      // Las listas vuelven a ser arrays; de eso se encarga `normalizarPerfil`.
      const guardado = await api.guardarPerfil({
        ...perfil,
        nombre: borrador.nombre,
        descripcion: borrador.descripcion,
        presupuesto_minimo: borrador.presupuesto_minimo === null ? null : String(borrador.presupuesto_minimo),
        presupuesto_maximo: borrador.presupuesto_maximo === null ? null : String(borrador.presupuesto_maximo),
        ...borrador.listas,
      })
      await api.guardarConfig({ pesos })
      setMensaje('Perfil guardado. Repuntúa para aplicarlo a lo ya descargado.')
      await onGuardado?.(guardado)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGuardando(false)
    }
  }

  const repuntuar = async () => {
    setRepuntuando(true)
    setError(null)
    setMensaje('Repuntuando todo lo descargado… puede tardar un rato. El panel se actualiza al terminar.')
    try {
      // Se lanza y se avisa: es la operacion larga (toda la store `procesos`), y
      // quien avisa al panel de que ha terminado es `Sincronizador`, que ya
      // escucha el fin de la ingesta para recargar la lista.
      await api.repuntuar()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setMensaje(null)
    } finally {
      setRepuntuando(false)
    }
  }

  // Solo rellena el formulario: no guarda. Lo guardado en este navegador manda
  // sobre el perfil por defecto, asi que es la forma de volver a el sin borrar
  // los datos; el usuario lo revisa y pulsa Guardar.
  const restablecer = () => {
    setBorrador(borradorDe(PERFIL_POR_DEFECTO))
    setError(null)
    setMensaje('Formulario con el perfil por defecto (Investigación, Diseño e Innovación). Pulsa Guardar perfil para aplicarlo.')
  }

  const sumaPesos = Object.values(pesos).reduce((a, b) => a + (Number(b) || 0), 0)

  return (
    <div className="overlay" onClick={onCerrar}>
      <div className="modal perfil-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Perfil de empresa</h2>
            <p className="entidad">Se usa para puntuar cada licitación. Vive solo en este navegador.</p>
          </div>
          <button type="button" className="cerrar" onClick={onCerrar} aria-label="Cerrar">
            ×
          </button>
        </header>

        <div className="perfil-form">
          <label>
            <span>Nombre</span>
            <input value={borrador.nombre || ''} onChange={(e) => cambiar('nombre', e.target.value)} />
          </label>

          <label>
            <span>Descripción</span>
            <textarea
              rows={4}
              value={borrador.descripcion || ''}
              onChange={(e) => cambiar('descripcion', e.target.value)}
              placeholder="Qué hace la organización, en qué temas y para quién."
            />
          </label>

          {CAMPOS_LISTA.map((c) => (
            <label key={c.clave}>
              <span>{c.etiqueta}</span>
              <textarea
                rows={2}
                value={borrador.listas[c.clave]}
                onChange={(e) => cambiarLista(c.clave, e.target.value)}
                placeholder="separadas por comas"
              />
              <small>{c.ayuda}</small>
            </label>
          ))}

          <div className="perfil-dinero">
            <label>
              <span>Presupuesto mínimo (COP)</span>
              <input
                type="number"
                value={borrador.presupuesto_minimo ?? ''}
                onChange={(e) => cambiar('presupuesto_minimo', e.target.value)}
              />
            </label>
            <label>
              <span>Presupuesto máximo (COP)</span>
              <input
                type="number"
                value={borrador.presupuesto_maximo ?? ''}
                onChange={(e) => cambiar('presupuesto_maximo', e.target.value)}
              />
            </label>
          </div>
          <small className="perfil-nota">
            Fuera de ese rango, la licitación se queda con 20 puntos como máximo.
          </small>

          <fieldset className="pesos">
            <legend>Pesos del score (se normalizan; suman {sumaPesos})</legend>
            {NOMBRES_COMPONENTES.map(({ clave, nombre }) => (
              <label key={clave}>
                <span>{nombre}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  aria-label={`Peso de ${nombre}`}
                  value={pesos[clave]}
                  onChange={(e) => setPesos((p) => ({ ...p, [clave]: Math.max(0, Number(e.target.value) || 0) }))}
                />
              </label>
            ))}
            <small className="perfil-nota">
              Un componente sin datos (p. ej. un proceso sin fecha de cierre) reparte su peso entre los demás.
            </small>
          </fieldset>

          {error && <p className="error">{error}</p>}
          {mensaje && <p className="ok">{mensaje}</p>}
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn" disabled={guardando} onClick={guardar}>
            {guardando ? 'Guardando…' : 'Guardar perfil'}
          </button>
          <button
            type="button"
            className="btn fantasma"
            disabled={repuntuando}
            onClick={repuntuar}
            title="Vuelve a puntuar todo lo ya descargado con este perfil"
          >
            {repuntuando ? 'Repuntuando…' : 'Repuntuar todo'}
          </button>
          <button
            type="button"
            className="btn fantasma"
            onClick={restablecer}
            title="Rellena el formulario con el perfil por defecto; no guarda hasta que pulses Guardar perfil"
          >
            Restablecer perfil por defecto
          </button>
          <button type="button" className="btn fantasma" onClick={onCerrar}>
            Cerrar
          </button>
        </footer>
      </div>
    </div>
  )
}
