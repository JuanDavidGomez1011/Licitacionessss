/**
 * Almacen de datos del navegador.
 *
 * Dos implementaciones con la misma interfaz:
 *
 *   - `AlmacenIdb`, sobre IndexedDB, que es donde viven los datos de verdad.
 *     Los datos no se van a ningun servidor: no hay servidor.
 *   - `AlmacenMemoria`, en un `Map`, para cuando IndexedDB no existe (los tests
 *     con jsdom) o no se puede abrir (segun navegador, abrir el HTML con doble
 *     clic lo bloquea).
 *
 * Las stores:
 *
 *   `procesos`  la fila completa del dataset de procesos, con su descripcion
 *   `ligeros`   la version sin textos, que es la que alimenta el indice de
 *               consulta. Sin esta store, ordenar 340.000 fichas por score
 *               tendria que traer 340.000 descripciones a memoria.
 *   `matches`   el score y las vinetas
 *   `contratos` los contratos, enlazados por `notice_uid`
 *   `acciones`  guardar / ocultar / descartar (clave compuesta id + accion)
 *   `crm`       la columna del tablero Kanban de cada oportunidad que se sigue
 *   `meta`      configuracion, perfil, historial de descargas, alertas y
 *               busquedas guardadas
 */

import { ligeroProceso } from './mapper'
import type { Accion, Contrato, EstadoCRM, Match, Proceso, ProcesoLigero, TarjetaCRM, TipoAccion } from './tipos'

const NOMBRE = 'licitaciones'
// v2 anade el indice `notice_uid` a `ligeros`, que hace falta para enlazar
// contratos con procesos (`porNoticeUid`). Sin el, el primer `sync` que bajara
// contratos reventaba con NotFoundError al abrir el indice. Subir la version es
// lo que dispara el `onupgradeneeded` que lo crea en las instalaciones que ya
// tenian la v1 con datos.
// v3 anade la store `crm` del tablero Kanban.
const VERSION = 3

/** Que hay en cada store. Es lo que tipa `guardar`, `obtener` y `recorrer`. */
export interface Registros {
  procesos: Proceso
  ligeros: ProcesoLigero
  matches: Match
  contratos: Contrato
  acciones: Accion
  crm: TarjetaCRM
  meta: { clave: string; valor: unknown }
}

export type NombreStore = keyof Registros

type Clave = IDBValidKey

interface DefStore {
  clave: string | string[]
  indices: string[]
}

const TIENDAS: Record<NombreStore, DefStore> = {
  procesos: { clave: 'id_del_proceso', indices: ['fecha_publicacion', 'precio_base', 'entidad', 'notice_uid'] },
  ligeros: { clave: 'id_del_proceso', indices: ['fecha_publicacion', 'entidad', 'departamento_entidad', 'notice_uid'] },
  matches: { clave: 'tender_id', indices: ['score'] },
  contratos: { clave: 'id_contrato', indices: ['proceso_id', 'notice_uid'] },
  acciones: { clave: ['tender_id', 'accion'], indices: ['tender_id'] },
  crm: { clave: 'tender_id', indices: ['estado'] },
  meta: { clave: 'clave', indices: [] },
}

const NOMBRES = Object.keys(TIENDAS) as NombreStore[]

/**
 * Clave de un registro tal como la espera IndexedDB: un escalar si el `keyPath`
 * es un string, o un array si el `keyPath` es compuesto. Encapsularlo aqui
 * evita el fallo clasico de hacer `get('abc')` sobre una store con clave
 * compuesta, que lanza `DataError`.
 */
function claveDe<S extends NombreStore>(store: S, registro: Registros[S]): Clave {
  const def = TIENDAS[store]
  const campos = registro as unknown as Record<string, Clave | null | undefined>
  if (Array.isArray(def.clave)) return def.clave.map((c) => campos[c] ?? '')
  return campos[def.clave] ?? ''
}

/** La misma clave, aplastada a string para usarla de clave de un `Map`. */
const claveTexto = (clave: Clave): string => (Array.isArray(clave) ? JSON.stringify(clave) : String(clave))

// `typeof` y no `?.`: `IDBKeyRange?.only` sigue lanzando ReferenceError si el
// identificador no existe, y el fallback a memoria existe justo para ese caso.
const rangoIgual = (valor: Clave): IDBKeyRange | null =>
  typeof IDBKeyRange !== 'undefined' ? IDBKeyRange.only(valor) : null
const rangoAcotado = (min: Clave, max: Clave): IDBKeyRange | null =>
  typeof IDBKeyRange !== 'undefined' ? IDBKeyRange.bound(min, max) : null

const peticion = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

function finDeTransaccion(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('transaccion abortada'))
  })
}

export interface ResultadoGuardar {
  nuevas: number
  actualizadas: number
}

export interface OpcionesRecorrer {
  indice?: string | null
  rango?: IDBKeyRange | null
}

/** Callback de `recorrer`. Devuelve `false` para parar. Tiene que ser sincrono. */
export type AlFila<T> = (fila: T) => boolean | void

/** Lo que tienen en comun las dos implementaciones. */
export interface Almacen {
  readonly tipo: 'IndexedDB' | 'memoria'
  readonly persistente: boolean
  guardar<S extends NombreStore>(store: S, registros: Registros[S][]): Promise<ResultadoGuardar>
  obtener<S extends NombreStore>(store: S, clave: Clave): Promise<Registros[S] | null>
  obtenerVarios<S extends NombreStore>(store: S, claves: Clave[]): Promise<Registros[S][]>
  contar(store: NombreStore): Promise<number>
  recorrer<S extends NombreStore>(store: S, alFila: AlFila<Registros[S]>, opciones?: OpcionesRecorrer): Promise<boolean>
  borrar(store: NombreStore, claves: Clave[]): Promise<void>
  porNoticeUid(uids: (string | null)[]): Promise<Map<string, string>>
  borrarTodo(): Promise<void>
  cerrar(): Promise<void>
}

// --- IndexedDB --------------------------------------------------------------

class AlmacenIdb implements Almacen {
  readonly tipo = 'IndexedDB' as const
  readonly persistente = true
  private db: IDBDatabase

  constructor(db: IDBDatabase) {
    this.db = db
  }

  static async abrir(): Promise<AlmacenIdb> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(NOMBRE, VERSION)
      req.onupgradeneeded = () => {
        const dbreq = req.result
        for (const nombre of NOMBRES) {
          const def = TIENDAS[nombre]
          const store = dbreq.objectStoreNames.contains(nombre)
            ? req.transaction!.objectStore(nombre)
            : dbreq.createObjectStore(nombre, { keyPath: def.clave })
          for (const indice of def.indices) {
            if (!store.indexNames.contains(indice)) store.createIndex(indice, indice)
          }
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('IndexedDB bloqueada: hay otra pestana del panel abierta'))
    })
    return new AlmacenIdb(db)
  }

  private tx(nombres: NombreStore[], modo: IDBTransactionMode = 'readonly'): IDBTransaction {
    return this.db.transaction(nombres, modo)
  }

  /**
   * `put` en lote. Devuelve cuantas filas eran nuevas y cuantas ya existian, que
   * es lo que usa el progreso de la ingesta para no informar de 340.000
   * "nuevos" la segunda vez que se sincroniza.
   */
  async guardar<S extends NombreStore>(store: S, registros: Registros[S][]): Promise<ResultadoGuardar> {
    if (!registros.length) return { nuevas: 0, actualizadas: 0 }
    const tx = this.tx([store], 'readwrite')
    const os = tx.objectStore(store)
    const existentes = await Promise.all(
      registros.map((registro) => peticion(os.get(claveDe(store, registro))).then((v) => v !== undefined)),
    )
    for (const registro of registros) os.put(registro)
    await finDeTransaccion(tx)
    return {
      nuevas: existentes.filter((e) => !e).length,
      actualizadas: existentes.filter(Boolean).length,
    }
  }

  async obtener<S extends NombreStore>(store: S, clave: Clave): Promise<Registros[S] | null> {
    const tx = this.tx([store])
    const valor = (await peticion(tx.objectStore(store).get(clave))) as Registros[S] | undefined
    return valor === undefined ? null : valor
  }

  async obtenerVarios<S extends NombreStore>(store: S, claves: Clave[]): Promise<Registros[S][]> {
    const tx = this.tx([store])
    const os = tx.objectStore(store)
    const out: Registros[S][] = []
    for (const clave of claves) {
      const valor = (await peticion(os.get(clave))) as Registros[S] | undefined
      if (valor !== undefined) out.push(valor)
    }
    return out
  }

  async contar(store: NombreStore): Promise<number> {
    const tx = this.tx([store])
    return peticion(tx.objectStore(store).count())
  }

  /**
   * Recorre una store con un cursor, en vez de traerse la store entera a memoria.
   *
   * `alFila` tiene que ser sincrono: el cursor no espera una promesa, asi que un
   * callback `async` haria que `continue()` se llamara antes de que terminara y
   * las escrituras se solaparian. Devolver `false` para parar.
   */
  async recorrer<S extends NombreStore>(
    store: S,
    alFila: AlFila<Registros[S]>,
    { indice = null, rango = null }: OpcionesRecorrer = {},
  ): Promise<boolean> {
    const tx = this.tx([store])
    const os = tx.objectStore(store)
    const cursorReq = indice ? os.index(indice).openCursor(rango) : os.openCursor(rango)
    await new Promise<void>((resolve, reject) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (!cursor) {
          resolve()
          return
        }
        // `alFila` devuelve false para parar: un `return` en medio de un
        // `for...of` sobre el valor del cursor no unwind el callback del cursor.
        if (alFila(cursor.value as Registros[S]) === false) {
          resolve()
          return
        }
        cursor.continue()
      }
      cursorReq.onerror = () => reject(cursorReq.error)
    })
    return true
  }

  async borrar(store: NombreStore, claves: Clave[]): Promise<void> {
    const tx = this.tx([store], 'readwrite')
    const os = tx.objectStore(store)
    for (const clave of claves) os.delete(clave)
    await finDeTransaccion(tx)
  }

  /**
   * De `notice_uid` a `id_del_proceso`, para enlazar los contratos con los
   * procesos. Se resuelve en la pagina con un indice, no cruzando los 340.000
   * procesos en memoria por cada pagina de 500 contratos.
   */
  async porNoticeUid(uids: (string | null)[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const unicos = [...new Set(uids.filter((u): u is string => Boolean(u)))].sort()
    if (!unicos.length) return out
    const TROZO = 400
    for (let i = 0; i < unicos.length; i += TROZO) {
      const trozo = unicos.slice(i, i + TROZO)
      const dentro = new Set(trozo)
      const tx = this.tx(['ligeros'])
      const idx = tx.objectStore('ligeros').index('notice_uid')
      await new Promise<void>((resolve, reject) => {
        const req = idx.openCursor(rangoAcotado(trozo[0]!, trozo[trozo.length - 1]!))
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) {
            resolve()
            return
          }
          const fila = cursor.value as ProcesoLigero
          if (fila.notice_uid && dentro.has(fila.notice_uid)) {
            out.set(fila.notice_uid, fila.id_del_proceso)
          }
          cursor.continue()
        }
        req.onerror = () => reject(req.error)
      })
    }
    return out
  }

  async borrarTodo(): Promise<void> {
    const tx = this.tx(NOMBRES, 'readwrite')
    for (const nombre of NOMBRES) tx.objectStore(nombre).clear()
    await finDeTransaccion(tx)
  }

  async cerrar(): Promise<void> {
    this.db.close()
  }
}

// --- memoria (tests, y navegadores sin IndexedDB) ---------------------------

class AlmacenMemoria implements Almacen {
  readonly tipo = 'memoria' as const
  readonly persistente = false
  private datos: Record<NombreStore, Map<string, unknown>>

  constructor() {
    this.datos = Object.fromEntries(NOMBRES.map((n) => [n, new Map<string, unknown>()])) as Record<
      NombreStore,
      Map<string, unknown>
    >
  }

  private mapa<S extends NombreStore>(store: S): Map<string, Registros[S]> {
    return this.datos[store] as Map<string, Registros[S]>
  }

  async guardar<S extends NombreStore>(store: S, registros: Registros[S][]): Promise<ResultadoGuardar> {
    const mapa = this.mapa(store)
    let nuevas = 0
    let actualizadas = 0
    for (const registro of registros) {
      const k = claveTexto(claveDe(store, registro))
      if (mapa.has(k)) actualizadas += 1
      else nuevas += 1
      mapa.set(k, registro)
    }
    return { nuevas, actualizadas }
  }

  async obtener<S extends NombreStore>(store: S, clave: Clave): Promise<Registros[S] | null> {
    return this.mapa(store).get(claveTexto(clave)) ?? null
  }

  async obtenerVarios<S extends NombreStore>(store: S, claves: Clave[]): Promise<Registros[S][]> {
    const out: Registros[S][] = []
    for (const clave of claves) {
      const valor = await this.obtener(store, clave)
      if (valor) out.push(valor)
    }
    return out
  }

  async contar(store: NombreStore): Promise<number> {
    return this.datos[store].size
  }

  async recorrer<S extends NombreStore>(store: S, alFila: AlFila<Registros[S]>): Promise<boolean> {
    // El `rango` no se puede expresar sin IDBKeyRange, asi que aqui se recorre
    // entero y filtra el callback, que ya compara el campo. Solo se usa desde
    // los tests y el fallback, donde las stores estan vacias o son pequenas.
    for (const fila of this.mapa(store).values()) {
      if (alFila(fila) === false) break
    }
    return true
  }

  async borrar(store: NombreStore, claves: Clave[]): Promise<void> {
    for (const clave of claves) this.datos[store].delete(claveTexto(clave))
  }

  async porNoticeUid(uids: (string | null)[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const pedidos = new Set(uids.filter(Boolean))
    for (const fila of this.mapa('ligeros').values()) {
      if (fila.notice_uid && pedidos.has(fila.notice_uid)) out.set(fila.notice_uid, fila.id_del_proceso)
    }
    return out
  }

  async borrarTodo(): Promise<void> {
    for (const nombre of NOMBRES) this.datos[nombre].clear()
  }

  async cerrar(): Promise<void> {}
}

// --- fachada ----------------------------------------------------------------

type TipoPedido = 'idb' | 'memoria'

let instancia: Almacen | null = null
let tipoAlmacen: TipoPedido | null = null

/**
 * Abre (o devuelve) el almacen. Cae en memoria si IndexedDB no esta disponible,
 * y avisa por consola: la diferencia entre "no se guardo nada" y "se guardo
 * hasta que cierres la pestana" no puede ser silenciosa.
 */
export async function abrirAlmacen({ forzar = null }: { forzar?: TipoPedido | null } = {}): Promise<Almacen> {
  if (instancia && !forzar) return instancia
  const quiere = forzar || tipoAlmacen || 'idb'
  if (quiere === 'memoria' || typeof indexedDB === 'undefined') {
    instancia = new AlmacenMemoria()
    tipoAlmacen = 'memoria'
    if (quiere === 'idb') {
      console.warn(
        'almacen: este navegador no expone IndexedDB, se usa memoria. ' +
          'Los datos se perderan al cerrar la pestana.',
      )
    }
    return instancia
  }
  try {
    instancia = await AlmacenIdb.abrir()
    tipoAlmacen = 'idb'
  } catch (error) {
    console.warn(
      `almacen: no se pudo abrir IndexedDB (${error instanceof Error ? error.message : String(error)}). Se usa memoria: ` +
        'puede ser que la pagina este abierta con file://. Los datos no se guardan.',
    )
    instancia = new AlmacenMemoria()
    tipoAlmacen = 'memoria'
  }
  return instancia
}

/** Cambia el almacen activo. Solo lo usan los tests. */
export async function fijarAlmacen(tipo: TipoPedido): Promise<Almacen> {
  if (instancia) await instancia.cerrar()
  instancia = null
  tipoAlmacen = tipo
  return abrirAlmacen({ forzar: tipo })
}

export function tipoDeAlmacen(): string | null {
  return instancia?.tipo || null
}

// --- operaciones con nombre de dominio --------------------------------------

export async function guardarProcesos(registros: Proceso[]): Promise<ResultadoGuardar> {
  const almacen = await abrirAlmacen()
  const proceso = await almacen.guardar('procesos', registros)
  await almacen.guardar('ligeros', registros.map(ligeroProceso))
  return { nuevas: proceso.nuevas, actualizadas: proceso.actualizadas }
}

export async function obtenerProceso(id: string): Promise<Proceso | null> {
  const almacen = await abrirAlmacen()
  return almacen.obtener('procesos', id)
}

/**
 * Los procesos completos de una lista de ids.
 *
 * La usa la puntuacion: el indice invertido trabaja sobre textos, y los textos
 * solo estan en la store `procesos`, no en `ligeros`. Los ids vienen de la
 * descarga que se acaba de hacer, asi que son unos miles, no 118.000.
 */
export async function procesosPorIds(ids: string[]): Promise<Proceso[]> {
  if (!ids.length) return []
  const almacen = await abrirAlmacen()
  return almacen.obtenerVarios('procesos', ids)
}

export async function contarProcesos(): Promise<number> {
  const almacen = await abrirAlmacen()
  return almacen.contar('procesos')
}

export async function recorrerLigeros(alFila: AlFila<ProcesoLigero>, opciones?: OpcionesRecorrer): Promise<boolean> {
  const almacen = await abrirAlmacen()
  return almacen.recorrer('ligeros', alFila, opciones)
}

export async function recorrerProcesos(alFila: AlFila<Proceso>): Promise<boolean> {
  const almacen = await abrirAlmacen()
  return almacen.recorrer('procesos', alFila)
}

export async function noticeUidAProceso(uids: (string | null)[]): Promise<Map<string, string>> {
  const almacen = await abrirAlmacen()
  return almacen.porNoticeUid(uids)
}

export async function guardarMatches(matches: Match[]): Promise<ResultadoGuardar> {
  const almacen = await abrirAlmacen()
  return almacen.guardar('matches', matches)
}

export async function obtenerMatch(id: string): Promise<Match | null> {
  const almacen = await abrirAlmacen()
  return almacen.obtener('matches', id)
}

export async function contarMatches(): Promise<number> {
  const almacen = await abrirAlmacen()
  return almacen.contar('matches')
}

export async function recorrerMatches(alFila: AlFila<Match>, opciones?: OpcionesRecorrer): Promise<boolean> {
  const almacen = await abrirAlmacen()
  return almacen.recorrer('matches', alFila, opciones)
}

export async function guardarContratos(contratos: Contrato[]): Promise<ResultadoGuardar> {
  const almacen = await abrirAlmacen()
  return almacen.guardar('contratos', contratos)
}

export async function contarContratos(): Promise<number> {
  const almacen = await abrirAlmacen()
  return almacen.contar('contratos')
}

export async function contratosDeProceso(procesoId: string, limite = 5): Promise<Contrato[]> {
  const almacen = await abrirAlmacen()
  const out: Contrato[] = []
  await almacen.recorrer(
    'contratos',
    (fila) => {
      if (fila.proceso_id !== procesoId) return true
      out.push(fila)
      return out.length < limite
    },
    { indice: 'proceso_id', rango: rangoIgual(procesoId) },
  )
  out.sort((a, b) => String(b.fecha_de_firma || '').localeCompare(String(a.fecha_de_firma || '')))
  return out.slice(0, limite)
}

export async function ponerAccion(accion: {
  tender_id: string
  accion: TipoAccion
  nota?: string | null
  created_at?: string
}): Promise<Accion> {
  const almacen = await abrirAlmacen()
  const registro: Accion = {
    tender_id: accion.tender_id,
    accion: accion.accion,
    nota: accion.nota ?? null,
    created_at: accion.created_at || new Date().toISOString(),
  }
  await almacen.guardar('acciones', [registro])
  return registro
}

export async function accionesDe(tenderId: string): Promise<Accion[]> {
  const almacen = await abrirAlmacen()
  const out: Accion[] = []
  await almacen.recorrer(
    'acciones',
    (fila) => {
      if (fila.tender_id === tenderId) out.push(fila)
      return true
    },
    { indice: 'tender_id', rango: rangoIgual(tenderId) },
  )
  return out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
}

export async function todasLasAcciones(): Promise<Accion[]> {
  const almacen = await abrirAlmacen()
  const out: Accion[] = []
  await almacen.recorrer('acciones', (fila) => {
    out.push(fila)
    return true
  })
  return out
}

export async function borrarAccionesDe(tenderIds: string[], acciones: TipoAccion[]): Promise<void> {
  const almacen = await abrirAlmacen()
  const claves: Clave[] = []
  for (const id of tenderIds) for (const accion of acciones) claves.push([id, accion])
  return almacen.borrar('acciones', claves)
}

// --- CRM (tablero Kanban) ---------------------------------------------------

export async function guardarTarjetaCRM(tarjeta: TarjetaCRM): Promise<TarjetaCRM> {
  const almacen = await abrirAlmacen()
  await almacen.guardar('crm', [tarjeta])
  return tarjeta
}

export async function obtenerTarjetaCRM(id: string): Promise<TarjetaCRM | null> {
  const almacen = await abrirAlmacen()
  return almacen.obtener('crm', id)
}

export async function todasLasTarjetasCRM(): Promise<TarjetaCRM[]> {
  const almacen = await abrirAlmacen()
  const out: TarjetaCRM[] = []
  await almacen.recorrer('crm', (fila) => {
    out.push(fila)
    return true
  })
  return out
}

export async function borrarTarjetaCRM(id: string): Promise<void> {
  const almacen = await abrirAlmacen()
  await almacen.borrar('crm', [id])
}

/** Columna de cada oportunidad seguida, para pintarla en la lista. */
export async function estadosCRM(): Promise<Map<string, EstadoCRM>> {
  const out = new Map<string, EstadoCRM>()
  for (const t of await todasLasTarjetasCRM()) out.set(t.tender_id, t.estado)
  return out
}

// --- meta -------------------------------------------------------------------

export async function leerMeta<T>(clave: string, porDefecto: T): Promise<T> {
  const almacen = await abrirAlmacen()
  const fila = await almacen.obtener('meta', clave)
  return fila === null ? porDefecto : (fila.valor as T)
}

export async function escribirMeta<T>(clave: string, valor: T): Promise<T> {
  const almacen = await abrirAlmacen()
  await almacen.guardar('meta', [{ clave, valor }])
  return valor
}

export async function borrarTodo(): Promise<void> {
  const almacen = await abrirAlmacen()
  await almacen.borrarTodo()
}

export interface ResumenAlmacen {
  tipo: string
  persistente: boolean
  procesos: number
  ligeros: number
  matches: number
  contratos: number
  acciones: number
  crm: number
  cuota: { usado: number; total: number } | null
}

/** Cuanto hay de cada cosa, para el aviso de "estos datos son de tu navegador". */
export async function resumenAlmacen(): Promise<ResumenAlmacen> {
  const almacen = await abrirAlmacen()
  const [procesos, ligeros, matches, contratos, acciones, crm] = await Promise.all([
    almacen.contar('procesos'),
    almacen.contar('ligeros'),
    almacen.contar('matches'),
    almacen.contar('contratos'),
    almacen.contar('acciones'),
    almacen.contar('crm'),
  ])
  let cuota: ResumenAlmacen['cuota'] = null
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate()
      cuota = { usado: est.usage || 0, total: est.quota || 0 }
    } catch {
      cuota = null
    }
  }
  return {
    tipo: almacen.tipo,
    persistente: almacen.persistente,
    procesos,
    ligeros,
    matches,
    contratos,
    acciones,
    crm,
    cuota,
  }
}
