/*!
 * Pascal VOC, YOLO and CreateML label files, read and written as LabelImg 1.8.6 reads and
 * writes them (libs/pascal_voc_io.py, yolo_io.py, create_ml_io.py and labelFile.py), so a
 * folder labelled in LabelImg opens here and LabelImg opens what this app writes.
 * Ported from LabelImg (https://github.com/HumanSignal/labelImg) under its MIT licence:
 *
 * Copyright (c) <2015-Present> Tzutalin
 *
 * Copyright (C) 2013  MIT, Computer Science and Artificial Intelligence Laboratory. Bryan Russell, Antonio Torralba, William T. Freeman
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { LabelFileError, newShape, type Shape } from './labelfile'

export const LABEL_FORMATS = ['labelme', 'voc', 'yolo', 'createml'] as const
export type LabelFormat = (typeof LABEL_FORMATS)[number]
export const FORMAT_NAMES: Record<LabelFormat, string> = { labelme: 'LabelMe JSON', voc: 'Pascal VOC', yolo: 'YOLO', createml: 'CreateML' }
export const FORMAT_EXT: Record<LabelFormat, string> = { labelme: '.json', voc: '.xml', yolo: '.txt', createml: '.json' }
// LabelImg's own order for its format button
export const NEXT_FORMAT: Record<LabelFormat, LabelFormat> = { labelme: 'voc', voc: 'yolo', yolo: 'createml', createml: 'labelme' }
/** YOLO's class names, one per line, in the folder of the .txt files */
export const YOLO_CLASSES = 'classes.txt'

/** LabelImg's formats hold boxes and their labels, nothing else */
export const holdsBoxesOnly = (f: LabelFormat) => f !== 'labelme'
/** Where an image's verified mark can be kept: YOLO has no place for it */
export const keepsVerified = (f: LabelFormat) => f !== 'yolo'
/** Only Pascal VOC keeps the difficult flag; LabelImg drops it from YOLO and CreateML */
export const keepsDifficult = (f: LabelFormat) => f === 'labelme' || f === 'voc'

function fail(message: string): never {
  throw new LabelFileError(message)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The box around a shape, [x0, y0, x1, y1] */
export function boxOf(s: Shape): [number, number, number, number] {
  if (s.shape_type === 'circle' && s.points.length >= 2) {
    const [[cx, cy], [px, py]] = s.points
    const r = Math.hypot(px - cx, py - cy)
    return [cx - r, cy - r, cx + r, cy + r]
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of s.points) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
  }
  return [x0, y0, x1, y1]
}

/** The shape as the box these formats keep: rectangles stay as they are */
export function asBox(s: Shape): Shape {
  if (s.shape_type === 'rectangle') return s
  const [x0, y0, x1, y1] = boxOf(s)
  return { ...s, shape_type: 'rectangle', points: [[x0, y0], [x1, y1]], mask: null }
}

/** LabelImg's convert_points_to_bnd_box: whole pixels, and never 0 at the left or top, which broke Faster R-CNN training */
export function bndBox(s: Shape): [number, number, number, number] {
  const [x0, y0, x1, y1] = boxOf(s)
  return [Math.trunc(Math.max(x0, 1)), Math.trunc(Math.max(y0, 1)), Math.trunc(x1), Math.trunc(y1)]
}

const isDifficult = (s: Shape) => s.flags.difficult === true
const box = (label: string, x0: number, y0: number, x1: number, y1: number, difficult = false) =>
  newShape(label, 'rectangle', [[x0, y0], [x1, y1]], difficult ? { flags: { difficult: true } } : {})

// XML, as much as label files use: elements, attributes, text, entities, CDATA and comments

export type XmlElement = { name: string; attrs: Record<string, string>; children: XmlElement[]; text: string }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescape = (s: string) => s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] !== '#') return ENTITIES[e] ?? m
  const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
  return code <= 0x10ffff ? String.fromCodePoint(code) : m
})

export function parseXml(text: string): XmlElement {
  const stack: XmlElement[] = []
  let root: XmlElement | null = null
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const skipTo = (end: string, from: number, what: string) => {
    const at = text.indexOf(end, from)
    if (at < 0) fail(`It isn't valid XML: ${what} never ends`)
    return at + end.length
  }
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    const chunk = text.slice(i, lt < 0 ? text.length : lt)
    if (stack.length) stack[stack.length - 1].text += unescape(chunk)
    else if (chunk.trim()) fail("It isn't valid XML: there's text outside the top element")
    if (lt < 0) break
    if (text.startsWith('<!--', lt)) { i = skipTo('-->', lt + 4, 'a comment'); continue }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = skipTo(']]>', lt + 9, 'a CDATA section')
      if (stack.length) stack[stack.length - 1].text += text.slice(lt + 9, end - 3)
      i = end
      continue
    }
    if (text.startsWith('<?', lt)) { i = skipTo('?>', lt + 2, 'a declaration'); continue }
    if (text.startsWith('<!', lt)) {
      // A DOCTYPE, with any internal subset in brackets
      let j = lt + 2, depth = 0
      for (; j < text.length; j++) {
        if (text[j] === '[') depth++
        else if (text[j] === ']') depth--
        else if (text[j] === '>' && depth <= 0) break
      }
      i = j + 1
      continue
    }
    // The tag ends at the first ">" outside quotes
    let gt = lt + 1, quote = ''
    for (; gt < text.length; gt++) {
      const c = text[gt]
      if (quote) { if (c === quote) quote = '' }
      else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
    }
    if (gt >= text.length) fail("It isn't valid XML: a tag never ends")
    const body = text.slice(lt + 1, gt)
    i = gt + 1
    if (body.startsWith('/')) {
      const name = body.slice(1).trim()
      const open = stack.pop()
      if (!open || open.name !== name) fail(`It isn't valid XML: </${name}> closes nothing that's open`)
      continue
    }
    const closed = body.endsWith('/')
    const inner = closed ? body.slice(0, -1) : body
    const name = /^[^\s/>]+/.exec(inner)?.[0]
    if (!name) fail("It isn't valid XML: a tag has no name")
    const element: XmlElement = { name, attrs: {}, children: [], text: '' }
    for (const m of inner.slice(name.length).matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      element.attrs[m[1]] = unescape(m[2] ?? m[3])
    }
    if (stack.length) stack[stack.length - 1].children.push(element)
    else if (root) fail("It isn't valid XML: it has two top elements")
    else root = element
    if (!closed) stack.push(element)
  }
  if (stack.length) fail(`It isn't valid XML: <${stack[stack.length - 1].name}> is never closed`)
  if (!root) fail("It isn't valid XML: it has no elements")
  return root
}

const child = (e: XmlElement, name: string) => e.children.find((c) => c.name === name)

// Pascal VOC

export type VocImage = {
  /** The image folder's name, its file name and its full path, as LabelImg writes them */
  folder: string
  filename: string
  path: string
  width: number
  height: number
  /** 1 for grey images, 3 for colour */
  depth: number
}

/** LabelImg's PascalVocReader, which keeps whole pixels; boxes with fractions keep them here */
export function readVoc(text: string): { shapes: Shape[]; verified: boolean } {
  const root = parseXml(text)
  if (root.name !== 'annotation') fail(`It isn't a Pascal VOC file: the top element is <${root.name}>, not <annotation>`)
  const shapes = root.children.filter((c) => c.name === 'object').map((o, k) => {
    const where = `Object ${k + 1}`
    const name = child(o, 'name')
    if (!name) fail(`${where} has no <name>`)
    const bndbox = child(o, 'bndbox')
    if (!bndbox) fail(`${where} has no <bndbox>`)
    const coord = (tag: string) => {
      const v = child(bndbox, tag)?.text.trim() ?? ''
      if (!v || !Number.isFinite(Number(v))) fail(`${where} needs a number in <${tag}>`)
      return Number(v)
    }
    const difficult = /^\s*(1|true|yes)\s*$/i.test(child(o, 'difficult')?.text ?? '')
    return box(name.text.trim(), coord('xmin'), coord('ymin'), coord('xmax'), coord('ymax'), difficult)
  })
  return { shapes, verified: root.attrs.verified === 'yes' }
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** LabelImg's PascalVocWriter, byte for byte: lxml's pretty print with tabs, no declaration */
export function writeVoc(image: VocImage, shapes: Shape[], verified: boolean): string {
  const el = (depth: number, tag: string, value: string | number) => {
    const text = escapeXml(String(value))
    return `${'\t'.repeat(depth)}${text ? `<${tag}>${text}</${tag}>` : `<${tag}/>`}`
  }
  const lines = [
    verified ? '<annotation verified="yes">' : '<annotation>',
    el(1, 'folder', image.folder), el(1, 'filename', image.filename), el(1, 'path', image.path),
    '\t<source>', el(2, 'database', 'Unknown'), '\t</source>',
    '\t<size>', el(2, 'width', image.width), el(2, 'height', image.height), el(2, 'depth', image.depth), '\t</size>',
    el(1, 'segmented', 0)
  ]
  for (const s of shapes) {
    const [xmin, ymin, xmax, ymax] = bndBox(s)
    // LabelImg's rule: a box reaching the right or bottom edge, or starting at 1, is truncated
    const truncated = ymax === Math.trunc(image.height) || ymin === 1 || xmax === Math.trunc(image.width) || xmin === 1
    lines.push(
      '\t<object>', el(2, 'name', s.label), el(2, 'pose', 'Unspecified'), el(2, 'truncated', truncated ? 1 : 0),
      el(2, 'difficult', isDifficult(s) ? 1 : 0),
      '\t\t<bndbox>', el(3, 'xmin', xmin), el(3, 'ymin', ymin), el(3, 'xmax', xmax), el(3, 'ymax', ymax), '\t\t</bndbox>',
      '\t</object>'
    )
  }
  lines.push('</annotation>')
  return lines.join('\n') + '\n'
}

// YOLO

/**
 * classes.txt as LabelImg reads it. Blank lines in the middle stay, so the numbers after them do too.
 * A byte order mark, which some editors write first, is left out of the first name, where LabelImg
 * keeps it: class 0 is then named as Seamline names it, and as it reads on screen.
 */
export function readClasses(text: string): string[] {
  const names = text.replace(/^[\r\n]+|[\r\n]+$/g, '').split(/\r?\n/)
  names[0] = names[0].replace(/^\uFEFF/, '')
  return names
}
export const writeClasses = (classes: string[]) => classes.map((c) => `${c}\n`).join('')
/**
 * classes.txt with names added at its end, and the rest as it was, its line ends too: written again
 * from the names read, a byte order mark before a blank first line would go, and that line with it,
 * so every class after it would take the number before
 */
export function addClasses(text: string, names: string[]) {
  const end = text.includes('\r\n') ? '\r\n' : '\n'
  return text.replace(/[\r\n]+$/, '') + names.map((n) => end + n).join('') + end
}

/** Python's round(): halves go to the even number */
export function pyRound(x: number) {
  const f = Math.floor(x)
  return x - f === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(x)
}

/** Python's '%.6f': the exact value rounded half to even, where toFixed rounds halves up */
export function pyFixed(x: number, digits = 6): string {
  const [whole, fraction] = Math.abs(x).toFixed(100).split('.')
  const kept = fraction.slice(0, digits), rest = fraction.slice(digits)
  let n = BigInt(whole + kept)
  const last = Number((whole + kept).slice(-1))
  if (rest[0] > '5' || (rest[0] === '5' && (/[1-9]/.test(rest.slice(1)) || last % 2 === 1))) n += 1n
  const s = n.toString().padStart(digits + 1, '0')
  const out = digits ? `${s.slice(0, -digits)}.${s.slice(-digits)}` : s
  return x < 0 || Object.is(x, -0) ? `-${out}` : out
}

/** LabelImg's YoloReader: each line is a class and a box's centre and size, as shares of the image */
export function readYolo(text: string, classes: string[], width: number, height: number): Shape[] {
  const shapes: Shape[] = []
  text.split(/\r?\n/).forEach((line, k) => {
    if (!line.trim()) return
    const parts = line.trim().split(/\s+/)
    if (parts.length !== 5) fail(`Line ${k + 1} needs a class and four numbers, as YOLO's boxes have`)
    const [c, xc, yc, w, h] = parts.map(Number)
    if (![c, xc, yc, w, h].every(Number.isFinite)) fail(`Line ${k + 1} has something that isn't a number`)
    if (!Number.isInteger(c) || c < 0 || c >= classes.length) fail(`Line ${k + 1}: class ${parts[0]} isn't in ${YOLO_CLASSES}`)
    shapes.push(box(classes[c],
      pyRound(width * Math.max(xc - w / 2, 0)), pyRound(height * Math.max(yc - h / 2, 0)),
      pyRound(width * Math.min(xc + w / 2, 1)), pyRound(height * Math.min(yc + h / 2, 1))))
  })
  return shapes
}

/** LabelImg's YOLOWriter. Labels missing from `classes` are added at the end, and the list comes back. */
export function writeYolo(shapes: Shape[], classes: string[], width: number, height: number): { text: string; classes: string[] } {
  const list = [...classes]
  const text = shapes.map((s) => {
    const [xmin, ymin, xmax, ymax] = bndBox(s)
    if (!list.includes(s.label)) list.push(s.label)
    const values = [(xmin + xmax) / 2 / width, (ymin + ymax) / 2 / height, (xmax - xmin) / width, (ymax - ymin) / height]
    return `${list.indexOf(s.label)} ${values.map((v) => pyFixed(v)).join(' ')}\n`
  }).join('')
  return { text, classes: list }
}

// CreateML

/** LabelImg's CreateMLReader: the entries for this image. Their boxes keep any fractions. */
export function readCreateML(text: string, image: string): { shapes: Shape[]; verified: boolean; found: boolean } {
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch (e) {
    fail(`It isn't valid JSON (${(e as Error).message})`)
  }
  if (!Array.isArray(list)) fail("It isn't a CreateML file: the top level must be a list")
  const shapes: Shape[] = []
  let verified = false, found = false
  list.forEach((entry, k) => {
    if (!isObject(entry) || typeof entry.image !== 'string' || !Array.isArray(entry.annotations)) {
      fail(`Entry ${k + 1} needs an image name and a list of annotations`)
    }
    if (entry.image !== image) return
    found = true
    if (entry.verified === true) verified = true
    entry.annotations.forEach((a, n) => {
      const c = isObject(a) ? a.coordinates : null
      if (!isObject(a) || typeof a.label !== 'string' || !isObject(c) || !['x', 'y', 'width', 'height'].every((v) => typeof c[v] === 'number')) {
        fail(`Annotation ${n + 1} of ${image} needs a label and coordinates x, y, width and height`)
      }
      const { x, y, width, height } = c as Record<string, number>
      shapes.push(box(a.label, x - width / 2, y - height / 2, x + width / 2, y + height / 2))
    })
  })
  return { shapes, verified, found }
}

// Python's json.dumps, which LabelImg writes CreateML with: ", " and ": " between items,
// non-ASCII as \u escapes, and floats as Python prints them, 105.0 rather than 105
class PyFloat {
  constructor(readonly value: number) {}
}

function pyRepr(v: number): string {
  if (Number.isNaN(v)) return 'NaN'
  if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity'
  if (v === 0) return Object.is(v, -0) ? '-0.0' : '0.0'
  // The shortest digits that read back the same, which both languages pick
  const [mantissa, e] = Math.abs(v).toExponential().split('e')
  const exp = Number(e)
  const digits = mantissa.replace('.', '')
  const sign = v < 0 ? '-' : ''
  if (exp < -4 || exp >= 16) return `${sign}${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ''}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`
  return `${sign}${digits.slice(0, exp + 1).padEnd(exp + 1, '0')}.${digits.slice(exp + 1) || '0'}`
}

function pyString(s: string) {
  let out = '"'
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k)
    const ch = s[k]
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\b') out += '\\b'
    else if (ch === '\f') out += '\\f'
    else if (c < 0x20 || c > 0x7e) out += `\\u${c.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return out + '"'
}

export function pyDumps(v: unknown): string {
  if (v instanceof PyFloat) return pyRepr(v.value)
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyRepr(v)
  if (typeof v === 'string') return pyString(v)
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(', ')}]`
  return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pyString(k)}: ${pyDumps(x)}`).join(', ')}}`
}

/** JSON as Python reads it: numbers written with a point or an exponent stay floats */
function parsePython(text: string): unknown {
  return JSON.parse(text, function (this: unknown, _key: string, value: unknown, context?: { source?: string }) {
    return typeof value === 'number' && context?.source && /[.eE]/.test(context.source) ? new PyFloat(value) : value
  } as (this: unknown, key: string, value: unknown) => unknown)
}

/**
 * LabelImg's CreateMLWriter: the file is a list of images, and this image's entry is put in
 * place of its old one, or added. Entries for other images stay as they were.
 */
export function writeCreateML(existing: string | null, image: string, shapes: Shape[], verified: boolean): string {
  let list: unknown = []
  if (existing !== null) {
    try {
      list = parsePython(existing)
    } catch (e) {
      fail(`It isn't valid JSON (${(e as Error).message})`)
    }
    if (!Array.isArray(list)) fail("It isn't a CreateML file: the top level must be a list")
  }
  const entry = {
    image,
    verified,
    annotations: shapes.map((s) => {
      // LabelImg takes a box's first corner and the one across from it, then sorts them
      const [[x1, y1], [x2, y2]] = s.shape_type === 'rectangle' && s.points.length === 2
        ? s.points : ((b) => [[b[0], b[1]], [b[2], b[3]]])(boxOf(s))
      const [xmin, xmax] = x1 < x2 ? [x1, x2] : [x2, x1]
      const [ymin, ymax] = y1 < y2 ? [y1, y2] : [y2, y1]
      const width = xmax - xmin, height = ymax - ymin
      return {
        label: s.label,
        coordinates: { x: new PyFloat(xmin + width / 2), y: new PyFloat(ymin + height / 2), width: new PyFloat(width), height: new PyFloat(height) }
      }
    })
  }
  const entries = list as unknown[]
  const at = entries.findIndex((e) => isObject(e) && e.image === image)
  if (at >= 0) entries[at] = entry
  else entries.push(entry)
  return pyDumps(entries)
}

/** Takes this image's entries out of a CreateML list; null when nothing else is left in it */
export function removeCreateML(existing: string, image: string): string | null {
  const list = parsePython(existing)
  if (!Array.isArray(list)) fail("It isn't a CreateML file: the top level must be a list")
  const rest = list.filter((e) => !(isObject(e) && e.image === image))
  return rest.length ? pyDumps(rest) : null
}

/** Is this JSON text a CreateML list rather than a LabelMe file? Decided by its first character. */
export const looksLikeCreateML = (text: string) => /^﻿?\s*\[/.test(text)
