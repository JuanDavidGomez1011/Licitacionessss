/**
 * Exportar e importar el almacen del navegador.
 *
 * Por que existe: los datos ya no estan en PostgreSQL, estan en el IndexedDB de
 * una maquina. Si no hay forma de sacarlos, cambiar de ordenador o de navegador
 * significa volver a descargar varios dias de SECOP. Este modulo es el equivalente
 * a `backend/scripts/exportar_navegador.py` y al boton "exportar" de la API vieja.
 *
 * Formato: NDJSON, una linea por fila, con una linea de cabecera que dice que
 * version del formato es y que stores trae. Se eligio NDJSON y no JSON por una
 * razon concreta: un JSON entero de 340.000 filas son cientos de MB que el
 * navegador tiene que construir entero en memoria antes de escribir nada. Con
 * NDJSON se puede ir escribiendo linea a linea, y si el fichero se corta a mitad,
 * lo ya escrito sigue siendo valido.
 *
 * No se exporta la store `ligeros`: son los mismos procesos sin los textos, y se
 * reconstruye sola al importar. Exportarla duplicaria el fichero a proposito.
 */

import {
  abrirAlmacen,
  guardarContratos,
  guardarMatches,
  guardarProcesos,
  leerMeta,
  ponerAccion,
} from './db'
import { normalizarPerfil } from './perfil'

export const FORMATO = 'licitaciones-ndjson'
export const VERSION_FORMATO = 1

const STORES = ['procesos', 'matches', 'contratos', 'acciones']

/** Serializa la cabecera: que es esto, de cuando, y con que perfil. */
async function cabecera() {
  const perfil = normalizarPerfil((await leerMeta('perfil', null)) || {})
  const ultima = await leerMeta('ultima_sync', null)
  return {
    _formato: FORMATO,
    _version: VERSION_FORMATO,
    _exportado: new Date().toISOString(),
    _stores: STORES,
    _ultima_sync: ultima,
    perfil,
  }
}

/** La clave natural de cada store, para filtrar por ids al exportar. */
const claveDe = (fila) => fila.tender_id || fila.id_del_proceso || fila.id_contrato

/**
 * Recorre el almacen y entrega cada fila a `alLinea`.
 *
 * Quien decide donde se escribe es el llamante: con la File System Access API se
 * escribe directo a disco sin llegar a construir el fichero entero en memoria, y
 * sin ella se acumulan trozos y se arma un `Blob` al final. Aqui solo se recorre,
 * sin decidir nada de eso.
 *
 * Con `ids` solo se exportan esas filas (la lista que esta viendo el usuario);
 * sin `ids`, todo el almacen.
 */
export async function recorrerParaExportar({ ids = null, alProgresar, signal, alLinea } = {}) {
  const almacen = await abrirAlmacen()
  const Linea = await cabecera()
  alLinea(Linea)

  const soloEstos = ids ? new Set(ids) : null
  let total = 0
  const cuenta = { procesos: 0, matches: 0, contratos: 0, acciones: 0 }

  for (const store of STORES) {
    await almacen.recorrer(store, (fila) => {
      if (signal?.aborted) throw new DOMException('exportacion cancelada', 'AbortError')
      if (soloEstos && !soloEstos.has(claveDe(fila))) return true
      alLinea({ _store: store, ...fila })
      cuenta[store] += 1
      total += 1
      if (total % 1000 === 0) alProgresar?.({ hechos: total, ...cuenta })
      return true
    })
  }

  alProgresar?.({ hechos: total, ...cuenta })
  return { total, porStore: cuenta }
}

/**
 * Guarda el volcado en un fichero.
 *
 * Con `showSaveFilePicker` (Chrome, Edge) se escribe linea a linea a un fichero
 * de verdad, asi que el tamano no importa: 400 MB de SECOP salen bien. En Firefox
 * y Safari no hay esa API, hay que acumular y armar un `Blob`, que es lo que
 * limita la exportacion a lo que aguante la memoria. Por eso `soloIds` existe: con
 * la lista filtrada, el fichero es mucho mas pequeno.
 */
export async function descargar({ ids = null, alProgresar, signal, soloVisibles = false } = {}) {
  const soloIds = soloVisibles ? ids : null
  const dia = new Date().toISOString().slice(0, 10)

  if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
    const handle = await window.showSaveFilePicker({
      suggestedName: `licitaciones-${dia}.ndjson`,
      types: [{ description: 'NDJSON del panel', accept: { 'application/x-ndjson': ['.ndjson'] } }],
    })
    const writable = await handle.createWritable()
    // `write()` devuelve una promesa y el recorrido del cursor es sincrono (no se
    // puede parar a esperar dentro, o la transaccion de IndexedDB se cierra sola),
    // asi que las escrituras se encadenan: cada una espera a la anterior. Sin
    // esto se lanzarian ~340.000 escrituras a la vez y el orden del fichero seria
    // el del scheduler, no el de los datos.
    let cola = Promise.resolve()
    const escribir = (obj) => {
      cola = cola.then(() => writable.write(`${JSON.stringify(obj)}\n`))
      return cola
    }
    try {
      const res = await recorrerParaExportar({
        ids: soloIds,
        alProgresar,
        signal,
        alLinea: escribir,
      })
      // Vaciar la cola ANTES del `close()`: si se cierra con escrituras en vuelo,
      // el navegador las descarta y el .ndjson sale truncado sin avisar.
      await cola
      return { nombre: handle.name, ...res, streamed: true }
    } finally {
      // El `close` va siempre, tambien si se cancela: si no, el fichero queda
      // como parcial y sin cerrar, que el explorador no puede ni abrir. Se espera
      // la cola tambien en este camino, y se silencian sus errores para que el
      // fallo real sea el de la excepcion que estamos propagando.
      await cola.catch(() => {})
      await writable.close()
    }
  }

  const trozos = []
  const res = await recorrerParaExportar({
    ids: soloIds,
    alProgresar,
    signal,
    alLinea: (obj) => trozos.push(`${JSON.stringify(obj)}\n`),
  })
  const blob = new Blob(trozos, { type: 'application/x-ndjson' })
  const nombre = `licitaciones-${dia}.ndjson`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nombre
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Sin este revoke, el blob queda retenido hasta que se recarga la pagina: con
  // cientos de MB se nota en la memoria de la pestana.
  setTimeout(() => URL.revokeObjectURL(url), 10000)
  return { nombre, ...res, streamed: false }
}

/**
 * Importa un NDJSON.
 *
 * Acepta texto, `File` o `Blob`. Si el objeto trae `stream()` se lee por trozos,
 * sin cargarlo entero en memoria. Cada linea se agrupa por store y se escribe en
 * bloques de 500, porque una transaccion de IndexedDB con 100.000 `put` dentro se
 * queda colgada.
 */
export async function importar(fuente, { alProgresar, signal } = {}) {
  const pendientes = { procesos: [], matches: [], contratos: [], acciones: [] }
  let cabeceraLeida = null
  let leidas = 0
  let ignoradas = 0

  const escribir = async () => {
    if (pendientes.procesos.length) {
      await guardarProcesos(pendientes.procesos)
      pendientes.procesos = []
    }
    if (pendientes.matches.length) {
      await guardarMatches(pendientes.matches)
      pendientes.matches = []
    }
    if (pendientes.contratos.length) {
      await guardarContratos(pendientes.contratos)
      pendientes.contratos = []
    }
    for (const accion of pendientes.acciones) {
      await ponerAccion(accion)
    }
    pendientes.acciones = []
    alProgresar?.({ leidas, guardadas: leidas - ignoradas })
  }

  const procesar = async (linea) => {
    const limpia = linea.trim()
    if (!limpia) return
    let fila
    try {
      fila = JSON.parse(limpia)
    } catch {
      // Una linea corrupta no puede tumbar toda la importacion: se cuenta y se
      // sigue. Un fichero a medio escribir es el caso normal, no la excepcion.
      ignoradas += 1
      return
    }
    leidas += 1
    if (fila._formato) {
      cabeceraLeida = fila
      if (fila._formato !== FORMATO) {
        throw new Error(`No es un fichero del panel: viene de "${fila._formato}"`)
      }
      return
    }
    const store = fila._store
    if (!store || !pendientes[store]) {
      ignoradas += 1
      return
    }
    delete fila._store
    pendientes[store].push(fila)
    if (pendientes.procesos.length + pendientes.matches.length + pendientes.contratos.length >= 500) {
      await escribir()
    }
  }

  if (typeof fuente === 'string') {
    for (const linea of fuente.split('\n')) {
      if (signal?.aborted) throw new DOMException('importacion cancelada', 'AbortError')
      await procesar(linea)
    }
  } else if (typeof fuente?.stream === 'function') {
    const lector = fuente.stream().getReader()
    const decodificador = new TextDecoder()
    let resto = ''
    for (;;) {
      if (signal?.aborted) throw new DOMException('importacion cancelada', 'AbortError')
      const { done, value } = await lector.read()
      if (done) break
      resto += decodificador.decode(value, { stream: true })
      const trozos = resto.split('\n')
      resto = trozos.pop() || ''
      for (const linea of trozos) await procesar(linea)
    }
    if (resto) await procesar(resto)
  } else {
    for (const linea of (await fuente.text()).split('\n')) await procesar(linea)
  }

  await escribir()
  return { cabecera: cabeceraLeida, leidas, ignoradas }
}

/**
 * El perfil que viene en la cabecera de un fichero importado.
 *
 * Va aparte a proposito: es lo unico que no son datos de SECOP, y aplicarlo sin
 * querer dejaria el panel puntuando contra otra empresa. Se devuelve y que sea el
 * panel el que pregunte.
 */
export function perfilDeCabecera(cabecera) {
  return cabecera?.perfil ? normalizarPerfil(cabecera.perfil) : null
}