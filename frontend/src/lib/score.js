/**
 * Motor de puntuacion. Corre dentro de la pagina: sin servidor y sin modelo.
 *
 * Que sustituye y que no:
 *
 *   - Sustituye al embedder de Ollama. Ahi habia un `bge-m3` de 560M parametros
 *     que tardaba ~40 s en cargar y ocupaba mas de 1 GB de RAM. Aqui la
 *     similitud es TF-IDF con coseno sobre vectores dispersos. No es tan buena:
 *     no entiende sinonimos ni parafrasis. Pero es determinista, tarda
 *     milisegundos y no ocupa nada.
 *   - Sustituye al LLM que redactaba el resumen. Los bullets salen de las
 *     reglas y de los terminos que mas pesan. Se pierde la redaccion fluideza a
 *     cambio de que el motivo del score sea siempre trazable a un campo
 *     concreto de la ficha.
 *
 * El orden de las operaciones importa y es el de `matchmaker.py`:
 *
 *   1. similitud TF-IDF entre el perfil y el texto de la ficha
 *   2. componente de reglas (cobertura de palabras clave)
 *   3. mezcla de los dos con el peso de la configuracion
 *   4. topes por exclusion y por presupuesto, AL FINAL
 *
 * El paso 4 va al final a proposito. Un cap aplicado antes de la mezcla se
 * reescalaba hacia arriba al multiplicar por el peso semantico, y un proceso
 * excluido con score 100 salia con score 8. Cap y mezcla en este orden son el
 * unico orden en el que el cap significa algo (bug #14).
 */

import { aplicar, CAP_BUDGET, evaluate } from './reglas'
import { buildProfileText, keywordOverlap, textoFicha, tokenize } from './texto'

const BATCH = 400

// --- indice del corpus -------------------------------------------------------

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
export function construirIndiceCorpus(procesos) {
  const postings = new Map()
  const docs = new Array(procesos.length)

  for (let i = 0; i < procesos.length; i++) {
    const p = procesos[i]
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
  const idf = new Map()
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
export function vectorizarPerfil(perfil, idf) {
  const conteo = new Map()
  for (const termino of tokenize(buildProfileText(perfil))) {
    conteo.set(termino, (conteo.get(termino) || 0) + 1)
  }
  const pesos = new Map()
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
export function cosenoContraDoc(vectorPerfil, indice, i) {
  if (vectorPerfil.norma === 0) return 0
  const doc = indice.docs[i]
  if (!doc.longitud) return 0

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

// --- puntuacion de un proceso ------------------------------------------------

const FICHA = (p, yaAccion) => ({
  id: p.id_del_proceso,
  text: textoFicha(p),
  modalidad: p.modalidad_de_contratacion,
  departamento: p.departamento_entidad,
  precio: p.precio_base,
  ya_accion: yaAccion || null,
})

/**
 * Escala del coseno a 0-100.
 *
 * El coseno sale en [0, 1] pero, con TF-IDF, lo "relacionado" cae en 0.05-0.35
 * y lo demas por debajo de 0.03. Sin estirar, casi todo salia por debajo de 35
 * y el panel parecia roto. Se remapea la banda `simFloor..simCeil` a 0-100 en
 * lugar de dividir por una constante, porque asi los cortes se pueden ajustar
 * desde el panel sin tocar el codigo. Los cortes salen de la configuracion, no
 * de los embeddings que usaba el matchmaker (alli la banda era 0.45-0.88, que
 * aqui daria 0 a todo).
 */
const BANDA_POR_DEFECTO = { floor: 0.03, ceil: 0.35 }
function aCien(coseno, banda) {
  const floor = Number.isFinite(banda?.floor) ? banda.floor : BANDA_POR_DEFECTO.floor
  const ceil = Number.isFinite(banda?.ceil) ? banda.ceil : BANDA_POR_DEFECTO.ceil
  if (ceil <= floor) return Math.round(Math.min(100, Math.max(0, coseno * 100)) * 10) / 10
  const valor = ((coseno - floor) / (ceil - floor)) * 100
  return Math.round(Math.min(100, Math.max(0, valor)) * 10) / 10
}

/**
 * Componente de reglas: cobertura de las palabras clave del perfil.
 *
 * Es el sustituto de la parte "semantica" que el embedder no cubria. Va de 0 a
 * 100 y mide cuantas palabras clave aparecen literalmente en la ficha. Sin
 * palabras clave en el perfil no hay componente de reglas: la mezcla se queda
 * solo con la similitud, en vez de inventar un 0 que hundiria todos los scores.
 */
function cobertura(perfil, ficha) {
  const claves = perfil.palabras_clave || []
  if (!claves.length) return null
  const presentes = keywordOverlap(ficha.text, claves)
  return { valor: (presentes.length / claves.length) * 100, presentes }
}

/**
 * Puntua un proceso. Devuelve el registro tal y como se guarda en `matches`.
 *
 * `bullets` son las razones de las reglas mas los terminos del perfil que mas
 * pesan. Es la parte de explicabilidad: cada linea se puede comprobar contra el
 * texto de la ficha, cosa que con un LLM no era verdad.
 */
export function puntuarProceso({ proceso, ficha, vector, indice, indicePos, perfil, peso, banda }) {
  const cos = cosenoContraDoc(vector, indice, indicePos)
  const semantico = aCien(cos, banda)

  const reglas = cobertura(perfil, ficha)
  const veredicto = evaluate(perfil, ficha)

  // Mezcla antes del tope. Si el tope se aplicara al semantico y luego se
  // mezclara con las reglas, el cap se reescalaria hacia arriba.
  const mezcla = reglas === null ? semantico : semantico * peso + reglas.valor * (1 - peso)

  const score = aplicar(veredicto, mezcla)

  const bullets = [...veredicto.razones]
  const razonesSemanticas = topTerminos(vector, indice, indicePos, 5)
  for (const t of razonesSemanticas) bullets.push(`Perfil: '${t.termino}' (idf ${t.idf})`)
  if (reglas) for (const k of reglas.presentes) bullets.push(`Palabra clave del perfil: '${k}'`)

  const penalizaciones = []
  if (veredicto.descartado) penalizaciones.push('exclusion')
  if (veredicto.maxScore === CAP_BUDGET) penalizaciones.push('presupuesto')

  return {
    tender_id: proceso.id_del_proceso,
    score,
    score_semantico: semantico,
    score_reglas: reglas === null ? null : Math.round(reglas.valor * 10) / 10,
    peso_semantico: reglas === null ? null : peso,
    bullets: bullets.slice(0, 8),
    razones_semanticas: razonesSemanticas,
    penalizaciones,
    descartado: veredicto.descartado,
    ya_accion: ficha.ya_accion || null,
    calculado_en: new Date().toISOString(),
  }
}

/** Terminos del perfil presentes en la ficha, ordenados por peso conjunto. */
function topTerminos(vector, indice, i, n) {
  const doc = indice.docs[i]
  if (!doc) return []
  const out = []
  for (const termino of new Set(doc.tokens)) {
    const pesoPerfil = vector.pesos.get(termino)
    if (!pesoPerfil) continue
    const idf = indice.idf.get(termino) || 1
    out.push({ termino, peso: Math.round(pesoPerfil * idf * 1000) / 1000, idf: Math.round(idf * 100) / 100 })
  }
  out.sort((a, b) => b.peso - a.peso)
  return out.slice(0, n)
}

// --- puntuacion del corpus ---------------------------------------------------

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
  pesoSemantico = 0.7,
  simFloor,
  simCeil,
  yaAccionDe,
  alProgresar,
  alLote,
  signal,
}) {
  const peso = Math.min(Math.max(Number(pesoSemantico) || 0, 0), 1)
  const banda = { floor: simFloor, ceil: simCeil }
  const alEmpezar = Date.now()
  const indice = construirIndiceCorpus(procesos)
  const perfilVec = vectorizarPerfil(perfil, indice.idf)
  const matches = new Map()
  const total = indice.docs.length

  for (let inicio = 0; inicio < total; inicio += BATCH) {
    if (signal?.aborted) throw new DOMException('puntuacion cancelada', 'AbortError')

    const fin = Math.min(inicio + BATCH, total)
    const delLote = []
    for (let i = inicio; i < fin; i++) {
      const doc = indice.docs[i]
      const ficha = FICHA(doc.proceso, yaAccionDe?.(doc.id))
      const match = puntuarProceso({
        proceso: doc.proceso,
        ficha,
        vector: perfilVec,
        indice,
        indicePos: i,
        perfil,
        peso,
        banda,
      })
      matches.set(doc.id, match)
      delLote.push(match)
    }

    alProgresar?.({ hechos: fin, total, ms: Date.now() - alEmpezar })
    // Solo el lote, no el acumulador entero: mandar los 118.000 matches en
    // cada uno de los 295 lotes para que se escriban al final es O(n^2).
    if (alLote) alLote(delLote)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  return matches
}

/** Cuantos quedaron por encima de cada corte. Para la cabecera del panel. */
export function resumenPuntuacion(matches) {
  const res = { total: 0, alto: 0, medio: 0, bajo: 0, excluidos: 0, fueraPresupuesto: 0 }
  for (const m of matches.values()) {
    res.total += 1
    const s = Number(m.score) || 0
    if (s >= 75) res.alto += 1
    else if (s >= 50) res.medio += 1
    else res.bajo += 1
    if (m.penalizaciones?.includes('exclusion')) res.excluidos += 1
    if (m.penalizaciones?.includes('presupuesto')) res.fueraPresupuesto += 1
  }
  return res
}

/** El Map como array, que es lo que se guarda en IndexedDB. */
export function matchesComoArray(matches) {
  return [...matches.values()]
}