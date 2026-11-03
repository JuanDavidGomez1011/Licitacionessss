import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { api } from '../lib/api'
import { countdown, diasHasta, formatCompact, scoreColor } from '../lib/format'
import type { EstadoCRM, TarjetaCRM } from '../lib/tipos'

/**
 * CRM de licitaciones: tablero Kanban de las oportunidades que se siguen.
 *
 * Las tarjetas viven en la store `crm` de IndexedDB (y van en el respaldo
 * NDJSON). Se mueven arrastrando o con el selector de cada tarjeta, que es lo
 * que funciona con teclado y en movil, donde el arrastre HTML5 no existe.
 */

export const COLUMNAS_CRM: EstadoCRM[] = ['evaluacion', 'preparacion', 'presentada', 'ganada', 'descartada']

export const ETIQUETAS_CRM: Record<EstadoCRM, string> = {
  evaluacion: 'En evaluación',
  preparacion: 'En preparación',
  presentada: 'Oferta presentada',
  ganada: 'Ganada',
  descartada: 'Descartada',
}

const TIPO_ARRASTRE = 'application/x-licitacion'

interface TableroProps {
  onDetalle: (id: string) => void
  /** Sube cuando algo de fuera cambia el tablero (p. ej. "Al tablero" en la lista). */
  version?: number
}

export default function Tablero({ onDetalle, version = 0 }: TableroProps) {
  const [tarjetas, setTarjetas] = useState<TarjetaCRM[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sobre, setSobre] = useState<EstadoCRM | null>(null)

  const cargar = useCallback(async () => {
    try {
      setTarjetas(await api.tablero())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  // `version` sube cuando algo de fuera mete o mueve tarjetas: hay que releer.
  useEffect(() => {
    let vivo = true
    api
      .tablero()
      .then((ts) => {
        if (vivo) setTarjetas(ts)
      })
      .catch((e: unknown) => {
        if (vivo) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      vivo = false
    }
  }, [version])

  const mover = async (id: string, estado: EstadoCRM) => {
    // Optimista: el tablero responde al soltar, y si falla se recarga.
    setTarjetas((ts) => ts?.map((t) => (t.tender_id === id ? { ...t, estado } : t)) ?? ts)
    try {
      await api.moverCRM(id, estado)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      await cargar()
    }
  }

  const quitar = async (id: string) => {
    setTarjetas((ts) => ts?.filter((t) => t.tender_id !== id) ?? ts)
    await api.quitarCRM(id)
  }

  const guardarNota = async (id: string, nota: string) => {
    const previa = tarjetas?.find((t) => t.tender_id === id)
    if (!previa || previa.nota === nota) return
    setTarjetas((ts) => ts?.map((t) => (t.tender_id === id ? { ...t, nota } : t)) ?? ts)
    await api.notaCRM(id, nota)
  }

  const alSoltar = (estado: EstadoCRM) => (e: DragEvent<HTMLElement>) => {
    e.preventDefault()
    setSobre(null)
    const id = e.dataTransfer.getData(TIPO_ARRASTRE)
    if (id) void mover(id, estado)
  }

  if (tarjetas === null) return <p className="cargando">Cargando tablero…</p>

  return (
    <section className="tablero" aria-label="Tablero de oportunidades">
      {error && <p className="error">{error}</p>}
      {tarjetas.length === 0 && (
        <p className="vacio-nota">
          El tablero está vacío. Pulsa <strong>Al tablero</strong> en una licitación para seguirla; luego
          muévela entre columnas a medida que avanza.
        </p>
      )}
      <div className="kanban">
        {COLUMNAS_CRM.map((estado) => {
          const enColumna = tarjetas.filter((t) => t.estado === estado)
          return (
            <div
              key={estado}
              className={`kanban-col col-${estado}${sobre === estado ? ' sobre' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setSobre(estado)
              }}
              onDragLeave={() => setSobre((s) => (s === estado ? null : s))}
              onDrop={alSoltar(estado)}
            >
              <h3>
                {ETIQUETAS_CRM[estado]} <span className="n">{enColumna.length}</span>
              </h3>
              {enColumna.map((t) => {
                const cuenta = countdown(diasHasta(t.fecha_cierre))
                return (
                  <div
                    key={t.tender_id}
                    className={`kanban-card score-${scoreColor(t.score)}`}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(TIPO_ARRASTRE, t.tender_id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                  >
                    <div className="kanban-card-head">
                      <span className="score-mini">{t.score ?? '–'}</span>
                      <button type="button" className="linkish" onClick={() => onDetalle(t.tender_id)}>
                        {t.titulo}
                      </button>
                    </div>
                    <p className="entidad">{t.entidad || 'Entidad no informada'}</p>
                    <p className="kanban-meta">
                      {formatCompact(t.precio_base)}
                      {cuenta && <span className={`cuenta ${cuenta.clase}`}>{cuenta.texto}</span>}
                    </p>
                    <textarea
                      aria-label={`Nota de ${t.titulo}`}
                      rows={2}
                      defaultValue={t.nota}
                      placeholder="Nota interna…"
                      onBlur={(e) => void guardarNota(t.tender_id, e.target.value)}
                    />
                    <div className="kanban-card-foot">
                      <select
                        aria-label={`Columna de ${t.titulo}`}
                        value={t.estado}
                        onChange={(e) => void mover(t.tender_id, e.target.value as EstadoCRM)}
                      >
                        {COLUMNAS_CRM.map((c) => (
                          <option key={c} value={c}>
                            {ETIQUETAS_CRM[c]}
                          </option>
                        ))}
                      </select>
                      {t.url_proceso && (
                        <a href={t.url_proceso} target="_blank" rel="noreferrer" className="btn fantasma">
                          SECOP ↗
                        </a>
                      )}
                      <button type="button" className="btn fantasma" onClick={() => void quitar(t.tender_id)}>
                        Quitar
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </section>
  )
}
