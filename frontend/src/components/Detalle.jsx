import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { formatDate, formatMoney, formatNumber } from '../lib/format'

/** Las pestañas reciben un array de `{clave, etiqueta, contenido}`.
 *
 * Antes se derivaba la etiqueta de `Object.keys(children)`, que sobre los hijos
 * estaticos de JSX devuelve `['0','1','2','3']`: las pestañas se veian numeradas.
 */
function Pestanas({ pestanas, actual, onChange }) {
  return (
    <div className="pestanas">
      <div className="pestanas-btns" role="tablist">
        {pestanas.map((p) => (
          <button
            key={p.clave}
            type="button"
            role="tab"
            aria-selected={actual === p.clave}
            className={actual === p.clave ? 'activa' : ''}
            onClick={() => onChange(p.clave)}
          >
            {p.etiqueta}
          </button>
        ))}
      </div>
      <div className="pestanas-body" role="tabpanel">
        {pestanas.find((p) => p.clave === actual)?.contenido}
      </div>
    </div>
  )
}

export default function Detalle({ id, version = 0, onAccion, onCerrar }) {
  const [datos, setDatos] = useState(null)
  const [similares, setSimilares] = useState([])
  const [pestana, setPestana] = useState('resumen')
  const [error, setError] = useState(null)
  const [ocupado, setOcupado] = useState(true)

  useEffect(() => {
    let vivo = true
    setOcupado(true)
    setError(null)
    Promise.all([
      api.detalle(id),
      api.similares(id, 5).catch(() => ({ items: [] })),
    ])
      .then(([d, s]) => {
        if (!vivo) return
        setDatos(d)
        setSimilares(s.items || [])
      })
      .catch((e) => vivo && setError(e.message))
      .finally(() => vivo && setOcupado(false))
    return () => {
      vivo = false
    }
  }, [id, version])

  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onCerrar()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onCerrar])

  if (error) {
    return (
      <div className="overlay" onClick={onCerrar}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <p className="error">No se pudo cargar el detalle: {error}</p>
          <button type="button" className="btn" onClick={onCerrar}>
            Cerrar
          </button>
        </div>
      </div>
    )
  }

  if (ocupado || !datos) {
    return (
      <div className="overlay" onClick={onCerrar}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <p className="cargando">Cargando detalle…</p>
        </div>
      </div>
    )
  }

  const { licitacion: op, match, ocds, contratos, acciones } = datos
  const aplicadas = new Set((acciones || []).map((a) => a.accion))

  return (
    <div className="overlay" onClick={onCerrar}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{op.titulo || 'Sin título'}</h2>
            <p className="entidad">{op.entidad}</p>
            <p className="ref">
              {op.referencia_del_proceso} · {op.id_del_proceso}
            </p>
          </div>
          <button type="button" className="cerrar" onClick={onCerrar} aria-label="Cerrar">
            ×
          </button>
        </header>

        <div className="modal-acciones">
          {['guardar', 'ocultar', 'descartar'].map((a) => (
            <button
              key={a}
              type="button"
              className={`btn ${a}${aplicadas.has(a) ? ' activa' : ''}`}
              onClick={() => onAccion(op.id_del_proceso, a)}
            >
              {a}
            </button>
          ))}
          {op.url_proceso && (
            <a className="btn fantasma" href={op.url_proceso} target="_blank" rel="noreferrer">
              Abrir en SECOP ↗
            </a>
          )}
        </div>

        <Pestanas
          actual={pestana}
          onChange={setPestana}
          pestanas={[
            {
              clave: 'resumen',
              etiqueta: 'Resumen',
              contenido: <Resumen op={op} match={match} contratos={contratos} />,
            },
            {
              clave: 'ia',
              etiqueta: 'Análisis IA',
              contenido: (
                <div>
                  {match?.bullets?.length > 0 ? (
                    <ul className="bullets">
                      {match.bullets.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="vacio">Sin análisis de IA para esta licitación.</p>
                  )}
                  {match?.rationale && <p className="rationale">{match.rationale}</p>}
                  <h4>Palabras clave que coinciden</h4>
                  <p>{match?.matched_keywords?.join(', ') || '—'}</p>
                  <h4>Brechas detectadas</h4>
                  <p>{match?.gaps?.join(', ') || '—'}</p>
                  <h4>Trazabilidad</h4>
                  <p className="mono">
                    modelo {match?.model || '—'} · similitud{' '}
                    {match?.semantic_similarity !== null && match?.semantic_similarity !== undefined
                      ? match.semantic_similarity.toFixed(3)
                      : '—'}{' '}
                    · puntuado {formatDate(match?.scored_at)}
                  </p>
                </div>
              ),
            },
            {
              clave: 'similares',
              etiqueta: 'Similares',
              contenido: (
                <div>
                  {similares.length === 0 ? (
                    <p className="vacio">
                      Sin licitaciones similares (falta el embedding de esta ficha).
                    </p>
                  ) : (
                    <ul className="similares">
                      {similares.map((s) => (
                        <li key={s.oportunidad.id_del_proceso}>
                          <span className="sim">{(s.similitud * 100).toFixed(0)}%</span>
                          <div>
                            <strong>{s.oportunidad.titulo}</strong>
                            <p>{s.oportunidad.entidad}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ),
            },
            {
              clave: 'ocds',
              etiqueta: 'OCDS',
              contenido: <pre className="json">{JSON.stringify(ocds, null, 2)}</pre>,
            },
          ]}
        />
      </div>
    </div>
  )
}

function Resumen({ op, match, contratos }) {
  return (
    <div>
      <dl className="datos full">
        <div>
          <dt>Presupuesto base</dt>
          <dd>{formatMoney(op.precio_base)}</dd>
        </div>
        <div>
          <dt>Modalidad</dt>
          <dd>{op.modalidad || '—'}</dd>
        </div>
        <div>
          <dt>Estado</dt>
          <dd>{op.estado || '—'}</dd>
        </div>
        <div>
          <dt>Categoría UNSPSC</dt>
          <dd>{op.categoria || '—'}</dd>
        </div>
        <div>
          <dt>Lotes</dt>
          <dd>{formatNumber(op.lotes)}</dd>
        </div>
        <div>
          <dt>Score</dt>
          <dd>{match?.score ?? '—'}</dd>
        </div>
        <div>
          <dt>Ciudad</dt>
          <dd>{op.ciudad || '—'}</dd>
        </div>
        <div>
          <dt>Departamento</dt>
          <dd>{op.departamento || '—'}</dd>
        </div>
        <div>
          <dt>Publicada</dt>
          <dd>{formatDate(op.fecha_publicacion)}</dd>
        </div>
        <div>
          <dt>Apertura de respuestas</dt>
          <dd>{formatDate(op.fecha_apertura_respuesta)}</dd>
        </div>
      </dl>

      {op.descripcion && (
        <>
          <h4>Descripción</h4>
          <p className="descripcion">{op.descripcion}</p>
        </>
      )}

      <h4>Contratos asociados ({contratos?.length || 0})</h4>
      {contratos?.length ? (
        <ul className="contratos">
          {contratos.map((c) => (
            <li key={c.id_contrato}>
              <span className="mono">{c.id_contrato}</span>
              <span>{c.proveedor || 'Sin proveedor'}</span>
              <span>{formatMoney(c.valor)}</span>
              <span>{formatDate(c.fecha_firma)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="vacio">Sin contratos asociados en la base local.</p>
      )}
    </div>
  )
}
