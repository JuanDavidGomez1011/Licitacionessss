/**
 * Humo de verdad: la pagina en un navegador de verdad.
 *
 * Los tests de vitest cubren la logica con el almacen en memoria y sin red. Esto
 * cubre lo que solo aparece cuando todo lo demas esta en su sitio: el render de
 * React con CSS, IndexedDB de verdad, y la cadena entera de descarga
 * (Socrata -> mapper -> db -> indice -> score -> UI). Para no depender de
 * datos.gov.co se intercepta su respuesta con filas SoQL reales, que es tambien
 * la unica forma de comprobar el enlazado de contratos por `noticeUID`.
 */
import { expect, test, type Page, type Route } from '@playwright/test'

const PROCESOS = [
  {
    id_del_proceso: 'CO1.REQ.1',
    referencia_del_proceso: 'REQ-1',
    entidad: 'MINISTERIO DE SALUD',
    nit_entidad: '830009196',
    departamento_entidad: 'Bogota D.C.',
    ciudad_entidad: 'Bogota D.C.',
    nombre_del_procedimiento: '  Suministro de  software   de gestion clinica  ',
    descripci_n_del_procedimiento:
      'Contratar el suministro e implementacion de software de gestion clinica para hospitales del distrito, con soporte y Capacitacion.',
    precio_base: '450000000',
    modalidad_de_contratacion: 'Licitacion publica',
    justificaci_n_modalidad_de: 'Licitacion publica',
    duracion: '365',
    unidad_de_duracion: 'DIAS',
    numero_de_lotes: '1',
    codigo_principal_de_categoria: '80141600',
    categorias_adicionales: 'Software',
    estado_del_procedimiento: 'Convocada',
    adjudicado: 'No',
    fecha_de_publicacion_del: '2026-09-26T00:00:00',
    fecha_de_recepcion_de: '2026-08-01T00:00:00',
    fecha_de_apertura_de_respuesta: '2099-01-01T00:00:00',
    fecha_de_ultima_publicaci: '2026-09-26T00:00:00',
    tipo_de_contrato: 'Contrato',
    subtipo_de_contrato: 'Prestacion de servicios',
    urlproceso: { url: 'https://community.secop.gov.co/Public/Tendering/OpportunityDetail?noticeUID=CO1.NTC.1' },
    estado_resumen: 'Convocada',
  },
  {
    id_del_proceso: 'CO1.REQ.2',
    referencia_del_proceso: 'REQ-2',
    entidad: 'ALCALDIA DE MEDELLIN',
    nit_entidad: '890905211',
    departamento_entidad: 'Antioquia',
    ciudad_entidad: 'Medellin',
    nombre_del_procedimiento: 'Provision deOXigeno domiciliario',
    descripci_n_del_procedimiento: 'Suministro de oxigeno domiciliario y equipos medicos para pungis de salud.',
    precio_base: '80000000',
    modalidad_de_contratacion: 'Subasta',
    justificaci_n_modalidad_de: 'Subasta',
    duracion: '90',
    unidad_de_duracion: 'DIAS',
    numero_de_lotes: '2',
    codigo_principal_de_categoria: '42181800',
    categorias_adicionales: 'Oxigeno',
    estado_del_procedimiento: 'Convocada',
    adjudicado: 'No',
    fecha_de_publicacion_del: '2026-09-25T00:00:00',
    fecha_de_recepcion_de: '2026-08-01T00:00:00',
    fecha_de_apertura_de_respuesta: '2099-01-01T00:00:00',
    fecha_de_ultima_publicaci: '2026-09-25T00:00:00',
    tipo_de_contrato: 'Contrato',
    subtipo_de_contrato: 'Suministro',
    urlproceso: { url: 'https://community.secop.gov.co/Public/Tendering/OpportunityDetail?noticeUID=CO1.NTC.2' },
    estado_resumen: 'Convocada',
  },
]

const // La columna se llama `urlproceso` (sin guion bajo): asi la trae el dataset, y es
// la que lee `noticeUid()` para enlazar el contrato con su proceso.
CONTRATOS = [
  {
    id_contrato: 'CO1.PCCNTR.1',
    proceso_de_compra: 'CO1.REQ.1',
    referencia_del_contrato: 'CTR-1',
    nombre_entidad: 'MINISTERIO DE SALUD',
    nit_entidad: '830009196',
    departamento: 'Bogota D.C.',
    ciudad: 'Bogota D.C.',
    estado_contrato: 'Adjudicado',
    descripcion_del_proceso: 'Suministro de software de gestion clinica',
    objeto_del_contrato: 'Implementar el software de gestion clinica en doce hospitales',
    valor_del_contrato: '440000000',
    fecha_de_firma: '2026-09-20',
    fecha_de_inicio_del_contrato: '2026-10-01',
    fecha_de_fin_del_contrato: '2027-09-30',
    proveedor_adjudicado: 'PROVEEDOR DE SOFTWARE S.A.S.',
    urlproceso: {
      url: 'https://community.secop.gov.co/Public/Tendering/OpportunityDetail?noticeUID=CO1.NTC.1',
    },
  },
]

/**
 * Sustituye datos.gov.co por filas SoQL. Responde al `count(*)` y luego pagina
 * segun `$offset`/`$limit`, que es lo que espera `SocrataClient.iterRows`.
 */
async function fingirSocrata(page: Page): Promise<string[]> {
  const pedidos: string[] = []
  await page.route('**://*.datos.gov.co/**', async (route: Route) => {
    const url = new URL(route.request().url())
    // Una entrada legible por peticion: el dataset y la query sin codificar.
    pedidos.push(`${url.pathname} ${decodeURIComponent(url.search)}`)

    // SECOP I (`f789-7hwg`) se responde vacio: este humo mira la cadena de
    // SECOP II; el mapeo de SECOP I tiene su test unitario.
    const filas = url.pathname.includes('p6dx-8zbt') ? PROCESOS : url.pathname.includes('f789-7hwg') ? [] : CONTRATOS
    const json = (cuerpo: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cuerpo) })

    if (url.searchParams.get('$select')?.includes('count(*)')) return json([{ n: filas.length }])

    const limite = Number(url.searchParams.get('$limit')) || 500
    const offset = Number(url.searchParams.get('$offset')) || 0
    return json(filas.slice(offset, offset + limite))
  })
  return pedidos
}

test('la pagina carga en un navegador, con IndexedDB y sin errores de consola', async ({ page }) => {
  const errores: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errores.push(m.text())
  })
  page.on('pageerror', (e) => errores.push(String(e)))

  await fingirSocrata(page)
  await page.goto('/')

  // Sin datos todavia, pero el almacen es el de verdad: en Chromium sobre http
  // IndexedDB abre bien, asi que no debe salir el aviso de "solo en memoria".
  await expect(page.getByText(/todavía no tiene datos/)).toBeVisible()
  // `exact: true`: la nota del vacio tambien nombra el almacen, y lo que
  // importa aqui es el chip de cabecera (si no abriera IndexedDB diria "solo memoria").
  await expect(page.getByText('IndexedDB', { exact: true })).toBeVisible()
  expect(errores).toEqual([])
})

test('descargar trae los datos de Socrata, los puntua y los pinta', async ({ page }) => {
  const errores: string[] = []
  page.on('pageerror', (e) => errores.push(String(e)))

  const pedidos = await fingirSocrata(page)
  await page.goto('/')

  await page.getByRole('button', { name: 'Descargar SECOP' }).click()

  // La descarga entera: count, pagina de procesos, count y pagina de contratos.
  await expect(page.getByText('Descarga terminada')).toBeVisible({ timeout: 60_000 })

  // Los dos procesos, con el titulo normalizado (Socrata manda espacios dobles).
  // Se busca por rol y no por texto suelto: el titulo esta dentro de un h2 de una
  // tarjeta y el texto plano tambien aparece troceado en otros sitios.
  await expect(page.getByRole('heading', { name: 'Suministro de software de gestion clinica' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Provision deOXigeno domiciliario' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '2 oportunidades' })).toBeVisible()

  // Y el contrato tambien entra y queda enlazado a su proceso. Se comprueba por el
  // modal, que es donde se ve; la cabecera muestra el total de contratos.
  await page.getByRole('button', { name: 'Ver detalle' }).first().click()
  await expect(page.getByRole('heading', { name: /Contratos asociados \(1\)/ })).toBeVisible()
  await expect(page.getByText('CO1.PCCNTR.1')).toBeVisible()
  await expect(page.getByText('Sin contratos asociados')).toHaveCount(0)

  // Puntuados de verdad: la cabecera dice cuantos hay y la tarjeta lo enseña.
  await expect(page.getByText(/2 procesos/)).toBeVisible()
  await expect(page.getByText(/2 puntuados/)).toBeVisible()
  const scoreDeLaPrimera = await page.locator('article').first().innerText()
  expect(scoreDeLaPrimera).toMatch(/score/i)
  // El numero, no solo la etiqueta: `filaDe` devolvia `score` suelto y la
  // tarjeta lee `match`, asi que la lista pintaba "—" en todas las fichas
  // aunque la cabecera dijera "N puntuados". Este assert lo habria cazado.
  await expect(page.locator('article .score-num').first()).toHaveText(/^\d+$/)

// Se pidieron los dos datasets, y cada uno con su `count` ANTES que las filas: es
  // lo que permite pintar una barra de progreso real en vez de un spinner.
  const deProcesos = pedidos.filter((p) => p.includes('p6dx-8zbt'))
  const deContratos = pedidos.filter((p) => p.includes('jbjy-vk9h'))
  const esCount = (p: string) => p.includes('count(*)')
  const esPagina = (p: string) => p.includes('$limit=') && p.includes('$offset=')

  expect(deProcesos.some(esCount)).toBe(true)
  expect(deProcesos.some(esPagina)).toBe(true)
  // Solo hay 2 filas, asi que se piden 2 y no las 500 por pagina: `iterRows`
  // recorta la ultima pagina al numero de filas que quedan por leer, y con esto
  // no se baja de mas lo que Socrata tiene.
  expect(deProcesos.some((p) => p.includes('$limit=2'))).toBe(true)
  expect(deProcesos.some((p) => /[?&]\$limit=(\d+)/.test(p) && Number(p.match(/[?&]\$limit=(\d+)/)?.[1]) > 500)).toBe(false)
  // El filtro de ventana va por `fecha_de_ultima_publicaci`, no por la de
  // publicacion: es la que Colombia Compra Eficiente mueve al republicar. La
  // query llega con `+` donde deberia haber espacios, asi que se normaliza.
  const normalizado = (p: string) => p.replace(/\+/g, ' ')
  expect(deProcesos.some((p) => normalizado(p).includes('fecha_de_ultima_publicaci >='))).toBe(true)
  expect(deProcesos.some((p) => normalizado(p).includes('fecha_de_publicacion_del DESC'))).toBe(true)
  expect(deContratos.some(esCount)).toBe(true)
  expect(deContratos.some(esPagina)).toBe(true)
  expect(deContratos.some((p) => normalizado(p).includes('fecha_de_firma >='))).toBe(true)

  // El `count` va antes que la primera pagina de cada uno.
  expect(deProcesos.findIndex(esCount)).toBeLessThan(deProcesos.findIndex(esPagina))
  expect(deContratos.findIndex(esCount)).toBeLessThan(deContratos.findIndex(esPagina))

  expect(errores).toEqual([])
})

test('los datos sobreviven a recargar: se guardaron en IndexedDB, no en memoria', async ({ page }) => {
  await fingirSocrata(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Descargar SECOP' }).click()
  await expect(page.getByText('Descarga terminada')).toBeVisible({ timeout: 60_000 })

  await page.reload()

  await expect(page.getByRole('heading', { name: 'Suministro de software de gestion clinica' })).toBeVisible()
  await expect(page.getByText('IndexedDB')).toBeVisible()
  // El aviso de "solo memoria" es el que distingue las dos situaciones: si no
  // sale, los datos estan de verdad en el disco del navegador.
  await expect(page.getByText(/se pierden al cerrar/i)).toHaveCount(0)
})

test('el contrato se enlaza con su proceso por noticeUID', async ({ page }) => {
  await fingirSocrata(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Descargar SECOP' }).click()
  await expect(page.getByText('Descarga terminada')).toBeVisible({ timeout: 60_000 })

  // El detalle del segundo proceso, que es el que NO tiene contrato enlazado:
  // sirve para comprobar que el enlace es por proceso y no esta enganchando
  // cualquier contrato a la primera tarjeta.
  await page.getByRole('button', { name: 'Ver detalle' }).nth(1).click()
  await expect(page.getByRole('heading', { name: /Contratos asociados \(0\)/ })).toBeVisible()
  await expect(page.getByText('Sin contratos asociados')).toBeVisible()
  await page.getByRole('button', { name: 'Cerrar' }).click()

  // Y el del primero, que si lo tiene. Sin esto, "0 contratos" en todas habria
  // pasado el test anterior por casualidad.
  await page.getByRole('button', { name: 'Ver detalle' }).first().click()
  await expect(page.getByRole('heading', { name: /Contratos asociados \(1\)/ })).toBeVisible()
  await expect(page.getByText('CO1.PCCNTR.1')).toBeVisible()
})

test('una descarga limitada por Socrata deja el error visible tras recargar', async ({ page }) => {
  // El sintoma del usuario: la descarga choca con el limite de peticiones,
  // la pagina sale vacia y al recargar no queda ni rastro del error. El route
  // no sale de la maquina: la suite sigue pudiendo correr sin internet.
  await page.route('**://*.datos.gov.co/**', (route) =>
    route.fulfill({
      status: 429,
      // Sin `Expose-Headers`, CORS no deja que el JS lea `Retry-After` y el
      // cliente cae en la espera por defecto (5 s por intento) en vez de la que
      // manda el servidor.
      headers: {
        'Retry-After': '0',
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Retry-After',
      },
      body: JSON.stringify({ message: 'Too Many Requests' }),
    }),
  )
  await page.goto('/')

  await page.getByRole('button', { name: 'Descargar SECOP' }).click()
  const error = page.locator('.sync-error')
  await expect(error).toBeVisible({ timeout: 30_000 })
  // La pista accionable: sin ella el usuario solo ve una descarga que no acaba.
  await expect(error).toContainText('app-config.json')

  await page.reload()

  // Tras recargar el error sigue ahi, y el vacio dice donde viven los datos.
  await expect(page.locator('.sync-error')).toBeVisible()
  await expect(page.locator('.sync-error')).toContainText('HTTP 429')
  await expect(page.getByText(/todavía no tiene datos/)).toBeVisible()
  await expect(page.getByText(/La última descarga falló/)).toBeVisible()
})