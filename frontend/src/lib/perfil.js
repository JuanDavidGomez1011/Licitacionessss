/**
 * Perfil de empresa: el patron contra el que se puntua.
 *
 * Es el `backend/app/seed/profile.yaml` translated a JS. Antes se editaba en ese
 * fichero y se cargaba con `bootstrap.py --perfil`; ahora vive en el navegador y
 * se edita desde el panel (que era el pendiente "pantalla de perfil editable" del
 * ESTADO-PROYECTO). El YAML se queda como copia de referencia: si algun dia se
 * vuelve al backend, el perfil sigue siendo el mismo.
 */

export const PERFIL_POR_DEFECTO = {
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
}

/** Normaliza lo que llega del formulario: listas como texto -> listas limpias. */
export function normalizarPerfil(bruto) {
  const lista = (v) => {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
    return String(v || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  }
  const numero = (v) => {
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
    modalidades_preferidas: lista(bruto?.modalidades_preferidas),
    exclusiones: lista(bruto?.exclusiones),
    departamentos_preferidos: lista(bruto?.departamentos_preferidos),
    presupuesto_minimo: numero(bruto?.presupuesto_minimo),
    presupuesto_maximo: numero(bruto?.presupuesto_maximo),
    activo: bruto?.activo !== false,
    actualizado_en: bruto?.actualizado_en || null,
  }
}