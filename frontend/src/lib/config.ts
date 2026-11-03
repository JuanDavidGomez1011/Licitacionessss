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

import type { Config, PesosScore } from './tipos'

const CLAVE = 'licitaciones.config.v1'

/**
 * Pesos del score compuesto. Suman 100 para que se lean como porcentajes, pero
 * se normalizan al mezclar: un componente sin datos (sin UNSPSC en el perfil,
 * sin fecha de cierre) reparte su peso entre los demas.
 */
export const PESOS_POR_DEFECTO: PesosScore = {
  objeto: 30,
  unspsc: 25,
  presupuesto: 20,
  palabras: 15,
  tiempo: 10,
}

const POR_DEFECTO: Config = {
  // --- datos abiertos ---
  socrataBase: 'https://www.datos.gov.co',
  datasetProcesos: 'p6dx-8zbt', // SECOP II - Procesos de Contratacion
  datasetContratos: 'jbjy-vk9h', // SECOP II - Contratos Electronicos
  datasetSecopI: 'f789-7hwg', // SECOP I - Procesos de Compra Publica
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
  // SECOP I casi no tiene procesos nuevos (~2.500 convocados por semana); el
  // tope es para que una ventana larga no se coma la descarga entera.
  maxProcesosSecopI: 2000,
  includeContracts: true,
  incluirSecopI: true,

  // --- puntuacion (en la pagina, sin modelos) ---
  puntuarEnLaDescarga: true,
  // Banda de similitud que se remapea a 0-100. Calibrada para TF-IDF, no para
  // embeddings: el coseno de TF-IDF entre textos relacionados cae en 0.05-0.35
  // y los ajenos por debajo de 0.03 (la banda del matchmaker con nomic-embed
  // era 0.45-0.88, que aqui daria 0 a todo).
  simFloor: 0.03,
  simCeil: 0.35,
  pesos: { ...PESOS_POR_DEFECTO },
  topicosSimilares: 12, // cuantos terminos se guardan por ficha para "similares"

  // --- comportamiento ---
  autoSyncAlAbrir: false, // nada descarga datos solo al abrir la pagina
  // Sincronizacion periodica: opt-in. Solo corre mientras la pestana este
  // abierta, porque no hay servidor que la sostenga cuando se cierra.
  autoSync: false,
  autoSyncMinutos: 60,

  // --- alertas ---
  alertas: true,
  alertaUmbral: 80,
  alertaNotificacion: false,
}

let cache: Config | null = null

function deAlmacenamiento(): Partial<Config> {
  try {
    const crudo = window.localStorage.getItem(CLAVE)
    return crudo ? (JSON.parse(crudo) as Partial<Config>) : {}
  } catch {
    return {}
  }
}

/** Mezcla por capas sin perder los pesos que no se hayan tocado. */
function combinar(...capas: Partial<Config>[]): Config {
  let out: Config = { ...POR_DEFECTO, pesos: { ...POR_DEFECTO.pesos } }
  for (const capa of capas) {
    out = { ...out, ...capa, pesos: { ...out.pesos, ...(capa.pesos || {}) } }
  }
  return out
}

/**
 * Devuelve la configuracion efectiva. Es asincrono solo para poder leer el
 * fichero; si no esta disponible, resuelve igual con los defaults.
 */
export async function config({ recargar = false }: { recargar?: boolean } = {}): Promise<Config> {
  if (cache && !recargar) return cache
  cache = combinar(deAlmacenamiento())

  try {
    const res = await fetch(new URL('app-config.json', document.baseURI), { cache: 'no-store' })
    if (res.ok) {
      const desdeFichero = (await res.json()) as Partial<Config>
      // El fichero va por debajo de localStorage: lo que el usuario haya
      // cambiado en el panel manda sobre lo que este en el repositorio.
      cache = combinar(desdeFichero, deAlmacenamiento())
    }
  } catch {
    console.warn(
      'config: no se pudo leer app-config.json (normal si abriste el index.html con file://). ' +
        'Se usan los valores por defecto y lo guardado en este navegador.',
    )
  }
  return cache
}

/**
 * Guarda los cambios del panel. Se acumulan con lo que ya estaba en
 * `localStorage`: guardar las alertas no puede borrar el token guardado antes.
 */
export function guardarConfig(parcial: Partial<Config>): Config {
  const actual = cache || combinar()
  const siguiente = combinar(actual, parcial)
  try {
    const previo = deAlmacenamiento()
    window.localStorage.setItem(CLAVE, JSON.stringify({ ...previo, ...parcial }))
  } catch {
    console.warn('config: no se pudo guardar en localStorage')
  }
  cache = siguiente
  // El panel Datos y el selector de ventana del sincronizador viven en
  // componentes distintos: sin este aviso, cambiar los dias dejaba el selector
  // diciendo "ultimos 7 dias" aunque la descarga ya usara otra ventana.
  try {
    window.dispatchEvent(new CustomEvent<Config>('licitaciones:config', { detail: cache }))
  } catch {
    /* sin window (tests de Node puro) no hay nada que avisar */
  }
  return cache
}

export function valoresPorDefecto(): Config {
  return combinar()
}
