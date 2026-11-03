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
 *   `meta`      configuracion, perfil, historial de descargas y contadores
 */

import { ligeroProceso } from './mapper'

const NOMBRE = 'licitaciones'
// v2 anade el indice `notice_uid` a `ligeros`, que hace falta para enlazar
// contratos con procesos (`porNoticeUid`). Sin el, el primer `sync` que bajara
// contratos reventaba con NotFoundError al abrir el indice. Subir la version es
// lo que dispara el `onupgradeneeded` que lo crea en las instalaciones que ya
// tenian la v1 con datos.
const VERSION = 2

const TIENDAS = {
  procesos: { clave: 'id_del_proceso', indices: ['fecha_publicacion', 'precio_base', 'entidad', 'notice_uid'] },
  ligeros: { clave: 'id_del_proceso', indices: ['fecha_publicacion', 'entidad', 'departamento_entidad', 'notice_uid'] },
  matches: { clave: 'tender_id', indices: ['score'] },
  contratos: { clave: 'id_contrato', indices: ['proceso_id', 'notice_uid'] },
  acciones: { clave: ['tender_id', 'accion'], indices: ['tender_id'] },
  meta: { clave: 'clave', indices: [] },
}

const defDe = (store) => TIENDAS[store]

/**
 * Clave de un registro tal como la espera IndexedDB: un escalar si el `keyPath`
 * es un string, o un array si el `keyPath` es compuesto. Encapsularlo aqui
 * evita el fallo clasico de hacer `get('abc')` sobre una store con clave
 * compuesta, que lanza `DataError`.
 */
const claveDe = (store, registro) => {
  const def = defDe(store)
  return Array.isArray(def.clave) ? def.clave.map((c) => registro[c] ?? null) : registro[def.clave]
}

/** La misma clave, aplastada a string para usarla de clave de un `Map`. */
const claveTexto = (clave) => (Array.isArray(clave) ? JSON.stringify(clave) : String(clave))

// `typeof` y no `?.`: `IDBKeyRange?.only` sigue lanzando ReferenceError si el
// identificador no existe, y el fallback a memoria existe justo para ese caso.
const rangoIgual = (valor) => (typeof IDBKeyRange !== 'undefined' ? IDBKeyRange.only(valor) : null)
const rangoAcotado = (min, max) => (typeof IDBKeyRange !== 'undefined' ? IDBKeyRange.bound(min, max) : null)

const peticion = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

function finDeTransaccion(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('transaccion abortada'))
  })
}

// --- IndexedDB --------------------------------------------------------------

class AlmacenIdb {
  constructor(db) {
    this.db = db
    this.tipo = 'IndexedDB'
    this.persistente = true
  }

  static async abrir() {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(NOMBRE, VERSION)
      req.onupgradeneeded = () => {
        const dbreq = req.result
        for (const [nombre, def] of Object.entries(TIENDAS)) {
          const store = dbreq.objectStoreNames.contains(nombre)
            ? req.transaction.objectStore(nombre)
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

  tx(nombres, modo = 'readonly') {
    return this.db.transaction(nombres, modo)
  }

  /**
   * `put` en lote. Devuelve cuantas filas eran nuevas y cuantas ya existian, que
   * es lo que usa el progreso de la ingesta para no informar de 340.000
   * "nuevos" la segunda vez que se sincroniza.
   */
  async guardar(store, registros) {
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

  async obtener(store, clave) {
    const tx = this.tx([store])
    const valor = await peticion(tx.objectStore(store).get(clave))
    return valor === undefined ? null : valor
  }

  async obtenerVarios(store, claves) {
    const tx = this.tx([store])
    const os = tx.objectStore(store)
    const out = []
    for (const clave of claves) {
      const valor = await peticion(os.get(clave))
      if (valor !== undefined) out.push(valor)
    }
    return out
  }

  async contar(store) {
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
  async recorrer(store, alFila, { indice = null, rango = null } = {}) {
    const tx = this.tx([store])
    const os = tx.objectStore(store)
    const cursorReq = indice ? os.index(indice).openCursor(rango) : os.openCursor(rango)
    await new Promise((resolve, reject) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (!cursor) {
          resolve()
          return
        }
        // `alFila` devuelve false para parar: un `return` en medio de un
        // `for...of` sobre el valor del cursor no unwind el callback del cursor.
        if (alFila(cursor.value) === false) {
          resolve()
          return
        }
        cursor.continue()
      }
      cursorReq.onerror = () => reject(cursorReq.error)
    })
    return true
  }

  /**
   * De `notice_uid` a `id_del_proceso`, para enlazar los contratos con los
   * procesos. Se resuelve en la pagina con un indice, no cruzando los 340.000
   * procesos en memoria por cada pagina de 500 contratos.
   */
  async porNoticeUid(uids) {
    const out = new Map()
    const unicos = [...new Set(uids.filter(Boolean))].sort()
    if (!unicos.length) return out
    const TROZO = 400
    for (let i = 0; i < unicos.length; i += TROZO) {
      const trozo = unicos.slice(i, i + TROZO)
      const dentro = new Set(trozo)
      const tx = this.tx(['ligeros'])
      const idx = tx.objectStore('ligeros').index('notice_uid')
      await new Promise((resolve, reject) => {
        const req = idx.openCursor(rangoAcotado(trozo[0], trozo[trozo.length - 1]))
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) {
            resolve()
            return
          }
          const fila = cursor.value
          if (dentro.has(fila.notice_uid) && fila.notice_uid) {
            out.set(fila.notice_uid, fila.id_del_proceso)
          }
          cursor.continue()
        }
        req.onerror = () => reject(req.error)
      })
    }
    return out
  }

  async borrarAcciones(tenderIds, acciones) {
    const tx = this.tx(['acciones'], 'readwrite')
    const os = tx.objectStore('acciones')
    for (const id of tenderIds) {
      for (const accion of acciones) {
        os.delete(Array.isArray(defDe('acciones').clave) ? [id, accion] : id)
      }
    }
    await finDeTransaccion(tx)
  }

  async borrarTodo() {
    const tx = this.tx(Object.keys(TIENDAS), 'readwrite')
    for (const nombre of Object.keys(TIENDAS)) tx.objectStore(nombre).clear()
    await finDeTransaccion(tx)
  }

  async cerrar() {
    this.db.close()
  }
}

// --- memoria (tests, y navegadores sin IndexedDB) ---------------------------

class AlmacenMemoria {
  constructor() {
    this.tipo = 'memoria'
    this.persistente = false
    this.datos = Object.fromEntries(Object.keys(TIENDAS).map((n) => [n, new Map()]))
  }

  async guardar(store, registros) {
    const mapa = this.datos[store]
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

  async obtener(store, clave) {
    return this.datos[store].get(claveTexto(clave)) ?? null
  }

  async obtenerVarios(store, claves) {
    const out = []
    for (const clave of claves) {
      const valor = await this.obtener(store, clave)
      if (valor) out.push(valor)
    }
    return out
  }

  async contar(store) {
    return this.datos[store].size
  }

  async recorrer(store, alFila) {
    // El `rango` no se puede expresar sin IDBKeyRange, asi que aqui se recorre
    // entero y filtra el callback, que ya compara el campo. Solo se usa desde
    // los tests y el fallback, donde las stores estan vacias o son pequenas.
    for (const fila of this.datos[store].values()) {
      if (alFila(fila) === false) break
    }
    return true
  }

  async porNoticeUid(uids) {
    const out = new Map()
    const pedidos = new Set(uids.filter(Boolean))
    for (const fila of this.datos.ligeros.values()) {
      if (pedidos.has(fila.notice_uid) && fila.notice_uid) out.set(fila.notice_uid, fila.id_del_proceso)
    }
    return out
  }

  async borrarAcciones(tenderIds, acciones) {
    const def = defDe('acciones')
    for (const id of tenderIds) {
      for (const accion of acciones) {
        const clave = Array.isArray(def.clave) ? [id, accion] : id
        this.datos.acciones.delete(claveTexto(clave))
      }
    }
  }

  async borrarTodo() {
    for (const nombre of Object.keys(TIENDAS)) this.datos[nombre].clear()
  }

  async cerrar() {}
}

// --- fachada ----------------------------------------------------------------

let instancia = null
let tipoAlmacen = null

/**
 * Abre (o devuelve) el almacen. Cae en memoria si IndexedDB no esta disponible,
 * y avisa por consola: la diferencia entre "no se guardo nada" y "se guardo
 * hasta que cierres la pestana" no puede ser silenciosa.
 */
export async function abrirAlmacen({ forzar = null } = {}) {
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
      `almacen: no se pudo abrir IndexedDB (${error.message}). Se usa memoria: ` +
        'puede ser que la pagina este abierta con file://. Los datos no se guardan.',
    )
    instancia = new AlmacenMemoria()
    tipoAlmacen = 'memoria'
  }
  return instancia
}

/** Cambia el almacen activo. Solo lo usan los tests. */
export async function fijarAlmacen(tipo) {
  if (instancia) await instancia.cerrar()
  instancia = null
  tipoAlmacen = tipo
  return abrirAlmacen({ forzar: tipo })
}

export function tipoDeAlmacen() {
  return instancia?.tipo || null
}

// --- operaciones con nombre de dominio --------------------------------------

export async function guardarProcesos(registros) {
  const almacen = await abrirAlmacen()
  const proceso = await almacen.guardar('procesos', registros)
  const ligero = await almacen.guardar('ligeros', registros.map(ligeroProceso))
  return { nuevas: proceso.nuevas, actualizadas: proceso.actualizadas, ...ligero }
}

export async function obtenerProceso(id) {
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
export async function procesosPorIds(ids) {
  if (!ids.length) return []
  const almacen = await abrirAlmacen()
  return almacen.obtenerVarios('procesos', ids)
}

export async function contarProcesos() {
  const almacen = await abrirAlmacen()
  return almacen.contar('procesos')
}

export async function recorrerLigeros(alFila, opciones) {
  const almacen = await abrirAlmacen()
  return almacen.recorrer('ligeros', alFila, opciones)
}

export async function noticeUidAProceso(uids) {
  const almacen = await abrirAlmacen()
  return almacen.porNoticeUid(uids)
}

export async function guardarMatches(matches) {
  const almacen = await abrirAlmacen()
  return almacen.guardar('matches', matches)
}

export async function obtenerMatch(id) {
  const almacen = await abrirAlmacen()
  return almacen.obtener('matches', id)
}

export async function contarMatches() {
  const almacen = await abrirAlmacen()
  return almacen.contar('matches')
}

export async function recorrerMatches(alFila, opciones) {
  const almacen = await abrirAlmacen()
  return almacen.recorrer('matches', alFila, opciones)
}

export async function guardarContratos(contratos) {
  const almacen = await abrirAlmacen()
  return almacen.guardar('contratos', contratos)
}

export async function contarContratos() {
  const almacen = await abrirAlmacen()
  return almacen.contar('contratos')
}

export async function contratosDeProceso(procesoId, limite = 5) {
  const almacen = await abrirAlmacen()
  const out = []
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

export async function ponerAccion(accion) {
  const almacen = await abrirAlmacen()
  const registro = {
    tender_id: accion.tender_id,
    accion: accion.accion,
    nota: accion.nota ?? null,
    created_at: accion.created_at || new Date().toISOString(),
  }
  await almacen.guardar('acciones', [registro])
  return registro
}

export async function accionesDe(tenderId) {
  const almacen = await abrirAlmacen()
  const out = []
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

export async function todasLasAcciones() {
  const almacen = await abrirAlmacen()
  const out = []
  await almacen.recorrer('acciones', (fila) => {
    out.push(fila)
    return true
  })
  return out
}

export async function borrarAccionesDe(tenderIds, acciones) {
  const almacen = await abrirAlmacen()
  return almacen.borrarAcciones(tenderIds, acciones)
}

export async function leerMeta(clave, porDefecto = null) {
  const almacen = await abrirAlmacen()
  const fila = await almacen.obtener('meta', clave)
  return fila === null ? porDefecto : fila.valor
}

export async function escribirMeta(clave, valor) {
  const almacen = await abrirAlmacen()
  await almacen.guardar('meta', [{ clave, valor }])
  return valor
}

export async function borrarTodo() {
  const almacen = await abrirAlmacen()
  await almacen.borrarTodo()
}

/** Cuanto hay de cada cosa, para el aviso de "estos datos son de tu navegador". */
export async function resumenAlmacen() {
  const almacen = await abrirAlmacen()
  const [procesos, ligeros, matches, contratos, acciones] = await Promise.all([
    almacen.contar('procesos'),
    almacen.contar('ligeros'),
    almacen.contar('matches'),
    almacen.contar('contratos'),
    almacen.contar('acciones'),
  ])
  let cuota = null
  if (navigator.storage?.estimate) {
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
    cuota,
  }
}