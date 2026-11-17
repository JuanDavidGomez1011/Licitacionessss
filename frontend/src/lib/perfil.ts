/**
 * Perfil de empresa: el patron contra el que se puntua.
 *
 * Es el `backend/app/seed/profile.yaml` translated a JS. Antes se editaba en ese
 * fichero y se cargaba con `bootstrap.py --perfil`; ahora vive en el navegador y
 * se edita desde el panel (que era el pendiente "pantalla de perfil editable" del
 * ESTADO-PROYECTO). El YAML se queda como copia de referencia: si algun dia se
 * vuelve al backend, el perfil sigue siendo el mismo.
 */

import { listaDeTerminos } from './texto'
import type { Perfil } from './tipos'

export const PERFIL_POR_DEFECTO: Perfil = {
  version: 2,
  nombre: 'Investigación, Diseño e Innovación',
  descripcion:
    'Organización colombiana dedicada a la investigación aplicada, el diseño y la innovación. Formula y ' +
    'ejecuta proyectos de ciencia, tecnología e innovación; realiza estudios, diagnósticos y ' +
    'caracterizaciones; diseña servicios, productos, procesos y piezas gráficas; acompaña laboratorios de ' +
    'innovación y procesos de innovación social, y transfiere conocimiento a entidades públicas, ' +
    'universidades, comunidades y empresas.',
  actividades: [
    'Investigación aplicada, estudios técnicos, diagnósticos y caracterizaciones',
    'Formulación y ejecución de proyectos de ciencia, tecnología e innovación',
    'Diseño de servicios, de producto y diseño gráfico',
    'Laboratorios de innovación, innovación social y co-creación con comunidades',
    'Transferencia y apropiación social del conocimiento',
  ],
  palabras_clave: [
    'investigación',
    'investigación aplicada',
    'estudios técnicos',
    'diagnóstico',
    'caracterización',
    'diseño',
    'diseño de servicios',
    'diseño de producto',
    'diseño gráfico',
    'innovación',
    'innovación social',
    'ciencia, tecnología e innovación',
    'laboratorio de innovación',
    'prototipo',
    'transferencia de conocimiento',
    'apropiación social del conocimiento',
    'formulación de proyectos',
    'consultoría',
  ],
  // Familias UNSPSC que usan de verdad los procesos de investigacion, diseno e
  // innovacion en SECOP II (consulta a p6dx-8zbt de 2025-2026, 17/11/2026):
  // 8010 asesoria y gestion, 8014 investigacion de mercados, 8016 administracion
  // de empresas, 8110 ingenieria y diseno, 9314 desarrollo comunitario y social,
  // mas 8214 diseno grafico. Queda fuera 8011 (recursos humanos / prestacion de
  // servicios) aunque es el mas usado: es tan generico que daria 100 a cualquier
  // contrato de prestacion de servicios. Se puede anadir desde el panel.
  codigos_unspsc: ['8010', '8014', '8016', '8110', '8214', '9314'],
  // Concurso de meritos es la modalidad de la consultoria (estudios, disenos,
  // investigacion); los contratos de CTeI suelen ir por contratacion directa o
  // por regimen especial (universidades, Minciencias).
  modalidades_preferidas: [
    'Concurso de meritos',
    'Contratacion directa',
    'Regimen especial',
    'Licitacion publica',
    'Seleccion abreviada',
    'Minima cuantia',
  ],
  exclusiones: [
    'obra publica',
    'construccion de edificaciones',
    'interventoria de obra',
    'compra de maquinaria',
    'suministro de alimentos',
    'combustible',
    'vigilancia y seguridad',
    'aseo y cafeteria',
  ],
  departamentos_preferidos: ['Bogota D.C.', 'Bogota', 'Antioquia', 'Atlantico', 'Valle del Cauca', 'Santander'],
  presupuesto_minimo: 10000000,
  presupuesto_maximo: 5000000000,
  activo: true,
  actualizado_en: null,
}

/** Lo que puede llegar del formulario o de un backup: listas como texto o arrays. */
export type PerfilBruto = {
  [K in keyof Perfil]?: Perfil[K] extends string[] ? string[] | string : Perfil[K] | string | null
}

/** Codigos UNSPSC limpios: solo digitos, quitando el prefijo `V1.` de SECOP II. */
export function limpiarUnspsc(codigos: string[]): string[] {
  return codigos.map((c) => c.replace(/\D/g, '')).filter((c) => c.length >= 2)
}

/** Normaliza lo que llega del formulario: listas como texto -> listas limpias. */
export function normalizarPerfil(bruto: PerfilBruto | null | undefined): Perfil {
  const lista = (v: string[] | string | null | undefined): string[] => listaDeTerminos(v)
  const numero = (v: unknown): number | null => {
    if (v === '' || v === null || v === undefined) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return {
    version: Number(bruto?.version) || 1,
    nombre: String(bruto?.nombre || '').trim() || 'Mi Empresa',
    descripcion: String(bruto?.descripcion || '').trim(),
    actividades: lista(bruto?.actividades),
    palabras_clave: lista(bruto?.palabras_clave),
    codigos_unspsc: limpiarUnspsc(lista(bruto?.codigos_unspsc)),
    modalidades_preferidas: lista(bruto?.modalidades_preferidas),
    exclusiones: lista(bruto?.exclusiones),
    departamentos_preferidos: lista(bruto?.departamentos_preferidos),
    presupuesto_minimo: numero(bruto?.presupuesto_minimo),
    presupuesto_maximo: numero(bruto?.presupuesto_maximo),
    activo: bruto?.activo !== false,
    actualizado_en: typeof bruto?.actualizado_en === 'string' ? bruto.actualizado_en : null,
  }
}