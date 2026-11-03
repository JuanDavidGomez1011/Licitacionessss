import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { CategoriaRequisito, ResumenPliego as Resumen } from '../lib/tipos'

const CATEGORIAS: { clave: CategoriaRequisito; titulo: string }[] = [
  { clave: 'juridico', titulo: 'Jurídicos' },
  { clave: 'financiero', titulo: 'Financieros' },
  { clave: 'tecnico', titulo: 'Técnicos' },
]

/**
 * Pestaña "Requisitos" del detalle: el resumen del pliego.
 *
 * Se pide al abrir la pestaña y no con el detalle: es un calculo local y
 * rapido, pero no hace falta si el usuario solo queria ver la ficha.
 */
export default function ResumenPliego({ id, urlProceso }: { id: string; urlProceso: string | null }) {
  const [resumen, setResumen] = useState<Resumen | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    api
      .resumenPliego(id)
      .then((r) => vivo && setResumen(r))
      .catch((e: unknown) => vivo && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      vivo = false
    }
  }, [id])

  if (error) return <p className="error">No se pudo resumir: {error}</p>
  if (!resumen) return <p className="cargando">Resumiendo el pliego…</p>

  return (
    <div className="resumen-pliego">
      {resumen.advertencias.map((a) => (
        <p key={a} className="aviso-pliego">
          {a}
        </p>
      ))}

      <h4>Objeto</h4>
      <p className="descripcion">{resumen.objeto}</p>

      <dl className="datos full">
        {resumen.datos_clave.map((d) => (
          <div key={d.etiqueta}>
            <dt>{d.etiqueta}</dt>
            <dd>{d.valor}</dd>
          </div>
        ))}
      </dl>

      <div className="requisitos">
        {CATEGORIAS.map(({ clave, titulo }) => (
          <section key={clave} className={`requisitos-col req-${clave}`}>
            <h4>Requisitos {titulo.toLowerCase()}</h4>
            {resumen.requisitos[clave].length === 0 ? (
              <p className="vacio">Nada específico en el texto publicado.</p>
            ) : (
              <ul>
                {resumen.requisitos[clave].map((r, i) => (
                  <li key={i} className={`req-${r.origen}`}>
                    {r.texto}
                    {r.origen === 'habitual' && <span className="tag">habitual</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      <p className="perfil-nota">
        <span className="tag">habitual</span> = lo que la ley exige normalmente para esta modalidad; sin marca =
        citado del texto del proceso.
        {urlProceso && (
          <>
            {' '}
            <a href={urlProceso} target="_blank" rel="noreferrer">
              Ver los documentos del proceso en SECOP ↗
            </a>
          </>
        )}
      </p>
    </div>
  )
}
