/**
 * Exportar la lista filtrada a CSV, Excel (.xlsx) o PDF.
 *
 * No es el respaldo (`snapshot.ts`, NDJSON para volver a importar): esto es lo
 * que se manda a un comercial o se adjunta a un comite. Por eso exporta la vista
 * —las oportunidades que pasan los filtros, en el mismo orden— con las columnas
 * legibles y no las stores.
 *
 *   - CSV con `;` y BOM: es lo que Excel en es-CO abre bien con doble clic (la
 *     coma es el separador decimal y Excel la toma por decimal, no por columna).
 *   - XLSX escrito a mano con `fflate`: un libro de verdad, sin la advertencia de
 *     formato que da un .xls de SpreadsheetML, y sin cargar una libreria de
 *     hojas de calculo de cientos de KB.
 *   - PDF con `jspdf` + `jspdf-autotable`, cargados al pulsar (import dinamico):
 *     pesan ~400 KB y no tienen por que viajar en la carga de la pagina.
 */

import { strToU8, zipSync } from 'fflate'
import { formatDate, scoreLabel } from './format'
import type { Oportunidad } from './tipos'

export type FormatoExportacion = 'csv' | 'xlsx' | 'pdf'

type Celda = string | number | null

interface Columna {
  titulo: string
  valor: (o: Oportunidad) => Celda
  /** Ancho en caracteres en Excel y peso relativo en el PDF. */
  ancho: number
  enPdf?: boolean
}

const COLUMNAS: Columna[] = [
  { titulo: 'Score', valor: (o) => o.match?.score ?? null, ancho: 7, enPdf: true },
  { titulo: 'Nivel', valor: (o) => (o.match ? scoreLabel(o.match.score) : 'Sin puntuar'), ancho: 10, enPdf: true },
  { titulo: 'Título', valor: (o) => o.titulo, ancho: 60, enPdf: true },
  { titulo: 'Entidad', valor: (o) => o.entidad, ancho: 40, enPdf: true },
  { titulo: 'Departamento', valor: (o) => o.departamento, ancho: 18, enPdf: true },
  { titulo: 'Municipio', valor: (o) => o.ciudad, ancho: 18 },
  { titulo: 'Modalidad', valor: (o) => o.modalidad, ancho: 24, enPdf: true },
  { titulo: 'Estado', valor: (o) => o.estado, ancho: 14 },
  { titulo: 'Presupuesto (COP)', valor: (o) => o.precio_base, ancho: 18, enPdf: true },
  { titulo: 'Publicada', valor: (o) => fecha(o.fecha_publicacion), ancho: 12 },
  { titulo: 'Cierre', valor: (o) => fecha(o.fecha_apertura_respuesta), ancho: 12, enPdf: true },
  { titulo: 'Fuente', valor: (o) => o.fuente, ancho: 9 },
  { titulo: 'UNSPSC', valor: (o) => o.categoria, ancho: 14 },
  { titulo: 'Referencia', valor: (o) => o.referencia_del_proceso, ancho: 22 },
  { titulo: 'ID', valor: (o) => o.id_del_proceso, ancho: 20 },
  { titulo: 'Enlace SECOP', valor: (o) => o.url_proceso, ancho: 50 },
]

/** Fecha corta ISO (`2026-11-03`): ordena bien y Excel la reconoce. */
function fecha(valor: string | null): string | null {
  return valor ? valor.slice(0, 10) : null
}

function nombreFichero(extension: string): string {
  const ahora = new Date()
  const dia = ahora.toISOString().slice(0, 10)
  return `licitaciones-${dia}.${extension}`
}

/** Dispara la descarga de un Blob con un enlace temporal. */
export function descargarBlob(blob: Blob, nombre: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = nombre
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

// --- CSV ----------------------------------------------------------------------

function celdaCsv(valor: Celda): string {
  if (valor === null || valor === undefined) return ''
  const texto = String(valor)
  return /[;"\n\r]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto
}

export function aCsv(filas: Oportunidad[]): string {
  const lineas = [COLUMNAS.map((c) => celdaCsv(c.titulo)).join(';')]
  for (const o of filas) lineas.push(COLUMNAS.map((c) => celdaCsv(c.valor(o))).join(';'))
  // BOM: sin el, Excel abre el UTF-8 como Windows-1252 y las tildes salen rotas.
  return `\uFEFF${lineas.join('\r\n')}\r\n`
}

// --- XLSX ---------------------------------------------------------------------

const xml = (texto: string): string =>
  texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Los caracteres de control no son XML valido y Excel rechaza el libro entero.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

function letraColumna(i: number): string {
  let n = i + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

function celdaXlsx(valor: Celda, ref: string, estilo = 0): string {
  const s = estilo ? ` s="${estilo}"` : ''
  if (valor === null || valor === undefined || valor === '') return ''
  if (typeof valor === 'number' && Number.isFinite(valor)) return `<c r="${ref}"${s}><v>${valor}</v></c>`
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xml(String(valor))}</t></is></c>`
}

/** Un .xlsx minimo y valido: una hoja, cabecera en negrita y fija, autofiltro. */
export function aXlsx(filas: Oportunidad[]): Uint8Array {
  const ultima = letraColumna(COLUMNAS.length - 1)
  const filasXml: string[] = []
  filasXml.push(
    `<row r="1">${COLUMNAS.map((c, i) => celdaXlsx(c.titulo, `${letraColumna(i)}1`, 1)).join('')}</row>`,
  )
  filas.forEach((o, n) => {
    const r = n + 2
    // El presupuesto con formato de miles (estilo 2).
    const celdas = COLUMNAS.map((c, i) =>
      celdaXlsx(c.valor(o), `${letraColumna(i)}${r}`, c.titulo.startsWith('Presupuesto') ? 2 : 0),
    )
    filasXml.push(`<row r="${r}">${celdas.join('')}</row>`)
  })

  const hoja = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${COLUMNAS.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.ancho}" customWidth="1"/>`).join('')}</cols>
<sheetData>${filasXml.join('')}</sheetData>
<autoFilter ref="A1:${ultima}${Math.max(1, filas.length + 1)}"/>
</worksheet>`

  const estilos = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
</styleSheet>`

  const archivos: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Licitaciones" sheetId="1" r:id="rId1"/></sheets>
<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Licitaciones!$A$1:$${ultima}$${Math.max(1, filas.length + 1)}</definedName></definedNames>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(hoja),
    'xl/styles.xml': strToU8(estilos),
  }
  return zipSync(archivos, { level: 6 })
}

// --- PDF ----------------------------------------------------------------------

/** El PDF lleva las columnas que caben en un A4 apaisado. */
async function aPdf(filas: Oportunidad[], titulo: string): Promise<Blob> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
  const columnas = COLUMNAS.filter((c) => c.enPdf)
  doc.setFontSize(14)
  doc.text(titulo, 40, 40)
  doc.setFontSize(9)
  doc.text(`${filas.length} oportunidades · generado el ${formatDate(new Date())}`, 40, 56)
  autoTable(doc, {
    startY: 70,
    head: [columnas.map((c) => c.titulo)],
    body: filas.map((o) =>
      columnas.map((c) => {
        const v = c.valor(o)
        if (c.titulo.startsWith('Presupuesto') && typeof v === 'number') return v.toLocaleString('es-CO')
        return v === null ? '' : String(v)
      }),
    ),
    styles: { fontSize: 7, cellPadding: 3, overflow: 'linebreak' },
    headStyles: { fillColor: [31, 41, 55] },
    columnStyles: Object.fromEntries(columnas.map((c, i) => [i, { cellWidth: 'auto' as const, minCellWidth: c.ancho * 2.5 }])),
    margin: { left: 40, right: 40 },
  })
  return doc.output('blob')
}

/** Exporta y descarga. Devuelve el nombre del fichero. */
export async function exportarOportunidades(
  filas: Oportunidad[],
  formato: FormatoExportacion,
  titulo = 'Licitaciones filtradas',
): Promise<string> {
  if (formato === 'csv') {
    const nombre = nombreFichero('csv')
    descargarBlob(new Blob([aCsv(filas)], { type: 'text/csv;charset=utf-8' }), nombre)
    return nombre
  }
  if (formato === 'xlsx') {
    const nombre = nombreFichero('xlsx')
    // `slice()` deja un ArrayBuffer del tamano justo: el de `zipSync` puede
    // venir de un buffer mas grande y el Blob arrastraria bytes de sobra.
    const bytes = aXlsx(filas).slice()
    descargarBlob(
      new Blob([bytes.buffer as ArrayBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      nombre,
    )
    return nombre
  }
  const nombre = nombreFichero('pdf')
  descargarBlob(await aPdf(filas, titulo), nombre)
  return nombre
}
