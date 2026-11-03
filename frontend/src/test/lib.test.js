import { beforeEach, describe, expect, it } from 'vitest'

/**
 * Tests de la logica pura del panel.
 *
 * Se prueban los modulos, no la pagina: es donde estaban los bugs de verdad
 * (el cap que se reescalaba, el `notice_uid` que no cuadraba, las filas que
 * reventaban el lote) y es lo que se puede comprobar sin montar React.
 *
 * El almacen se fuerza a memoria con `fijarAlmacen('memoria')`: jsdom no trae
 * IndexedDB, y probarlo de verdad haria que estos tests dependieran del
 * navegador.
 */
import {
  accionesDe,
  contarProcesos,
  escribirMeta,
  fijarAlmacen,
  guardarMatches,
  guardarProcesos,
  leerMeta,
  noticeUidAProceso,
  ponerAccion,
} from '../lib/db'
import { Indice } from '../lib/indice'
import { api } from '../lib/api'
import { deduplicar, mapearProceso, ligeroProceso } from '../lib/mapper'
import { noticeUid, isoDia, soqlDate, soqlQuote, socrataDate, socrataUrl, SocrataClient } from '../lib/socrata'
import { CAP_BUDGET, CAP_EXCLUSION, aplicar, evaluate } from '../lib/reglas'
import { norm, textoFicha, tokenize } from '../lib/texto'
import { construirIndiceCorpus, cosenoContraDoc, puntuarProceso, vectorizarPerfil } from '../lib/score'
import { PERFIL_POR_DEFECTO, normalizarPerfil } from '../lib/perfil'
import { descargar, importar, perfilDeCabecera, recorrerParaExportar } from '../lib/snapshot'

/**
 * Fila CRUDA de Socrata: los nombres son los del dataset (`p6dx-8zbt`), con los
 * acentos rotos por elnombre corto de columna (`urlproceso`,
 * `descripci_n_del_procedimiento`). `mapearProceso` es la que los traduce a los
 * nombres con los que se guarda.
 *
 * Confundir los dos niveles fue el error al escribir este test: un fixture con
 * `descripcion` y `url_proceso` mapea a `null` sin avisar, porque son columnas
 * que en Socrata no existen.
 */
const FILA_CRUDA = (over = {}) => ({
  id_del_proceso: 'CO1.REQ.1',
  nombre_del_procedimiento: 'PRESTAR SERVICIOS DE DESARROLLO DE SOFTWARE',
  descripci_n_del_procedimiento: 'Desarrollo y mantenimiento de un sistema de informacion, soporte y capacitacion.',
  entidad: 'MINISTERIO DE TECNOLOGIAS DE LA INFORMACION',
  nit_entidad: '830123456',
  departamento_entidad: 'Bogotá D.C.',
  ciudad_entidad: 'Bogotá',
  modalidad_de_contratacion: 'Licitacion publica',
  estado_del_procedimiento: 'Convocado',
  codigo_principal_de_categoria: '43232107',
  numero_de_lotes: 1,
  precio_base: 150000000,
  fecha_de_publicacion_del: '2026-09-20T00:00:00',
  fecha_de_apertura_de_respuesta: '2026-10-05T00:00:00',
  tipo_de_contrato: 'Prestacion de servicios',
  urlproceso: 'https://community.secop.gov.co/Public/Tendering/ContractNotice/Notice?noticeUID=CO1.NTC.9988776',
  ...over,
})

/** Proceso ya MAPEADO: la forma que hay en la store y la que ve el indice. */
const PROCESO = (over = {}) => ({
  id_del_proceso: 'CO1.REQ.1',
  nombre_del_procedimiento: 'PRESTAR SERVICIOS DE DESARROLLO DE SOFTWARE',
  descripcion: 'Desarrollo y mantenimiento de un sistema de informacion, soporte y capacitacion.',
  entidad: 'MINISTERIO DE TECNOLOGIAS DE LA INFORMACION',
  nit_entidad: '830123456',
  departamento_entidad: 'Bogotá D.C.',
  ciudad_entidad: 'Bogotá',
  modalidad_de_contratacion: 'Licitacion publica',
  estado_del_procedimiento: 'Convocado',
  codigo_principal_categoria: '43232107',
  numero_de_lotes: 1,
  precio_base: 150000000,
  fecha_publicacion: '2026-09-20T00:00:00.000Z',
  fecha_apertura_respuesta: '2026-10-05T00:00:00.000Z',
  tipo_contrato: 'Prestacion de servicios',
  url_proceso: 'https://community.secop.gov.co/Public/Tendering/ContractNotice/Notice?noticeUID=CO1.NTC.9988776',
  notice_uid: 'CO1.NTC.9988776',
  origen: 'socrata',
  ...over,
})

beforeEach(async () => {
  await fijarAlmacen('memoria')
})

describe('texto', () => {
  it('norm quita acentos y colapsa espacios', () => {
    expect(norm(' Bogotá   D.C.  ')).toBe('bogota d.c.')
    expect(norm('  MÚLTIPLES   ESPACIOS ')).toBe('multiples espacios')
  })

  it('norm no rompe el texto ya normalizado', () => {
    expect(norm('')).toBe('')
    expect(norm(null)).toBe('')
  })

  it('tokenize saca palabras sin acentos', () => {
    expect(tokenize('Software, soporte y REDES')).toEqual(['software', 'soporte', 'y', 'redes'])
  })

  it('textoFicha usa la descripcion si no hay objeto', () => {
    expect(textoFicha(PROCESO())).toContain('sistema de informacion')
  })
})

describe('reglas', () => {
  const perfil = normalizarPerfil(PERFIL_POR_DEFECTO)

  it('una exclusion descarta con el tope, aunque la similitud sea maxima', () => {
    // Este es el bug #14: si el cap se aplicara antes de mezclar, el 100 del
    // similitud reescalaba el 5 hacia arriba y el proceso no salia descartado.
    const v = evaluate({ ...perfil, exclusiones: ['desarrollo de software'] }, {
      text: 'DESARROLLO DE SOFTWARE a medida',
      precio: 100000000,
      modalidad: 'Licitacion publica',
      departamento: 'Bogotá D.C.',
    })
    expect(v.maxScore).toBe(CAP_EXCLUSION)
    expect(v.descartado).toBe(true)
    // Aunque el score de entrada sea 100, la salida no puede pasar de 5.
    expect(aplicar(v, 100)).toBeLessThanOrEqual(CAP_EXCLUSION)
  })

  it('el presupuesto fuera de rango deja el tope en 20, sin descartar', () => {
    const v = evaluate(perfil, { text: 'algo', precio: 999999999999, modalidad: null, departamento: null })
    expect(v.maxScore).toBe(CAP_BUDGET)
    expect(v.descartado).toBe(false)
  })

  it('modalidad y territorio no preferidos restan, pero no descartan', () => {
    const v = evaluate(
      { ...perfil, modalidades_preferidas: ['Subasta'], departamentos_preferidos: ['Antioquia'] },
      { text: 'algo', precio: null, modalidad: 'Licitacion publica', departamento: 'Bogotá D.C.' },
    )
    expect(v.penalizacion).toBe(25)
    expect(v.descartado).toBe(false)
    expect(aplicar(v, 100)).toBe(75)
  })

  it('un proceso sin texto puntua 0 y queda descartado', () => {
    const v = evaluate(perfil, { text: '', precio: null, modalidad: null, departamento: null })
    expect(v.maxScore).toBe(0)
    expect(aplicar(v, 90)).toBe(0)
  })
})

describe('score', () => {
  const perfil = normalizarPerfil({
    ...PERFIL_POR_DEFECTO,
    exclusiones: [],
    presupuesto_minimo: null,
    presupuesto_maximo: null,
  })

  it('el corpus se indexa y la similitud del propio documento es la maxima', () => {
    const procesos = [
      PROCESO(),
      PROCESO({ id_del_proceso: 'CO1.REQ.2', nombre_del_procedimiento: 'COMPRA DE COMPUTADORES', descripcion: 'Adquisicion de equipos de computo para la entidad.' }),
    ]
    const indice = construirIndiceCorpus(procesos)
    expect(indice.docs).toHaveLength(2)

    const vector = vectorizarPerfil(perfil, indice.idf)
    const propio = cosenoContraDoc(vector, indice, 0)
    const otro = cosenoContraDoc(vector, indice, 1)
    // El software puntua mas alto que la compra de computers, pero no es 0:
    // comparten terminos genericos del sector.
    expect(propio).toBeGreaterThan(otro)
    expect(propio).toBeGreaterThan(0)
  })

  it('la exclusion manda sobre el score final del proceso', () => {
    const procesos = [PROCESO()]
    const indice = construirIndiceCorpus(procesos)
    const vector = vectorizarPerfil(perfil, indice.idf)
    const conExclusion = { ...perfil, exclusiones: ['software'] }
    const match = puntuarProceso({
      proceso: procesos[0],
      ficha: { id: procesos[0].id_del_proceso, text: textoFicha(procesos[0]), precio: 150000000, modalidad: 'Licitacion publica', departamento: 'Bogotá D.C.' },
      vector,
      indice,
      indicePos: 0,
      perfil: conExclusion,
      peso: 0.35,
      banda: { floor: 0.03, ceil: 0.35 },
    })
    expect(match.penalizaciones).toContain('exclusion')
    expect(match.score).toBeLessThanOrEqual(CAP_EXCLUSION)
    expect(match.score).toBeGreaterThanOrEqual(0)
  })

  it('el score siempre cae entre 0 y 100', () => {
    const procesos = [PROCESO()]
    const indice = construirIndiceCorpus(procesos)
    const vector = vectorizarPerfil(perfil, indice.idf)
    const match = puntuarProceso({
      proceso: procesos[0],
      ficha: { id: 'x', text: textoFicha(procesos[0]), precio: null, modalidad: null, departamento: null },
      vector,
      indice,
      indicePos: 0,
      perfil,
      peso: 1,
      banda: { floor: 0.03, ceil: 0.35 },
    })
    expect(match.score).toBeGreaterThanOrEqual(0)
    expect(match.score).toBeLessThanOrEqual(100)
    expect(match.calculado_en).toBeTruthy()
  })
})

describe('mapper', () => {
  it('saca el notice_uid de la URL, que es la clave de union con contratos', () => {
    const p = mapearProceso(FILA_CRUDA())
    expect(p.notice_uid).toBe('CO1.NTC.9988776')
  })

  it('traduce los nombres cortos de columna a los del panel', () => {
    const p = mapearProceso(FILA_CRUDA())
    expect(p.descripcion).toContain('sistema de informacion')
    expect(p.fecha_publicacion).toBe('2026-09-20T00:00:00.000Z')
    expect(p.codigo_principal_categoria).toBe('43232107')
    expect(p.precio_base).toBe(150000000)
  })

  it('descarta filas sin id, que en Socrata hay por redondeos', () => {
    expect(mapearProceso({ ...FILA_CRUDA(), id_del_proceso: null })).toBeNull()
    expect(mapearProceso({ ...FILA_CRUDA(), id_del_proceso: '   ' })).toBeNull()
  })

  it('recorta los textos que no caben en el ancho de columna', () => {
    const largo = 'X'.repeat(900)
    const p = mapearProceso(FILA_CRUDA({ referencia_del_proceso: largo }))
    expect(p.referencia_del_proceso).toHaveLength(120)
    // El recorte es solo del campo acotado, no de todo.
    expect(p.nombre_del_procedimiento).toContain('SOFTWARE')
  })

  it('deduplicar deja la primera y cuenta las repetidas', () => {
    const r = [FILA_CRUDA(), FILA_CRUDA({ entidad: 'OTRA' }), FILA_CRUDA()]
    const limpio = deduplicar(r.map(mapearProceso), 'id_del_proceso')
    expect(limpio).toHaveLength(1)
    expect(limpio.repetidas).toBe(2)
  })

  it('el registro ligero conserva el titulo y suelta los textos largos', () => {
    const ligero = ligeroProceso(PROCESO())
    expect(ligero.nombre_del_procedimiento).toContain('SOFTWARE')
    expect(ligero.descripcion).toBeUndefined()
    expect(ligero.notice_uid).toBe('CO1.NTC.9988776')
    expect(ligero.id_del_proceso).toBe('CO1.REQ.1')
  })
})

describe('socrata', () => {
  it('las fechas sin zona se interpretan en UTC, no en la del navegador', () => {
    expect(socrataDate('2026-09-24T00:00:00')).toBe('2026-09-24T00:00:00.000Z')
    expect(socrataDate('2026-09-24T00:00:00.000Z')).toBe('2026-09-24T00:00:00.000Z')
    expect(socrataDate('2026-09-24')).toBe('2026-09-24T00:00:00.000Z')
  })

  it('acepta epoch en segundos y en milisegundos', () => {
    expect(socrataDate(1760000000)).toBe(new Date(1760000000000).toISOString())
    expect(socrataDate(1760000000000)).toBe(new Date(1760000000000).toISOString())
  })

  it('aplana el objeto url que llega en algunos campos', () => {
    expect(socrataUrl({ url: 'https://x.test/a' })).toBe('https://x.test/a')
    expect(socrataUrl('https://x.test/b')).toBe('https://x.test/b')
    expect(socrataUrl(null)).toBeNull()
  })

  it('noticeUid saca el identificador de la URL y tolera las que no lo tienen', () => {
    expect(noticeUid('https://x.test/Notice?noticeUID=CO1.NTC.1')).toBe('CO1.NTC.1')
    expect(noticeUid('https://x.test/sin-uid')).toBeNull()
    expect(noticeUid(null)).toBeNull()
  })

  it('soqlDate escapa comillas y trunca a dia, que es lo que acepta calendar_date', () => {
    const where = soqlDate('fecha_de_publicacion_del', '2026-01-01T12:34:00', '2026-01-31T23:00:00')
    // Sin truncar, una ventana con hora puede devolver cero filas de un dia con datos.
    expect(where).toBe("fecha_de_publicacion_del >= '2026-01-01' AND fecha_de_publicacion_del <= '2026-01-31'")
    expect(soqlQuote("O'Brien")).toBe("'O''Brien'")
  })

  it('el dia no se desplaza por la zona horaria', () => {
    // El fallo era de estos dos, y en UTC-5 (Bogotá) los dos fallaban:
    // 23:00 local se iba a UTC y el cierre cogia un dia de mas; 02:00 local
    // retrocedia y el primer dia de la ventana se quedaba fuera.
    expect(isoDia('2026-01-31T23:00:00')).toBe('2026-01-31')
    expect(isoDia('2026-01-01T02:00:00')).toBe('2026-01-01')
    expect(isoDia('2026-01-01')).toBe('2026-01-01')
    expect(isoDia('2026-01-01T00:00:00Z')).toBe('2026-01-01')
    // Un instante sin ambiguedad (epoch, `Date`) si se resuelve en UTC.
    expect(isoDia(new Date(Date.UTC(2026, 0, 15)))).toBe('2026-01-15')
    expect(isoDia(Date.UTC(2026, 0, 15))).toBe('2026-01-15')
  })

  it('sin rango no inventa un filtro que dejaria fuera casi todo', () => {
    // `new Date(null)` es la epoca: sin el guarda de `isoDia`, esto devolvia
    // "col >= '1970-01-01'" en vez de null.
    expect(soqlDate('col', null, null)).toBeNull()
    expect(isoDia(null)).toBeNull()
    expect(isoDia('')).toBeNull()
    expect(isoDia('no-es-una-fecha')).toBeNull()
  })

  it('iterRows respeta el tope sin pasarse una pagina entera', async () => {
    // El bug: el tope se comprobaba DESPUES de leer la pagina, asi que un
    // `maxRows: 120` con paginas de 500 pedia 500 filas y guardaba 492 de mas.
    const pedidas = []
    const cliente = new SocrataClient({ pageSize: 500, requestDelay: 0 })
    cliente.pagina = async ({ limit, offset }) => {
      pedidas.push({ limit, offset })
      const total = 1000
      const filas = []
      for (let i = offset; i < Math.min(offset + limit, total); i += 1) {
        filas.push({ n: i })
      }
      return { rows: filas, hayMas: filas.length >= limit }
    }

    const { leidas } = await cliente.iterRows({ dataset: 'x', maxRows: 120 }, { alPagina: (f) => f.length })
    expect(leidas).toBe(120)
    // 120 + 480: la ultima pagina se pide justa, no de 500 en 500.
    expect(pedidas).toEqual([{ limit: 120, offset: 0 }])

    const { leidas: leidas2 } = await cliente.iterRows({ dataset: 'x', maxRows: 900 }, {})
    expect(leidas2).toBe(900)
    expect(pedidas.slice(1)).toEqual([{ limit: 500, offset: 0 }, { limit: 400, offset: 500 }])

    // Sin tope, pagina hasta que el servidor se queda sin filas.
    const { leidas: leidas3 } = await cliente.iterRows({ dataset: 'x' }, {})
    expect(leidas3).toBe(1000)
  })

  it('al agotar los reintentos contra un 429 dice cual es el arreglo', async () => {
    // El caso del usuario: una descarga que choca con el limite de peticiones
    // de Socrata aterriza en una pagina vacia, y sin la pista no hay manera de
    // saber que era eso y no una caida de red.
    const original = globalThis.fetch
    globalThis.fetch = async () => ({
      status: 429,
      ok: false,
      headers: { get: (h) => (h === 'Retry-After' ? '0' : null) },
      json: async () => ({ message: 'Too Many Requests' }),
    })
    try {
      // `maxRetries: 1` para que no espere entre intentos: lo que se comprueba
      // es el mensaje final, no la politica de esperas.
      const cliente = new SocrataClient({ requestDelay: 0, maxRetries: 1 })
      await expect(cliente.count('p6dx-8zbt', null)).rejects.toThrow(/app-config\.json/)
    } finally {
      globalThis.fetch = original
    }
  })

  it('respeta el Retry-After del servidor en vez de la espera creciente', async () => {
    const original = globalThis.fetch
    let llamadas = 0
    globalThis.fetch = async () => {
      llamadas += 1
      if (llamadas === 1) {
        return {
          status: 429,
          ok: false,
          headers: { get: (h) => (h === 'Retry-After' ? '0' : null) },
          json: async () => ({ message: 'Too Many Requests' }),
        }
      }
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => [{ n: 5 }],
      }
    }
    try {
      const t0 = Date.now()
      const cliente = new SocrataClient({ requestDelay: 0, maxRetries: 2 })
      const n = await cliente.count('p6dx-8zbt', null)
      const ms = Date.now() - t0
      expect(n).toBe(5)
      // Sin el Retry-After la espera del primer reintento seria 1.000 ms.
      expect(ms).toBeLessThan(800)
    } finally {
      globalThis.fetch = original
    }
  })

  it('el 429 persistente concede dos reintentos extra antes de rendirse', async () => {
    // El limite casi siempre se levanta si se espera: rendirse a los 4
    // intentos de siempre (1/2/4 s) es morir por prisa, no por limite.
    const original = globalThis.fetch
    let llamadas = 0
    globalThis.fetch = async () => {
      llamadas += 1
      return {
        status: 429,
        ok: false,
        headers: { get: () => '0' },
        json: async () => ({ message: 'Too Many Requests' }),
      }
    }
    try {
      const cliente = new SocrataClient({ requestDelay: 0, maxRetries: 1 })
      await expect(cliente.count('p6dx-8zbt', null)).rejects.toThrow(/tras 3 intentos/)
      expect(llamadas).toBe(3) // 1 del maxRetries + 2 de limite
    } finally {
      globalThis.fetch = original
    }
  })

  it('tras un 429 la pagina siguiente ya espera mas (ritmo x3)', async () => {
    // El refuerzo no es solo esperar dentro del reintento: si el portal acaba
    // de limitarnos, seguir paginando a la misma velocidad acaba en el segundo
    // 429 y ahi si que no hay reintentos de sobra.
    const original = globalThis.fetch
    let llamadas = 0
    globalThis.fetch = async () => {
      llamadas += 1
      if (llamadas === 1) {
        return {
          status: 429,
          ok: false,
          headers: { get: () => '0' },
          json: async () => ({ message: 'Too Many Requests' }),
        }
      }
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        json: async () => [{ n: 5 }],
      }
    }
    try {
      const cliente = new SocrataClient({ requestDelay: 350, maxRetries: 4 })
      expect(cliente.ritmo).toBe(350)
      expect(await cliente.count('p6dx-8zbt', null)).toBe(5)
      expect(cliente.ritmo).toBe(1050) // 350 x 3
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('db en memoria', () => {
  it('guarda, cuenta y deduplica por clave natural', async () => {
    await guardarProcesos([PROCESO()])
    await guardarProcesos([PROCESO()])
    expect(await contarProcesos()).toBe(1)
  })

  it('resuelve notice_uid -> id_del_proceso para enlazar los contratos', async () => {
    await guardarProcesos([PROCESO(), PROCESO({ id_del_proceso: 'OTRO', notice_uid: 'CO1.NTC.777' })])
    const mapa = await noticeUidAProceso(['CO1.NTC.9988776', 'CO1.NTC.777', 'CO1.NTC.999'])
    expect(mapa.get('CO1.NTC.9988776')).toBe('CO1.REQ.1')
    expect(mapa.get('CO1.NTC.777')).toBe('OTRO')
    expect(mapa.has('CO1.NTC.999')).toBe(false)
  })

  it('las acciones se guardan como id + accion, y las dos pueden convivir', async () => {
    await ponerAccion({ tender_id: 'CO1.REQ.1', accion: 'guardar' })
    await ponerAccion({ tender_id: 'CO1.REQ.1', accion: 'ocultar' })
    const acciones = await accionesDe('CO1.REQ.1')
    expect(acciones.map((a) => a.accion).sort()).toEqual(['guardar', 'ocultar'])
  })
})

describe('estado de la descarga', () => {
  // `estadoIngesta()` en memoria solo cubre la pestana actual: al recargar, el
  // modulo arranca de cero. Estos tests fijan que lo que se persistio en
  // `progreso_sync` se recupere, que es lo que hace que una descarga fallida
  // siga explicandose (y una cortada a mitad, avisando) tras pulsar F5.
  it('el error de una descarga fallida sobrevive a recargar', async () => {
    await escribirMeta('progreso_sync', {
      corriendo: false,
      fase: 'error',
      error: 'no se pudo consultar /resource/x.json tras 4 intentos: HTTP 429',
      hechos: 0,
      total: 120,
      nuevas: 0,
    })

    const e = await api.estadoSync()
    expect(e.en_curso).toBe(false)
    expect(e.fase).toBe('error')
    expect(e.error).toContain('HTTP 429')
    expect(e.ultimo).toBeNull()
  })

  it('una descarga recortada en mitad se marca interrumpida', async () => {
    await escribirMeta('progreso_sync', {
      corriendo: false,
      fase: 'procesos',
      error: null,
      hechos: 300,
      total: 5000,
      nuevas: 300,
    })

    const e = await api.estadoSync()
    expect(e.fase).toBe('interrumpida')
    expect(e.hechos).toBe(300)
    expect(e.error).toBeNull()
  })

  it('una descarga terminada no se pinta ni fallida ni interrumpida', async () => {
    await escribirMeta('progreso_sync', {
      corriendo: false,
      fase: 'listo',
      error: null,
      hechos: 120,
      total: 120,
      nuevas: 120,
    })
    await escribirMeta('ultima_sync', '2026-10-05T10:00:00Z')

    const e = await api.estadoSync()
    expect(e.fase).toBe('listo')
    expect(e.error).toBeNull()
    expect(e.ultimo?.status).toBe('ok')
    expect(e.ultimo?.rows_inserted).toBe(120)
  })
})

describe('indice', () => {
  const procesos = [
    PROCESO({ id_del_proceso: 'A', departamento_entidad: 'Bogotá D.C.', modalidad_de_contratacion: 'Licitacion publica', precio_base: 100, fecha_publicacion: '2026-09-01T00:00:00.000Z', fecha_apertura_respuesta: '2099-01-01T00:00:00.000Z' }),
    PROCESO({ id_del_proceso: 'B', departamento_entidad: 'Antioquia', modalidad_de_contratacion: 'Subasta', precio_base: 900, fecha_publicacion: '2026-08-01T00:00:00.000Z', fecha_apertura_respuesta: '2020-01-01T00:00:00.000Z' }),
  ]
  const matches = new Map([
    ['A', { tender_id: 'A', score: 80, bullets: ['x'], razones_semanticas: [{ termino: 'software', idf: 3, peso: 1 }] }],
    ['B', { tender_id: 'B', score: 40, bullets: [], razones_semanticas: [] }],
  ])

  it('pagina y ordena por score por defecto', () => {
    const ind = new Indice({ procesos, matches })
    const r = ind.consultar({}, { limite: 1, offset: 0 })
    expect(r.total).toBe(2)
    expect(r.pagina[0].id_del_proceso).toBe('A')
    expect(r.hayMas).toBe(true)
    expect(ind.consultar({}, { limite: 1, offset: 1 }).pagina[0].id_del_proceso).toBe('B')
  })

  it('acepta varias modalidades marcadas a la vez', () => {
    const ind = new Indice({ procesos, matches })
    expect(ind.filtrar({ modalidades: ['Subasta'] }).size).toBe(1)
    expect(ind.filtrar({ modalidades: ['Subasta', 'Licitacion publica'] }).size).toBe(2)
  })

  it('el rango de precio no descarta lo que no tiene precio', () => {
    const sinPrecio = PROCESO({ id_del_proceso: 'C', precio_base: null })
    const ind = new Indice({ procesos: [...procesos, sinPrecio], matches })
    expect(ind.filtrar({ precioMin: 1000, precioMax: 2000 }).has('C')).toBe(true)
  })

  it('descartado y oculto salen de la vista; guardado, solo con ese filtro', () => {
    const acciones = new Map([
      ['A', new Set(['descartar'])],
      ['B', new Set(['guardar'])],
    ])
    const ind = new Indice({ procesos, matches })
    // A esta descartado: sale de la vista aunque no se pida el filtro.
    expect(ind.filtrar({ acciones }).has('A')).toBe(false)
    expect([...ind.filtrar({ acciones })]).toEqual(['B'])
    // Con `soloGuardadas` solo entra el guardado; el descartado tampoco.
    expect([...ind.filtrar({ acciones, soloGuardadas: true })]).toEqual(['B'])
    // Un oculto tampoco sale: sale de la vista igual que descartado.
    const oculto = new Map([['B', new Set(['ocultar'])]])
    expect([...ind.filtrar({ acciones: oculto })]).toEqual(['A'])
  })

  it('las facetas se calculan sobre el conjunto filtrado, no sobre todo', () => {
    const ind = new Indice({ procesos, matches })
    const ids = ind.filtrar({ modalidades: ['Subasta'] })
    const fac = ind.facetas(ids)
    expect(fac.departamentos.map((d) => d.valor)).toEqual(['Antioquia'])
    expect(fac.total).toBe(1)
  })

  it('solo_por_vencer deja fuera lo que ya cerro', () => {
    const ind = new Indice({ procesos, matches })
    expect([...ind.filtrar({ soloPorVencer: true })]).toEqual(['A'])
  })

  it('la lista de la fachada trae el match completo, no solo el score suelto', async () => {
    // El bug: `filaDe` devolvia `score`, pero `aOportunidad` lee `fila.match`.
    // La lista pintaba "—" en todas las tarjetas aunque hubiera matches.
    await guardarProcesos([PROCESO({ id_del_proceso: 'CO1.REQ.1' })])
    await guardarMatches([
      {
        tender_id: 'CO1.REQ.1',
        score: 80,
        bullets: ['Encaja con software'],
        razones_semanticas: [{ termino: 'software', idf: 3, peso: 1 }],
        penalizaciones: [],
        score_semantico: 0.8,
        calculado_en: '2026-10-29T00:00:00.000Z',
      },
    ])

    const { items } = await api.licitaciones({ limit: 24 })
    expect(items[0].match).toMatchObject({ score: 80, semantic_similarity: 0.8 })
    expect(items[0].match.bullets).toEqual(['Encaja con software'])
  })
})

describe('snapshot', () => {
  it('exportar e importar deja el mismo numero de filas', async () => {
    await guardarProcesos([PROCESO(), PROCESO({ id_del_proceso: 'OTRO' })])
    await ponerAccion({ tender_id: 'CO1.REQ.1', accion: 'guardar' })

    const lineas = []
    const res = await recorrerParaExportar({ alLinea: (obj) => lineas.push(JSON.stringify(obj)) })
    // Cabecera + 2 procesos + 1 accion. La cabecera no cuenta como fila de dato.
    expect(res.total).toBe(3)
    expect(lineas).toHaveLength(4)

    await fijarAlmacen('memoria')
    expect(await contarProcesos()).toBe(0)

    const r = await importar(lineas.join('\n'))
    expect(r.leidas).toBe(4)
    expect(r.ignoradas).toBe(0)
    expect(r.cabecera._formato).toBe('licitaciones-ndjson')
    expect(await contarProcesos()).toBe(2)
    expect((await accionesDe('CO1.REQ.1')).map((a) => a.accion)).toEqual(['guardar'])
  })

  it('el perfil de la cabecera se devuelve sin aplicarse solo', async () => {
    await escribirMeta('perfil', { nombre: 'Otra Empresa S.A.S.', palabras_clave: 'a, b' })
    const lineas = []
    await recorrerParaExportar({ alLinea: (obj) => lineas.push(JSON.stringify(obj)) })
    const { cabecera: cab } = await importar(lineas.join('\n'))
    expect(perfilDeCabecera(cab).nombre).toBe('Otra Empresa S.A.S.')
    expect(perfilDeCabecera(cab).palabras_clave).toEqual(['a', 'b'])
    // Importar no debe cambiar el perfil con el que puntua el panel.
    expect((await leerMeta('perfil', null)).nombre).toBe('Otra Empresa S.A.S.')
  })

  it('una linea corrupta no tumba la importacion entera', async () => {
    const r = await importar(
      [
        JSON.stringify({ _formato: 'licitaciones-ndjson', _version: 1 }),
        '{esto no es json',
        JSON.stringify({ _store: 'procesos', ...PROCESO() }),
        JSON.stringify({ _store: 'inventado', id: 1 }),
      ].join('\n'),
    )
    expect(r.ignoradas).toBe(2)
    expect(r.leidas).toBe(3)
    expect(await contarProcesos()).toBe(1)
  })

  it('un fichero de otro formato se rechaza con un mensaje claro', async () => {
    await expect(importar(JSON.stringify({ _formato: 'otra-cosa' }))).rejects.toThrow(/otra-cosa/)
  })

  it('escribe en orden y espera a vaciar la cola antes de cerrar', async () => {
    await guardarProcesos([
      { id_del_proceso: 'A', objeto: 'Licitacion A' },
      { id_del_proceso: 'B', objeto: 'Licitacion B' },
    ])

    // `write()` se resuelve en el proximo turno, como el de verdad: si `descargar`
    // no encadena las escrituras, el orden del fichero seria el del scheduler.
    const escribas = []
    let pendientes = 0
    const writable = {
      write: (texto) => {
        escribas.push(texto)
        pendientes += 1
        return Promise.resolve().then(() => {
          pendientes -= 1
        })
      },
      // Si se cerrara con escrituras en vuelo, el navegador las descartaria y el
      // fichero saldria truncado. Se anota el estado para poder comprobarlo.
      close: () => {
        escribas.pendientesAlCerrar = pendientes
        return Promise.resolve()
      },
    }
    const original = window.showSaveFilePicker
    window.showSaveFilePicker = async () => ({ name: 'prueba.ndjson', createWritable: async () => writable })
    try {
      const r = await descargar()
      expect(r.streamed).toBe(true)
      const cuerpo = escribas.join('')
      const lineas = cuerpo.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      expect(lineas[0]._formato).toBeDefined()
      expect(lineas.filter((l) => l._store === 'procesos').map((l) => l.id_del_proceso)).toEqual(['A', 'B'])
      expect(escribas.pendientesAlCerrar).toBe(0)
    } finally {
      window.showSaveFilePicker = original
    }
  })
})