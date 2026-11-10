// labelme 7's AI flows (its _automation/_ai_assist.py and _text_detection.py): a model's
// results become shapes of the kind asked for, without repeats, without objects already drawn
// when that's asked for, and with new group IDs after the image's own.
import type { AiOutput } from '../shared/config'
import { type Annotation, generateFromPrompt, generateFromTexts, modelDef } from './ai'
import { assignGroupIds, type BuiltShape, type Detection, type ExistingShape, matchExisting, NEEDS_MASK, nms, roundHalfEven, shapesFromDetections, suppressGreedy } from './detections'
import { decodeMask, encodeMask } from './masks'
import type { Grid } from './polygonize'

/** A shape on its way to the window: a mask shape's pixels as labelme's base64 PNG */
export type ProposedShape = { label?: string; shape_type: AiOutput; points: number[][]; mask?: string; description?: string; group_id?: number | null }
/** A shape already in the image, as the window sends it */
export type DrawnShape = { shape_type: string; points: number[][]; label?: string; mask?: string | null }

export type AssistRequest = {
  root: string
  name: string
  model: string
  /** Clicks (labels 1 and 0), or a box as two corners (labels 2 and 3), in the image's pixels */
  points: number[][]
  labels: number[]
  output: AiOutput
  detail: number
  /** Shapes to leave alone: their objects aren't proposed again, and they're named instead. Null: not asked for. */
  drawn: DrawnShape[] | null
  /** Group IDs in use, so new groups come after them */
  groups: number[]
  /** Points may lie outside the image */
  outside: boolean
}

export type TextRequest = Omit<AssistRequest, 'points' | 'labels' | 'drawn'> & { texts: string[]; drawn: DrawnShape[]; iou: number; score: number }

export type Proposal = { shapes: ProposedShape[]; matched: number[] }

const round2 = (v: number) => Math.round(v * 100) / 100

function detectionsFrom(annotations: Annotation[]): Detection[] {
  // Best first, as labelme sorts them; osam gives SAM's masks no score, which counts as 0
  return [...annotations]
    .map((a, i) => ({ a, i }))
    .sort((x, y) => y.a.score - x.a.score || x.i - y.i)
    .map(({ a }) => ({ box: a.box, mask: a.mask, score: a.score, label: a.text }))
}

/** The copy the model saw, against the whole image: its scale across and down, which rounding sets apart */
type Copy = { sx: number; sy: number; full: [number, number] }
const copyOf = (gen: { width: number; height: number; full: [number, number] }): Copy =>
  ({ sx: gen.width / gen.full[0], sy: gen.height / gen.full[1], full: gen.full })
const whole = (c: Copy) => c.sx === 1 && c.sy === 1

/** Shapes drawn on the whole image, in the pixels of the copy the model saw */
async function toWork(drawn: DrawnShape[], c: Copy): Promise<ExistingShape[]> {
  return Promise.all(drawn.map(async (s) => {
    const points = s.points.map(([x, y]) => [x * c.sx, y * c.sy])
    if (s.shape_type !== 'mask' || !s.mask) return { shape_type: s.shape_type, points, label: s.label }
    let mask: Grid = await decodeMask(s.mask)
    if (!whole(c)) {
      // The box the scaled corners round to, filled from the nearest pixel of the mask
      const [[x0, y0], [x1, y1]] = points.map((p) => p.map(roundHalfEven))
      const w = x1 - x0 + 1, h = y1 - y0 + 1
      const data = new Uint8Array(Math.max(0, w * h))
      for (let y = 0; y < h; y++) {
        const my = Math.min(mask.height - 1, Math.floor((y + 0.5) / c.sy))
        for (let x = 0; x < w; x++) {
          const mx = Math.min(mask.width - 1, Math.floor((x + 0.5) / c.sx))
          data[y * w + x] = mask.data[my * mask.width + mx]
        }
      }
      mask = { data, width: w, height: h }
    }
    return { shape_type: s.shape_type, points, label: s.label, mask }
  }))
}

/** Shapes from the copy the model saw back to the whole image; masks scaled up pixel by pixel, inside it */
async function toWhole(shapes: BuiltShape[], c: Copy): Promise<ProposedShape[]> {
  return Promise.all(shapes.map(async (s) => {
    const out: ProposedShape = {
      label: s.label, shape_type: s.shape_type, points: s.points.map(([x, y]) => [round2(x / c.sx), round2(y / c.sy)]),
      description: s.description, group_id: s.group_id
    }
    if (s.shape_type !== 'mask' || !s.mask) return out
    const [[bx, by]] = s.points
    if (whole(c)) {
      out.mask = await encodeMask(s.mask.data, s.mask.width, s.mask.height)
      out.points = s.points.map(([x, y]) => [x, y])
      return out
    }
    const x0 = Math.floor(bx / c.sx), y0 = Math.floor(by / c.sy)
    const x1 = Math.min(c.full[0], Math.ceil((bx + s.mask.width) / c.sx)) - 1, y1 = Math.min(c.full[1], Math.ceil((by + s.mask.height) / c.sy)) - 1
    const w = x1 - x0 + 1, h = y1 - y0 + 1
    const data = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
      const my = Math.min(s.mask.height - 1, Math.floor((y0 + y + 0.5) * c.sy) - by)
      for (let x = 0; x < w; x++) {
        const mx = Math.min(s.mask.width - 1, Math.floor((x0 + x + 0.5) * c.sx) - bx)
        data[y * w + x] = my >= 0 && mx >= 0 ? s.mask.data[my * s.mask.width + mx] : 0
      }
    }
    out.points = [[x0, y0], [x1, y1]]
    out.mask = await encodeMask(data, w, h)
    return out
  }))
}

function inside(d: Detection, [px, py]: number[]) {
  if (!d.box) return false
  const [x0, y0, x1, y1] = d.box.map(roundHalfEven)
  const x = roundHalfEven(px), y = roundHalfEven(py)
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  return !d.mask || d.mask.data[(y - y0) * d.mask.width + (x - x0)] === 1
}

/** labelme's AiAssistSession.propose_shapes: AI points and AI box */
export async function assist(req: AssistRequest): Promise<Proposal> {
  const gen = await generateFromPrompt(req.root, req.name, req.model, req.points, req.labels)
  const copy = copyOf(gen)
  let detections = detectionsFrom(gen.annotations)
  if (!req.labels.includes(2) && detections.length) {
    // Of several masks, the one that agrees with most clicks, then the surest
    const pts = req.points.map(([x, y]) => [x * copy.sx, y * copy.sy])
    const agree = (d: Detection) => pts.filter((p, i) => inside(d, p) === (req.labels[i] === 1)).length
    detections = [detections.reduce((best, d) => (agree(d) > agree(best) || (agree(d) === agree(best) && d.score > best.score) ? d : best))]
  }
  detections = suppressGreedy(detections, 0.5)
  const drawn = req.drawn ? await toWork(req.drawn, copy) : []
  const { fresh, matched } = matchExisting(detections, drawn)
  const shapes = shapesFromDetections(fresh, req.output, req.outside ? null : [gen.width, gen.height], req.detail)
  assignGroupIds(shapes, req.groups.map((g) => ({ group_id: g })))
  return { shapes: await toWhole(shapes, copy), matched }
}

// Python's json.dumps({"score": …, "text": …}): its separators, float format and \u escapes
function pyFloat(v: number) {
  if (v !== 0 && (Math.abs(v) < 1e-4 || Math.abs(v) >= 1e16)) {
    const [m, e] = v.toExponential().split('e')
    const exp = Number(e)
    return `${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
  }
  const s = String(v)
  return s.includes('.') || s.includes('e') ? s : `${s}.0`
}
const pyString = (s: string) => JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
const pyDescription = (score: number, text: string) => `{"score": ${pyFloat(score)}, "text": ${pyString(text)}}`

export class MaskOutputUnavailable extends Error {}

/** labelme's propose_shapes_from_texts: the AI text prompt */
export async function fromTexts(req: TextRequest): Promise<Proposal> {
  const texts = req.texts
  const gen = await generateFromTexts(req.root, req.name, req.model, texts)
  const copy = copyOf(gen)
  const found = gen.annotations
  const hasMasks = found.length > 0 && found[0].mask !== null
  if (!hasMasks && found.length && NEEDS_MASK.includes(req.output)) {
    throw new MaskOutputUnavailable(`${modelDef(req.model).title} only finds boxes, so it can't make ${req.output === 'mask' ? 'masks' : 'polygons'}: switch to SAM 3, or to rectangles.`)
  }
  const boxes = found.map((a) => [...a.box])
  const scores = found.map((a) => Math.fround(a.score))
  const labels = found.map((a) => texts.indexOf(a.text!))
  // Shapes already drawn outrank any score, so what overlaps them goes and they stay
  const EXISTING = Math.fround(1.01)
  const drawn = await toWork(req.drawn, copy)
  for (const s of drawn) {
    if (s.shape_type !== req.output || !texts.includes(s.label ?? '')) continue
    let box: number[] | null = null
    if (s.shape_type === 'circle' && s.points.length === 2) {
      const [[cx, cy], [ex, ey]] = s.points
      const r = Math.hypot(ex - cx, ey - cy)
      box = [cx - r, cy - r, cx + r, cy + r]
    } else if (s.points.length >= ({ rectangle: 2, mask: 2, polygon: 3, oriented_rectangle: 4 } as Record<string, number>)[s.shape_type]) {
      const xs = s.points.map((p) => p[0]), ys = s.points.map((p) => p[1])
      box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    }
    if (!box) continue
    boxes.push(box.map(Math.fround))
    scores.push(EXISTING)
    labels.push(texts.indexOf(s.label!))
  }
  const classes = Math.max(-1, ...labels) + 1
  const matrix = scores.map((score, i) => Array.from({ length: classes }, (_, c) => (c === labels[i] ? score : 0)))
  const kept = boxes.length ? nms(boxes, matrix, req.iou, req.score, 100).filter((k) => k.score !== EXISTING) : []
  let detections: Detection[] = kept.map((k) => ({
    box: boxes[k.index].map(Number) as Detection['box'],
    mask: hasMasks ? found[k.index].mask : null,
    label: texts[k.label],
    description: pyDescription(k.score, texts[k.label]),
    score: k.score
  }))
  detections = suppressGreedy(detections, req.iou)
  const shapes = shapesFromDetections(detections, req.output, req.outside ? null : [gen.width, gen.height], req.detail)
  assignGroupIds(shapes, req.groups.map((g) => ({ group_id: g })))
  return { shapes: await toWhole(shapes, copy), matched: [] }
}
