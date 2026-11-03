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
  version: 1,
  nombre: 'Servicios Integrales de Tecnología S.A.S.',
  descripcion:
    'Empresa colombiana de tecnologia y consultoria que presta servicios de desarrollo de software, ' +
    'soporte tecnologico, infraestructura de redes y ciberseguridad, analisis de datos y ' +
    'capacitacion, tanto a entidades del estado como al sector privado. Cuenta con ISO 9001 y 27001, ' +
    'equipo de soporte en sitio y capacidad de integracion con sistemas de informacion externos.',
  actividades: [
    'Desarrollo y mantenimiento de software a medida',
    'Soporte tecnologico e infraestructura de redes',
    'Ciberseguridad, auditoria y gestion de incidentes',
    'Analisis de datos, BI y automatizacion de procesos',
    'Capacitacion y transferencia tecnologica',
  ],
  palabras_clave: [
    'software',
    'desarrollo de software',
    'soporte tecnologico',
    'mantenimiento de sistemas',
    'ciberseguridad',
    'seguridad de la informacion',
    'redes',
    'computacion en la nube',
    'servicio de hosting',
    'licencias de software',
    'contenedorizacion',
    'base de datos',
    'inteligencia artificial',
    'analitica',
    'capacitacion',
    'consultoria',
  ],
  // Familias UNSPSC: 4323 software, 8111 servicios informaticos, 8116 entrega
  // de servicios de TI. Se puede afinar a clase (6) o producto (8 digitos).
  codigos_unspsc: ['4323', '8111', '8116'],
  modalidades_preferidas: ['Licitacion publica', 'Seleccion directa', 'Concurso', 'Subasta'],
  exclusiones: [
    'obra publica',
    'construccion de edificaciones',
    'interventoria de obra',
    'compra de maquinaria',
    'suministro de alimentos',
  ],
  departamentos_preferidos: ['Bogota D.C.', 'Bogota', 'Antioquia', 'Atlantico', 'Valle del Cauca', 'Santander'],
  presupuesto_minimo: 20000000,
  presupuesto_maximo: 9000000000,
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