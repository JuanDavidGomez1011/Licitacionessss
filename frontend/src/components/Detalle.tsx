import { useEffect, useState, type ReactNode } from 'react'
import { api, type ContratoVista, type Detalle as DatosDetalle, type Similar } from '../lib/api'
import { formatDate, formatMoney, formatNumber, scoreLabel } from '../lib/format'
import type { EstadoCRM, MatchVista, OportunidadDetalle, TipoAccion } from '../lib/tipos'
import ResumenPliego from './ResumenPliego'
import { COLUMNAS_CRM, ETIQUETAS_CRM } from './Tablero'
import { Desglose } from './Tarjeta'

interface Pestana {
  clave: string
  etiqueta: string
  contenido: ReactNode
}

/** Las pestañas reciben un array de `{clave, etiqueta, contenido}`.
 *
 * Antes se derivaba la etiqueta de `Object.keys(children)`, que sobre los hijos
 * estaticos de JSX devuelve `['0','1','2','3']`: las pestañas se veian numeradas.
 */
function Pestanas({ pestanas, actual, onChange }: { pestanas: Pestana[]; actual: string; onChange: (c: string) => void }) {
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

export interface DetalleProps {
  id: string
  version?: number
  pestanaInicial?: string
  onAccion: (id: string, accion: TipoAccion) => void
  onCRM?: (id: string, estado: EstadoCRM | null) => void
  onCerrar: () => void
}

export default function Detalle({ id, version = 0, pestanaInicial = 'resumen', onAccion, onCRM, onCerrar }: DetalleProps) {
  const [pestana, setPestana] = useState(pestanaInicial)
  // Lo cargado va con la clave de lo que se pidio: mientras no coincida con la
  // ficha y la version actuales, se esta cargando. Asi el efecto solo escribe
  // estado cuando llega la respuesta, nunca de forma sincrona.
  const clave = `${id}:${version}`
  const [carga, setCarga] = useState<{
    clave: string
    datos: DatosDetalle | null
    similares: Similar[]
    error: string | null
  } | null>(null)

  useEffect(() => {
    let vivo = true
    Promise.all([api.detalle(id), api.similares(id, 5).catch(() => ({ items: [] as Similar[] }))])
      .then(([d, s]) => {
        if (vivo) setCarga({ clave, datos: d, similares: s.items || [], error: null })
      })
      .catch((e: unknown) => {
        if (vivo) setCarga({ clave, datos: null, similares: [], error: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      vivo = false
    }
  }, [id, clave])

  const ocupado = carga?.clave !== clave
  const datos = carga?.datos ?? null
  const similares = carga?.similares ?? []
  const error = ocupado ? null : (carga?.error ?? null)

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onCerrar()
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

  const { licitacion: op, match, ocds, contratos, acciones, crm } = datos
  const aplicadas = new Set((acciones || []).map((a) => a.accion))

  return (
    <div className="overlay" onClick={onCerrar}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{op.titulo || 'Sin título'}</h2>
            <p className="entidad">{op.entidad}</p>
            <p className="ref">
              {op.referencia_del_proceso} · {op.id_del_proceso} · {op.fuente}
            </p>
          </div>
          <button type="button" className="cerrar" onClick={onCerrar} aria-label="Cerrar">
            ×
          </button>
        </header>

        <div className="modal-acciones">
          {(['guardar', 'ocultar', 'descartar'] as const).map((a) => (
            <button
              key={a}
              type="button"
              className={`btn ${a}${aplicadas.has(a) ? ' activa' : ''}`}
              onClick={() => onAccion(op.id_del_proceso, a)}
            >
              {a}
            </button>
          ))}
          {onCRM && (
            <label className="crm-select">
              <span>Tablero</span>
              <select
                value={crm?.estado ?? ''}
                onChange={(e) => onCRM(op.id_del_proceso, (e.target.value || null) as EstadoCRM | null)}
              >
                <option value="">— sin seguir —</option>
                {COLUMNAS_CRM.map((c) => (
                  <option key={c} value={c}>
                    {ETIQUETAS_CRM[c]}
                  </option>
                ))}
              </select>
            </label>
          )}
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
              clave: 'requisitos',
              etiqueta: 'Requisitos',
              contenido: <ResumenPliego id={op.id_del_proceso} urlProceso={op.url_proceso} />,
            },
            {
              clave: 'ia',
              etiqueta: 'Análisis IA',
              contenido: <Analisis match={match} />,
            },
            {
              clave: 'similares',
              etiqueta: 'Similares',
              contenido: (
                <div>
                  {similares.length === 0 ? (
                    <p className="vacio">Sin licitaciones similares en los datos de este navegador.</p>
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

function Analisis({ match }: { match: MatchVista | null }) {
  if (!match) return <p className="vacio">Esta licitación aún no tiene puntuación.</p>
  return (
    <div>
      <p>
        <strong className={`semaforo semaforo-${match.nivel}`}>
          {match.score} · {scoreLabel(match.score)}
        </strong>
      </p>
      {match.componentes ? (
        <Desglose componentes={match.componentes} />
      ) : (
        <p className="vacio">Score calculado con la versión anterior del motor: pulsa «Repuntuar todo» en Perfil.</p>
      )}
      {match.bullets.length > 0 && (
        <ul className="bullets">
          {match.bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}
      {match.rationale && <p className="rationale">{match.rationale}</p>}
      <h4>Palabras clave que coinciden</h4>
      <p>{match.matched_keywords.join(', ') || '—'}</p>
      <h4>Brechas detectadas</h4>
      <p>{match.gaps.join(', ') || '—'}</p>
      <h4>Trazabilidad</h4>
      <p className="mono">
        modelo {match.model} · similitud{' '}
        {match.semantic_similarity !== null ? match.semantic_similarity.toFixed(1) : '—'} · puntuado{' '}
        {formatDate(match.scored_at)}
      </p>
    </div>
  )
}

function Resumen({
  op,
  match,
  contratos,
}: {
  op: OportunidadDetalle
  match: MatchVista | null
  contratos: ContratoVista[]
}) {
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
          <dt>Cierre (presentación de ofertas)</dt>
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
