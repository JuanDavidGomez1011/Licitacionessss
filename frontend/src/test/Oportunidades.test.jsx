import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixtures from './fixtures.json'

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
const { mockApi } = vi.hoisted(() => ({ mockApi: { actual: null } }))

/** Asigna el objeto que vera `api` en este test. */
const setApi = (impl) => {
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
  suscribirseIngesta: (fn) => {
    fn({ corriendo: false, fase: null, hechos: 0, total: 0, nuevas: 0, repetidas: 0 })
    return () => {}
  },
}))

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

function apisPorDefecto(over = {}) {
  return {
    salud: vi.fn(async () => SALUD),
    estadisticas: vi.fn(async () => fixtures.estadisticas),
    perfil: vi.fn(async () => fixtures.perfil),
    guardarPerfil: vi.fn(async (p) => p),
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
    accion: vi.fn(async (_id, accion) => [{ accion, nota: null, created_at: '2026-09-26T00:00:00Z' }]),
    recalcular: vi.fn(async () => ({ score: 1 })),
    estadoSync: vi.fn(async () => ({ en_curso: false, ultimo: null })),
    sincronizar: vi.fn(async () => ({ lanzado: true, mensaje: 'ok' })),
    cancelarSync: vi.fn(async () => ({ cancelado: true })),
    repuntuar: vi.fn(async () => ({ lanzado: true })),
    historialSync: vi.fn(async () => ({ items: [] })),
    guardarConfig: vi.fn(async (c) => c),
    invalidarCache: vi.fn(async () => ({ ok: true })),
    borrarTodo: vi.fn(async () => ({ ok: true })),
    ...over,
  }
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
      const ultimo = api.licitaciones.mock.calls.at(-1)[0]
      expect(ultimo.score_min).toBe(40)
    })

    await user.type(screen.getByRole('searchbox'), 'software')
    await waitFor(() => {
      const ultimo = api.licitaciones.mock.calls.at(-1)[0]
      expect(ultimo.q).toBe('software')
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
      const ultimo = api.licitaciones.mock.calls.at(-1)[0]
      expect(ultimo.departamentos).toEqual([depto])
    })
  })

  it('persiste la accion guardar y la refleja en la tarjeta', async () => {
    const api = apisPorDefecto()
    setApi(api)
    const user = userEvent.setup()
    render(<Oportunidades />)

    const op = fixtures.licitaciones.items[0]
    await screen.findByText(normaliza(op.titulo))

    const tarjeta = screen.getByText(normaliza(op.titulo)).closest('article')
    await user.click(within(tarjeta).getAllByRole('button', { name: 'Guardar' })[0])

    await waitFor(() => {
      expect(api.accion).toHaveBeenCalledWith(op.id_del_proceso, 'guardar')
    })
  })

  it('abre el detalle y carga OCDS y similares', async () => {
    render(<Oportunidades />)
    const user = userEvent.setup()

    const op = fixtures.licitaciones.items[0]
    await screen.findByText(normaliza(op.titulo))

    const tarjeta = screen.getByText(normaliza(op.titulo)).closest('article')
    await user.click(within(tarjeta).getByRole('button', { name: 'Ver detalle' }))

    // Las pestañas deben bringar nombre, no el indice del hijo.
    await screen.findByRole('tab', { name: 'OCDS' })
    for (const etiqueta of ['Resumen', 'Análisis IA', 'Similares', 'OCDS']) {
      expect(screen.getByRole('tab', { name: etiqueta })).toBeInTheDocument()
    }

    await user.click(screen.getByRole('tab', { name: 'OCDS' }))
    expect(screen.getByText(/"ocid":/)).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Similares' }))
    // El titulo tambien esta en la tarjeta de la lista, asi que se acota al modal.
    const modal = document.querySelector('.modal')
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
    expect(api.guardarConfig.mock.calls.at(-1)[0]).toMatchObject({
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
    expect(normaliza(aviso.closest('.banner').textContent)).toMatch(
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
})

/** react-range no expone un setter comodo; dispara el evento nativo. */
function fireSlider(element, valor) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(element, String(valor))
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Colapsa espacios, como hace el matcher de testing-library. */
function normaliza(s) {
  return s.replace(/\s+/g, ' ').trim()
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}