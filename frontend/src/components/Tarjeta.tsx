import { countdown, formatCompact, formatDate, scoreColor, scoreLabel } from '../lib/format'
import type { ComponenteScore, Componentes, EstadoCRM, Oportunidad, TipoAccion } from '../lib/tipos'
import { ETIQUETAS_CRM } from './Tablero'

const ACCIONES: { id: TipoAccion; label: string }[] = [
  { id: 'guardar', label: 'Guardar' },
  { id: 'ocultar', label: 'Ocultar' },
  { id: 'descartar', label: 'Descartar' },
]

/** Nombre corto de cada componente del score, en el orden en que se pintan. */
export const NOMBRES_COMPONENTES: { clave: ComponenteScore; nombre: string }[] = [
  { clave: 'objeto', nombre: 'Objeto' },
  { clave: 'unspsc', nombre: 'UNSPSC' },
  { clave: 'presupuesto', nombre: 'Presupuesto' },
  { clave: 'palabras', nombre: 'Palabras clave' },
  { clave: 'tiempo', nombre: 'Plazo' },
]

/** Barras del desglose. Un componente sin datos se dice, no se pinta a cero. */
export function Desglose({ componentes }: { componentes: Componentes }) {
  return (
    <ul className="desglose" aria-label="Desglose del score">
      {NOMBRES_COMPONENTES.map(({ clave, nombre }) => {
        const valor = componentes[clave]
        return (
          <li key={clave} title={valor === null ? 'Sin datos: su peso se reparte entre los demás' : `${nombre}: ${valor}`}>
            <span className="desglose-nombre">{nombre}</span>
            <span className="desglose-barra">
              <span
                className={`desglose-fill score-${scoreColor(valor)}`}
                style={{ width: `${valor === null ? 0 : Math.max(2, valor)}%` }}
              />
            </span>
            <span className="desglose-valor">{valor === null ? 's/d' : Math.round(valor)}</span>
          </li>
        )
      })}
    </ul>
  )
}

export interface TarjetaProps {
  op: Oportunidad
  onAccion: (id: string, accion: TipoAccion | 'restaurar') => void
  onDetalle: (id: string, pestana?: string) => void
  onSeguir?: (id: string, estado: EstadoCRM) => void
  busy?: boolean
}

export default function Tarjeta({ op, onAccion, onDetalle, onSeguir, busy = false }: TarjetaProps) {
  const match = op.match
  const cuenta = countdown(op.dias_restantes)
  const aplicadas = new Set(op.acciones || [])
  const nivel = scoreColor(match?.score)

  return (
    <article className={`tarjeta score-${nivel}`}>
      <header className="tarjeta-head">
        <div className="score" title={`Compatibilidad: ${scoreLabel(match?.score)}`}>
          <span className="score-num">{match?.score ?? '–'}</span>
          <span className="score-lbl">score</span>
          <span className={`semaforo semaforo-${nivel}`}>{scoreLabel(match?.score)}</span>
        </div>
        <div className="titulos">
          <h2>{op.titulo || 'Sin título'}</h2>
          <p className="entidad">{op.entidad || 'Entidad no informada'}</p>
          <p className="ref">
            {op.referencia_del_proceso || op.id_del_proceso}
            {op.estado ? ` · ${op.estado}` : ''}
            {op.fuente === 'SECOP I' ? ' · SECOP I' : ''}
          </p>
        </div>
        {cuenta && <span className={`cuenta ${cuenta.clase}`}>{cuenta.texto}</span>}
      </header>

      {match?.componentes && <Desglose componentes={match.componentes} />}

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
          <dt>Ubicación</dt>
          <dd>{[op.ciudad, op.departamento].filter(Boolean).join(', ') || '—'}</dd>
        </div>
        <div>
          <dt>Publicada</dt>
          <dd>{formatDate(op.fecha_publicacion)}</dd>
        </div>
      </dl>

      {match && (match.gaps.length > 0 || match.matched_keywords.length > 0) && (
        <div className="tags">
          {match.matched_keywords.slice(0, 4).map((k) => (
            <span key={k} className="tag ok">
              {k}
            </span>
          ))}
          {match.gaps.slice(0, 3).map((g) => (
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
          {onSeguir &&
            (op.crm ? (
              <span className="tag crm" title="Esta oportunidad está en el tablero">
                Tablero: {ETIQUETAS_CRM[op.crm]}
              </span>
            ) : (
              <button
                type="button"
                className="btn fantasma"
                disabled={busy}
                onClick={() => onSeguir(op.id_del_proceso, 'evaluacion')}
                title="Añadir al tablero, en la columna En evaluación"
              >
                Al tablero
              </button>
            ))}
        </div>
        <div className="enlaces">
          <button
            type="button"
            className="btn fantasma"
            onClick={() => onDetalle(op.id_del_proceso, 'requisitos')}
            title="Extrae los requisitos jurídicos, financieros y técnicos"
          >
            Resumir pliego
          </button>
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
