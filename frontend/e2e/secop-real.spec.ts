import { expect, test, type Page } from '@playwright/test'

/**
 * Carga REAL de SECOP, con tope bajo a proposito.
 *
 * `humo.spec.js` intercepta `datos.gov.co` con dos filas de ejemplo: prueba la
 * cadena entera, pero no el volumen ni los 503 de Socrata, que solo salen con los
 * datos de verdad. Esta prueba es la que faltaba para cerrar eso.
 *
 * Va acotada a proposito, porque la ventana de 7 dias trae ~24.000 filas de
 * procesos y ~14.000 contratos (medido el 29/10): descargar todo son ~100 MB. Los topes se recortan desde
 * `localStorage` (la app los lee de ahi antes de descargar) y no tocando el
 * codigo, para no dejar un limite artificial en el producto.
 *
 * NO corre en `npm run test:e2e`: golpea el portal de datos abiertos de verdad, y
 * esa suite tiene que poder correr en cualquier maquina sin internet. A mano:
 *
 *     $env:SECOP_REAL = '1'
 *     npx playwright test e2e/secop-real.spec.js
 */
const TOPES = {
  lookbackDays: 7,
  maxProcesos: 120,
  maxContratos: 60,
  // SECOP I va aparte y con su propio tope: sin el, la ventana de 7 dias trajo
  // 1.261 convocados de SECOP I en la primera corrida (3/11/2026).
  incluirSecopI: true,
  maxProcesosSecopI: 60,
  puntuarEnLaDescarga: true,
  includeContracts: true,
}

const LIMITE = 15 * 60 * 1000

/** El chip de la cabecera: "IndexedDB - N procesos - M puntuados". */
async function leerContadores(page: Page) {
  const texto = await page.locator('.estado').innerText()
  const n = (re: RegExp) => Number((texto.match(re)?.[1] ?? '0').replace(/\./g, ''))
  return {
    texto: texto.replace(/\s+/g, ' ').trim(),
    procesos: n(/([\d.]+)\s+procesos/),
    puntuados: n(/([\d.]+)\s+puntuados/),
  }
}

test('una carga acotada de SECOP entra, se puntua y sobrevive a recargar', async ({ page }) => {
  test.skip(!process.env.SECOP_REAL, 'golpea datos.gov.co de verdad: pon SECOP_REAL=1')
  test.setTimeout(LIMITE)

  const errores: string[] = []
  const caidas: string[] = []
  const malas: string[] = []
  let peticiones = 0

  page.on('console', (m) => m.type() === 'error' && errores.push(m.text()))
  page.on('pageerror', (e) => errores.push(`pageerror: ${e.message}`))
  page.on('requestfailed', (r) => caidas.push(`${r.url()} :: ${r.failure()?.errorText}`))
  page.on('response', (r) => {
    if (!r.url().includes('datos.gov.co')) return
    peticiones += 1
    if (r.status() >= 400) malas.push(`${r.status()} ${r.url().slice(0, 130)}`)
  })

  // La config se inyecta antes de que corra la app: `config()` la lee de
  // `localStorage`, que tiene prioridad sobre `app-config.json`.
  await page.addInitScript((cfg) => {
    window.localStorage.setItem('licitaciones.config.v1', JSON.stringify(cfg))
  }, TOPES)

  await page.goto('/')
  await page.getByRole('button', { name: 'Descargar SECOP' }).click()

  // El progreso tiene que verse de verdad: si la barra no aparece, la descarga no
  // va contando y el "terminada" de abajo no diria nada.
  await expect(page.locator('.sync-barra')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Descarga terminada')).toBeVisible({ timeout: LIMITE - 60_000 })

  const contadores = await leerContadores(page)
  const pintadas = await page.locator('.lista .tarjeta').count()

  console.log('\n  --- SECOP real ---')
  console.log(`  peticiones a datos.gov.co : ${peticiones}`)
  console.log(`  respuestas 4xx/5xx         : ${malas.length}`)
  malas.slice(0, 6).forEach((m) => console.log(`      ${m}`))
  console.log(`  peticiones caidas          : ${caidas.length}`)
  caidas.slice(0, 6).forEach((m) => console.log(`      ${m}`))
  console.log(`  fichas pintadas            : ${pintadas}`)
  console.log(`  contadores                 : ${contadores.texto}`)
  console.log(`  errores de consola         : ${errores.length}`)
  errores.slice(0, 6).forEach((m) => console.log(`      ${m}`))

  expect(peticiones).toBeGreaterThanOrEqual(6) // 3 counts + 3 paginas (SECOP II, SECOP I, contratos)
  expect(caidas).toEqual([])
  expect(errores).toEqual([])
  expect(pintadas).toBeGreaterThan(0)
  // El tope se pide en la URL (`$limit`), no despues de leer: si se comprobara
  // tarde, con paginas de 500 se guardarian cientos de mas. Puede quedar por
  // debajo del tope porque el portal devuelve ids repetidos y `deduplicar` los
  // quita (de 120 filas salieron 116 distintas en la ultima corrida).
  expect(contadores.procesos).toBeGreaterThan(0)
  expect(contadores.procesos).toBeLessThanOrEqual(TOPES.maxProcesos + TOPES.maxProcesosSecopI)
  // Entraron procesos de las dos fuentes: la faceta "Fuente" lo cuenta.
  await page.getByRole('button', { name: 'Mostrar filtros' }).click()
  await page.locator('details.grupo summary', { hasText: 'Fuente' }).click()
  await expect(page.getByRole('checkbox', { name: /SECOP I \d/ })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: /SECOP II/ })).toBeVisible()
  // Lo descargado se puntua en la misma pasada: sin esto, "terminada" podria
  // significar "guardado y sin puntuar".
  expect(contadores.puntuados).toBeGreaterThan(0)
  expect(contadores.puntuados).toBe(contadores.procesos)

  // Y no se pierde al recargar: es IndexedDB, no memoria.
  await page.reload()
  await expect(page.locator('.estado')).toContainText('IndexedDB')
  await expect.poll(async () => (await leerContadores(page)).procesos).toBe(contadores.procesos)
  await expect(page.locator('.lista .tarjeta').first()).toBeVisible({ timeout: 30_000 })
})