// labelme 7's AI results to shapes (its _automation/_shape_builders.py and _suppression.py):
// each detection becomes a polygon, mask, rectangle, circle or rotated rectangle; repeats of
// one object are dropped, and so are detections over shapes already drawn. Also osam's
// non-maximum suppression, as ONNX Runtime's NonMaxSuppression runs it.
import type { AiOutput } from '../shared/config'
import { circleFromMask, type Grid, orientedRectFromMask, polygonsFromMask } from './polygonize'

type Point = [number, number]

/** A detection: its box (inclusive pixel corners) and the mask inside that box */
export type Detection = { box: [number, number, number, number] | null; mask: Grid | null; label?: string; description?: string; score: number }

/** A shape as the renderer keeps it; a mask shape's pixels are a Grid until saved */
export type BuiltShape = { label?: string; shape_type: AiOutput; points: number[][]; mask?: Grid; description?: string; group_id?: number | null }

/** The shapes a mask-less (box only) detection can't make */
export const NEEDS_MASK: AiOutput[] = ['polygon', 'mask']

const roundBox = (b: number[]) => b.map((v) => roundHalfEven(v)) as [number, number, number, number]

/** Python's round: halves to even */
export function roundHalfEven(v: number) {
  const r = Math.round(v)
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

function buildShapes(d: Detection, type: AiOutput, imageSize: [number, number] | null, detail: number): BuiltShape[] {
  const base = { label: d.label, description: d.description }
  if (type === 'rectangle') {
    if (!d.box) return []
    const [x0, y0, x1, y1] = d.box
    return [{ ...base, shape_type: 'rectangle', points: [[x0, y0], [x1, y1]] }]
  }
  if (type === 'polygon') {
    if (!d.mask) return []
    const [ox, oy] = d.box ? [Math.fround(d.box[0]), Math.fround(d.box[1])] : [0, 0]
    return polygonsFromMask(d.mask, detail)
      .map((polygon) => polygon.map(([x, y]) => [Math.fround(x + ox), Math.fround(y + oy)]))
      .filter((p) => p.length >= 3)
      .map((points) => ({ ...base, shape_type: 'polygon' as const, points }))
  }
  if (type === 'mask') {
    if (!d.box || !d.mask || !d.mask.data.some((v) => v)) return []
    const [x0, y0, x1, y1] = roundBox(d.box)
    return [{ ...base, shape_type: 'mask', points: [[x0, y0], [x1, y1]], mask: d.mask }]
  }
  if (type === 'circle') {
    const c = circleFor(d)
    return c ? [{ ...base, shape_type: 'circle', points: [[c.cx, c.cy], [c.cx + c.radius, c.cy]] }] : []
  }
  let corners = orientedRectFor(d)
  if (corners && imageSize) corners = fitToImage(corners, imageSize)
  return corners ? [{ ...base, shape_type: 'oriented_rectangle', points: corners }] : []
}

function circleFor(d: Detection) {
  if (d.mask) {
    const c = circleFromMask(d.mask)
    if (c) {
      const [ox, oy] = d.box ? [d.box[0], d.box[1]] : [0, 0]
      return { cx: c.cx + ox, cy: c.cy + oy, radius: c.radius }
    }
  }
  if (d.box) {
    // The circle inside the box, when there's no mask to measure
    const [x0, y0, x1, y1] = d.box
    const radius = Math.min(x1 - x0, y1 - y0) / 2
    if (radius > 0) return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, radius }
  }
  return null
}

function orientedRectFor(d: Detection): Point[] | null {
  if (d.mask) {
    const corners = orientedRectFromMask(d.mask)
    if (corners) {
      const [ox, oy] = d.box ? [Math.fround(d.box[0]), Math.fround(d.box[1])] : [0, 0]
      return corners.map(([x, y]) => [Math.fround(x + ox), Math.fround(y + oy)])
    }
  }
  if (d.box) {
    const [x0, y0, x1, y1] = d.box.map(Math.fround)
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
  }
  return null
}

/** labelme's _fit_oriented_rectangle_to_image: a rectangle that leaves the image becomes its upright box, clipped */
function fitToImage(corners: Point[], [w, h]: [number, number]): Point[] | null {
  if (corners.every(([x, y]) => x >= 0 && y >= 0 && x <= w && y <= h)) return corners
  const clip = (v: number, max: number) => Math.min(Math.max(v, 0), max)
  const lo: Point = [clip(Math.min(...corners.map((p) => p[0])), w), clip(Math.min(...corners.map((p) => p[1])), h)]
  const hi: Point = [clip(Math.max(...corners.map((p) => p[0])), w), clip(Math.max(...corners.map((p) => p[1])), h)]
  if (hi[0] <= lo[0] || hi[1] <= lo[1]) return null
  return [lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]]
}

/** labelme's shapes_from_detections: a detection that makes several polygons groups them */
export function shapesFromDetections(detections: Detection[], type: AiOutput, imageSize: [number, number] | null = null, detail = 60): BuiltShape[] {
  const shapes: BuiltShape[] = []
  let group = 1
  for (const d of detections) {
    const made = buildShapes(d, type, imageSize, detail)
    if (made.length > 1) {
      for (const s of made) s.group_id = group
      group++
    }
    shapes.push(...made)
  }
  return shapes
}

/** labelme's assign_available_group_ids: new groups numbered after the image's own */
export function assignGroupIds(shapes: BuiltShape[], existing: { group_id?: number | null }[]) {
  let next = Math.max(0, ...existing.map((s) => s.group_id ?? 0)) + 1
  const replace = new Map<number, number>()
  for (const s of shapes) {
    if (s.group_id === null || s.group_id === undefined) continue
    if (!replace.has(s.group_id)) replace.set(s.group_id, next++)
    s.group_id = replace.get(s.group_id)
  }
}

type LocalMask = { mask: Uint8Array; x: number; y: number; w: number; h: number; area: number }

function localFromDetection(d: Detection): LocalMask {
  const [x0, y0, x1, y1] = roundBox(d.box!)
  const w = x1 - x0 + 1, h = y1 - y0 + 1
  if (!d.mask) return { mask: new Uint8Array(w * h).fill(1), x: x0, y: y0, w, h, area: w * h }
  if (d.mask.width !== w || d.mask.height !== h) throw new Error(`mask shape ${d.mask.height}x${d.mask.width} does not match its box ${h}x${w}`)
  let area = 0
  for (const v of d.mask.data) if (v) area++
  return { mask: d.mask.data, x: x0, y: y0, w, h, area }
}

/** A shape already drawn, as the renderer sends it: a mask shape brings its pixels */
export type ExistingShape = { shape_type: string; points: number[][]; label?: string; mask?: Grid }

function boxOf(s: ExistingShape): number[] | null {
  if (s.shape_type === 'circle') {
    if (s.points.length !== 2) return null
    const [[cx, cy], [ex, ey]] = s.points
    const r = Math.hypot(ex - cx, ey - cy)
    return [cx - r, cy - r, cx + r, cy + r]
  }
  const need: Record<string, number> = { rectangle: 2, mask: 2, polygon: 3, oriented_rectangle: 4 }
  if (!(s.shape_type in need) || s.points.length < need[s.shape_type]) return null
  const xs = s.points.map((p) => p[0]), ys = s.points.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.fround)
}

/** Fill a polygon into a w×h grid, pixel centres inside (even-odd), as PIL's polygon fill near enough */
function fillPolygon(points: number[][], w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const cy = y + 0.5
    const xs: number[] = []
    for (let i = 0; i < points.length; i++) {
      const [ax, ay] = points[i], [bx, by] = points[(i + 1) % points.length]
      if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax))
    }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x < Math.min(w, Math.ceil(xs[k + 1] - 0.5)); x++) out[y * w + x] = 1
    }
  }
  return out
}

function localFromShape(s: ExistingShape): LocalMask | null {
  if (!['rectangle', 'polygon', 'circle', 'oriented_rectangle', 'mask'].includes(s.shape_type)) return null
  const box = boxOf(s)
  if (!box) return null
  const [x0, y0, x1, y1] = roundBox(box)
  const w = x1 - x0 + 1, h = y1 - y0 + 1
  if (w <= 0 || h <= 0) return null
  let mask: Uint8Array
  if (s.shape_type === 'rectangle' || (s.shape_type === 'mask' && !s.mask)) {
    mask = new Uint8Array(w * h).fill(1)
  } else if (s.shape_type === 'mask') {
    if (s.mask!.width !== w || s.mask!.height !== h) return null
    mask = s.mask!.data
  } else if (s.shape_type === 'circle') {
    const [[cx, cy], [ex, ey]] = s.points
    const r = Math.hypot(ex - cx, ey - cy)
    mask = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[y * w + x] = Math.hypot(x + 0.5 - (cx - x0), y + 0.5 - (cy - y0)) <= r ? 1 : 0
  } else {
    mask = fillPolygon(s.points.map(([x, y]) => [x - x0, y - y0]), w, h)
  }
  let area = 0
  for (const v of mask) if (v) area++
  return { mask, x: x0, y: y0, w, h, area }
}

function overlap(a: LocalMask, b: LocalMask) {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h)
  let inter = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) if (a.mask[(y - a.y) * a.w + (x - a.x)] && b.mask[(y - b.y) * b.w + (x - b.x)]) inter++
  }
  if (!inter) return { iou: 0, containment: 0 }
  return { iou: inter / (a.area + b.area - inter), containment: inter / Math.min(a.area, b.area) }
}

// Nested masks (a cluster of trees and one tree in it) share little area but one holds the other
const redundant = (o: { iou: number; containment: number }, iouThreshold: number) => o.iou >= iouThreshold || o.containment >= 0.85

/** labelme's suppress_detections_greedy: detections in order of priority, later repeats of a label dropped */
export function suppressGreedy(detections: Detection[], iouThreshold: number): Detection[] {
  const withBox = detections.filter((d) => d.box)
  if (new Set(withBox.map((d) => !!d.mask)).size > 1) throw new Error('detections must be homogeneous: either all have masks or none do')
  const kept: Detection[] = []
  const peers = new Map<string | undefined, LocalMask[]>()
  for (const d of detections) {
    if (!d.box) { kept.push(d); continue }
    const local = localFromDetection(d)
    const same = peers.get(d.label) ?? []
    peers.set(d.label, same)
    if (same.some((p) => redundant(overlap(local, p), iouThreshold))) continue
    kept.push(d)
    same.push(local)
  }
  return kept
}

/** labelme's match_detections_to_existing_shapes: what's new, and which drawn shapes the rest matched */
export function matchExisting(detections: Detection[], existing: ExistingShape[]): { fresh: Detection[]; matched: number[] } {
  const masks = existing.map((s, i) => [i, localFromShape(s)] as const).filter((x): x is readonly [number, LocalMask] => x[1] !== null)
  if (!masks.length) return { fresh: [...detections], matched: [] }
  const fresh: Detection[] = []
  const matched: number[] = []
  for (const d of detections) {
    if (!d.box) { fresh.push(d); continue }
    const local = localFromDetection(d)
    let best = -1, bestIou = -1
    for (const [i, m] of masks) {
      const o = overlap(local, m)
      if (redundant(o, 0.5) && o.iou > bestIou) { best = i; bestIou = o.iou }
    }
    if (best < 0) fresh.push(d)
    else if (!matched.includes(best)) matched.push(best)
  }
  return { fresh, matched }
}

function iouAbove(a: number[], b: number[], threshold: number) {
  const f = Math.fround
  const ax0 = Math.min(a[0], a[2]), ax1 = Math.max(a[0], a[2]), ay0 = Math.min(a[1], a[3]), ay1 = Math.max(a[1], a[3])
  const bx0 = Math.min(b[0], b[2]), bx1 = Math.max(b[0], b[2]), by0 = Math.min(b[1], b[3]), by1 = Math.max(b[1], b[3])
  const areaA = f(f(ax1 - ax0) * f(ay1 - ay0)), areaB = f(f(bx1 - bx0) * f(by1 - by0))
  if (areaA <= 0 || areaB <= 0) return false
  const ix0 = Math.max(ax0, bx0), iy0 = Math.max(ay0, by0), ix1 = Math.min(ax1, bx1), iy1 = Math.min(ay1, by1)
  const inter = f(f(Math.max(ix1 - ix0, 0)) * f(Math.max(iy1 - iy0, 0)))
  const iou = f(inter / f(f(areaA + areaB) - inter))
  return iou > threshold
}

/**
 * osam's non_maximum_suppression: ONNX's NonMaxSuppression per class, boxes over the score
 * threshold taken best first, each dropped if it overlaps one kept by more than the IoU
 * threshold. Returns, class by class, [box index, class, score].
 */
export function nms(boxes: number[][], scores: number[][], iouThreshold: number, scoreThreshold: number, maxPerClass: number) {
  const out: { index: number; label: number; score: number }[] = []
  const classes = scores[0]?.length ?? 0
  const thr = Math.fround(iouThreshold), sthr = Math.fround(scoreThreshold)
  for (let c = 0; c < classes; c++) {
    const candidates = boxes.map((_, i) => i).filter((i) => Math.fround(scores[i][c]) > sthr)
    candidates.sort((a, b) => Math.fround(scores[b][c]) - Math.fround(scores[a][c]) || a - b)
    const kept: number[] = []
    for (const i of candidates) {
      if (kept.length >= maxPerClass) break
      if (kept.some((k) => iouAbove(boxes[i], boxes[k], thr))) continue
      kept.push(i)
    }
    for (const i of kept) out.push({ index: i, label: c, score: Math.fround(scores[i][c]) })
  }
  if (out.length > maxPerClass) {
    // numpy's argsort of the scores, keeping the last (highest) ones in that order
    const order = out.map((_, i) => i).sort((a, b) => out[a].score - out[b].score || a - b)
    return order.slice(-maxPerClass).map((i) => out[i])
  }
  return out
}
