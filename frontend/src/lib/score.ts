/**
 * Motor de puntuacion. Corre dentro de la pagina: sin servidor y sin modelo.
 *
 * El score (0-100) es una media ponderada de cinco componentes, cada uno en
 * 0-100, y despues las reglas duras del perfil:
 *
 *   objeto       similitud TF-IDF + coseno entre el perfil y el objeto/descripcion
 *   unspsc       coincidencia del codigo UNSPSC del proceso con los del perfil
 *   presupuesto  si el precio base cae en el rango del perfil (y cuanto se aleja)
 *   palabras     cuantas palabras clave estrategicas aparecen literalmente
 *   tiempo       si queda tiempo razonable para preparar la oferta
 *
 * Un componente sin datos (perfil sin codigos UNSPSC, proceso sin precio o sin
 * fecha de cierre) vale `null` y NO cuenta como 0: su peso se reparte entre los
 * demas. Puntuar "sin fecha" como "cerrado" hundiria todo SECOP I, que no
 * publica la fecha de cierre.
 *
 * Que sustituye y que no:
 *
 *   - Sustituye al embedder de Ollama. Ahi habia un `bge-m3` de 560M parametros
 *     que tardaba ~40 s en cargar y ocupaba mas de 1 GB de RAM. Aqui la
 *     similitud es TF-IDF con coseno sobre vectores dispersos. No es tan buena:
 *     no entiende sinonimos ni parafrasis. Pero es determinista, tarda
 *     milisegundos y no ocupa nada.
 *   - Sustituye al LLM que redactaba el resumen. Los bullets salen de las
 *     reglas, de los componentes y de los terminos que mas pesan: cada motivo es
 *     trazable a un campo concreto de la ficha.
 *
 * El orden de las operaciones importa y es el de `matchmaker.py`:
 *
 *   1. componentes (incluida la similitud)
 *   2. mezcla ponderada
 *   3. topes por exclusion y por presupuesto, AL FINAL
 *
 * El paso 3 va al final a proposito. Un cap aplicado antes de la mezcla se
 * reescalaba hacia arriba al multiplicar por el peso, y un proceso excluido con
 * score 100 salia con score 8. Cap y mezcla en este orden son el unico orden en
 * el que el cap significa algo (bug #14).
 */

import { PESOS_POR_DEFECTO } from './config'
import { diasHasta, nivelDe } from './format'
import { aplicar, CAP_BUDGET, evaluate } from './reglas'
import { buildProfileText, keywordOverlap, STOPWORDS, textoFicha, tokenize } from './texto'
import type {
  ComponenteScore,
  Componentes,
  Ficha,
  Match,
  Penalizacion,
  Perfil,
  PesosScore,
  Proceso,
  TerminoPeso,
} from './tipos'

const BATCH = 400

// --- indice del corpus -------------------------------------------------------

export interface DocCorpus {
  id: string
  proceso: Proceso
  tokens: string[]
  longitud: number
}

export interface IndiceCorpus {
  postings: Map<string, number[]>
  idf: Map<string, number>
  N: number
  docs: DocCorpus[]
  /** La fachada lo usa para saber si el indice se quedo viejo. */
  versionDatos?: number
}

export interface VectorPerfil {
  pesos: Map<string, number>
  norma: number
}

/**
 * Invierte los textos del corpus en `termino -> lista de documentos`.
 *
 * Indice invertido de verdad, no un mapa de vectores densos: un proceso tiene
 * 60-120 terminos utiles, no 60.000. Con posting lists el corpus entero ocupa
 * unos pocos MB; con vectores densos serian 118.000 x 60.000 floats, que no
 * caben en ninguna pestana.
 *
 * Las posting lists guardan el *indice* numerico del documento, no su id, para
 * que sean numeros y no cadenas, y para poder leer el documento sin buscar.
 */
export function construirIndiceCorpus(procesos: Proceso[]): IndiceCorpus {
  const postings = new Map<string, number[]>()
  const docs: DocCorpus[] = new Array(procesos.length)

  for (let i = 0; i < procesos.length; i++) {
    const p = procesos[i]!
    const toks = tokenize(textoFicha(p))
    docs[i] = { id: p.id_del_proceso, proceso: p, tokens: toks, longitud: toks.length }
    for (const termino of new Set(toks)) {
      let lista = postings.get(termino)
      if (!lista) {
        lista = []
        postings.set(termino, lista)
      }
      lista.push(i)
    }
  }

  const N = procesos.length || 1
  const idf = new Map<string, number>()
  for (const [termino, lista] of postings) {
    // idf = ln((N + 1) / (df + 1)) + 1. El +1 de SMOOTHING evita el idf 0 en
    // terminos que estan en todos los documentos, que es justo lo que pasa con
    // "contratacion" o "servicios" en SECOP.
    idf.set(termino, Math.log((N + 1) / (lista.length + 1)) + 1)
  }
  return { postings, idf, N, docs }
}

/**
 * Vector disperso del perfil, normalizado.
 *
 * Se construye DESPUES de invertir el corpus, porque necesita el idf de cada
 * termino, y el idf depende de cuantos documentos lo contienen. Ese orden es
 * obligatorio: si el perfil se vectorizara antes, habria que pasarle el idf de
 * otro corpus.
 */
export function vectorizarPerfil(perfil: Partial<Perfil> | string, idf: Map<string, number>): VectorPerfil {
  const conteo = new Map<string, number>()
  for (const termino of tokenize(buildProfileText(perfil))) {
    conteo.set(termino, (conteo.get(termino) || 0) + 1)
  }
  const pesos = new Map<string, number>()
  let suma = 0
  for (const [termino, n] of conteo) {
    // TF sublineal (1 + ln n): sin el, un termino repetido 20 veces en el perfil
    // domina el vector y todos los procesos salen iguales.
    const peso = (1 + Math.log(n)) * (idf.get(termino) || 1)
    pesos.set(termino, peso)
    suma += peso * peso
  }
  return { pesos, norma: Math.sqrt(suma) }
}

/**
 * Coseno del perfil contra un documento.
 *
 * Se recorre el documento, no el perfil: el documento tiene ~80 terminos y el
 * perfil ~100, pero recorrer el documento hace que el coste por ficha sea
 * proporcional al tamano de la ficha y no al del indice global.
 */
export function cosenoContraDoc(vectorPerfil: VectorPerfil, indice: IndiceCorpus, i: number): number {
  if (vectorPerfil.norma === 0) return 0
  const doc = indice.docs[i]
  if (!doc || !doc.longitud) return 0

  let producto = 0
  let acumDoc = 0
  for (const termino of new Set(doc.tokens)) {
    const pesoPerfil = vectorPerfil.pesos.get(termino)
    if (!pesoPerfil) continue
    const pesoDoc = (indice.idf.get(termino) || 1) * (1 + Math.log(doc.longitud))
    producto += pesoPerfil * pesoDoc
    acumDoc += pesoDoc * pesoDoc
  }
  if (acumDoc === 0) return 0
  return producto / (vectorPerfil.norma * Math.sqrt(acumDoc))
}

// --- componentes -------------------------------------------------------------

export interface Banda {
  floor?: number | null
  ceil?: number | null
}

/**
 * Escala del coseno a 0-100.
 *
 * El coseno sale en [0, 1] pero, con TF-IDF, lo "relacionado" cae en 0.05-0.35
 * y lo demas por debajo de 0.03. Sin estirar, casi todo salia por debajo de 35
 * y el panel parecia roto. Se remapea la banda `simFloor..simCeil` a 0-100 en
 * lugar de dividir por una constante, porque asi los cortes se pueden ajustar
 * desde la configuracion sin tocar el codigo.
 */
const BANDA_POR_DEFECTO = { floor: 0.03, ceil: 0.35 }
function aCien(coseno: number, banda?: Banda | null): number {
  const floor = Number.isFinite(banda?.floor) ? Number(banda?.floor) : BANDA_POR_DEFECTO.floor
  const ceil = Number.isFinite(banda?.ceil) ? Number(banda?.ceil) : BANDA_POR_DEFECTO.ceil
  if (ceil <= floor) return redondear(Math.min(100, Math.max(0, coseno * 100)))
  const valor = ((coseno - floor) / (ceil - floor)) * 100
  return redondear(Math.min(100, Math.max(0, valor)))
}

const redondear = (n: number): number => Math.round(n * 10) / 10

/**
 * Solo los digitos de un codigo UNSPSC.
 *
 * SECOP II los publica como `V1.43232107` (el `V1` es la version del
 * clasificador, no parte del codigo) y a veces como `UNSPECIFIED`; SECOP I trae
 * la clase pelada (`931415`).
 */
export function digitosUnspsc(codigo: string | null | undefined): string {
  if (!codigo) return ''
  return String(codigo)
    .trim()
    .replace(/^[A-Za-z]+\d*\./, '')
    .replace(/\D/g, '')
}

/** Codigos del proceso: el principal y, si los hay, los adicionales. */
function codigosDelProceso(p: Pick<Proceso, 'codigo_principal_categoria' | 'categorias_adicionales'>): string[] {
  const out = [digitosUnspsc(p.codigo_principal_categoria)]
  for (const extra of String(p.categorias_adicionales || '').split(',')) out.push(digitosUnspsc(extra))
  return [...new Set(out.filter((c) => c.length >= 2))]
}

export interface ResultadoUnspsc {
  valor: number | null
  detalle: string | null
}

/**
 * Coincidencia UNSPSC (0-100).
 *
 * El perfil declara codigos a la granularidad que le interesa (segmento 2,
 * familia 4, clase 6 o producto 8 digitos). Si el proceso esta DENTRO de uno de
 * ellos, es coincidencia plena. Si no, cuenta lo cerca que esta en el arbol:
 * misma clase 80, misma familia 60, mismo segmento 30.
 */
export function puntajeUnspsc(codigosPerfil: string[], proceso: Pick<Proceso, 'codigo_principal_categoria' | 'categorias_adicionales'>): ResultadoUnspsc {
  const perfil = codigosPerfil.map(digitosUnspsc).filter((c) => c.length >= 2)
  if (!perfil.length) return { valor: null, detalle: null }
  const delProceso = codigosDelProceso(proceso)
  if (!delProceso.length) return { valor: null, detalle: null }

  let mejor = 0
  let detalle: string | null = null
  for (const cp of delProceso) {
    for (const cf of perfil) {
      let valor = 0
      let como = ''
      if (cp.startsWith(cf)) {
        valor = 100
        como = `dentro de ${cf}`
      } else {
        const comun = prefijoComun(cp, cf)
        if (comun >= 6) [valor, como] = [80, 'misma clase']
        else if (comun >= 4) [valor, como] = [60, 'misma familia']
        else if (comun >= 2) [valor, como] = [30, 'mismo segmento']
      }
      if (valor > mejor) {
        mejor = valor
        detalle = `UNSPSC ${cp} ${como} que ${cf}`
      }
    }
  }
  return { valor: mejor, detalle: mejor > 0 ? detalle : `UNSPSC ${delProceso[0]} fuera de los codigos del perfil` }
}

function prefijoComun(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1
  // Solo cuentan niveles completos del arbol: 2, 4, 6 u 8 digitos.
  return n - (n % 2)
}

/**
 * Compatibilidad de presupuesto (0-100). Dentro del rango, 100. Fuera, la
 * proporcion entre el precio y el limite que rebasa: la mitad del minimo da 50.
 * Sin precio o sin rango en el perfil, `null`.
 */
export function puntajePresupuesto(perfil: Partial<Perfil>, precio: number | null): number | null {
  const minimo = perfil.presupuesto_minimo ?? null
  const maximo = perfil.presupuesto_maximo ?? null
  if (precio === null || !Number.isFinite(precio) || precio <= 0) return null
  if (minimo === null && maximo === null) return null
  if (minimo !== null && precio < minimo) return redondear((precio / minimo) * 100)
  if (maximo !== null && precio > maximo) return redondear((maximo / precio) * 100)
  return 100
}

/**
 * Tiempo restante hasta el cierre (0-100).
 *
 * Cerrado vale 0. Cerrar en menos de 3 dias apenas deja preparar una oferta;
 * entre 6 y 45 dias es la ventana comoda; mas alla sigue siendo bueno pero
 * menos urgente de mirar. Sin fecha de cierre (SECOP I) es `null`.
 */
export function puntajeTiempo(fechaCierre: string | null, ahora: number = Date.now()): number | null {
  const dias = diasHasta(fechaCierre, ahora)
  if (dias === null) return null
  if (dias < 0) return 0
  if (dias <= 2) return 25
  if (dias <= 5) return 60
  if (dias <= 45) return 100
  return 80
}

/**
 * Cobertura de palabras clave (0-100). Satura en 4 coincidencias: un perfil
 * con 16 palabras clave no puede exigir que un proceso las tenga todas, y con
 * la proporcion lisa un proceso que nombra cuatro salia con 25.
 */
export function puntajePalabras(perfil: Partial<Perfil>, texto: string): { valor: number | null; presentes: string[] } {
  const claves = perfil.palabras_clave || []
  if (!claves.length) return { valor: null, presentes: [] }
  const presentes = keywordOverlap(texto, claves)
  const objetivo = Math.min(4, claves.length)
  return { valor: redondear(Math.min(1, presentes.length / objetivo) * 100), presentes }
}

/**
 * Media ponderada de los componentes que tienen datos. Los pesos se
 * normalizan sobre los presentes, asi que un componente sin datos no resta.
 */
export function mezclar(componentes: Componentes, pesos: PesosScore): number {
  let suma = 0
  let total = 0
  for (const clave of Object.keys(pesos) as ComponenteScore[]) {
    const valor = componentes[clave]
    const peso = Math.max(0, Number(pesos[clave]) || 0)
    if (valor === null || peso === 0) continue
    suma += valor * peso
    total += peso
  }
  return total ? suma / total : 0
}

// --- puntuacion de un proceso ------------------------------------------------

const FICHA = (p: Proceso, yaAccion?: string | null): Ficha => ({
  id: p.id_del_proceso,
  text: textoFicha(p),
  modalidad: p.modalidad_de_contratacion,
  departamento: p.departamento_entidad,
  precio: p.precio_base,
  ya_accion: yaAccion || null,
})

export interface EntradaPuntuacion {
  proceso: Proceso
  ficha: Ficha
  vector: VectorPerfil
  indice: IndiceCorpus
  indicePos: number
  perfil: Perfil
  pesos?: PesosScore
  banda?: Banda | null
  ahora?: number
}

/**
 * Puntua un proceso. Devuelve el registro tal y como se guarda en `matches`.
 *
 * `bullets` son las razones de las reglas, los componentes y los terminos del
 * perfil que mas pesan. Es la parte de explicabilidad: cada linea se puede
 * comprobar contra el texto de la ficha.
 */
export function puntuarProceso({
  proceso,
  ficha,
  vector,
  indice,
  indicePos,
  perfil,
  pesos = PESOS_POR_DEFECTO,
  banda,
  ahora = Date.now(),
}: EntradaPuntuacion): Match {
  const cos = cosenoContraDoc(vector, indice, indicePos)
  const objeto = aCien(cos, banda)
  const unspsc = puntajeUnspsc(perfil.codigos_unspsc || [], proceso)
  const palabras = puntajePalabras(perfil, ficha.text)

  const componentes: Componentes = {
    objeto,
    unspsc: unspsc.valor,
    presupuesto: puntajePresupuesto(perfil, ficha.precio),
    palabras: palabras.valor,
    tiempo: puntajeTiempo(proceso.fecha_apertura_respuesta, ahora),
  }

  const veredicto = evaluate(perfil, ficha)
  // Mezcla antes del tope. Si el tope se aplicara a un componente y luego se
  // mezclara, el cap se reescalaria hacia arriba.
  const score = aplicar(veredicto, mezclar(componentes, pesos))

  const bullets = [...veredicto.razones]
  if (unspsc.detalle) bullets.push(unspsc.detalle)
  if (palabras.presentes.length) bullets.push(`Palabras clave: ${palabras.presentes.slice(0, 5).join(', ')}`)
  if (componentes.tiempo !== null && componentes.tiempo < 60 && componentes.tiempo > 0) {
    bullets.push('Poco tiempo para preparar la oferta')
  }
  const razonesSemanticas = topTerminos(vector, indice, indicePos, 5)
  const lineaPerfil = bulletPerfil(razonesSemanticas)
  if (lineaPerfil) bullets.push(lineaPerfil)

  const penalizaciones: Penalizacion[] = []
  if (veredicto.descartado) penalizaciones.push('exclusion')
  if (veredicto.maxScore === CAP_BUDGET) penalizaciones.push('presupuesto')

  return {
    tender_id: proceso.id_del_proceso,
    score,
    nivel: nivelDe(score) ?? 'baja',
    componentes,
    score_semantico: objeto,
    score_reglas: palabras.valor,
    bullets: bullets.slice(0, 8),
    razones_semanticas: razonesSemanticas,
    penalizaciones,
    descartado: veredicto.descartado,
    ya_accion: ficha.ya_accion || null,
    calculado_en: new Date(ahora).toISOString(),
    razones: veredicto.razones,
  }
}

/**
 * Un termino que sirve como motivo: ni palabra vacia ("con", "de") ni de dos
 * letras. Esas tambien suman algo al coseno, pero como explicacion no dicen
 * nada: "coincide en 'con'" no es una razon para mirar una licitacion.
 */
export function esTerminoUtil(termino: string): boolean {
  return termino.length >= 3 && !STOPWORDS.has(termino)
}

/**
 * La linea legible de la parte TF-IDF: los terminos del perfil que mas pesan
 * en esta ficha, juntos. Antes era una linea por termino con su idf
 * ("Perfil: 'software' (idf 5.47)"), que es jerga del motor y no del usuario.
 */
export function bulletPerfil(terminos: TerminoPeso[]): string | null {
  const utiles = terminos.map((t) => t.termino).filter(esTerminoUtil)
  return utiles.length ? `Coincide con tu perfil en: ${utiles.join(', ')}` : null
}

/** Terminos del perfil presentes en la ficha, ordenados por peso conjunto. */
function topTerminos(vector: VectorPerfil, indice: IndiceCorpus, i: number, n: number): TerminoPeso[] {
  const doc = indice.docs[i]
  if (!doc) return []
  const out: TerminoPeso[] = []
  for (const termino of new Set(doc.tokens)) {
    if (!esTerminoUtil(termino)) continue
    const pesoPerfil = vector.pesos.get(termino)
    if (!pesoPerfil) continue
    const idf = indice.idf.get(termino) || 1
    out.push({ termino, peso: Math.round(pesoPerfil * idf * 1000) / 1000, idf: Math.round(idf * 100) / 100 })
  }
  out.sort((a, b) => b.peso - a.peso)
  return out.slice(0, n)
}

// --- puntuacion del corpus ---------------------------------------------------

export interface ProgresoPuntuacion {
  hechos: number
  total: number
  ms: number
}

export interface OpcionesCorpus {
  procesos: Proceso[]
  perfil: Perfil
  pesos?: PesosScore
  simFloor?: number
  simCeil?: number
  yaAccionDe?: (id: string) => string | null | undefined
  alProgresar?: (p: ProgresoPuntuacion) => void
  alLote?: (lote: Match[]) => unknown
  signal?: AbortSignal | null
}

/**
 * Puntua todo el corpus y devuelve un `Map` de `tender_id -> match`.
 *
 * Cede el hilo entre lotes con `setTimeout`. Sin esa cesion, el bucle de
 * 118.000 procesos congela la pestana, el progreso no se repinta y el boton de
 * cancelar no responde: `signal` solo se mira cuando el hilo vuelve a la cola
 * de tareas.
 */
export async function puntuarCorpus({
  procesos,
  perfil,
  pesos = PESOS_POR_DEFECTO,
  simFloor,
  simCeil,
  yaAccionDe,
  alProgresar,
  alLote,
  signal,
}: OpcionesCorpus): Promise<Map<string, Match>> {
  const banda: Banda = { floor: simFloor ?? null, ceil: simCeil ?? null }
  const alEmpezar = Date.now()
  const indice = construirIndiceCorpus(procesos)
  const perfilVec = vectorizarPerfil(perfil, indice.idf)
  const matches = new Map<string, Match>()
  const total = indice.docs.length

  for (let inicio = 0; inicio < total; inicio += BATCH) {
    if (signal?.aborted) throw new DOMException('puntuacion cancelada', 'AbortError')

    const fin = Math.min(inicio + BATCH, total)
    const delLote: Match[] = []
    for (let i = inicio; i < fin; i++) {
      const doc = indice.docs[i]!
      const ficha = FICHA(doc.proceso, yaAccionDe?.(doc.id))
      const match = puntuarProceso({
        proceso: doc.proceso,
        ficha,
        vector: perfilVec,
        indice,
        indicePos: i,
        perfil,
        pesos,
        banda,
        ahora: alEmpezar,
      })
      matches.set(doc.id, match)
      delLote.push(match)
    }

    alProgresar?.({ hechos: fin, total, ms: Date.now() - alEmpezar })
    // Solo el lote, no el acumulador entero: mandar los 118.000 matches en
    // cada uno de los 295 lotes para que se escriban al final es O(n^2).
    if (alLote) await alLote(delLote)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  return matches
}

export interface ResumenScores {
  total: number
  alto: number
  medio: number
  bajo: number
  excluidos: number
  fueraPresupuesto: number
}

/** Cuantos quedaron en cada nivel del semaforo. Para la cabecera del panel. */
export function resumenPuntuacion(matches: Map<string, Match>): ResumenScores {
  const res: ResumenScores = { total: 0, alto: 0, medio: 0, bajo: 0, excluidos: 0, fueraPresupuesto: 0 }
  for (const m of matches.values()) {
    res.total += 1
    const nivel = nivelDe(Number(m.score) || 0)
    if (nivel === 'alta') res.alto += 1
    else if (nivel === 'media') res.medio += 1
    else res.bajo += 1
    if (m.penalizaciones?.includes('exclusion')) res.excluidos += 1
    if (m.penalizaciones?.includes('presupuesto')) res.fueraPresupuesto += 1
  }
  return res
}

/** El Map como array, que es lo que se guarda en IndexedDB. */
export function matchesComoArray(matches: Map<string, Match>): Match[] {
  return [...matches.values()]
}
