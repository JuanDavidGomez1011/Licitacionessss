import { countdown, formatCompact, formatDate, scoreColor, scoreLabel } from '../lib/format'

const ACCIONES = [
  { id: 'guardar', label: 'Guardar' },
  { id: 'ocultar', label: 'Ocultar' },
  { id: 'descartar', label: 'Descartar' },
]

export default function Tarjeta({ op, onAccion, onDetalle, busy }) {
  const match = op.match
  const cuenta = countdown(op.dias_restantes)
  const aplicadas = new Set(op.acciones || [])

  return (
    <article className={`tarjeta score-${scoreColor(match?.score)}`}>
      <header className="tarjeta-head">
        <div className="score" title={`Compatibilidad: ${scoreLabel(match?.score)}`}>
          <span className="score-num">{match?.score ?? '–'}</span>
          <span className="score-lbl">score</span>
        </div>
        <div className="titulos">
          <h2>{op.titulo || 'Sin título'}</h2>
          <p className="entidad">{op.entidad || 'Entidad no informada'}</p>
          <p className="ref">
            {op.referencia_del_proceso || op.id_del_proceso}
            {op.estado ? ` · ${op.estado}` : ''}
          </p>
        </div>
        {cuenta && <span className={`cuenta ${cuenta.clase}`}>{cuenta.texto}</span>}
      </header>

      {match && (
        <ul className="bullets">
          {(match.bullets || []).map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}

      {match?.rationale && <p className="rationale">{match.rationale}</p>}

      <dl className="datos">
        <div>
          <dt>Presupuesto</dt>
          <dd>{formatCompact(op.precio_base)}</dd>
        </div>
        <div>
          <dt>Modalidad</dt>
          <dd>{op.modalidad || '—'}</dd>
        </div>
        <div>
          <dt>Departamento</dt>
          <dd>{op.departamento || '—'}</dd>
        </div>
        <div>
          <dt>Publicada</dt>
          <dd>{formatDate(op.fecha_publicacion)}</dd>
        </div>
      </dl>

      {match && (match.gaps?.length > 0 || match.matched_keywords?.length > 0) && (
        <div className="tags">
          {match.matched_keywords?.slice(0, 4).map((k) => (
            <span key={k} className="tag ok">
              {k}
            </span>
          ))}
          {match.gaps?.slice(0, 3).map((g) => (
            <span key={g} className="tag gap">
              {g}
            </span>
          ))}
        </div>
      )}

      <footer className="tarjeta-foot">
        <div className="acciones">
          {ACCIONES.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`btn ${a.id}${aplicadas.has(a.id) ? ' activa' : ''}`}
              disabled={busy}
              onClick={() => onAccion(op.id_del_proceso, a.id)}
            >
              {a.label}
            </button>
          ))}
          {aplicadas.size > 0 && (
            <button
              type="button"
              className="btn restaurar"
              disabled={busy}
              onClick={() => onAccion(op.id_del_proceso, 'restaurar')}
            >
              Restaurar
            </button>
          )}
        </div>
        <div className="enlaces">
          <button type="button" className="btn fantasma" onClick={() => onDetalle(op.id_del_proceso)}>
            Ver detalle
          </button>
          {op.url_proceso && (
            <a className="btn fantasma" href={op.url_proceso} target="_blank" rel="noreferrer">
              SECOP ↗
            </a>
          )}
        </div>
      </footer>
    </article>
  )
}
