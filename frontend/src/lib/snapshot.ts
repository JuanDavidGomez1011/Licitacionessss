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
  guardarTarjetaCRM,
  leerMeta,
  ponerAccion,
  type Registros,
} from './db'
import { normalizarPerfil, type PerfilBruto } from './perfil'
import type { Accion, Contrato, Match, Perfil, Proceso, TarjetaCRM } from './tipos'

export const FORMATO = 'licitaciones-ndjson'
export const VERSION_FORMATO = 1

// `crm` entra en el respaldo: el tablero es trabajo del usuario, no se puede
// volver a descargar de SECOP.
const STORES = ['procesos', 'matches', 'contratos', 'acciones', 'crm'] as const
type StoreExportada = (typeof STORES)[number]

export interface Cabecera {
  _formato: string
  _version?: number
  _exportado?: string
  _stores?: readonly string[]
  _ultima_sync?: string | null
  perfil?: PerfilBruto
}

type Fila = Registros[StoreExportada]
type LineaExportada = Cabecera | (Fila & { _store: StoreExportada })

export interface ProgresoExportar {
  hechos: number
  procesos: number
  matches: number
  contratos: number
  acciones: number
  crm: number
}

export interface ResultadoExportar {
  total: number
  porStore: Record<StoreExportada, number>
}

/** Serializa la cabecera: que es esto, de cuando, y con que perfil. */
async function cabecera(): Promise<Cabecera> {
  const perfil = normalizarPerfil((await leerMeta<PerfilBruto | null>('perfil', null)) || {})
  const ultima = await leerMeta<string | null>('ultima_sync', null)
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
const claveDe = (fila: Fila): string => {
  if ('tender_id' in fila) return fila.tender_id
  if ('id_del_proceso' in fila) return fila.id_del_proceso
  return fila.id_contrato
}

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
export async function recorrerParaExportar({
  ids = null,
  alProgresar,
  signal,
  alLinea,
}: {
  ids?: string[] | null
  alProgresar?: (p: ProgresoExportar) => void
  signal?: AbortSignal | null
  alLinea: (linea: LineaExportada) => unknown
}): Promise<ResultadoExportar> {
  const almacen = await abrirAlmacen()
  const Linea = await cabecera()
  alLinea(Linea)

  const soloEstos = ids ? new Set(ids) : null
  let total = 0
  const cuenta: Record<StoreExportada, number> = { procesos: 0, matches: 0, contratos: 0, acciones: 0, crm: 0 }

  for (const store of STORES) {
    await almacen.recorrer(store, (fila: Fila) => {
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
type VentanaConPicker = Window & {
  showSaveFilePicker?: (opciones: {
    suggestedName: string
    types: { description: string; accept: Record<string, string[]> }[]
  }) => Promise<{ name: string; createWritable: () => Promise<{ write: (t: string) => Promise<void>; close: () => Promise<void> }> }>
}

export async function descargar({
  ids = null,
  alProgresar,
  signal,
  soloVisibles = false,
}: {
  ids?: string[] | null
  alProgresar?: (p: ProgresoExportar) => void
  signal?: AbortSignal | null
  soloVisibles?: boolean
} = {}): Promise<ResultadoExportar & { nombre: string; streamed: boolean }> {
  const soloIds = soloVisibles ? ids : null
  const dia = new Date().toISOString().slice(0, 10)

  const ventana = typeof window !== 'undefined' ? (window as VentanaConPicker) : null
  if (ventana && typeof ventana.showSaveFilePicker === 'function') {
    const handle = await ventana.showSaveFilePicker({
      suggestedName: `licitaciones-${dia}.ndjson`,
      types: [{ description: 'NDJSON del panel', accept: { 'application/x-ndjson': ['.ndjson'] } }],
    })
    const writable = await handle.createWritable()
    // `write()` devuelve una promesa y el recorrido del cursor es sincrono (no se
    // puede parar a esperar dentro, o la transaccion de IndexedDB se cierra sola),
    // asi que las escrituras se encadenan: cada una espera a la anterior. Sin
    // esto se lanzarian ~340.000 escrituras a la vez y el orden del fichero seria
    // el del scheduler, no el de los datos.
    let cola: Promise<void> = Promise.resolve()
    const escribir = (obj: LineaExportada) => {
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

  const trozos: string[] = []
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
interface Pendientes {
  procesos: Proceso[]
  matches: Match[]
  contratos: Contrato[]
  acciones: Accion[]
  crm: TarjetaCRM[]
}

export interface ResultadoImportar {
  cabecera: Cabecera | null
  leidas: number
  ignoradas: number
}

export async function importar(
  fuente: string | Blob,
  { alProgresar, signal }: { alProgresar?: (p: { leidas: number; guardadas: number }) => void; signal?: AbortSignal | null } = {},
): Promise<ResultadoImportar> {
  const pendientes: Pendientes = { procesos: [], matches: [], contratos: [], acciones: [], crm: [] }
  let cabeceraLeida: Cabecera | null = null
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
    for (const tarjeta of pendientes.crm) {
      await guardarTarjetaCRM(tarjeta)
    }
    pendientes.crm = []
    alProgresar?.({ leidas, guardadas: leidas - ignoradas })
  }

  const procesar = async (linea: string) => {
    const limpia = linea.trim()
    if (!limpia) return
    let fila: Record<string, unknown>
    try {
      fila = JSON.parse(limpia) as Record<string, unknown>
    } catch {
      // Una linea corrupta no puede tumbar toda la importacion: se cuenta y se
      // sigue. Un fichero a medio escribir es el caso normal, no la excepcion.
      ignoradas += 1
      return
    }
    leidas += 1
    if (typeof fila._formato === 'string') {
      cabeceraLeida = fila as unknown as Cabecera
      if (fila._formato !== FORMATO) {
        throw new Error(`No es un fichero del panel: viene de "${fila._formato}"`)
      }
      return
    }
    const store = fila._store
    if (typeof store !== 'string' || !(store in pendientes)) {
      ignoradas += 1
      return
    }
    delete fila._store
    // El fichero es nuestro formato: cada linea es una fila de su store.
    ;(pendientes[store as StoreExportada] as unknown[]).push(fila)
    if (pendientes.procesos.length + pendientes.matches.length + pendientes.contratos.length >= 500) {
      await escribir()
    }
  }

  if (typeof fuente === 'string') {
    for (const linea of fuente.split('\n')) {
      if (signal?.aborted) throw new DOMException('importacion cancelada', 'AbortError')
      await procesar(linea)
    }
  } else if (typeof fuente.stream === 'function') {
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
export function perfilDeCabecera(cabecera: Cabecera | null | undefined): Perfil | null {
  return cabecera?.perfil ? normalizarPerfil(cabecera.perfil) : null
}