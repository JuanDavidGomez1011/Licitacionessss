import '@testing-library/jest-dom/vitest'
import { beforeEach } from 'vitest'
import { fijarAlmacen } from '../lib/db'

/**
 * Los tests corren en jsdom, que no implementa IndexedDB. Sin esto, `abrirAlmacen`
 * caeria al almacen de memoria avisando por consola en cada test, y lo que uno
 * prueba aqui no es lo que corre en un navegador real.
 *
 * Forzarlo aqui, y no en cada test, es lo que deja la suite sin depender del
 * orden: cada test empieza con el almacen vacio.
 */
beforeEach(async () => {
  await fijarAlmacen('memoria')
})