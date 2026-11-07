import ClipperLib from 'clipper-lib'
import { accepted, type Shape } from '../../shared/labelfile'

// Geometry for each of labelme's shape types: what a shape covers, where its edges and
// vertices are, and the edits labelme allows on it.

export type Pt = number[]

export const CLOSED = new Set(['polygon', 'rectangle', 'circle', 'mask'])
export const EDITABLE_POINTS = new Set(['polygon', 'linestrip'])

export function bounds(s: Shape): [number, number, number, number] {
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

/** The outline as a closed ring, for filling, testing and clipping */
export function outline(s: Shape): Pt[] {
  if ((s.shape_type === 'rectangle' || s.shape_type === 'mask') && s.points.length >= 2) {
    const [[a, b], [c, d]] = s.points
    return [[a, b], [c, b], [c, d], [a, d]]
  }
  if (s.shape_type === 'circle' && s.points.length >= 2) {
    const [[cx, cy], [px, py]] = s.points
    const r = Math.hypot(px - cx, py - cy)
    const n = Math.max(24, Math.min(256, Math.round(r)))
    return Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)])
  }
  return s.points
}

export function insideRing(p: Pt, poly: Pt[]) {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

export function segmentDistance(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

/** Edges as index pairs: closed shapes wrap around, open ones don't */
export function edges(s: Shape): [number, number][] {
  const n = s.points.length
  if (s.shape_type === 'polygon') return Array.from({ length: n }, (_, i) => [i, (i + 1) % n] as [number, number])
  if (s.shape_type === 'linestrip' || s.shape_type === 'line') return Array.from({ length: Math.max(0, n - 1) }, (_, i) => [i, i + 1] as [number, number])
  return []
}

/** Is the point on the shape? Lines count within `tolerance` image pixels, as in labelme. */
export function contains(s: Shape, p: Pt, tolerance: number) {
  const t = s.shape_type
  if (t === 'point') return Math.hypot(p[0] - s.points[0][0], p[1] - s.points[0][1]) <= tolerance
  if (t === 'line' || t === 'linestrip' || t === 'points') {
    return edges(s).some(([a, b]) => segmentDistance(p, s.points[a], s.points[b]) <= tolerance)
  }
  if (t === 'circle' && s.points.length >= 2) {
    const [[cx, cy], [px, py]] = s.points
    return Math.hypot(p[0] - cx, p[1] - cy) <= Math.hypot(px - cx, py - cy)
  }
  return insideRing(p, outline(s))
}

export function nearestVertex(s: Shape, p: Pt, tolerance: number): number {
  let best = -1, dist = tolerance
  s.points.forEach((q, i) => {
    const d = Math.hypot(p[0] - q[0], p[1] - q[1])
    if (d <= dist) { best = i; dist = d }
  })
  return best
}

export function nearestEdge(s: Shape, p: Pt, tolerance: number): number {
  if (!EDITABLE_POINTS.has(s.shape_type)) return -1
  let best = -1, dist = tolerance
  edges(s).forEach(([a, b], i) => {
    const d = segmentDistance(p, s.points[a], s.points[b])
    if (d <= dist) { best = i; dist = d }
  })
  return best
}

export const clampTo = (w: number, h: number) => (p: Pt): Pt => [Math.max(0, Math.min(w, p[0])), Math.max(0, Math.min(h, p[1]))]

/** Where a line from inside the image to a point outside it crosses the edge, as labelme draws */
export function toEdge(from: Pt, to: Pt, w: number, h: number): Pt {
  const inside = (q: Pt) => q[0] >= 0 && q[0] <= w && q[1] >= 0 && q[1] <= h
  if (inside(to)) return to
  let t = 1
  const dx = to[0] - from[0], dy = to[1] - from[1]
  if (dx) t = Math.min(t, Math.max((0 - from[0]) / dx, (w - from[0]) / dx))
  if (dy) t = Math.min(t, Math.max((0 - from[1]) / dy, (h - from[1]) / dy))
  return clampTo(w, h)([from[0] + dx * Math.max(0, t), from[1] + dy * Math.max(0, t)])
}

/** Move shapes, but no further than keeps all of them inside the image, as labelme does */
export function moveShapes(shapes: Shape[], which: number[], dx: number, dy: number, w: number, h: number): Shape[] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const i of which) {
    const [a, b, c, d] = shapes[i].shape_type === 'circle' ? [shapes[i].points[0][0], shapes[i].points[0][1], shapes[i].points[0][0], shapes[i].points[0][1]] : bounds(shapes[i])
    x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, c); y1 = Math.max(y1, d)
  }
  dx = Math.max(-x0, Math.min(w - x1, dx))
  dy = Math.max(-y0, Math.min(h - y1, dy))
  if (!dx && !dy) return shapes
  const set = new Set(which)
  return shapes.map((s, i) => (set.has(i) ? { ...accepted(s), points: s.points.map(([x, y]) => [x + dx, y + dy]) } : s))
}

/** Rectangles with Shift held stay square, as in labelme */
export function squareFrom(a: Pt, p: Pt): Pt {
  const dx = p[0] - a[0], dy = p[1] - a[1]
  const size = Math.min(Math.abs(dx), Math.abs(dy))
  return [a[0] + Math.sign(dx) * size, a[1] + Math.sign(dy) * size]
}

/** labelme's limits: a polygon keeps 3 points, a line strip 2 */
export function canRemovePoint(s: Shape) {
  if (s.shape_type === 'polygon') return s.points.length > 3
  if (s.shape_type === 'linestrip') return s.points.length > 2
  return false
}

export function insertPoint(s: Shape, edge: number, p: Pt): Shape {
  const [a] = edges(s)[edge]
  const points = [...s.points]
  points.splice(a + 1, 0, p)
  return { ...accepted(s), points }
}

/** LabelMeV2's Ctrl+M: several points spread evenly along one edge */
export function addPointsToEdge(s: Shape, edge: number, count: number): Shape {
  const [a, b] = edges(s)[edge]
  const p = s.points[a], q = s.points[b]
  const extra = Array.from({ length: count }, (_, k) => {
    const t = (k + 1) / (count + 1)
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
  })
  const points = [...s.points]
  points.splice(a + 1, 0, ...extra)
  return { ...accepted(s), points }
}

const SCALE = 100
const toPath = (points: Pt[]) => points.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }))

/**
 * LabelMeV2's merge: polygons that touch or overlap become one; the rest stay apart but
 * share the first one's label. Returns null when nothing would change.
 */
export function mergePolygons(shapes: Shape[], which: number[]): { shapes: Shape[]; selected: number[] } | null {
  const chosen = which.filter((i) => CLOSED.has(shapes[i].shape_type) && shapes[i].shape_type !== 'mask')
  if (chosen.length < 2) return null
  const first = shapes[chosen[0]]
  const clipper = new ClipperLib.Clipper()
  for (const i of chosen) {
    const ring = ClipperLib.Clipper.SimplifyPolygon(toPath(outline(shapes[i])), ClipperLib.PolyFillType.pftEvenOdd)
    clipper.AddPaths(ring, ClipperLib.PolyType.ptSubject, true)
  }
  const tree = new ClipperLib.PolyTree()
  clipper.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  const pieces = ClipperLib.JS.PolyTreeToExPolygons(tree).map((p: { outer: { X: number; Y: number }[] }) =>
    p.outer.map((q) => [q.X / SCALE, q.Y / SCALE])
  )
  if (!pieces.length) return null
  const base = accepted(first)
  const merged = pieces.map((points: Pt[]) => ({ ...base, shape_type: 'polygon' as const, points }))
  const drop = new Set(chosen)
  const at = chosen[0]
  const out: Shape[] = []
  let start = 0
  shapes.forEach((s, i) => {
    if (i === at) { start = out.length; out.push(...merged) }
    else if (!drop.has(i)) out.push(s)
  })
  return { shapes: out, selected: merged.map((_: Shape, k: number) => start + k) }
}

export function describe(s: Shape) {
  switch (s.shape_type) {
    case 'polygon': return `${s.points.length} pts`
    case 'linestrip': return `line strip · ${s.points.length} pts`
    case 'rectangle': return 'box'
    default: return s.shape_type
  }
}
