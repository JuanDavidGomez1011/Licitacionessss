import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type Estadisticas, type EstadoSync, type Salud } from './lib/api'
import type { ResultadoBusquedaRemota } from './lib/busquedaRemota'
import { exportarOportunidades, type FormatoExportacion } from './lib/exportar'
import { formatDate, formatNumber } from './lib/format'
import { listaDeTerminos } from './lib/texto'
import type { BusquedaGuardada, EstadoCRM, Facetas, FiltrosUI, Oportunidad, Orden, ParamsConsulta, Perfil, TipoAccion } from './lib/tipos'
import Detalle from './components/Detalle'
import PanelAlertas from './components/PanelAlertas'
import PanelDatos from './components/PanelDatos'
import PanelFiltros from './components/PanelFiltros'
import PanelPerfil from './components/PanelPerfil'
import Respaldo from './components/Respaldo'
import Sincronizador from './components/Sincronizador'
import Tablero from './components/Tablero'
import Tarjeta from './components/Tarjeta'

export const VACIO: FiltrosUI = {
  q: '',
  incluir: '',
  excluir: '',
  score_min: 0,
  precio_min: '',
  precio_max: '',
  solo_por_vencer: false,
  dias_por_vencer: '',
  solo_guardadas: false,
  departamentos: [],
  ciudades: [],
  modalidades: [],
  entidades: [],
  estados: [],
  fuentes: [],
  orden: 'score',
}

const LIMITE = 24

const ORDENES: { valor: Orden; etiqueta: string }[] = [
  { valor: 'score', etiqueta: 'Mayor score' },
  { valor: 'cierre', etiqueta: 'Cierre más próximo' },
  { valor: 'fecha', etiqueta: 'Más recientes' },
  { valor: 'precio_desc', etiqueta: 'Mayor cuantía' },
  { valor: 'precio', etiqueta: 'Menor cuantía' },
]

const FORMATOS: { formato: FormatoExportacion; etiqueta: string }[] = [
  { formato: 'csv', etiqueta: 'CSV' },
  { formato: 'xlsx', etiqueta: 'Excel' },
  { formato: 'pdf', etiqueta: 'PDF' },
]

type Vista = 'lista' | 'tablero'

const mensajeDe = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Los filtros de la UI como los espera la fachada. Los vacios no se mandan. */
export function aParams(filtros: FiltrosUI): ParamsConsulta {
  const incluir = listaDeTerminos(filtros.incluir)
  const excluir = listaDeTerminos(filtros.excluir)
  return {
    q: filtros.q || undefined,
    incluir: incluir.length ? incluir : undefined,
    excluir: excluir.length ? excluir : undefined,
    score_min: filtros.score_min || undefined,
    precio_min: filtros.precio_min === '' ? undefined : filtros.precio_min,
    precio_max: filtros.precio_max === '' ? undefined : filtros.precio_max,
    solo_por_vencer: filtros.solo_por_vencer || undefined,
    dias_por_vencer: filtros.dias_por_vencer === '' ? undefined : filtros.dias_por_vencer,
    solo_guardadas: filtros.solo_guardadas || undefined,
    departamentos: filtros.departamentos,
    ciudades: filtros.ciudades.length ? filtros.ciudades : undefined,
    modalidades: filtros.modalidades,
    entidades: filtros.entidades,
    estados: filtros.estados.length ? filtros.estados : undefined,
    fuentes: filtros.fuentes.length ? filtros.fuentes : undefined,
    orden: filtros.orden !== 'score' ? filtros.orden : undefined,
  }
}

export default function Oportunidades() {
  const [filtros, setFiltros] = useState<FiltrosUI>(VACIO)
  const [pagina, setPagina] = useState(0)
  const [datos, setDatos] = useState<{ items: Oportunidad[]; total: number }>({ items: [], total: 0 })
  const [facetas, setFacetas] = useState<Facetas | null>(null)
  const [salud, setSalud] = useState<Salud | null>(null)
  const [estadisticas, setEstadisticas] = useState<Estadisticas | null>(null)
  // El resultado de la ultima descarga (fallida o interrumpida). Vive aqui y no
  // solo en `Sincronizador` porque el estado vacio es donde hay que explicar
  // por que no hay nada, y ese es justamente el caso en el que el error de la
  // descarga es lo unico que dice que paso.
  const [syncEstado, setSyncEstado] = useState<EstadoSync | null>(null)
  const [perfil, setPerfil] = useState<Perfil | null>(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Es el `id_del_proceso` de la ficha abierta, no el detalle entero: el detalle
  // lo pide el modal `Detalle` por su cuenta.
  const [detalle, setDetalle] = useState<{ id: string; pestana: string } | null>(null)
  const [detalleVersion, setDetalleVersion] = useState(0)
  const [oculto, setOculto] = useState(true)
  const [pendientes, setPendientes] = useState<Set<string>>(new Set())
  const [editandoPerfil, setEditandoPerfil] = useState(false)
  const [editandoDatos, setEditandoDatos] = useState(false)
  const [vista, setVista] = useState<Vista>('lista')
  const [tableroVersion, setTableroVersion] = useState(0)
  const [busquedas, setBusquedas] = useState<BusquedaGuardada[]>([])
  const [exportando, setExportando] = useState<FormatoExportacion | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)

  // La primera respuesta que llega puede ser de una petición ya descartada.
  const requestId = useRef(0)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Resultados de "Buscar en SECOP". Mientras estan a la vista, la lista enseña
  // exactamente esos procesos (con el orden elegido) y nada mas: `$q` encontro
  // coincidencias en la descripcion, que el buscador local no mira, y los
  // filtros del panel podrian esconder justo lo que se acaba de buscar.
  const [remoto, setRemoto] = useState<{ texto: string; res: ResultadoBusquedaRemota } | null>(null)
  const [buscandoRemoto, setBuscandoRemoto] = useState(false)
  const controlRemoto = useRef<AbortController | null>(null)

  const filtrosParams = useMemo<ParamsConsulta>(
    () => (remoto ? { ids: remoto.res.ids, orden: filtros.orden } : aParams(filtros)),
    [filtros, remoto],
  )
  const params = useMemo<ParamsConsulta>(
    () => ({ ...filtrosParams, limit: LIMITE, offset: pagina * LIMITE }),
    [filtrosParams, pagina],
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
      if (id === requestId.current) setError(mensajeDe(e))
    } finally {
      if (id === requestId.current) setCargando(false)
    }
  }, [params])

  // El texto libre y las palabras clave esperan a que se deje de teclear.
  const tecleando = Boolean(filtros.q || filtros.incluir || filtros.excluir)
  useEffect(() => {
    clearTimeout(debounce.current)
    debounce.current = setTimeout(cargar, tecleando ? 350 : 0)
    return () => clearTimeout(debounce.current)
  }, [cargar, tecleando])

  // Los desplegables no dependen de la página ni del texto de búsqueda, pero sí
  // de los datos: `estadisticas` se refresca tras cada descarga o importación, y
  // sin esa dependencia las facetas se quedaban con lo que había al abrir (nada,
  // en un navegador recién estrenado) hasta recargar la página.
  useEffect(() => {
    let vivo = true
    api
      .facetas({ score_min: filtros.score_min || 0, limite: 30 })
      .then((f) => vivo && setFacetas(f))
      .catch(() => vivo && setFacetas(null))
    return () => {
      vivo = false
    }
  }, [filtros.score_min, estadisticas])

  useEffect(() => {
    Promise.all([api.salud(), api.estadisticas(), api.perfil(), api.estadoSync()])
      .then(([s, e, p, sy]) => {
        setSalud(s)
        setEstadisticas(e)
        setPerfil(p)
        setSyncEstado(sy)
      })
      .catch(() => setSalud(null))
    Promise.resolve(api.busquedasGuardadas?.())
      .then((b) => setBusquedas(b ?? []))
      .catch(() => setBusquedas([]))
  }, [])

  // Tras un ciclo de sincronizacion los totales cambian, asi que se refrescan
  // en bloque. `cargar` ya esta memorizada y con guardas de requestId.
  const refrescarCabecera = useCallback(async () => {
    const [s, e, sy] = await Promise.allSettled([api.salud(), api.estadisticas(), api.estadoSync()])
    if (s.status === 'fulfilled') setSalud(s.value)
    if (e.status === 'fulfilled') setEstadisticas(e.value)
    if (sy.status === 'fulfilled') setSyncEstado(sy.value)
    setTableroVersion((v) => v + 1)
  }, [])

  const abrirDetalle = useCallback((id: string, pestana = 'resumen') => setDetalle({ id, pestana }), [])

  // Al descartar/ocultar/guardar, la tarjeta sale de la vista según el filtro
  // activo: recargar es más simple que replicar la query en el cliente.
  const onAccion = useCallback(
    async (id: string, accion: TipoAccion | 'restaurar') => {
      setPendientes((p) => new Set(p).add(id))
      try {
        const result = await api.accion(id, accion)
        setDatos((d) => ({
          ...d,
          items: d.items.map((it) => (it.id_del_proceso === id ? { ...it, acciones: result.map((a) => a.accion) } : it)),
        }))
        // El modal abierto tiene su propio estado: se le cambia la version para
        // que vuelva a pedir el detalle y muestre la accion aplicada.
        if (detalle?.id === id) setDetalleVersion((v) => v + 1)

        const saleDeVista = (accion === 'descartar' || accion === 'ocultar') && !filtros.solo_guardadas
        if (saleDeVista || (accion === 'guardar' && filtros.solo_guardadas)) {
          await cargar()
        }
      } catch (e) {
        setError(mensajeDe(e))
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

  /** Mete una oportunidad en el tablero, la mueve, o la saca (`null`). */
  const onCRM = useCallback(
    async (id: string, estado: EstadoCRM | null) => {
      try {
        if (estado) await api.moverCRM(id, estado)
        else await api.quitarCRM(id)
        setDatos((d) => ({
          ...d,
          items: d.items.map((it) => (it.id_del_proceso === id ? { ...it, crm: estado } : it)),
        }))
        setTableroVersion((v) => v + 1)
        if (detalle?.id === id) setDetalleVersion((v) => v + 1)
      } catch (e) {
        setError(mensajeDe(e))
      }
    },
    [detalle],
  )

  const exportar = async (formato: FormatoExportacion) => {
    setExportando(formato)
    setAviso(null)
    try {
      const filas = await api.licitacionesParaExportar(filtrosParams)
      if (!filas.length) {
        setAviso('No hay resultados que exportar con estos filtros.')
        return
      }
      const nombre = await exportarOportunidades(filas, formato)
      setAviso(`Descargado ${nombre} (${formatNumber(filas.length)} filas).`)
    } catch (e) {
      setError(`No se pudo exportar: ${mensajeDe(e)}`)
    } finally {
      setExportando(null)
    }
  }

  const buscarEnSecop = async () => {
    const texto = filtros.q.trim()
    if (!texto) return
    controlRemoto.current?.abort()
    const control = new AbortController()
    controlRemoto.current = control
    setBuscandoRemoto(true)
    setAviso(null)
    setError(null)
    try {
      const res = await api.buscarEnSecop(texto, control.signal)
      if (control.signal.aborted) return
      if (res.aviso) {
        setAviso(res.aviso)
        return
      }
      setPagina(0)
      setRemoto({ texto, res })
      // Entraron procesos: cambian los totales de la cabecera y las facetas.
      await refrescarCabecera()
    } catch (e) {
      if (!control.signal.aborted) setError(`No se pudo buscar en SECOP: ${mensajeDe(e)}`)
    } finally {
      if (controlRemoto.current === control) {
        controlRemoto.current = null
        setBuscandoRemoto(false)
      }
    }
  }

  const cancelarBusquedaRemota = () => {
    controlRemoto.current?.abort()
    controlRemoto.current = null
    setBuscandoRemoto(false)
  }

  const guardarBusqueda = async (nombre: string) => {
    try {
      setBusquedas(await api.guardarBusqueda(nombre, filtros))
      setAviso(`Búsqueda «${nombre.trim()}» guardada.`)
    } catch (e) {
      setError(mensajeDe(e))
    }
  }

  const aplicarBusqueda = (b: BusquedaGuardada) => {
    // Las busquedas guardadas antes de anadir un filtro nuevo no lo traen: se
    // completan con el vacio para que el formulario no quede con `undefined`.
    setFiltros({ ...VACIO, ...b.filtros })
    setPagina(0)
  }

  const borrarBusqueda = async (id: string) => {
    setBusquedas(await api.borrarBusqueda(id))
  }

  const limpiar = () => {
    setFiltros(VACIO)
    setPagina(0)
  }

  const totalPaginas = Math.max(1, Math.ceil(datos.total / LIMITE))
  const hayFiltros = JSON.stringify(filtros) !== JSON.stringify(VACIO)

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
              {formatNumber(estadisticas.tenders)} procesos · {formatNumber(estadisticas.scored)} puntuados
            </span>
          )}
          <Sincronizador
            alTerminar={async () => {
              await Promise.all([cargar(), refrescarCabecera()])
            }}
          />
          <PanelAlertas onDetalle={abrirDetalle} />
          <button type="button" className="btn fantasma" onClick={() => setEditandoPerfil(true)}>
            Perfil
          </button>
          <button
            type="button"
            className="btn fantasma"
            onClick={() => setEditandoDatos(true)}
            title="Token de Socrata, días, topes, SECOP I y sincronización periódica"
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

      <nav className="vistas" role="tablist" aria-label="Vista">
        <button
          type="button"
          role="tab"
          aria-selected={vista === 'lista'}
          className={vista === 'lista' ? 'activa' : ''}
          onClick={() => setVista('lista')}
        >
          Licitaciones
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={vista === 'tablero'}
          className={vista === 'tablero' ? 'activa' : ''}
          onClick={() => setVista('tablero')}
        >
          Tablero
        </button>
      </nav>

      {vista === 'tablero' ? (
        <Tablero onDetalle={(id) => abrirDetalle(id)} version={tableroVersion} />
      ) : (
        <main className="layout">
          <form
            className="buscador"
            role="search"
            onSubmit={(e) => {
              // Enter busca ya, sin esperar al debounce.
              e.preventDefault()
              clearTimeout(debounce.current)
              void cargar()
            }}
          >
            <input
              type="search"
              aria-label="Buscar licitaciones"
              value={filtros.q}
              placeholder='Buscar por objeto, entidad, número de proceso (CO1.REQ…, CO1.NTC…), referencia, municipio o UNSPSC. Usa "comillas" para una frase exacta.'
              onChange={(e) => {
                setPagina(0)
                setRemoto(null)
                setFiltros((f) => ({ ...f, q: e.target.value }))
              }}
            />
            {filtros.q && (
              <button
                type="button"
                className="btn fantasma"
                aria-label="Borrar búsqueda"
                onClick={() => {
                  setPagina(0)
                  setRemoto(null)
                  setFiltros((f) => ({ ...f, q: '' }))
                }}
              >
                Borrar
              </button>
            )}
            {buscandoRemoto ? (
              <button type="button" className="btn cancelar" onClick={cancelarBusquedaRemota}>
                Cancelar
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                disabled={filtros.q.trim().length < 3}
                onClick={() => void buscarEnSecop()}
                title="Busca en datos.gov.co sin límite de fechas (objeto y descripción) y trae lo que encuentre"
              >
                Buscar en SECOP
              </button>
            )}
          </form>

          {buscandoRemoto && <p className="sync-mensaje aviso-linea buscador-estado">Buscando «{filtros.q.trim()}» en SECOP…</p>}

          {remoto && (
            <div className="banner remoto buscador-estado">
              <span>
                <strong>
                  {formatNumber(remoto.res.ids.length)}{' '}
                  {remoto.res.ids.length === 1 ? 'resultado' : 'resultados'} en SECOP
                </strong>{' '}
                para «{remoto.texto}»
                {remoto.res.ids.length > 0 &&
                  ` (${Object.entries(remoto.res.porFuente)
                    .map(([fuente, n]) => `${formatNumber(n)} de ${fuente}`)
                    .join(', ')}; ${formatNumber(remoto.res.nuevas)} ${remoto.res.nuevas === 1 ? 'no estaba' : 'no estaban'} en este navegador)`}
                .
                {remoto.res.recortado && ' Se trajeron los 100 más recientes por fuente: afina la búsqueda si no está el que buscas.'}
                {remoto.res.alertas > 0 && ` ${remoto.res.alertas} con score alto: mira las alertas.`}
                {remoto.res.ids.length === 0 && ' Prueba con otras palabras o con el número de proceso.'}
              </span>
              <button type="button" className="btn fantasma" onClick={() => setRemoto(null)}>
                Volver a la lista
              </button>
            </div>
          )}

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
              busquedas={busquedas}
              onGuardarBusqueda={guardarBusqueda}
              onAplicarBusqueda={aplicarBusqueda}
              onBorrarBusqueda={borrarBusqueda}
            />
          )}

          <section className="resultados">
            <div className="resultados-head">
              <h2>
                {cargando
                  ? 'Buscando…'
                  : `${formatNumber(datos.total)} ${datos.total === 1 ? 'oportunidad' : 'oportunidades'}`}
              </h2>
              <div className="resultados-herramientas">
                <label className="orden">
                  <span>Orden</span>
                  <select
                    value={filtros.orden}
                    onChange={(e) => {
                      setPagina(0)
                      setFiltros((f) => ({ ...f, orden: e.target.value as Orden }))
                    }}
                  >
                    {ORDENES.map((o) => (
                      <option key={o.valor} value={o.valor}>
                        {o.etiqueta}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="exportar" role="group" aria-label="Descargar resultados">
                  <span>Descargar resultados:</span>
                  {FORMATOS.map((f) => (
                    <button
                      key={f.formato}
                      type="button"
                      className="btn fantasma mini"
                      disabled={exportando !== null || datos.total === 0}
                      onClick={() => void exportar(f.formato)}
                    >
                      {exportando === f.formato ? '…' : f.etiqueta}
                    </button>
                  ))}
                </div>
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
            </div>

            {aviso && <p className="sync-mensaje aviso-linea">{aviso}</p>}

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
                    {syncEstado?.error && <p className="vacio-nota">La última descarga falló: {syncEstado.error}</p>}
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
                      No hay servidor: nada se descarga hasta que pulses el botón (o actives la
                      sincronización periódica en <strong>Datos</strong>).
                    </p>
                  </>
                ) : (
                  <>
                    <p>No hay licitaciones que cumplan los filtros.</p>
                    {filtros.q && (
                      <p className="vacio-nota">
                        La búsqueda mira solo lo descargado en este navegador, y no muestra las que
                        marcaste como ocultas o descartadas. Si buscas un proceso concreto que no aparece,
                        puede ser de fuera de la ventana descargada: amplía los días en <strong>Datos</strong>.
                      </p>
                    )}
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
                  onDetalle={abrirDetalle}
                  onSeguir={onCRM}
                />
              ))}
            </div>

            {hayFiltros && (
              <button type="button" className="btn fantasma limpiar-abajo" onClick={limpiar}>
                Limpiar filtros
              </button>
            )}
          </section>
        </main>
      )}

      {detalle && (
        <Detalle
          id={detalle.id}
          pestanaInicial={detalle.pestana}
          version={detalleVersion}
          onAccion={onAccion}
          onCRM={onCRM}
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
