/**
 * Cliente de la API SODA (Socrata) de Datos Abiertos Colombia, desde el navegador.
 *
 * Puerto de `backend/app/ingest/socrata.py`. Lo que se conserva del original:
 *
 *   - las fechas de SECOP II son `calendar_date`, así que los filtros SoQL van
 *     con literales ISO y con granularidad de DÍA. Comparar contra epoch en
 *     milisegundos devuelve HTTP 400, y una ventana con hora exacta puede
 *     devolver cero filas aunque haya datos (ver ESTADO-PROYECTO.md §3.2).
 *   - reintentos con espera creciente ante 429/5xx, igual que `RETRY_STATUS`.
 *   - los campos de tipo `url` de Socrata llegan como `{"url": "..."}`; sin
 *     aplanar se guardaba la repr del objeto como si fuera el texto (bug #3).
 *   - el `noticeUID` de la URL es la unica clave que comparten procesos y
 *     contratos (bug #10): los ids son `CO1.REQ.*` y `CO1.PCCNTR.*`.
 *
 * Lo que cambia: no hay `httpx` sino `fetch`, y se anade un respaldo con JSONP
 * (`$callback`) para cuando el navegador no deja hacer la peticion. datos.gov.co
 * responde con `Access-Control-Allow-Origin: *`, asi que lo normal es que `fetch`
 * funcione; el JSONP esta por si abres la pagina con una extension o un proxy
 * que corte el CORS.
 */

/** Error de Socrata. `retriable` marca los estados que tienen sentido reintentar. */
export class SocrataError extends Error {
  constructor(mensaje, estado, retriable = false, retryAfterMs = null) {
    super(mensaje)
    this.name = 'SocrataError'
    this.estado = estado
    this.retriable = retriable
    /** Lo que el servidor pide en `Retry-After`, en ms, si lo manda. */
    this.retryAfterMs = retryAfterMs
  }
}

const RE_INTENTABLES = new Set([408, 425, 429, 500, 502, 503, 504])
const RE_NOTICE_UID = /noticeUID=(CO1\.NTC\.\d+)/i

/**
 * `Retry-After` de la respuesta, en ms.
 *
 * Socrata lo manda en los 429/503 con los segundos que quiere que se espere.
 * Ignorarlo y usar la espera creciente de siempre hace que el reintento vuelva
 * a caer en el mismo limite, y con una descarga larga eso acaba en un error
 * final que se podria haber evitado esperando un poco mas.
 */
function retryAfterMs(res) {
  const crudo = res.headers?.get?.('Retry-After')
  if (!crudo) return null
  const segundos = Number(crudo)
  if (Number.isFinite(segundos)) return Math.max(0, segundos * 1000)
  const fecha = Date.parse(crudo)
  return Number.isFinite(fecha) ? Math.max(0, fecha - Date.now()) : null
}

const esperar = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          reject(new DOMException('cancelado', 'AbortError'))
        },
        { once: true },
      )
    }
  })

/** Peticion por JSONP, para cuando `fetch` no llega al servidor. */
function porJsonp(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const nombre = 'socrataCb'
    const script = document.createElement('script')
    const limpiar = () => {
      try {
        delete window[nombre]
      } catch {
        window[nombre] = undefined
      }
      script.remove()
    }
    const timer = setTimeout(() => {
      limpiar()
      reject(new SocrataError('JSONP: se acabo el tiempo de espera'))
    }, timeoutMs)

    window[nombre] = (datos) => {
      clearTimeout(timer)
      limpiar()
      resolve(datos)
    }
    script.onerror = () => {
      clearTimeout(timer)
      limpiar()
      reject(new SocrataError('JSONP: no se pudo cargar la respuesta'))
    }
    script.src = url
    document.head.appendChild(script)
  })
}

function urlDe(base, path, params) {
  const url = new URL(base.replace(/\/$/, '') + path)
  for (const [clave, valor] of Object.entries(params || {})) {
    if (valor === undefined || valor === null || valor === '') continue
    url.searchParams.set(clave, String(valor))
  }
  return url
}

/** Un `fetch` con tiempo limite. Devuelve el cuerpo ya parseado, o `null` si es 404. */
async function pedirJson(url, timeoutMs, signal) {
  const control = new AbortController()
  const temporizador = setTimeout(() => control.abort(), timeoutMs)
  const alAbortar = () => control.abort()
  signal?.addEventListener('abort', alAbortar, { once: true })
  try {
    const res = await fetch(url, { signal: control.signal, headers: { Accept: 'application/json' } })
    if (res.status === 404) return null
    if (res.ok) return await res.json()
    if (RE_INTENTABLES.has(res.status)) {
      throw new SocrataError(`HTTP ${res.status}`, res.status, true, retryAfterMs(res))
    }

    let detalle = `HTTP ${res.status}`
    try {
      const cuerpo = await res.json()
      if (cuerpo?.message || cuerpo?.error) detalle = cuerpo.message || cuerpo.error
    } catch {
      /* respuesta sin JSON */
    }
    throw new SocrataError(String(detalle), res.status, false)
  } finally {
    clearTimeout(temporizador)
    signal?.removeEventListener('abort', alAbortar)
  }
}

/**
 * GET con reintentos y espera creciente, como el cliente de Python.
 *
 * `fetch` devuelve `TypeError` cuando no llega al servidor, y en el navegador
 * eso casi siempre es CORS (datos.gov.co si manda `Access-Control-Allow-Origin:
 * *`, pero un proxy o una extension pueden cortarlo). Por eso, al primer fallo
 * de red se prueba JSONP una unica vez.
 *
 * El limite de peticiones (429/503) se trata aparte: concede hasta 2 reintentos
 * extra sobre `maxRetries`, espera mas que con el backoff normal si el servidor
 * no manda `Retry-After`, y avisa al cliente a traves de `alLimitar` para que
 * ralice el ritmo de paginacion. Cuatro intentos a 1/2/4 s mueren en ~7 s, y
 * el limite suele levantarse a los pocos: lo que hace falta es paciencia, no
 * mas prisa.
 */
async function get(base, path, params, { token, maxRetries, timeoutMs, signal, alLimitar }) {
  const url = urlDe(base, path, params)
  if (token) url.searchParams.set('$$app_token', token)

  let ultimoError = null
  let jsonpProbado = false
  let extrasPorLimite = 0
  let intento = 1

  // eslint-disable-next-line no-constant-condition
  for (; ; intento += 1) {
    if (signal?.aborted) throw new DOMException('cancelado', 'AbortError')
    try {
      const datos = await pedirJson(url, timeoutMs, signal)
      return datos === null ? null : normalizaCuerpo(datos)
    } catch (error) {
      if (signal?.aborted) throw new DOMException('cancelado', 'AbortError')

      if (error instanceof TypeError && !jsonpProbado) {
        jsonpProbado = true
        try {
          const conCallback = urlDe(base, path, params)
          conCallback.searchParams.set('$callback', 'socrataCb')
          if (token) conCallback.searchParams.set('$$app_token', token)
          return normalizaCuerpo(await porJsonp(conCallback.toString(), timeoutMs))
        } catch (errorJsonp) {
          ultimoError = errorJsonp
        }
      } else {
        ultimoError = error
      }

      if (error instanceof SocrataError && !error.retriable) throw error
      const limitado = error instanceof SocrataError && (error.estado === 429 || error.estado === 503)
      if (limitado) {
        if (extrasPorLimite < 2) extrasPorLimite += 1
        alLimitar?.()
      }
      if (intento >= maxRetries + extrasPorLimite) break
      // Si el servidor dice cuanto esperar, manda el; la espera creciente es el
      // plan B para cuando no lo dice. El tope de 60 s es para no parecer
      // colgado: si Socrata pide mas que eso, el reintento de todos modos
      // volveria a caer y conviene llegar antes al error visible.
      const espera =
        error instanceof SocrataError && error.retryAfterMs != null
          ? Math.min(error.retryAfterMs, 60000)
          : limitado
            ? Math.min(5000 * intento, 60000)
            : Math.min(2 ** (intento - 1), 8) * 1000
      console.warn(`socrata: fallo en ${path} (intento ${intento}/${maxRetries + extrasPorLimite}): ${error}`)
      await esperar(espera, signal)
    }
  }
  const limitado =
    ultimoError instanceof SocrataError && (ultimoError.estado === 429 || ultimoError.estado === 503)
  // Un 429/503 agotado no es "sin conexion": es el limite de peticiones, y sin
  // decirlo el usuario solo ve una descarga que no acaba nunca y luego una
  // pagina vacia. La pista apunta al arreglo (appToken) y al alivio (bajar el
  // tope), que son los dos fixes que dependen del usuario.
  const pista = limitado
    ? ` — Socrata esta limitando las peticiones (HTTP ${ultimoError.estado}): registra un appToken en datos.gov.co y pegalo en el panel Datos (o en frontend/public/app-config.json), o baja maxProcesos en ese mismo panel.`
    : ''
  throw new SocrataError(
    `no se pudo consultar ${path} tras ${intento} intentos: ${ultimoError?.message || ultimoError}${pista}`,
    ultimoError?.estado,
    true,
  )
}

/** Socrata devuelve `{error: [...]}` en lugar de lista cuando algo falla. */
function normalizaCuerpo(datos) {
  if (Array.isArray(datos)) return datos
  if (datos && typeof datos === 'object') {
    const codigo = Array.isArray(datos.error) ? datos.error[0] : datos.error
    if (codigo === 0) return []
    throw new SocrataError(String(datos.message || codigo || 'respuesta inesperada'))
  }
  return []
}

export class SocrataClient {
  constructor(cfg) {
    this.base = (cfg?.socrataBase || 'https://www.datos.gov.co').replace(/\/$/, '')
    this.token = cfg?.appToken || ''
    this.pageSize = Math.min(cfg?.pageSize || 500, 50000)
    this.requestDelay = cfg?.requestDelay ?? 350
    this.maxRetries = cfg?.maxRetries || 4
    this.timeoutMs = cfg?.timeoutMs || 90000
    /**
     * Ritmo real entre paginas: empieza en `requestDelay` y sube con cada
     * 429/503 (ver `ralentizar`). Vive en el cliente porque es un estado de la
     * corrida, no de la configuracion: el usuario no lo pide, lo impone el
     * servidor, y al recargar o volver a lanzar se empieza de cero.
     */
    this.ritmo = this.requestDelay
  }

  /**
   * Ralentiza la paginacion para el resto de la corrida (x3 por limite, tope
   * 5 s entre paginas).
   *
   * El limite de peticiones se levanta con el tiempo, no con la espera de un
   * solo reintento: si el portal acaba de decir "429", lo que arruina la
   * descarga es seguir a la misma velocidad en las paginas siguientes. Con
   * `requestDelay: 0` (tests) no hay ritmo que ralentizar.
   */
  ralentizar() {
    const antes = this.ritmo
    this.ritmo = Math.min(Math.max(this.ritmo, this.requestDelay) * 3, 5000)
    if (this.ritmo !== antes) {
      console.warn(`socrata: limite de peticiones, ritmo de pagina ${antes} → ${this.ritmo} ms`)
    }
  }

  async pedir(path, params, opciones = {}) {
    const datos = await get(this.base, path, params, {
      token: this.token,
      maxRetries: this.maxRetries,
      timeoutMs: this.timeoutMs,
      signal: opciones.signal,
      alLimitar: () => this.ralentizar(),
    })
    return datos === null ? null : normalizaCuerpo(datos)
  }

  /** `count(*)`, para saber cuanto hay antes de descargar. */
  async count(dataset, where, { signal } = {}) {
    const datos = await this.pedir(`/resource/${dataset}.json`, { $select: 'count(*) as n', $where: where }, { signal })
    if (!datos || !datos.length) return 0
    return Number(datos[0].n) || 0
  }

  /** Una pagina. Devuelve `{rows, hayMas}`. */
  async pagina({ dataset, where, order, limit, offset, select }, { signal } = {}) {
    const filas = await this.pedir(
      `/resource/${dataset}.json`,
      { $limit: limit, $offset: offset, $where: where, $order: order, $select: select },
      { signal },
    )
    const rows = filas || []
    return { rows, hayMas: rows.length >= limit }
  }

  /**
   * Itera filas paginando, igual que `SocrataClient.iter_rows`.
   *
   * `alPagina` recibe cada pagina ya mapeada para que la ingesta pueda ir
   * escribiendo mientras llega: no se acumulan 340.000 filas en memoria.
   */
  async iterRows(opciones, { signal, alPagina } = {}) {
    const limite = Math.min(opciones.limit || this.pageSize, 50000)
    let offset = 0
    let leidas = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal?.aborted) throw new DOMException('cancelado', 'AbortError')
      // El tope se respeta pidiendo de menos en la ultima pagina. Antes se
      // comprobaba despues de leerla entera, asi que un `maxProcesos: 120` con
      // paginas de 500 se guardaba hasta 499 procesos de mas: ya puntuados no,
      // pero guardados si, y el contador de la cabecera no cuadraba con el tope.
      const restante = opciones.maxRows ? opciones.maxRows - offset : Infinity
      const limitePagina = Math.max(1, Math.min(limite, restante))
      const { rows, hayMas } = await this.pagina({ ...opciones, limit: limitePagina, offset }, { signal })
      if (!rows.length) return { leidas }
      leidas += rows.length
      await alPagina?.(rows, offset)
      if (opciones.maxRows && leidas >= opciones.maxRows) return { leidas }
      if (!hayMas) return { leidas }
      offset += limitePagina
      if (opciones.maxRows && offset >= opciones.maxRows) return { leidas }
      if (this.ritmo > 0) await esperar(this.ritmo, signal)
    }
  }
}

// --- normalizacion de tipos de Socrata (igual que en `socrata.py`) ----------

const RE_ZONA = /(Z|[+-]\d{2}:?\d{2})$/i

/** Normaliza una fecha de Socrata a ISO. Acepta ISO y epoch en milisegundos. */
export function socrataDate(valor) {
  if (valor === null || valor === undefined || valor === '') return null
  if (valor instanceof Date) return Number.isNaN(valor.getTime()) ? null : valor.toISOString()

  if (typeof valor === 'string') {
    const texto = valor.trim()
    if (!texto) return null
    // `calendar_date` llega como "2026-09-24T00:00:00", sin zona. Sin sufijo se
    // interpreta como hora local, que haria depender el resultado de donde este
    // el navegador, asi que se fija en UTC.
    const conZona = RE_ZONA.test(texto) ? texto : `${texto.replace(' ', 'T')}Z`
    const d = new Date(conZona)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
    const corto = new Date(`${texto.slice(0, 10)}T00:00:00Z`)
    return Number.isNaN(corto.getTime()) ? null : corto.toISOString()
  }

  const numero = Number(valor)
  if (!Number.isFinite(numero) || numero <= 0) return null
  const ms = numero > 1e12 ? numero : numero * 1000
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function socrataFloat(valor) {
  if (valor === null || valor === undefined || valor === '') return null
  const n = typeof valor === 'number' ? valor : Number(String(valor).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

export function socrataInt(valor) {
  const n = socrataFloat(valor)
  return n === null ? null : Math.trunc(n)
}

/**
 * Texto plano. Los campos `url` llegan como `{url: "..."}` y los `point` como
 * `{lat, lon}`; sin aplanar se guardaba la repr del objeto (bug #3).
 */
export function socrataText(valor) {
  if (valor === null || valor === undefined || valor === '') return null
  if (typeof valor === 'object') {
    if (Array.isArray(valor)) return valor.map((v) => socrataText(v)).filter(Boolean).join(',') || null
    if ('url' in valor) return socrataText(valor.url)
    if ('lat' in valor && 'lon' in valor) return `${valor.lat},${valor.lon}`
    return null
  }
  const texto = String(valor).trim()
  return texto || null
}

/** Como `socrataText`, pero repara filas ya guardadas como repr (bug #3). */
export function socrataUrl(valor) {
  const texto = socrataText(valor)
  if (!texto) return null
  if (texto.startsWith('{') && texto.includes("'url':")) {
    const dentro = texto.split("'url':")[1].trim().replace(/^['"]|['"}]+$/g, '')
    return dentro || null
  }
  return texto
}

/** Extrae el `noticeUID=CO1.NTC.*` de una URL de OpportunityDetail. */
export function noticeUid(url) {
  if (!url) return null
  const m = RE_NOTICE_UID.exec(url)
  return m ? m[1] : null
}

/** Escapa un literal para SoQL. */
export function soqlQuote(valor) {
  return `'${String(valor).replace(/'/g, "''")}'`
}

/** ISO a `YYYY-MM-DD`, que es lo que acepta `calendar_date`. */
export function isoDia(valor) {
  // Sin este guarda, `new Date(null)` es la epoca y un `desde` ausente se
  // convertiria en un filtro `>= '1970-01-01'` en vez de "sin filtro".
  if (valor === null || valor === undefined || valor === '') return null
  // Una cadena ISO ya trae el dia en sus diez primeros caracteres, y ese es el dia
  // que se quiere: `calendar_date` no tiene zona horaria. Parsearla como fecha y
  // pasarla a UTC desplaza el dia: con hora local de la tarde lo advanced un dia
  // (traia de mas el ultimo) y con las de la madrugada lo retrocedia, dejando
  // fuera el primer dia de la ventana sin avisar.
  if (typeof valor === 'string') {
    const coincide = /^(\d{4}-\d{2}-\d{2})/.exec(valor.trim())
    if (coincide) return coincide[1]
  }
  const d = valor instanceof Date ? valor : new Date(valor)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

/**
 * Predicado SoQL sobre una columna `calendar_date`.
 *
 * Se trunca a dia a proposito: con granularidad de dia, una ventana calculada
 * con hora exacta puede devolver cero filas aunque haya datos para ese dia.
 */
export function soqlDate(columna, desde, hasta) {
  const inicio = isoDia(desde)
  if (!inicio) return null
  let clause = `${columna} >= ${soqlQuote(inicio)}`
  const fin = isoDia(hasta)
  if (fin) clause += ` AND ${columna} <= ${soqlQuote(fin)}`
  return clause
}