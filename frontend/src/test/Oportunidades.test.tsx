import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import fixtures from './fixtures.json'
import type { ParamsConsulta } from '../lib/tipos'

/**
 * El panel ya no habla por HTTP: `api` es una fachada local. Por eso el mock es
 * del modulo `lib/api` y no de `fetch`. Antes se mockeaban las rutas `/api/...`,
 * lo que hacia que estos tests no detectaran ni un solo cambio de la fachada.
 *
 * Se reescribieron enteros al migrar a la pagina: las formas de respuesta se
 * mantienen, asi que los fixtures siguen valiendo.
 */
// `api` es un objeto con muchos metodos, no una funcion: el mock tiene que
// devolver ese objeto. Con `vi.fn().mockImplementation(obj)` solo semia lo que
// devuelve al *llamar* a la funcion, y `api.facetas` salia `undefined`.
// Por eso el mock expone un getter y los tests asignan `mockApi.actual`.
/** El doble de `api`: cada metodo es un `vi.fn`. */
type ApiFalsa = Record<string, Mock>

const { mockApi } = vi.hoisted(() => ({ mockApi: { actual: null as ApiFalsa | null } }))

/** Asigna el objeto que vera `api` en este test. */
const setApi = (impl: ApiFalsa) => {
  mockApi.actual = impl
}

vi.mock('../lib/api', () => ({
  get api() {
    return mockApi.actual
  },
  ApiError: class extends Error {},
}))

// El componente de descarga se suscribe al modulo de ingesta; aqui se le da un
// estado fijo para que no dependa de una ingesta real.
vi.mock('../lib/ingesta', () => ({
  suscribirseIngesta: (fn: (e: object) => void) => {
    fn({ corriendo: false, fase: null, hechos: 0, total: 0, nuevas: 0, repetidas: 0 })
    return () => {}
  },
}))

// jsdom no implementa `URL.createObjectURL`: la exportacion se sustituye y se
// comprueba que se le pasan las filas y el formato correctos. El contenido de
// los ficheros lo prueba `lib.test.ts`.
const { exportarFalso } = vi.hoisted(() => ({
  exportarFalso: vi.fn(async (_filas: unknown[], formato: string) => `licitaciones.${formato}`),
}))
vi.mock('../lib/exportar', () => ({ exportarOportunidades: exportarFalso }))

import Oportunidades from '../Oportunidades'

const SALUD = {
  estado: 'ok',
  base_datos: 'IndexedDB',
  ollama: 'no se usa',
  procesos: 100,
  contracts: 60,
  scored: 40,
  mensaje: null,
}

function apisPorDefecto(over: ApiFalsa = {}): ApiFalsa {
  return {
    salud: vi.fn(async () => SALUD),
    estadisticas: vi.fn(async () => fixtures.estadisticas),
    perfil: vi.fn(async () => fixtures.perfil),
    guardarPerfil: vi.fn(async (p: object) => p),
    configuracion: vi.fn(async () => ({
      appToken: '',
      lookbackDays: 7,
      maxProcesos: 5000,
      maxContratos: 2000,
      includeContracts: true,
    })),
    facetas: vi.fn(async () => fixtures.facetas),
    licitaciones: vi.fn(async () => fixtures.licitaciones),
    detalle: vi.fn(async () => fixtures.detalle),
    similares: vi.fn(async () => fixtures.similares),
    accion: vi.fn(async (_id: string, accion: string) => [{ accion, nota: null, created_at: '2026-09-26T00:00:00Z' }]),
    recalcular: vi.fn(async () => ({ score: 1 })),
    estadoSync: vi.fn(async () => ({ en_curso: false, ultimo: null })),
    sincronizar: vi.fn(async () => ({ lanzado: true, mensaje: 'ok' })),
    cancelarSync: vi.fn(async () => ({ cancelado: true })),
    repuntuar: vi.fn(async () => ({ lanzado: true })),
    historialSync: vi.fn(async () => ({ items: [] })),
    guardarConfig: vi.fn(async (c: object) => c),
    alertas: vi.fn(async () => []),
    marcarAlertasLeidas: vi.fn(async () => []),
    borrarAlertas: vi.fn(async () => []),
    busquedasGuardadas: vi.fn(async () => []),
    guardarBusqueda: vi.fn(async (nombre: string, filtros: object) => [
      { id: 'b-1', nombre, filtros, creada_en: '2026-11-03T00:00:00Z' },
    ]),
    borrarBusqueda: vi.fn(async () => []),
    licitacionesParaExportar: vi.fn(async () => fixtures.licitaciones.items),
    resumenPliego: vi.fn(async () => ({
      tender_id: fixtures.licitaciones.items[0]!.id_del_proceso,
      objeto: 'Objeto de prueba',
      datos_clave: [{ etiqueta: 'Entidad', valor: 'MinTIC' }],
      requisitos: {
        juridico: [{ texto: 'RUP vigente y en firme.', origen: 'habitual' }],
        financiero: [],
        tecnico: [{ texto: 'Experiencia en tres contratos similares.', origen: 'extraido' }],
      },
      advertencias: ['Verifica en SECOP.'],
      generado_en: '2026-11-03T00:00:00Z',
    })),
    tablero: vi.fn(async () => []),
    moverCRM: vi.fn(async (id: string, estado: string) => ({ tender_id: id, estado })),
    quitarCRM: vi.fn(async () => ({ ok: true })),
    notaCRM: vi.fn(async () => ({})),
    invalidarCache: vi.fn(async () => ({ ok: true })),
    borrarTodo: vi.fn(async () => ({ ok: true })),
    ...over,
  }
}

/** Los parametros de la ultima llamada a un metodo del doble. */
function ultimaLlamada(fn: Mock | undefined): ParamsConsulta {
  return (fn?.mock.calls.at(-1)?.[0] ?? {}) as ParamsConsulta
}

/** El `<article>` de la tarjeta con ese titulo. */
function tarjetaDe(titulo: string): HTMLElement {
  const el = screen.getByText(normaliza(titulo)).closest('article')
  if (!el) throw new Error(`no hay tarjeta para ${titulo}`)
  return el
}

beforeEach(() => {
  mockApi.actual = apisPorDefecto()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Oportunidades', () => {
  it('pinta una tarjeta por oportunidad con score, vinetas y presupuesto', async () => {
    render(<Oportunidades />)

    await screen.findByText(normaliza(fixtures.licitaciones.items[0].titulo))

    for (const op of fixtures.licitaciones.items) {
      // Los titulos de SECOP vienen con espacios dobles, que testing-library
      // normaliza al comparar: hay que normalizar tambien la expectativa.
      expect(screen.getByText(normaliza(op.titulo))).toBeInTheDocument()
    }

    expect(screen.getAllByText('score').length).toBeGreaterThan(0)
    for (const b of fixtures.licitaciones.items[0].match.bullets) {
      expect(screen.getByText(b)).toBeInTheDocument()
    }
  })

  it('muestra el almacenamiento en la cabecera en lugar de la BD y el modelo', async () => {
    render(<Oportunidades />)

    // Antes era "BD ok - IA ok". Ahora lo unico que puede fallar es el almacen.
    await screen.findByText('IndexedDB')
    expect(screen.getByText('score medio')).toBeInTheDocument()
    expect(screen.getByText(String(fixtures.estadisticas.avg_score))).toBeInTheDocument()
  })

  it('pasa los filtros a la fachada como los recibia la API', async () => {
    const api = apisPorDefecto()
    setApi(api)
    const user = userEvent.setup()
    render(<Oportunidades />)

    await screen.findByText(normaliza(fixtures.licitaciones.items[0].titulo))
    await user.click(screen.getByRole('button', { name: 'Mostrar filtros' }))

    fireSlider(screen.getByRole('slider'), 40)
    await waitFor(() => {
      expect(ultimaLlamada(api.licitaciones).score_min).toBe(40)
    })

    await user.type(screen.getByRole('searchbox'), 'software')
    await waitFor(() => {
      expect(ultimaLlamada(api.licitaciones).q).toBe('software')
    })
  })

  it('filtra por departamento usando las facetas', async () => {
    const api = apisPorDefecto()
    setApi(api)
    const user = userEvent.setup()
    render(<Oportunidades />)

    await screen.findByText(normaliza(fixtures.licitaciones.items[0].titulo))
    await user.click(screen.getByRole('button', { name: 'Mostrar filtros' }))

    const depto = fixtures.facetas.departamentos[0].valor
    await user.click(screen.getByRole('checkbox', { name: new RegExp(escape(depto)) }))

    await waitFor(() => {
      expect(ultimaLlamada(api.licitaciones).departamentos).toEqual([depto])
    })
  })

  it('persiste la accion guardar y la refleja en la tarjeta', async () => {
    const api = apisPorDefecto()
    setApi(api)
    const user = userEvent.setup()
    render(<Oportunidades />)

    const op = fixtures.licitaciones.items[0]
    await screen.findByText(normaliza(op.titulo))

    await user.click(within(tarjetaDe(op.titulo)).getAllByRole('button', { name: 'Guardar' })[0]!)

    await waitFor(() => {
      expect(api.accion).toHaveBeenCalledWith(op.id_del_proceso, 'guardar')
    })
  })

  it('abre el detalle y carga OCDS y similares', async () => {
    render(<Oportunidades />)
    const user = userEvent.setup()

    const op = fixtures.licitaciones.items[0]
    await screen.findByText(normaliza(op.titulo))

    await user.click(within(tarjetaDe(op.titulo)).getByRole('button', { name: 'Ver detalle' }))

    // Las pestañas deben bringar nombre, no el indice del hijo.
    await screen.findByRole('tab', { name: 'OCDS' })
    for (const etiqueta of ['Resumen', 'Análisis IA', 'Similares', 'OCDS']) {
      expect(screen.getByRole('tab', { name: etiqueta })).toBeInTheDocument()
    }

    await user.click(screen.getByRole('tab', { name: 'OCDS' }))
    expect(screen.getByText(/"ocid":/)).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Similares' }))
    // El titulo tambien esta en la tarjeta de la lista, asi que se acota al modal.
    const modal = document.querySelector<HTMLElement>('.modal')!
    expect(
      within(modal).getByText(fixtures.similares.items[0].oportunidad.titulo),
    ).toBeInTheDocument()
  })

  it('ofrece descargar y editar el perfil, que antes no se podia desde el panel', async () => {
    render(<Oportunidades />)
    await screen.findByText(normaliza(fixtures.licitaciones.items[0].titulo))

    expect(screen.getByRole('button', { name: 'Descargar SECOP' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Perfil' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Exportar' })).toBeInTheDocument()
  })

  it('el panel de perfil ofrece repuntuar, que antes solo se podia desde el backend', async () => {
    const api = apisPorDefecto()
    setApi(api)
    const user = userEvent.setup()
    render(<Oportunidades />)

    await screen.findByText(normaliza(fixtures.licitaciones.items[0].titulo))
    await user.click(screen.getByRole('button', { name: 'Perfil' }))

    await user.click(await screen.findByRole('button', { name: 'Guardar perfil' }))
    await waitFor(() => expect(api.repuntuar).not.toHaveBeenCalled())

    await user.click(screen.getByRole('button', { name: 'Repuntuar todo' }))
    await waitFor(() => expect(api.repuntuar).toHaveBeenCalled())
  })

  it('permite pegar el appToken y cambiar los topes desde el panel Datos', async () => {
    const api = apisPorDefecto()
    setApi(api)
    const user = userEvent.setup()
    render(<Oportunidades />)

    await screen.findByText(normaliza(fixtures.licitaciones.items[0].titulo))
    await user.click(screen.getByRole('button', { name: 'Datos' }))

    const token = await screen.findByLabelText('App token de Socrata')
    await user.type(token, 'token-de-prueba')
    await user.click(screen.getByRole('button', { name: 'Ventana completa · 7 días' }))
    await user.click(screen.getByRole('button', { name: 'Guardar ajustes' }))

    await waitFor(() => expect(api.guardarConfig).toHaveBeenCalled())
    expect(api.guardarConfig!.mock.calls.at(-1)?.[0]).toMatchObject({
      appToken: 'token-de-prueba',
      maxProcesos: 50000,
      maxContratos: 50000,
    })
  })

  it('sin datos explica que hay que descargar, en vez de decir que no hay resultados', async () => {
    setApi(
      apisPorDefecto({
        licitaciones: vi.fn(async () => ({ items: [], total: 0 })),
        estadisticas: vi.fn(async () => ({ tenders: 0, scored: 0, contracts: 0, avg_score: null, high_matches: 0 })),
      }),
    )
    render(<Oportunidades />)

    await screen.findByText(/todavía no tiene datos/)
    expect(screen.queryByText('Limpiar filtros')).not.toBeInTheDocument()
  })

  it('el vacío explica dónde viven los datos y qué falló en la última descarga', async () => {
    // Es el síntoma del usuario: descarga, actualiza y la página sale vacía.
    // Sin estas dos líneas hay que pedir un snippet por consola para saber si
    // fue un 429 de Socrata, otro origen u otro navegador.
    setApi(
      apisPorDefecto({
        licitaciones: vi.fn(async () => ({ items: [], total: 0 })),
        estadisticas: vi.fn(async () => ({ tenders: 0, scored: 0, contracts: 0, avg_score: null, high_matches: 0 })),
        estadoSync: vi.fn(async () => ({
          en_curso: false,
          fase: 'error',
          error: 'no se pudo consultar /resource/x.json tras 4 intentos: HTTP 429',
          hechos: 0,
          total: 0,
          ultimo: null,
        })),
      }),
    )
    render(<Oportunidades />)

    await screen.findByText(/todavía no tiene datos/)
    expect(screen.getByText(/La última descarga falló/)).toBeInTheDocument()
    // El origen exacto, para poder compararlo con la dirección desde la que se
    // descargó: `localhost` y `127.0.0.1` no comparten almacen.
    expect(screen.getByText(window.location.origin)).toBeInTheDocument()
    expect(screen.getByText(/127\.0\.0\.1/)).toBeInTheDocument()
  })

  it('con datos y filtro sin resultados ofrece limpiar filtros', async () => {
    setApi(apisPorDefecto({ licitaciones: vi.fn(async () => ({ items: [], total: 0 })) }))
    render(<Oportunidades />)

    await screen.findByText('No hay licitaciones que cumplan los filtros.')
    expect(screen.getByRole('button', { name: 'Limpiar filtros' })).toBeInTheDocument()
  })

  it('muestra el error de la fachada sin romperse', async () => {
    setApi(
      apisPorDefecto({
        licitaciones: vi.fn(async () => {
          throw new Error('boom')
        }),
      }),
    )
    render(<Oportunidades />)

    await screen.findByText('boom')
  })

  it('avisa en pantalla cuando el almacen cayo a memoria', async () => {
    // El fallo que dio este test: con IndexedDB bloqueado (incognito, doble clic
    // en el .html, cookies bloqueadas) el panel se ve perfectamente y al recargar
    // no queda nada. El aviso solo estaba en el `title` del chip, y hay que
    // acertar el raton para verlo.
    setApi(
      apisPorDefecto({
        salud: vi.fn(async () => ({
          ...SALUD,
          estado: 'degradado',
          base_datos: 'memoria',
          mensaje: 'Los datos viven solo en memoria',
        })),
      }),
    )
    render(<Oportunidades />)

    const aviso = await screen.findByText(/los datos no se están guardando/i)
    // El texto largo va fuera del `<strong>`, asi que se mira el banner entero.
    expect(normaliza(aviso.closest('.banner')?.textContent ?? '')).toMatch(
      /recargar o cerrar la pestaña/,
    )
    // Sin boton de cerrar: si no se guarda, es informacion que no se puede
    // dejar pasar con un clic.
    expect(screen.queryByRole('button', { name: '×' })).not.toBeInTheDocument()
  })

  it('con IndexedDB no enseña el aviso', async () => {
    setApi(apisPorDefecto())
    render(<Oportunidades />)

    await screen.findByText('Licitaciones públicas de Colombia, puntuadas en tu navegador')
    expect(screen.queryByText(/no se están guardando/i)).not.toBeInTheDocument()
  })

  it('pinta el semáforo Alto/Medio/Bajo junto al score', async () => {
    render(<Oportunidades />)
    const op = fixtures.licitaciones.items[0]!
    await screen.findByText(normaliza(op.titulo))
    // El fixture trae 70: el corte de "Alto".
    expect(within(tarjetaDe(op.titulo)).getByText('Alto')).toBeInTheDocument()
  })

  it('Resumir pliego abre el detalle en la pestaña de requisitos', async () => {
    const api = apisPorDefecto()
    setApi(api)
    const user = userEvent.setup()
    render(<Oportunidades />)

    const op = fixtures.licitaciones.items[0]!
    await screen.findByText(normaliza(op.titulo))
    await user.click(within(tarjetaDe(op.titulo)).getByRole('button', { name: 'Resumir pliego' }))

    expect(await screen.findByText('RUP vigente y en firme.')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Requisitos' })).toHaveAttribute('aria-selected', 'true')
    expect(api.resumenPliego).toHaveBeenCalledWith(op.id_del_proceso)
  })

  it('Al tablero mete la oportunidad en la columna En evaluación', async () => {
    const api = apisPorDefecto()
    setApi(api)
    const user = userEvent.setup()
    render(<Oportunidades />)

    const op = fixtures.licitaciones.items[0]!
    await screen.findByText(normaliza(op.titulo))
    await user.click(within(tarjetaDe(op.titulo)).getByRole('button', { name: 'Al tablero' }))

    await waitFor(() => expect(api.moverCRM).toHaveBeenCalledWith(op.id_del_proceso, 'evaluacion'))
    expect(await within(tarjetaDe(op.titulo)).findByText(/Tablero: En evaluación/)).toBeInTheDocument()
  })

  it('la vista Tablero pinta las cinco columnas con sus tarjetas', async () => {
    setApi(
      apisPorDefecto({
        tablero: vi.fn(async () => [
          {
            tender_id: 'X1',
            estado: 'presentada',
            nota: '',
            titulo: 'Licencias de software ofimatico',
            entidad: 'MinTIC',
            precio_base: 90000000,
            fecha_cierre: null,
            url_proceso: null,
            score: 85,
            creado_en: '2026-11-01T00:00:00Z',
            actualizado_en: '2026-11-02T00:00:00Z',
          },
        ]),
      }),
    )
    const user = userEvent.setup()
    render(<Oportunidades />)
    await user.click(screen.getByRole('tab', { name: 'Tablero' }))

    for (const columna of ['En evaluación', 'En preparación', 'Oferta presentada', 'Ganada', 'Descartada']) {
      expect(await screen.findByRole('heading', { name: new RegExp(columna) })).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: 'Licencias de software ofimatico' })).toBeInTheDocument()
    expect(screen.getByLabelText('Columna de Licencias de software ofimatico')).toHaveValue('presentada')
  })

  it('descarga los resultados filtrados en el formato elegido', async () => {
    const api = apisPorDefecto()
    setApi(api)
    const user = userEvent.setup()
    render(<Oportunidades />)

    await screen.findByText(normaliza(fixtures.licitaciones.items[0]!.titulo))
    await user.click(screen.getByRole('button', { name: 'Mostrar filtros' }))
    fireSlider(screen.getByRole('slider'), 40)
    await user.click(screen.getByRole('button', { name: 'Excel' }))

    await waitFor(() => expect(exportarFalso).toHaveBeenCalled())
    // Exporta lo filtrado, no la pagina: se piden todas con los mismos filtros.
    expect(ultimaLlamada(api.licitacionesParaExportar).score_min).toBe(40)
    expect(exportarFalso.mock.calls.at(-1)?.[1]).toBe('xlsx')
    expect(await screen.findByText(/Descargado licitaciones\.xlsx/)).toBeInTheDocument()
  })

  it('guarda la búsqueda actual con un nombre y la vuelve a aplicar', async () => {
    const api = apisPorDefecto()
    setApi(api)
    const user = userEvent.setup()
    render(<Oportunidades />)

    await screen.findByText(normaliza(fixtures.licitaciones.items[0]!.titulo))
    await user.click(screen.getByRole('button', { name: 'Mostrar filtros' }))
    await user.type(screen.getByPlaceholderText('obra, alimentos, vigilancia'), 'obra')
    await user.type(screen.getByLabelText('Nombre de la búsqueda'), 'Sin obra')
    await user.click(screen.getByRole('button', { name: 'Guardar búsqueda' }))

    await waitFor(() => expect(api.guardarBusqueda).toHaveBeenCalled())
    const [nombre, filtros] = api.guardarBusqueda!.mock.calls.at(-1) as [string, { excluir: string }]
    expect(nombre).toBe('Sin obra')
    expect(filtros.excluir).toBe('obra')
    // Excluir llega a la fachada como lista de terminos.
    await waitFor(() => expect(ultimaLlamada(api.licitaciones).excluir).toEqual(['obra']))

    await user.click(screen.getByRole('button', { name: 'Limpiar' }))
    await waitFor(() => expect(ultimaLlamada(api.licitaciones).excluir).toBeUndefined())
    await user.click(await screen.findByRole('button', { name: 'Sin obra' }))
    await waitFor(() => expect(ultimaLlamada(api.licitaciones).excluir).toEqual(['obra']))
  })

  it('Buscar en SECOP enseña solo lo encontrado y se puede volver a la lista', async () => {
    const op = fixtures.licitaciones.items[0]!
    const api = apisPorDefecto({
      buscarEnSecop: vi.fn(async () => ({
        ids: [op.id_del_proceso],
        nuevas: 1,
        porFuente: { 'SECOP II': 1 },
        recortado: false,
        alertas: 0,
        aviso: null,
      })),
    })
    setApi(api)
    const user = userEvent.setup()
    render(<Oportunidades />)

    await screen.findByText(normaliza(op.titulo))
    const boton = screen.getByRole('button', { name: 'Buscar en SECOP' })
    expect(boton).toBeDisabled()
    await user.type(screen.getByRole('searchbox'), 'antiplagio')
    await user.click(boton)

    await waitFor(() => expect(api.buscarEnSecop).toHaveBeenCalledWith('antiplagio', expect.any(AbortSignal)))
    expect(await screen.findByText(/1 resultado en SECOP/)).toBeInTheDocument()
    // La lista pide exactamente esos ids, sin el texto: `$q` miro la descripcion.
    await waitFor(() => expect(ultimaLlamada(api.licitaciones).ids).toEqual([op.id_del_proceso]))
    expect(ultimaLlamada(api.licitaciones).q).toBeUndefined()

    await user.click(screen.getByRole('button', { name: 'Volver a la lista' }))
    await waitFor(() => expect(ultimaLlamada(api.licitaciones).ids).toBeUndefined())
    expect(ultimaLlamada(api.licitaciones).q).toBe('antiplagio')
  })

  it('la campana cuenta las alertas sin leer y abre la ficha', async () => {
    const op = fixtures.licitaciones.items[0]!
    const api = apisPorDefecto({
      alertas: vi.fn(async () => [
        { tender_id: op.id_del_proceso, titulo: 'Alerta de prueba', entidad: 'MinTIC', score: 91, creada_en: '2026-11-03T10:00:00Z', leida: false },
      ]),
    })
    setApi(api)
    const user = userEvent.setup()
    render(<Oportunidades />)

    await user.click(await screen.findByRole('button', { name: 'Alertas (1)' }))
    await user.click(screen.getByRole('button', { name: 'Alerta de prueba' }))
    expect(api.marcarAlertasLeidas).toHaveBeenCalledWith([op.id_del_proceso])
    await waitFor(() => expect(api.detalle).toHaveBeenCalledWith(op.id_del_proceso))
  })
})

/** react-range no expone un setter comodo; dispara el evento nativo. */
function fireSlider(element: HTMLElement, valor: number) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(element, String(valor))
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Colapsa espacios, como hace el matcher de testing-library. */
function normaliza(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}