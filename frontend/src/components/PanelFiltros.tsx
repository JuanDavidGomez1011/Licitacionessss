import { useState, type Dispatch, type SetStateAction } from 'react'
import type { BusquedaGuardada, Facetas, FiltrosUI, ValorFaceta } from '../lib/tipos'

type CampoLista = 'departamentos' | 'ciudades' | 'modalidades' | 'entidades' | 'estados' | 'fuentes'

export interface PanelFiltrosProps {
  filtros: FiltrosUI
  setFiltros: Dispatch<SetStateAction<FiltrosUI>>
  facetas: Facetas | null
  onLimpiar: () => void
  cargando: boolean
  busquedas?: BusquedaGuardada[]
  onGuardarBusqueda?: (nombre: string) => Promise<void> | void
  onAplicarBusqueda?: (b: BusquedaGuardada) => void
  onBorrarBusqueda?: (id: string) => Promise<void> | void
}

const numeroOVacio = (valor: string): number | '' => (valor === '' ? '' : Number(valor))

/**
 * Filtros de la lista. Todo se aplica en vivo: cada cambio vuelve a consultar
 * el indice en memoria, que tarda milisegundos.
 */
export default function PanelFiltros({
  filtros,
  setFiltros,
  facetas,
  onLimpiar,
  cargando,
  busquedas = [],
  onGuardarBusqueda,
  onAplicarBusqueda,
  onBorrarBusqueda,
}: PanelFiltrosProps) {
  const [nombreBusqueda, setNombreBusqueda] = useState('')
  const set = (patch: Partial<FiltrosUI>) => setFiltros((f) => ({ ...f, ...patch }))

  const alternar = (campo: CampoLista, valor: string) =>
    setFiltros((f) => {
      const actual = f[campo] || []
      return {
        ...f,
        [campo]: actual.includes(valor) ? actual.filter((v) => v !== valor) : [...actual, valor],
      }
    })

  const grupos: { campo: CampoLista; etiqueta: string; items: ValorFaceta[] | undefined }[] = [
    { campo: 'departamentos', etiqueta: 'Departamento', items: facetas?.departamentos },
    { campo: 'ciudades', etiqueta: 'Municipio', items: facetas?.ciudades },
    { campo: 'entidades', etiqueta: 'Entidad', items: facetas?.entidades },
    { campo: 'estados', etiqueta: 'Estado del proceso', items: facetas?.estados },
    { campo: 'modalidades', etiqueta: 'Modalidad', items: facetas?.modalidades },
    { campo: 'fuentes', etiqueta: 'Fuente', items: facetas?.fuentes },
  ]

  const guardar = async () => {
    if (!nombreBusqueda.trim() || !onGuardarBusqueda) return
    await onGuardarBusqueda(nombreBusqueda)
    setNombreBusqueda('')
  }

  return (
    <aside className="filtros">
      <div className="filtros-head">
        <h2>Filtros</h2>
        <button type="button" className="btn fantasma" onClick={onLimpiar}>
          Limpiar
        </button>
      </div>

      {onGuardarBusqueda && (
        <details className="grupo busquedas" open={busquedas.length > 0}>
          <summary>Búsquedas guardadas ({busquedas.length})</summary>
          {busquedas.length > 0 && (
            <ul className="opciones">
              {busquedas.map((b) => (
                <li key={b.id} className="busqueda">
                  <button type="button" className="linkish" onClick={() => onAplicarBusqueda?.(b)}>
                    {b.nombre}
                  </button>
                  <button
                    type="button"
                    className="btn fantasma mini"
                    aria-label={`Borrar la búsqueda ${b.nombre}`}
                    onClick={() => void onBorrarBusqueda?.(b.id)}
                  >
                    Borrar
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="guardar-busqueda">
            <input
              type="text"
              aria-label="Nombre de la búsqueda"
              value={nombreBusqueda}
              placeholder="Nombre (p. ej. Software Bogotá)"
              onChange={(e) => setNombreBusqueda(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void guardar()}
            />
            <button type="button" className="btn" disabled={!nombreBusqueda.trim()} onClick={() => void guardar()}>
              Guardar búsqueda
            </button>
          </div>
          <small className="perfil-nota">Se guardan en este navegador.</small>
        </details>
      )}

      {/* El buscador de texto libre va en la barra de encima de la lista, siempre
          a la vista: aqui solo quedan las palabras para afinar. */}
      <label className="campo">
        <span>Incluir (cualquiera de)</span>
        <input
          type="text"
          value={filtros.incluir}
          placeholder="aplicativo, licencias, nube"
          onChange={(e) => set({ incluir: e.target.value })}
        />
      </label>

      <label className="campo">
        <span>Excluir (ninguna de)</span>
        <input
          type="text"
          value={filtros.excluir}
          placeholder="obra, alimentos, vigilancia"
          onChange={(e) => set({ excluir: e.target.value })}
        />
      </label>

      <label className="campo">
        <span>
          Score mínimo: <strong>{filtros.score_min}</strong>
        </span>
        <input
          type="range"
          min="0"
          max="100"
          step="5"
          value={filtros.score_min}
          onChange={(e) => set({ score_min: Number(e.target.value) })}
        />
      </label>

      <div className="campo-doble">
        <label className="campo">
          <span>Cuantía mínima (COP)</span>
          <input
            type="number"
            min="0"
            step="1000000"
            value={filtros.precio_min}
            placeholder="Sin mínimo"
            onChange={(e) => set({ precio_min: numeroOVacio(e.target.value) })}
          />
        </label>
        <label className="campo">
          <span>Precio máximo (COP)</span>
          <input
            type="number"
            min="0"
            step="1000000"
            value={filtros.precio_max}
            placeholder="Sin límite"
            onChange={(e) => set({ precio_max: numeroOVacio(e.target.value) })}
          />
        </label>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={filtros.solo_por_vencer}
          onChange={(e) => set({ solo_por_vencer: e.target.checked, dias_por_vencer: e.target.checked ? 7 : '' })}
        />
        <span>Solo por vencer (7 días)</span>
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={filtros.solo_guardadas}
          onChange={(e) => set({ solo_guardadas: e.target.checked })}
        />
        <span>Solo guardadas</span>
      </label>

      {grupos.map(
        (g) =>
          (g.items?.length ?? 0) > 0 && (
            <details key={g.campo} className="grupo" open={g.campo === 'departamentos' || filtros[g.campo].length > 0}>
              <summary>
                {g.etiqueta}
                {filtros[g.campo].length > 0 ? ` (${filtros[g.campo].length})` : ''}
              </summary>
              <ul className="opciones">
                {g.items!.map((it) => {
                  const activo = filtros[g.campo].includes(it.valor)
                  return (
                    <li key={it.valor}>
                      <label className={activo ? 'activo' : ''}>
                        <input
                          type="checkbox"
                          checked={activo}
                          disabled={cargando}
                          onChange={() => alternar(g.campo, it.valor)}
                        />
                        <span className="etq">{it.valor}</span>
                        <span className="n">{it.n}</span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </details>
          ),
      )}
    </aside>
  )
}
