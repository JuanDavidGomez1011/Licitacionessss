export default function PanelFiltros({ filtros, setFiltros, facetas, onLimpiar, cargando }) {
  const set = (patch) => setFiltros((f) => ({ ...f, ...patch }))

  const alternar = (campo, valor) =>
    setFiltros((f) => {
      const actual = f[campo] || []
      return {
        ...f,
        [campo]: actual.includes(valor) ? actual.filter((v) => v !== valor) : [...actual, valor],
      }
    })

  const grupos = [
    { campo: 'departamentos', etiqueta: 'Departamento', items: facetas?.departamentos },
    { campo: 'modalidades', items: facetas?.modalidades },
    { campo: 'entidades', etiqueta: 'Entidad', items: facetas?.entidades },
  ]

  return (
    <aside className="filtros">
      <div className="filtros-head">
        <h2>Filtros</h2>
        <button type="button" className="btn fantasma" onClick={onLimpiar}>
          Limpiar
        </button>
      </div>

      <label className="campo">
        <span>Buscar</span>
        <input
          type="search"
          value={filtros.q}
          placeholder="software, Consulting,urez…"
          onChange={(e) => set({ q: e.target.value })}
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

      <label className="campo">
        <span>Precio máximo (COP)</span>
        <input
          type="number"
          min="0"
          step="1000000"
          value={filtros.precio_max}
          placeholder="Sin límite"
          onChange={(e) => set({ precio_max: e.target.value === '' ? '' : Number(e.target.value) })}
        />
      </label>

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
          g.items?.length > 0 && (
            <details key={g.campo} className="grupo" open={g.campo === 'departamentos'}>
              <summary>{g.etiqueta || g.campo}</summary>
              <ul className="opciones">
                {g.items.map((it) => {
                  const activo = (filtros[g.campo] || []).includes(it.valor)
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
