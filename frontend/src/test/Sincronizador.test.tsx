import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

/**
 * Test del componente de descarga.
 *
 * Lo importante aqui es el cambio de fondo: antes se comprobaba que el boton
 * lanzaba un POST y que el polling del backend acababa detectando el fin del
 * ciclo, con su "ventana de gracia" de 8 intentos porque el proceso de Python
 * todavia no habia cogido el lock. Ahora la ingesta vive en la propia pestana:
 * el progreso llega por suscripción y se puede cancelar, que antes no se podia.
 */
// `api` es un objeto con varios metodos, no una funcion: el mock lo expone con un
// getter, porque con `vi.fn().mockImplementation(obj)` solo se define lo que
// devuelve al llamar, y `api.estadoSync` salia `undefined`.
type ApiFalsa = Record<string, Mock>

const { mockApi } = vi.hoisted(() => ({ mockApi: { actual: {} as ApiFalsa } }))

vi.mock('../lib/api', () => ({
  get api() {
    return mockApi.actual
  },
  ApiError: class extends Error {},
}))

// El modulo real de ingesta se sustituye por un emisor controlado, para poder
// simular el progreso sin lanzar peticiones de red.
type Oyente = (estado: object) => void
const { oyentes } = vi.hoisted(() => ({ oyentes: new Set<Oyente>() }))

vi.mock('../lib/ingesta', () => ({
  suscribirseIngesta: (fn: Oyente) => {
    oyentes.add(fn)
    fn({ corriendo: false, fase: null, hechos: 0, total: 0, nuevas: 0, repetidas: 0 })
    return () => oyentes.delete(fn)
  },
}))

import Sincronizador from '../components/Sincronizador'

const estadoInicial = {
  en_curso: false,
  ultimo: { status: 'ok', rows_inserted: 1200, started_at: '2026-09-26T14:00:00Z' },
}

function apis(over: ApiFalsa = {}): ApiFalsa {
  return {
    estadoSync: vi.fn(async () => estadoInicial),
    configuracion: vi.fn(async () => ({ lookbackDays: 7 })),
    sincronizar: vi.fn(async () => ({ lanzado: true, mensaje: 'descargando' })),
    cancelarSync: vi.fn(async () => ({ cancelado: true })),
    repuntuar: vi.fn(async () => ({ lanzado: true })),
    ...over,
  }
}

/** Emite un estado de ingesta a todos los suscriptores, como hace el modulo real. */
function emitir(estado: object) {
  // Va dentro de `act`: el aviso "update not wrapped in act" aparece cuando el
  // estado llega por una suscripcion y no por un evento de React.
  act(() => {
    for (const fn of oyentes) fn(estado)
  })
}

beforeEach(() => {
  oyentes.clear()
  mockApi.actual = apis()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Sincronizador', () => {
  it('ofrece descargar y no ofrece cancelar en reposo', async () => {
    render(<Sincronizador />)

    expect(screen.getByRole('button', { name: 'Descargar SECOP' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument()
    await screen.findByText(/última: 1\.200 nuevas/)
  })

  it('el selector de ventana usa los dias configurados en el panel Datos', async () => {
    mockApi.actual = apis({ configuracion: vi.fn(async () => ({ lookbackDays: 30 })) })
    render(<Sincronizador />)

    expect(await screen.findByRole('option', { name: 'últimos 30 días' })).toBeInTheDocument()
  })

  it('lanza la descarga al pulsar y avisa de que sigue en la pestana', async () => {
    const user = userEvent.setup()
    render(<Sincronizador />)

    await user.click(screen.getByRole('button', { name: 'Descargar SECOP' }))

    expect(mockApi.actual.sincronizar).toHaveBeenCalled()
    await screen.findByText(/puedes seguir usando el panel/)
  })

  it('muestra la barra con el progreso real y el boton de cancelar', async () => {
    const user = userEvent.setup()
    render(<Sincronizador />)

    await user.click(screen.getByRole('button', { name: 'Descargar SECOP' }))
    emitir({ corriendo: true, fase: 'procesos', hechos: 500, total: 5000, nuevas: 480, repetidas: 20 })

    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeInTheDocument()
    expect(screen.getByText(/procesos 500 \/ 5\.000/)).toBeInTheDocument()
    expect(screen.getByText(/480 nuevas/)).toBeInTheDocument()
    // El boton de descargar se deshabilita mientras corre: dos descargas a la vez
    // pelearian por el mismo almacen.
    expect(screen.getByRole('button', { name: 'Descargando…' })).toBeDisabled()
  })

  it('cancelar llama a la API y lo avisa', async () => {
    const user = userEvent.setup()
    render(<Sincronizador />)

    await user.click(screen.getByRole('button', { name: 'Descargar SECOP' }))
    emitir({ corriendo: true, fase: 'procesos', hechos: 100, total: 5000 })

    await user.click(await screen.findByRole('button', { name: 'Cancelar' }))
    expect(mockApi.actual.cancelarSync).toHaveBeenCalled()
    await screen.findByText(/Cancelando/)
  })

  it('avisa al terminar para que la lista se recargue', async () => {
    const user = userEvent.setup()
    const alTerminar = vi.fn()
    render(<Sincronizador alTerminar={alTerminar} />)

    await user.click(screen.getByRole('button', { name: 'Descargar SECOP' }))
    emitir({ corriendo: true, fase: 'procesos', hechos: 100, total: 100 })
    expect(alTerminar).not.toHaveBeenCalled()

    emitir({ corriendo: false, fase: 'listo', hechos: 100, total: 100 })
    await waitFor(() => expect(alTerminar).toHaveBeenCalled())
    await screen.findByText('Descarga terminada')
  })

  it('no confunde una descarga cancelada con una terminada', async () => {
    const user = userEvent.setup()
    const alTerminar = vi.fn()
    render(<Sincronizador alTerminar={alTerminar} />)

    await user.click(screen.getByRole('button', { name: 'Descargar SECOP' }))
    emitir({ corriendo: true, fase: 'procesos', hechos: 10, total: 100 })
    emitir({ corriendo: false, fase: 'cancelado', hechos: 10, total: 100 })

    // Aun asi recarga la lista: puede haber escrito parte antes de parar.
    await waitFor(() => expect(alTerminar).toHaveBeenCalled())
    await screen.findByText('Descarga cancelada')
  })

  it('distingue repuntar de descargar al terminar', async () => {
    const alTerminar = vi.fn()
    render(<Sincronizador alTerminar={alTerminar} />)

    // Repuntuar no pasa por `api.sincronizar`: emite su propio ciclo.
    emitir({ corriendo: true, fase: 'repuntuando', hechos: 0, total: 1000 })
    expect(await screen.findByRole('button', { name: 'Cancelar' })).toBeInTheDocument()
    // La barra pinta fase, hechos y total en nodos distintos y sin espacios entre
    // ellos, asi que se comprueba el `title` de la barra, que es un nodo solo.
    expect(screen.getByTitle('0 de 1000 en repuntuando')).toBeInTheDocument()

    emitir({ corriendo: false, fase: 'repuntuado', hechos: 1000, total: 1000 })
    await screen.findByText('Repuntuación terminada')
    expect(alTerminar).toHaveBeenCalled()
  })

  it('muestra el error de una descarga fallida sin llamarla terminada', async () => {
    const user = userEvent.setup()
    render(<Sincronizador />)

    await user.click(screen.getByRole('button', { name: 'Descargar SECOP' }))
    emitir({ corriendo: true, fase: 'procesos', hechos: 10, total: 100 })
    emitir({ corriendo: false, fase: 'error', error: 'Socrata devolvio 503' })

    expect(await screen.findByText('Socrata devolvio 503')).toBeInTheDocument()
    expect(screen.queryByText('Descarga terminada')).not.toBeInTheDocument()
  })

  it('el error de una descarga fallida se ve tambien recien abierta la pagina', async () => {
    // El caso real: la descarga falla, el usuario pulsa F5 y la pagina sale
    // vacia. Si el error solo viviera en la memoria de la pestana, tras
    // recargar no quedaria ni rastro de que algo fallo.
    mockApi.actual = apis({
      estadoSync: vi.fn(async () => ({
        en_curso: false,
        fase: 'error',
        error: 'no se pudo consultar /resource/x.json tras 4 intentos: HTTP 429',
        hechos: 0,
        total: 0,
        ultimo: null,
      })),
    })
    render(<Sincronizador />)

    await screen.findByText(/HTTP 429/)
    expect(screen.queryByText('Descarga terminada')).not.toBeInTheDocument()
  })

  it('avisa de una descarga interrumpida a mitad tras recargar', async () => {
    mockApi.actual = apis({
      estadoSync: vi.fn(async () => ({
        en_curso: false,
        fase: 'interrumpida',
        error: null,
        hechos: 300,
        total: 5000,
        ultimo: null,
      })),
    })
    render(<Sincronizador />)

    await screen.findByText(/interrumpida \(300 \/ 5\.000\)/)
    expect(screen.getByText(/pulsa Descargar para retomar/)).toBeInTheDocument()
  })

  it('el selector de ventana solo aparece cuando no hay descarga en curso', async () => {
    const user = userEvent.setup()
    render(<Sincronizador />)

    expect(await screen.findByTitle('Ventana de fechas a descargar')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Descargar SECOP' }))
    emitir({ corriendo: true, fase: 'procesos', hechos: 1, total: 10 })
    expect(screen.queryByTitle('Ventana de fechas a descargar')).not.toBeInTheDocument()
  })
})