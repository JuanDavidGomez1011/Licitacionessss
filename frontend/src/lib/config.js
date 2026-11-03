/**
 * Configuracion de la aplicacion, toda en el navegador.
 *
 * Se lee de tres sitios, de mas especifico a mas general:
 *   1. `localStorage` (lo que el usuario cambia en el panel de datos y se guarda)
 *   2. `public/app-config.json` (se edita el fichero, sin recompilar)
 *   3. los valores por defecto de aqui
 *
 * El fichero del punto 2 se lee con `fetch`, que desde `file://` falla por CORS.
 * Por eso el fallo esta contemplado: se avisa en la consola y se sigue con los
 * valores por defecto. No es un error que pueda romper la pagina.
 */

const CLAVE = 'licitaciones.config.v1'

const POR_DEFECTO = {
  // --- datos abiertos ---
  socrataBase: 'https://www.datos.gov.co',
  datasetProcesos: 'p6dx-8zbt', // SECOP II - Procesos de Contratacion
  datasetContratos: 'jbjy-vk9h', // SECOP II - Contratos Electronicos
  // Registrate en datos.gov.co y ponlo aqui (o en app-config.json) para que
  // Socrata deje de devolver 503 con tanta frecuencia.
  appToken: '',

  // --- red ---
  pageSize: 500, // Socrata admite hasta 50.000 por pagina
  requestDelay: 350, // ms entre paginas: cortesia con el servidor; con un 429 sube sola (x3, tope 5 s)
  maxRetries: 4,
  timeoutMs: 90000,

  // --- ingesta ---
  lookbackDays: 7, // ventana por defecto de "descargar y puntuar"
  maxProcesos: 5000, // tope de procesos por pasada
  maxContratos: 2000,
  includeContracts: true,

  // --- puntuacion (en la pagina, sin modelos) ---
  puntuarEnLaDescarga: true,
  // Banda de similitud que se remapea a 0-100. Calibrada para TF-IDF, no para
  // embeddings: el coseno de TF-IDF entre textos relacionados cae en 0.05-0.35
  // y los ajenos por debajo de 0.03 (la banda del matchmaker con nomic-embed
  // era 0.45-0.88, que aqui daria 0 a todo).
  simFloor: 0.03,
  simCeil: 0.35,
  // Peso de la senal vectorial en la mezcla, igual que en el matchmaker (35/65).
  semanticWeight: 0.35,
  topicosSimilares: 12, // cuantos terminos se guardan por ficha para "similares"

  // --- comportamiento ---
  autoSyncAlAbrir: false, // nada descarga datos solo al abrir la pagina
}

let cache = null

function deAlmacenamiento() {
  try {
    const crudo = window.localStorage.getItem(CLAVE)
    return crudo ? JSON.parse(crudo) : {}
  } catch {
    return {}
  }
}

/**
 * Devuelve la configuracion efectiva. Es asincrono solo para poder leer el
 * fichero; si no esta disponible, resuelve igual con los defaults.
 */
export async function config({ recargar = false } = {}) {
  if (cache && !recargar) return cache
  cache = { ...POR_DEFECTO, ...deAlmacenamiento() }

  try {
    const res = await fetch(new URL('app-config.json', document.baseURI), { cache: 'no-store' })
    if (res.ok) {
      const desdeFichero = await res.json()
      // El fichero va por debajo de localStorage: lo que el usuario haya
      // cambiado en el panel manda sobre lo que este en el repositorio.
      cache = { ...cache, ...desdeFichero, ...deAlmacenamiento() }
    }
  } catch {
    console.warn(
      'config: no se pudo leer app-config.json (normal si abriste el index.html con file://). ' +
        'Se usan los valores por defecto y lo guardado en este navegador.',
    )
  }
  return cache
}

export function guardarConfig(parcial) {
  const actual = { ...(cache || POR_DEFECTO) }
  const siguiente = { ...actual, ...parcial }
  try {
    window.localStorage.setItem(CLAVE, JSON.stringify(parcial))
  } catch {
    console.warn('config: no se pudo guardar en localStorage')
  }
  cache = siguiente
  // El panel Datos y el selector de ventana del sincronizador viven en
  // componentes distintos: sin este aviso, cambiar los dias dejaba el selector
  // diciendo "ultimos 7 dias" aunque la descarga ya usara otra ventana.
  try {
    window.dispatchEvent(new CustomEvent('licitaciones:config', { detail: cache }))
  } catch {
    /* sin window (tests de Node puro) no hay nada que avisar */
  }
  return cache
}

export function valoresPorDefecto() {
  return { ...POR_DEFECTO }
}

export const DATASETS = {
  procesos: { id: 'procesos', campoFecha: 'fecha_de_ultima_publicaci', etiqueta: 'Procesos' },
  contratos: { id: 'contratos', campoFecha: 'fecha_de_firma', etiqueta: 'Contratos' },
}