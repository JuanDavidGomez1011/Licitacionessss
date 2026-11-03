/**
 * Tipos de dominio del panel.
 *
 * Todo lo que circula entre la ingesta, el almacen, la puntuacion y la UI esta
 * aqui. Los nombres de campo son los de las stores (`id_del_proceso`,
 * `precio_base`...), no los de las columnas de Socrata: esas solo existen en
 * `mapper.ts`, que es quien traduce.
 */

// --- datos crudos de Socrata -------------------------------------------------

/** Valor tal como llega de SODA: texto, numero, `{url}` o `{lat, lon}`. */
export type ValorSocrata =
  | string
  | number
  | boolean
  | null
  | undefined
  | { url?: string; lat?: string | number; lon?: string | number }
  | ValorSocrata[]

/** Una fila cruda de cualquier dataset de Socrata. */
export type FilaSocrata = Record<string, ValorSocrata>

// --- procesos y contratos ----------------------------------------------------

/** De que plataforma de Colombia Compra Eficiente viene el proceso. */
export type Fuente = 'SECOP II' | 'SECOP I'

/** Proceso completo, tal como se guarda en la store `procesos`. */
export interface Proceso {
  id_del_proceso: string
  referencia_del_proceso: string | null
  entidad: string | null
  nit_entidad: string | null
  departamento_entidad: string | null
  ciudad_entidad: string | null
  nombre_del_procedimiento: string | null
  descripcion: string | null
  precio_base: number | null
  modalidad_de_contratacion: string | null
  justificacion_modalidad: string | null
  duracion: number | null
  unidad_de_duracion: string | null
  numero_de_lotes: number | null
  codigo_principal_categoria: string | null
  categorias_adicionales: string | null
  estado_del_procedimiento: string | null
  adjudicado: string | null
  fecha_publicacion: string | null
  fecha_recepcion: string | null
  /** Fecha limite para presentar ofertas (cierre). SECOP I no la publica. */
  fecha_apertura_respuesta: string | null
  fecha_ultima_publicacion: string | null
  tipo_contrato: string | null
  subtipo_contrato: string | null
  url_proceso: string | null
  estado_resumen: string | null
  origen: string
  fuente: Fuente
  notice_uid: string | null
  /** Solo en procesos importados de backups antiguos o fixtures. */
  objeto_contrato?: string | null
}

/** Lo que necesita el indice de consulta: el proceso sin los textos largos. */
export type ProcesoLigero = Pick<
  Proceso,
  | 'id_del_proceso'
  | 'nombre_del_procedimiento'
  | 'referencia_del_proceso'
  | 'entidad'
  | 'departamento_entidad'
  | 'ciudad_entidad'
  | 'modalidad_de_contratacion'
  | 'estado_del_procedimiento'
  | 'codigo_principal_categoria'
  | 'numero_de_lotes'
  | 'precio_base'
  | 'fecha_publicacion'
  | 'fecha_apertura_respuesta'
  | 'notice_uid'
> & { fuente?: Fuente; url_proceso?: string | null }

export interface Contrato {
  id_contrato: string
  proceso_de_compra: string | null
  referencia_del_contrato: string | null
  nombre_entidad: string | null
  nit_entidad: string | null
  departamento: string | null
  ciudad: string | null
  localizacion: string | null
  estado_contrato: string | null
  descripcion_del_proceso: string | null
  objeto_del_contrato: string | null
  valor_del_contrato: number | null
  valor_pagado: number | null
  valor_facturado: number | null
  valor_pendiente_de_pago: number | null
  fecha_de_firma: string | null
  fecha_de_inicio: string | null
  fecha_de_fin: string | null
  tipo_de_contrato: string | null
  modalidad_de_contratacion: string | null
  proveedor_adjudicado: string | null
  es_pyme: string | null
  codigo_de_categoria_principal: string | null
  urlproceso: string | null
  ultima_actualizacion: string | null
  notice_uid: string | null
  proceso_id?: string | null
}

// --- perfil y configuracion --------------------------------------------------

export interface Perfil {
  version: number
  nombre: string
  descripcion: string
  actividades: string[]
  palabras_clave: string[]
  /** Codigos UNSPSC de interes: 2 (segmento), 4 (familia), 6 (clase) u 8 digitos. */
  codigos_unspsc: string[]
  modalidades_preferidas: string[]
  exclusiones: string[]
  departamentos_preferidos: string[]
  presupuesto_minimo: number | null
  presupuesto_maximo: number | null
  activo: boolean
  actualizado_en: string | null
}

/** Componentes del score y su peso (0-100 cada uno, se normalizan al mezclar). */
export interface PesosScore {
  unspsc: number
  objeto: number
  presupuesto: number
  tiempo: number
  palabras: number
}

export type ComponenteScore = keyof PesosScore

export interface Config {
  socrataBase: string
  datasetProcesos: string
  datasetContratos: string
  datasetSecopI: string
  appToken: string
  pageSize: number
  requestDelay: number
  maxRetries: number
  timeoutMs: number
  lookbackDays: number
  maxProcesos: number
  maxContratos: number
  maxProcesosSecopI: number
  includeContracts: boolean
  incluirSecopI: boolean
  puntuarEnLaDescarga: boolean
  simFloor: number
  simCeil: number
  pesos: PesosScore
  topicosSimilares: number
  autoSyncAlAbrir: boolean
  /** Sincronizacion periodica mientras la pestana este abierta. */
  autoSync: boolean
  autoSyncMinutos: number
  alertas: boolean
  alertaUmbral: number
  alertaNotificacion: boolean
}

// --- puntuacion --------------------------------------------------------------

export type Nivel = 'alta' | 'media' | 'baja'

export interface TerminoPeso {
  termino: string
  peso: number
  idf: number
}

export type Penalizacion = 'exclusion' | 'presupuesto'

/** Desglose del score por componente. `null` = sin datos para calcularlo. */
export type Componentes = Record<ComponenteScore, number | null>

/** Registro de la store `matches`. */
export interface Match {
  tender_id: string
  score: number
  nivel?: Nivel
  componentes?: Componentes
  score_semantico: number | null
  score_reglas: number | null
  peso_semantico?: number | null
  bullets: string[]
  razones_semanticas: TerminoPeso[]
  penalizaciones: Penalizacion[]
  descartado?: boolean
  ya_accion?: string | null
  calculado_en: string
  razones?: string[]
}

/** Lo que las reglas necesitan de un proceso. */
export interface Ficha {
  id: string
  text: string
  modalidad: string | null
  departamento: string | null
  precio: number | null
  ya_accion?: string | null
}

export interface Veredicto {
  maxScore: number
  penalizacion: number
  razones: string[]
  descartado: boolean
}

// --- acciones y CRM ----------------------------------------------------------

export type TipoAccion = 'guardar' | 'ocultar' | 'descartar'

export interface Accion {
  tender_id: string
  accion: TipoAccion
  nota: string | null
  created_at: string
}

/** Columnas del tablero Kanban. */
export type EstadoCRM = 'evaluacion' | 'preparacion' | 'presentada' | 'ganada' | 'descartada'

export interface TarjetaCRM {
  tender_id: string
  estado: EstadoCRM
  nota: string
  /** Copia de lo minimo para pintar el tablero sin abrir el proceso. */
  titulo: string
  entidad: string | null
  precio_base: number | null
  fecha_cierre: string | null
  url_proceso: string | null
  score: number | null
  creado_en: string
  actualizado_en: string
}

// --- alertas -----------------------------------------------------------------

export interface Alerta {
  tender_id: string
  titulo: string
  entidad: string | null
  score: number
  creada_en: string
  leida: boolean
}

// --- filtros -----------------------------------------------------------------

/** Filtros del indice en memoria (`Indice.filtrar`). */
export interface FiltrosIndice {
  /** Solo estos procesos (los resultados de "Buscar en SECOP"). */
  ids?: string[] | null
  q?: string
  incluir?: string[]
  excluir?: string[]
  entidades?: string[] | Set<string> | string | null
  departamentos?: string[] | Set<string> | string | null
  ciudades?: string[] | Set<string> | string | null
  modalidades?: string[] | Set<string> | string | null
  estados?: string[] | Set<string> | string | null
  fuentes?: string[] | Set<string> | string | null
  precioMin?: number | null
  precioMax?: number | null
  desde?: string
  hasta?: string
  soloPorVencer?: boolean
  diasPorVencer?: number | null
  acciones?: Map<string, Set<string>> | null
  soloGuardadas?: boolean
  soloConMatch?: boolean
  minScore?: number | null
  maxScore?: number | null
}

export type Orden = 'score' | 'fecha' | 'precio' | 'precio_desc' | 'entidad' | 'cierre'

/** Estado de los filtros en la UI: lo que se guarda en una busqueda guardada. */
export interface FiltrosUI {
  q: string
  incluir: string
  excluir: string
  score_min: number
  precio_min: number | ''
  precio_max: number | ''
  solo_por_vencer: boolean
  dias_por_vencer: number | ''
  solo_guardadas: boolean
  departamentos: string[]
  ciudades: string[]
  modalidades: string[]
  entidades: string[]
  estados: string[]
  fuentes: string[]
  orden: Orden
}

/** Parametros que la UI manda a la fachada (`api.licitaciones`). */
export interface ParamsConsulta {
  ids?: string[]
  q?: string
  incluir?: string[]
  excluir?: string[]
  score_min?: number
  precio_min?: number
  precio_max?: number
  solo_por_vencer?: boolean
  dias_por_vencer?: number
  solo_guardadas?: boolean
  departamentos?: string[]
  ciudades?: string[]
  modalidades?: string[]
  entidades?: string[]
  estados?: string[]
  fuentes?: string[]
  orden?: Orden
  limit?: number
  offset?: number
  limite?: number
}

export interface BusquedaGuardada {
  id: string
  nombre: string
  filtros: FiltrosUI
  creada_en: string
}

export interface ValorFaceta {
  valor: string
  n: number
}

export interface Facetas {
  entidades: ValorFaceta[]
  departamentos: ValorFaceta[]
  ciudades: ValorFaceta[]
  modalidades: ValorFaceta[]
  estados: ValorFaceta[]
  fuentes: ValorFaceta[]
  conPrecio: number
  total: number
}

// --- vistas de la fachada ----------------------------------------------------

/** Match con los nombres que pinta la UI. */
export interface MatchVista {
  score: number
  nivel: Nivel
  componentes: Componentes | null
  bullets: string[]
  rationale: string | null
  matched_keywords: string[]
  gaps: string[]
  model: string
  semantic_similarity: number | null
  scored_at: string | null
  penalizaciones: Penalizacion[]
}

/** Una oportunidad como la pinta `Tarjeta`. */
export interface Oportunidad {
  id_del_proceso: string
  titulo: string
  entidad: string | null
  referencia_del_proceso: string | null
  estado: string | null
  modalidad: string | null
  departamento: string | null
  ciudad: string | null
  categoria: string | null
  lotes: number | null
  precio_base: number | null
  fecha_publicacion: string | null
  fecha_apertura_respuesta: string | null
  dias_restantes: number | null
  url_proceso: string | null
  fuente: Fuente
  acciones: string[]
  crm: EstadoCRM | null
  match: MatchVista | null
}

export interface OportunidadDetalle extends Oportunidad {
  descripcion: string | null
  objeto_contrato: string | null
  justificacion_modalidad: string | null
  nit_entidad: string | null
  duracion: number | null
  unidad_de_duracion: string | null
  tipo_contrato: string | null
}

// --- resumidor ---------------------------------------------------------------

export type CategoriaRequisito = 'juridico' | 'financiero' | 'tecnico'

export interface Requisito {
  texto: string
  /** `extraido` sale del texto publicado; `habitual` es lo que la ley pide para la modalidad. */
  origen: 'extraido' | 'habitual'
}

export interface ResumenPliego {
  tender_id: string
  objeto: string
  datos_clave: { etiqueta: string; valor: string }[]
  requisitos: Record<CategoriaRequisito, Requisito[]>
  advertencias: string[]
  generado_en: string
}
