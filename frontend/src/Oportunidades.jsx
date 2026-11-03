import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './lib/api'
import { formatDate, formatNumber } from './lib/format'
import Detalle from './components/Detalle'
import PanelDatos from './components/PanelDatos'
import PanelFiltros from './components/PanelFiltros'
import PanelPerfil from './components/PanelPerfil'
import Respaldo from './components/Respaldo'
import Sincronizador from './components/Sincronizador'
import Tarjeta from './components/Tarjeta'

const VACIO = {
  q: '',
  score_min: 0,
  precio_max: '',
  solo_por_vencer: false,
  dias_por_vencer: '',
  solo_guardadas: false,
  departamentos: [],
  modalidades: [],
  entidades: [],
}

const LIMITE = 24

export default function Oportunidades() {
  const [filtros, setFiltros] = useState(VACIO)
  const [pagina, setPagina] = useState(0)
  const [datos, setDatos] = useState({ items: [], total: 0 })
  const [facetas, setFacetas] = useState(null)
  const [salud, setSalud] = useState(null)
  const [estadisticas, setEstadisticas] = useState(null)
  // El resultado de la ultima descarga (fallida o interrumpida). Vive aqui y no
  // solo en `Sincronizador` porque el estado vacio es donde hay que explicar
  // por que no hay nada, y ese es justamente el caso en el que el error de la
  // descarga es lo unico que dice que paso.
  const [syncEstado, setSyncEstado] = useState(null)
  const [perfil, setPerfil] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  // Es el `id_del_proceso` de la ficha abierta, no el detalle entero: el detalle
  // lo pide el modal `Detalle` por su cuenta.
  const [detalle, setDetalle] = useState(null)
  const [detalleVersion, setDetalleVersion] = useState(0)
  const [oculto, setOculto] = useState(true)
  const [pendientes, setPendientes] = useState(new Set())
  const [editandoPerfil, setEditandoPerfil] = useState(false)
  const [editandoDatos, setEditandoDatos] = useState(false)

  // La primera respuesta que llega puede ser de una petición ya descartada.
  const requestId = useRef(0)
  const debounce = useRef(null)

  const params = useMemo(
    () => ({
      q: filtros.q || undefined,
      score_min: filtros.score_min || undefined,
      precio_max: filtros.precio_max || undefined,
      solo_por_vencer: filtros.solo_por_vencer || undefined,
      dias_por_vencer: filtros.dias_por_vencer || undefined,
      solo_guardadas: filtros.solo_guardadas || undefined,
      departamentos: filtros.departamentos,
      modalidades: filtros.modalidades,
      entidades: filtros.entidades,
      limit: LIMITE,
      offset: pagina * LIMITE,
    }),
    [filtros, pagina],
  )

  const cargar = useCallback(async () => {
    const id = ++requestId.current
    setCargando(true)
    setError(null)
    try {
      const page = await api.licitaciones(params)
      if (id !== requestId.current) return
      setDatos({ items: page.items, total: page.total })
    } catch (e) {
      if (id === requestId.current) setError(e.message)
    } finally {
      if (id === requestId.current) setCargando(false)
    }
  }, [params])

  useEffect(() => {
    clearTimeout(debounce.current)
    debounce.current = setTimeout(cargar, filtros.q ? 350 : 0)
    return () => clearTimeout(debounce.current)
  }, [cargar, filtros.q])

  // Los desplegables no dependen de la página ni del texto de búsqueda.
  useEffect(() => {
    api
      .facetas({ score_min: filtros.score_min || 0, limite: 30 })
      .then(setFacetas)
      .catch(() => setFacetas(null))
  }, [filtros.score_min])

  useEffect(() => {
    Promise.all([api.salud(), api.estadisticas(), api.perfil(), api.estadoSync()])
      .then(([s, e, p, sy]) => {
        setSalud(s)
        setEstadisticas(e)
        setPerfil(p)
        setSyncEstado(sy)
      })
      .catch(() => setSalud(null))
  }, [])

  // Tras un ciclo de sincronizacion los totales cambian, asi que se refrescan
  // los tres en bloque. `cargar` ya esta memorizada y con guardas de requestId.
  const refrescarCabecera = useCallback(async () => {
    const [s, e, sy] = await Promise.allSettled([api.salud(), api.estadisticas(), api.estadoSync()])
    if (s.status === 'fulfilled') setSalud(s.value)
    if (e.status === 'fulfilled') setEstadisticas(e.value)
    if (sy.status === 'fulfilled') setSyncEstado(sy.value)
  }, [])

  // Al descartar/ocultar/guardar, la tarjeta sale de la vista según el filtro
  // activo: recargar es más simple que replicar la query en el cliente.
  const onAccion = useCallback(
    async (id, accion) => {
      setPendientes((p) => new Set(p).add(id))
      try {
        const result = await api.accion(id, accion)
        setDatos((d) => ({
          ...d,
          items: d.items.map((it) =>
            it.id_del_proceso === id
              ? { ...it, acciones: result.map((a) => a.accion) }
              : it,
          ),
        }))
        // El modal abierto tiene su propio estado: se le cambia la version para
        // que vuelva a pedir el detalle y muestre la accion aplicada.
        if (detalle === id) setDetalleVersion((v) => v + 1)

        const saleDeVista =
          (accion === 'descartar' || accion === 'ocultar') && !filtros.solo_guardadas
        if (saleDeVista || (accion === 'guardar' && filtros.solo_guardadas)) {
          await cargar()
        }
      } catch (e) {
        setError(e.message)
      } finally {
        setPendientes((p) => {
          const next = new Set(p)
          next.delete(id)
          return next
        })
      }
    },
    [cargar, detalle, filtros.solo_guardadas],
  )

  const limpiar = () => {
    setFiltros(VACIO)
    setPagina(0)
  }

  const totalPaginas = Math.max(1, Math.ceil(datos.total / LIMITE))
  const activa = JSON.stringify({ ...filtros, score_min: filtros.score_min })

  return (
    <div className="app">
      <header className="app-head">
        <div className="marca">
          <h1>Oportunidades</h1>
          <p>
            Licitaciones públicas de Colombia, puntuadas en tu navegador
            {perfil?.nombre ? ` para ${perfil.nombre}` : ''}
          </p>
        </div>
        <div className="estado">
          {salud && (
            <span
              className={`chip ${salud.estado === 'ok' ? 'ok' : 'mal'}`}
              title={salud.mensaje || `Datos en ${salud.base_datos}`}
            >
              {salud.base_datos}
            </span>
          )}
          {estadisticas && (
            <span className="chip">
              {formatNumber(estadisticas.tenders)} procesos ·{' '}
              {formatNumber(estadisticas.scored)} puntuados
            </span>
          )}
          <Sincronizador
            alTerminar={async () => {
              await Promise.all([cargar(), refrescarCabecera()])
            }}
          />
          <button type="button" className="btn fantasma" onClick={() => setEditandoPerfil(true)}>
            Perfil
          </button>
          <button
            type="button"
            className="btn fantasma"
            onClick={() => setEditandoDatos(true)}
            title="Token de Socrata, días y topes de descarga"
          >
            Datos
          </button>
          <button type="button" className="btn fantasma" onClick={cargar}>
            Actualizar
          </button>
        </div>
        <Respaldo
          alCambiar={async () => {
            await Promise.all([cargar(), refrescarCabecera()])
          }}
        />
      </header>

      {estadisticas && (
        <section className="resumen">
          <div>
            <strong>{estadisticas.avg_score ?? '—'}</strong>
            <span>score medio</span>
          </div>
          <div>
            <strong>{formatNumber(estadisticas.contracts)}</strong>
            <span>contratos</span>
          </div>
          <div>
            <strong>{formatNumber(estadisticas.high_matches)}</strong>
            <span>matches altos</span>
          </div>
          <div>
            <strong>{formatDate(estadisticas.newest_tender_at)}</strong>
            <span>dato más reciente</span>
          </div>
        </section>
      )}

      {error && (
        <div className="banner error">
          {error}
          <button type="button" className="cerrar" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      {/* Si el almacen cayo a memoria, el panel deja de persistir sin avisar en
          la pantalla: se ven las fichas, se puntuan, y al recargar desaparece
          todo. Antes solo estaba en el `title` del chip, que hay que acertar.
          No lleva boton de cerrar a proposito: si los datos no se guardan, es
          informacion que no se puede dejar pasar. */}
      {salud && salud.estado === 'degradado' && (
        <div className="banner aviso">
          <strong>Ojo: los datos no se están guardando.</strong> Este navegador no
          deja usar IndexedDB, así que el panel funciona pero en memoria: al
          recargar o cerrar la pestaña se pierde todo lo descargado. Se arregla
          abriendo la página por <code>http://localhost:5173</code> (con
          <code> .\start.ps1</code>) en vez de con doble clic en el
          <code> index.html</code>, y sin usar incógnito ni bloquear cookies de
          este sitio.
        </div>
      )}

      <main className="layout">
        <button type="button" className="toggle-filtros" onClick={() => setOculto((v) => !v)}>
          {oculto ? 'Mostrar filtros' : 'Ocultar filtros'}
        </button>

        {!oculto && (
          <PanelFiltros
            filtros={filtros}
            setFiltros={(fn) => {
              setPagina(0)
              setFiltros(fn)
            }}
            facetas={facetas}
            onLimpiar={limpiar}
            cargando={cargando}
          />
        )}

        <section className="resultados">
          <div className="resultados-head">
            <h2>
              {cargando ? 'Buscando…' : `${formatNumber(datos.total)} oportunidades`}
            </h2>
            {datos.total > LIMITE && (
              <div className="paginacion">
                <button
                  type="button"
                  className="btn fantasma"
                  disabled={pagina === 0}
                  onClick={() => setPagina((p) => p - 1)}
                >
                  ‹
                </button>
                <span>
                  {pagina + 1} / {totalPaginas}
                </span>
                <button
                  type="button"
                  className="btn fantasma"
                  disabled={pagina + 1 >= totalPaginas}
                  onClick={() => setPagina((p) => p + 1)}
                >
                  ›
                </button>
              </div>
            )}
          </div>

          {!cargando && datos.items.length === 0 && (
            <div className="vacio-box">
              {!estadisticas?.tenders ? (
                <>
                  <p>
                    Este navegador todavía no tiene datos. Pulsa <strong>Descargar SECOP</strong> para
                    bajar los procesos y puntuarlos; se guardan aquí y no se vuelven a descargar hasta
                    que tú lo pidas.
                  </p>
                  {/* Si la ultima descarga fallo o se corto, es lo unico que
                      explica el vacio: sin esto el usuario solo ve una pagina
                      en blanco y no hay por donde empezar a diagnosticarla. */}
                  {syncEstado?.error && (
                    <p className="vacio-nota">
                      La última descarga falló: {syncEstado.error}
                    </p>
                  )}
                  {syncEstado?.fase === 'interrumpida' && (
                    <p className="vacio-nota">
                      La última descarga se interrumpió a mitad (
                      {formatNumber(syncEstado.hechos)}
                      {syncEstado.total ? ` de ${formatNumber(syncEstado.total)}` : ''}). Lo ya
                      descargado está guardado; pulsa <strong>Descargar SECOP</strong> para retomarla.
                    </p>
                  )}
                  {/* Una descarga COMPLETADA en este origen con el panel a cero
                      no es un problema de Socrata ni de otro navegador: los
                      meta estan aqui y las stores no. Es el fallo del propio
                      panel y hace falta decirlo. */}
                  {syncEstado?.ultimo?.status === 'ok' && (
                    <p className="vacio-nota">
                      Aquí hubo una descarga completada, pero el panel no encuentra procesos: esto
                      ya sería un fallo del panel, no de la descarga.
                    </p>
                  )}
                  {/* El almacen es por origen: `localhost` y `127.0.0.1` no se
                      comparten, ni tampoco incognito u otro navegador. Decir
                      donde se guarda es lo que sustituye al snippet de
                      diagnostico que hay que pedir por consola. */}
                  <p className="vacio-nota">
                    Los datos viven en este navegador, en <code>{window.location.origin}</code>
                    {salud?.base_datos ? ` (almacén ${salud.base_datos})` : ''}. Si descargaste en
                    otra dirección — <code>localhost</code> y <code>127.0.0.1</code> son orígenes
                    distintos —, en incógnito o en otro navegador, aquí empiezas a cero.
                  </p>
                  <p className="vacio-nota">
                    No hay servidor ni descarga automática: nada se ejecuta hasta que pulses el botón.
                  </p>
                </>
              ) : (
                <>
                  <p>No hay licitaciones que cumplan los filtros.</p>
                  <button type="button" className="btn" onClick={limpiar}>
                    Limpiar filtros
                  </button>
                </>
              )}
            </div>
          )}

          <div className={cargando ? 'lista cargando' : 'lista'}>
            {datos.items.map((op) => (
              <Tarjeta
                key={op.id_del_proceso}
                op={op}
                busy={pendientes.has(op.id_del_proceso)}
                onAccion={onAccion}
                onDetalle={setDetalle}
              />
            ))}
          </div>

          {activa !== JSON.stringify(VACIO) && (
            <button type="button" className="btn fantasma limpiar-abajo" onClick={limpiar}>
              Limpiar filtros
            </button>
          )}
        </section>
      </main>

      {detalle && (
        <Detalle
          id={detalle}
          version={detalleVersion}
          onAccion={onAccion}
          onCerrar={() => setDetalle(null)}
        />
      )}

      {editandoPerfil && perfil && (
        <PanelPerfil
          perfil={perfil}
          onCerrar={() => setEditandoPerfil(false)}
          onGuardado={async () => {
            setPerfil(await api.perfil())
            await cargar()
          }}
        />
      )}

      {editandoDatos && (
        <PanelDatos
          onCerrar={() => setEditandoDatos(false)}
          onGuardado={async () => {
            // La configuracion no cambia los datos ya descargados, pero el
            // sincronizador pinta la ultima descarga y conviene que se vea
            // fresca al cerrar el panel.
            setSyncEstado(await api.estadoSync())
          }}
        />
      )}
    </div>
  )
}
