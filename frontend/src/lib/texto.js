/**
 * Normalizacion y tokenizacion de texto.
 *
 * Puerto directo de `backend/app/ai/rules.py` (norm, tokens) y
 * `backend/app/ai/embedder.py` (tokenize, keyword_overlap, build_*_text).
 * Se mantiene el mismo comportamiento a proposito: los cortes duros del perfil
 * dependen de estas funciones y un cambio sutil aqui cambiaria los scores sin
 * que se note.
 */

/** Palabras vacias del espanol/ingles, iguales a las de `embedder.py`. */
export const STOPWORDS = new Set([
  'de', 'la', 'el', 'los', 'las', 'del', 'un', 'una', 'unos', 'unas', 'y', 'o', 'u',
  'en', 'para', 'por', 'con', 'sin', 'sobre', 'entre', 'a', 'al', 'que', 'se', 'su',
  'sus', 'es', 'son', 'fue', 'ser', 'como', 'mas', 'menos', 'muy', 'este', 'esta',
  'estos', 'estas', 'todo', 'toda', 'todos', 'todas', 'otro', 'otra', 'lo',
  'the', 'of', 'and', 'for', 'with', 'to', 'in', 'on', 'an', 'or', 'by', 'at',
  'contratacion', 'contratación', 'proceso', 'procedimiento', 'servicio', 'servicios',
  'suministro', 'suministrar', 'adquisicion', 'adquisición', 'compra', 'comprar',
])

const RE_TOKENS_NORM = /[a-z0-9]+/g
const RE_TOKENS = /[a-zA-ZáéíóúñÁÉÍÓÚÑüÜ]+/g

/**
 * Minusculas, sin acentos y con los espacios colapsados.
 *
 * En Python es `unicodedata.normalize('NFKD', ...)`. Aqui NFD + quitar los
 * diacriticos da el mismo resultado en los casos del castellano: la `n` con
 * virgulilla se descompone en `n` + U+0303, y al quitar la marca queda `n`,
 * que es lo que hacia `str.maketrans("ñü", "nu")`.
 */
export function norm(valor) {
  if (valor === null || valor === undefined || valor === '') return ''
  return String(valor)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
}

/** Conjunto de tokens alfanumericos de un texto ya normalizado. */
export function tokens(valor) {
  return new Set(norm(valor).match(RE_TOKENS_NORM) || [])
}

/** Lista de palabras del texto, sin acentos y en minusculas. */
export function tokenize(texto) {
  const limpio = norm(texto || '')
  return limpio.match(RE_TOKENS) || []
}

/** True si el termino aparece como frase o como conjunto de palabras. */
export function hit(termino, texto) {
  const t = tokens(termino)
  if (!t.size) return false
  const destino = tokens(texto)
  for (const palabra of t) {
    if (!destino.has(palabra)) return false
  }
  return true
}

/** Palabras clave del perfil que aparecen literalmente en el texto. */
export function keywordOverlap(texto, keywords) {
  if (!texto) return []
  const conjunto = new Set(tokenize(texto))
  return (keywords || []).filter((k) => {
    if (!k) return false
    return tokenize(k).some((p) => conjunto.has(p))
  })
}

/** Texto del perfil usado para comparar contra las licitaciones. */
export function buildProfileText(profile) {
  if (!profile) return ''
  const partes = [
    profile.nombre || '',
    profile.descripcion || '',
    (profile.actividades || []).join(' '),
    (profile.palabras_clave || []).join(' '),
  ]
  return partes.filter((p) => p && p.trim()).join('\n').trim()
}

/** Texto de la/licitacion: objeto + descripcion + tipo de contrato. */
export function buildTenderText(tender) {
  if (!tender) return ''
  const partes = [
    tender.nombre_del_procedimiento || '',
    tender.descripcion || '',
    tender.objeto_contrato || '',
    [tender.tipo_contrato, tender.subtipo_contrato].filter(Boolean).join(' '),
  ]
  return partes.filter((p) => p && p.trim()).join('\n').trim()
}

/** Texto corto de la ficha: lo que se puntua y lo que sale en la tarjeta. */
export function textoFicha(tender) {
  return [
    tender.nombre_del_procedimiento || '',
    tender.descripcion || tender.objeto_contrato || '',
  ]
    .filter(Boolean)
    .join(' ')
    .trim()
}