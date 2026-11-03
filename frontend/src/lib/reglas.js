/**
 * Reglas deterministas del perfil de empresa.
 *
 * Puerto literal de `backend/app/ai/rules.py`. Los topes y las penalizaciones
 * son los mismos a proposito:
 *
 *   - una exclusion del perfil descarta el proceso (tope 5)
 *   - un presupuesto fuera de rango lo deja en el tope 20
 *   - modalidad no preferida: -15
 *   - territorio no preferido: -10
 *   - texto vacio: 0
 *
 * Aqui ya no hay LLM al que contradecir: la pagina es quien propone y las
 * reglas son el corte. Se conserva el orden de aplicacion (bug #14): el tope va
 * DESPUES de mezclar, nunca antes.
 */

import { hit, norm } from './texto'

export const CAP_EXCLUSION = 5
export const CAP_BUDGET = 20
export const PENALTY_MODALIDAD = 15
export const PENALTY_TERRITORIO = 10

/** Veredicto de las reglas, con las razones que lo justifican. */
export function veredictoVacio() {
  return { maxScore: 100, penalizacion: 0, razones: [], descartado: false }
}

/** Combina una puntuacion con las reglas y acota a 0-100. */
export function aplicar(veredicto, score) {
  let valor
  if (veredicto.maxScore < 100) valor = Math.min(score, veredicto.maxScore)
  else valor = score - veredicto.penalizacion
  return Math.max(0, Math.min(100, Math.round(valor)))
}

const numero = (n) => n.toLocaleString('es-CO', { maximumFractionDigits: 0 })

/**
 * Evalua el perfil contra una ficha.
 *
 * @param {object} profile  perfil de empresa
 * @param {object} ficha    `{ text, precio, modalidad, departamento }`
 */
export function evaluate(profile, ficha) {
  const v = veredictoVacio()
  const perfil = profile || {}
  const texto = norm(ficha.text)

  if (!texto) {
    v.maxScore = 0
    v.descartado = true
    v.razones.push('El proceso no tiene objeto ni descripcion publicados')
    return v
  }

  // 1. exclusiones
  for (const exclusion of perfil.exclusiones || []) {
    if (exclusion && hit(exclusion, texto)) {
      v.maxScore = Math.min(v.maxScore, CAP_EXCLUSION)
      v.descartado = true
      v.razones.push(`Excluido por el perfil: '${exclusion}'`)
      break
    }
  }

  // 2. presupuesto
  const precio = ficha.precio
  if (precio !== null && precio !== undefined && Number.isFinite(precio)) {
    const minimo = perfil.presupuesto_minimo
    const maximo = perfil.presupuesto_maximo
    if (minimo !== null && minimo !== undefined && precio < minimo) {
      v.maxScore = Math.min(v.maxScore, CAP_BUDGET)
      v.razones.push(`Presupuesto ${numero(precio)} COP por debajo del minimo ${numero(minimo)}`)
    }
    if (maximo !== null && maximo !== undefined && precio > maximo) {
      v.maxScore = Math.min(v.maxScore, CAP_BUDGET)
      v.razones.push(`Presupuesto ${numero(precio)} COP por encima del maximo ${numero(maximo)}`)
    }
  }

  // 3. modalidad (penaliza, no descarta)
  const preferidas = (perfil.modalidades_preferidas || []).filter(Boolean)
  if (preferidas.length && ficha.modalidad) {
    const m = norm(ficha.modalidad)
    if (!preferidas.some((p) => m.includes(norm(p)) || norm(p).includes(m))) {
      v.penalizacion += PENALTY_MODALIDAD
      v.razones.push(`Modalidad no preferida: ${ficha.modalidad}`)
    }
  }

  // 4. territorio (penaliza, no descarta)
  const depts = (perfil.departamentos_preferidos || []).filter(Boolean)
  if (depts.length && ficha.departamento) {
    const d = norm(ficha.departamento)
    if (!depts.some((p) => d.includes(norm(p)) || norm(p).includes(d))) {
      v.penalizacion += PENALTY_TERRITORIO
      v.razones.push(`Territorio fuera de los preferidos: ${ficha.departamento}`)
    }
  }

  return v
}