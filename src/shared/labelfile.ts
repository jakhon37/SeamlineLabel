// LabelMe JSON, read and written the way labelme 5 does it, so the same files go back and
// forth between labelme, LabelMeV2, Seamline and this app. Saving a file labelme wrote
// gives back the same bytes.

export const SHAPE_TYPES = ['polygon', 'rectangle', 'circle', 'line', 'point', 'linestrip', 'points', 'mask'] as const
export type ShapeType = (typeof SHAPE_TYPES)[number]

export type Shape = {
  label: string
  points: number[][]
  shape_type: ShapeType
  group_id: number | null
  description: string
  flags: Record<string, boolean>
  /** A mask shape's pixels inside its box, as a base64 PNG */
  mask: string | null
  /** Keys labelme doesn't know, such as an AI shape's score, kept as they were */
  other: Record<string, unknown>
  /** Hidden in the window from the shape list. Never saved. */
  hidden?: boolean
}

export type LabelDoc = {
  version: string
  flags: Record<string, boolean>
  shapes: Shape[]
  imagePath: string
  imageData: string | null
  imageHeight: number | null
  imageWidth: number | null
  /** Keys labelme doesn't know, kept as they were */
  other: Record<string, unknown>
}

// What labelme writes as `version` is its own version. New files say 5.5.0, as Seamline's do.
export const FORMAT_VERSION = '5.5.0'

const SHAPE_KEYS = new Set(['label', 'points', 'group_id', 'shape_type', 'flags', 'description', 'mask'])
const DOC_KEYS = new Set(['version', 'imageData', 'imagePath', 'shapes', 'flags', 'imageHeight', 'imageWidth'])

export class LabelFileError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function fail(message: string): never {
  throw new LabelFileError(message)
}

function readFlags(value: unknown, where: string): Record<string, boolean> {
  if (value === undefined || value === null) return {}
  if (!isObject(value) || !Object.values(value).every((v) => typeof v === 'boolean')) {
    fail(`${where} flags must map names to true or false`)
  }
  return { ...(value as Record<string, boolean>) }
}

/** One shape, checked as labelme checks it. Anything labelme would refuse is refused. */
export function readShape(raw: unknown, index = 0): Shape {
  const where = `Shape ${index + 1}`
  if (!isObject(raw)) fail(`${where} isn't an object`)
  if (typeof raw.label !== 'string') fail(`${where} needs a label`)
  const points = raw.points
  if (!Array.isArray(points) || !points.length) fail(`${where} needs points`)
  if (!points.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v)))) {
    fail(`${where} points must be [x, y] pairs`)
  }
  const type = raw.shape_type ?? 'polygon'
  if (!SHAPE_TYPES.includes(type as ShapeType)) fail(`${where} has an unknown shape_type: ${String(type)}`)
  if (raw.description !== undefined && raw.description !== null && typeof raw.description !== 'string') {
    fail(`${where} description must be text`)
  }
  if (raw.group_id !== undefined && raw.group_id !== null && !Number.isInteger(raw.group_id)) {
    fail(`${where} group_id must be a whole number`)
  }
  if (raw.mask !== undefined && raw.mask !== null && typeof raw.mask !== 'string') {
    fail(`${where} mask must be a base64 PNG`)
  }
  const other: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) if (!SHAPE_KEYS.has(k)) other[k] = v
  return {
    label: raw.label,
    points: (points as number[][]).map(([x, y]) => [x, y]),
    shape_type: type as ShapeType,
    group_id: (raw.group_id as number | null | undefined) ?? null,
    description: (raw.description as string | null | undefined) ?? '',
    flags: readFlags(raw.flags, where),
    mask: (raw.mask as string | null | undefined) ?? null,
    other
  }
}

/** A whole label file. Throws LabelFileError with a reason a person can act on. */
export function parseLabelFile(text: string): LabelDoc {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    fail(`It isn't valid JSON (${(e as Error).message})`)
  }
  if (!isObject(raw)) fail("It isn't a LabelMe file: the top level must be an object")
  if (!Array.isArray(raw.shapes)) fail("It isn't a LabelMe file: there is no shapes list")
  if (raw.imagePath !== undefined && raw.imagePath !== null && typeof raw.imagePath !== 'string') {
    fail('imagePath must be text')
  }
  if (raw.imageData !== undefined && raw.imageData !== null && typeof raw.imageData !== 'string') {
    fail('imageData must be base64 text')
  }
  const size = (v: unknown, name: string) => {
    if (v === undefined || v === null) return null
    if (!Number.isInteger(v) || (v as number) <= 0) fail(`${name} must be a positive whole number`)
    return v as number
  }
  const other: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) if (!DOC_KEYS.has(k)) other[k] = v
  return {
    version: typeof raw.version === 'string' ? raw.version : FORMAT_VERSION,
    flags: readFlags(raw.flags, 'Image'),
    shapes: raw.shapes.map(readShape),
    // labelme on Windows writes backslashes
    imagePath: typeof raw.imagePath === 'string' ? raw.imagePath.replace(/\\/g, '/') : '',
    imageData: (raw.imageData as string | null | undefined) ?? null,
    imageHeight: size(raw.imageHeight, 'imageHeight'),
    imageWidth: size(raw.imageWidth, 'imageWidth'),
    other
  }
}

// Python's json.dump(indent=2), which labelme uses. Points are Python floats, so whole
// numbers keep their ".0"; everything else prints as JSON.stringify would.
class PyFloat {
  constructor(readonly value: number) {}
}
const float = (v: number) => new PyFloat(v)

function dump(value: unknown, pad: string): string {
  if (value instanceof PyFloat) {
    const v = value.value
    return Number.isInteger(v) && Math.abs(v) < 1e16 ? v.toFixed(1) : String(v)
  }
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  const inner = pad + '  '
  if (Array.isArray(value)) {
    if (!value.length) return '[]'
    return `[\n${value.map((v) => inner + dump(v, inner)).join(',\n')}\n${pad}]`
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
  if (!entries.length) return '{}'
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${dump(v, inner)}`).join(',\n')}\n${pad}}`
}

/** The shape as labelme writes it: unknown keys first, then its own in its own order. */
export function shapeRecord(s: Shape, floats = false): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(s.other)) if (!SHAPE_KEYS.has(k)) out[k] = v
  return Object.assign(out, {
    label: s.label,
    points: s.points.map(([x, y]) => (floats ? [float(x), float(y)] : [x, y])),
    group_id: s.group_id,
    description: s.description,
    shape_type: s.shape_type,
    flags: s.flags,
    mask: s.mask
  })
}

export function serializeLabelFile(doc: LabelDoc): string {
  const out: Record<string, unknown> = {
    version: doc.version,
    flags: doc.flags,
    shapes: doc.shapes.map((s) => shapeRecord(s, true)),
    imagePath: doc.imagePath,
    imageData: doc.imageData,
    imageHeight: doc.imageHeight,
    imageWidth: doc.imageWidth
  }
  for (const [k, v] of Object.entries(doc.other)) if (!(k in out)) out[k] = v
  return dump(out, '')
}

export function newShape(label: string, shape_type: ShapeType, points: number[][], extra: Partial<Shape> = {}): Shape {
  return { label, points, shape_type, group_id: null, description: '', flags: {}, mask: null, other: {}, ...extra }
}

// Shapes a model proposed carry flags.ai and a score until someone accepts them, as in Seamline
export const isAi = (s: Shape) => s.flags.ai === true
export const scoreOf = (s: Shape) => (typeof s.other.score === 'number' ? s.other.score : undefined)

export function accepted(s: Shape): Shape {
  if (!isAi(s) && s.other.score === undefined) return s
  const { ai: _ai, ...flags } = s.flags
  const { score: _score, ...other } = s.other
  return { ...s, flags, other }
}
