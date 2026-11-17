/**
 * Normalizacion y tokenizacion de texto.
 *
 * Puerto directo de `backend/app/ai/rules.py` (norm, tokens) y
 * `backend/app/ai/embedder.py` (tokenize, keyword_overlap, build_*_text).
 * Se mantiene el mismo comportamiento a proposito: los cortes duros del perfil
 * dependen de estas funciones y un cambio sutil aqui cambiaria los scores sin
 * que se note.
 */

import type { Perfil } from './tipos'

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

/** Lo que se puede normalizar: cualquier cosa que tenga sentido como texto. */
type Textual = string | number | null | undefined

/**
 * Minusculas, sin acentos y con los espacios colapsados.
 *
 * En Python es `unicodedata.normalize('NFKD', ...)`. Aqui NFD + quitar los
 * diacriticos da el mismo resultado en los casos del castellano: la `n` con
 * virgulilla se descompone en `n` + U+0303, y al quitar la marca queda `n`,
 * que es lo que hacia `str.maketrans("ñü", "nu")`.
 */
export function norm(valor: Textual): string {
  if (valor === null || valor === undefined || valor === '') return ''
  return String(valor)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
}

/** Conjunto de tokens alfanumericos de un texto ya normalizado. */
export function tokens(valor: Textual): Set<string> {
  return new Set(norm(valor).match(RE_TOKENS_NORM) || [])
}

/** Lista de palabras del texto, sin acentos y en minusculas. */
export function tokenize(texto: Textual): string[] {
  const limpio = norm(texto || '')
  return limpio.match(RE_TOKENS) || []
}

/** True si el termino aparece como frase o como conjunto de palabras. */
export function hit(termino: string, texto: string): boolean {
  const t = tokens(termino)
  if (!t.size) return false
  const destino = tokens(texto)
  for (const palabra of t) {
    if (!destino.has(palabra)) return false
  }
  return true
}

/**
 * Palabras clave del perfil que aparecen en el texto.
 *
 * Una palabra clave de varias palabras cuenta si estan TODAS sus palabras con
 * significado (sin palabras vacias ni de menos de 3 letras). Antes bastaba con
 * una cualquiera, incluida "de": "diseño de producto" o "desarrollo de software"
 * coincidian con casi cualquier proceso y el componente salia inflado.
 */
export function keywordOverlap(texto: string, keywords: string[] | null | undefined): string[] {
  if (!texto) return []
  const conjunto = new Set(tokenize(texto))
  return (keywords || []).filter((k) => {
    if (!k) return false
    const significativas = tokenize(k).filter((p) => p.length >= 3 && !STOPWORDS.has(p))
    return significativas.length > 0 && significativas.every((p) => conjunto.has(p))
  })
}

/** Texto del perfil usado para comparar contra las licitaciones. */
export function buildProfileText(profile: Partial<Perfil> | string | null | undefined): string {
  if (!profile) return ''
  // `similares` usa el propio proceso como consulta: llega ya como texto.
  if (typeof profile === 'string') return profile
  const partes = [
    profile.nombre || '',
    profile.descripcion || '',
    (profile.actividades || []).join(' '),
    (profile.palabras_clave || []).join(' '),
  ]
  return partes.filter((p) => p && p.trim()).join('\n').trim()
}

/** Lo minimo de un proceso que hace falta para sacar su texto. */
export interface ConTexto {
  nombre_del_procedimiento?: string | null
  descripcion?: string | null
  objeto_contrato?: string | null
  tipo_contrato?: string | null
  subtipo_contrato?: string | null
}

/** Texto de la licitacion: objeto + descripcion + tipo de contrato. */
export function buildTenderText(tender: ConTexto | null | undefined): string {
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
export function textoFicha(tender: ConTexto): string {
  return [tender.nombre_del_procedimiento || '', tender.descripcion || tender.objeto_contrato || '']
    .filter(Boolean)
    .join(' ')
    .trim()
}

/** Separa una lista escrita a mano ("a, b; c") en terminos limpios. */
export function listaDeTerminos(texto: string | string[] | null | undefined): string[] {
  if (Array.isArray(texto)) return texto.map((t) => t.trim()).filter(Boolean)
  return String(texto || '')
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
}
