import ClipperLib from 'clipper-lib'
import { accepted, newShape, type Shape } from '../../shared/labelfile'
import { outline } from './shapes'

type Path = { X: number; Y: number }[]
export type Region = Path[]

// Clipper works in whole numbers: this keeps a hundredth of a pixel
const SCALE = 100

// Smaller specks and pinholes come from stroke edges, not from anything drawn on purpose
const MIN_AREA = 4

// Paint and cuts work on areas, so only area shapes take part: masks, lines and points don't
export const paintable = (s: Shape) => ['polygon', 'rectangle', 'circle'].includes(s.shape_type) && !s.hidden

const toPath = (points: number[][]): Path =>
  points.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }))
const fromPath = (path: Path) => path.map((p) => [p.X / SCALE, p.Y / SCALE])

function ringArea(ring: number[][]) {
  let sum = 0
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length]
    sum += p[0] * q[1] - q[0] * p[1]
  })
  return Math.abs(sum) / 2
}

// A shape's real area as clean outlines, with any zero-width cut (see withHoles) resolved
const solid = (s: Shape): Region =>
  ClipperLib.Clipper.SimplifyPolygon(toPath(outline(s)), ClipperLib.PolyFillType.pftEvenOdd)

function combine(type: number, subject: Region, clip: Region = []) {
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(subject, ClipperLib.PolyType.ptSubject, true)
  if (clip.length) clipper.AddPaths(clip, ClipperLib.PolyType.ptClip, true)
  const tree = new ClipperLib.PolyTree()
  clipper.Execute(type, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  return tree
}
const flat = (tree: unknown): Region => ClipperLib.Clipper.PolyTreeToPaths(tree)

/** The area a brush stroke covers, cut to the image. `tolerance` is in image pixels. */
export function strokeRegion(points: number[][], radius: number, tolerance: number, size: number[]): Region {
  const offset = new ClipperLib.ClipperOffset(2, tolerance * SCALE)
  offset.AddPath(toPath(points), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etOpenRound)
  const stroke: Region = []
  offset.Execute(stroke, radius * SCALE)
  const [w, h] = size
  const image = toPath([[0, 0], [w, 0], [w, h], [0, h]])
  const cut = flat(combine(ClipperLib.ClipType.ctIntersection, stroke, [image]))
  return ClipperLib.Clipper.CleanPolygons(cut, tolerance * SCALE)
}

const overlaps = (region: Region, s: Shape) =>
  paintable(s) && flat(combine(ClipperLib.ClipType.ctIntersection, solid(s), region)).length > 0

// LabelMe polygons have no holes: a hole joins its outer ring through a zero-width cut.
// Everything that reads these files (canvas, PIL, LabelMe) fills them even-odd.
function withHoles(outer: number[][], holes: number[][][]): number[][] {
  let ring = outer
  for (const hole of holes) {
    if (ringArea(hole) < MIN_AREA) continue
    // The shortest cut: from a hole's point to the nearest place on the outline
    let best = Infinity, at = 0, to = 0, join = ring[0]
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length]
      const dx = b[0] - a[0], dy = b[1] - a[1]
      hole.forEach((q, j) => {
        const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
        const p = [a[0] + t * dx, a[1] + t * dy]
        const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2
        if (d < best) { best = d; at = i; to = j; join = p }
      })
    })
    const on = join.map((v) => Math.round(v * SCALE) / SCALE)
    ring = [...ring.slice(0, at + 1), on, ...hole.slice(to), ...hole.slice(0, to + 1), on, ...ring.slice(at + 1)]
  }
  return ring
}

const parts = (tree: unknown): number[][][] =>
  ClipperLib.JS.PolyTreeToExPolygons(tree)
    .map((p: { outer: Path; holes: Path[] }) => ({ outer: fromPath(p.outer), holes: p.holes.map(fromPath) }))
    .filter((p: { outer: number[][] }) => ringArea(p.outer) >= MIN_AREA)
    .map((p: { outer: number[][]; holes: number[][][] }) => withHoles(p.outer, p.holes))

/** Add a stroke to a class. Shapes of that class it touches merge into one. */
export function paintShapes(shapes: Shape[], region: Region, label: string): Shape[] {
  // A pixel of slack: paint that exactly fills a hole or meets an edge still counts as touching
  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(region, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon)
  const reach: Region = []
  offset.Execute(reach, SCALE)
  const touched = shapes.filter((s) => s.label === label && overlaps(reach, s))
  const merged = combine(ClipperLib.ClipType.ctUnion, [...region, ...touched.flatMap(solid)])
  const base = touched[0] ? accepted(touched[0]) : newShape(label, 'polygon', [])
  const pieces = parts(merged).map((points) => ({ ...base, shape_type: 'polygon' as const, points }))
  // Later shapes win in training: a shape keeps its layer, so growing it can't cover another class
  if (!touched.length) return [...shapes, ...pieces]
  return shapes.flatMap((s) => (s === touched[0] ? pieces : touched.includes(s) ? [] : [s]))
}

/** Cut a stroke out of one shape, or out of everything it touches. Returns the same array if nothing changed. */
export function eraseShapes(shapes: Shape[], region: Region, only: number | null) {
  let changed = false
  let selected: number | null = null
  const next: Shape[] = []
  shapes.forEach((s, i) => {
    if ((only !== null && i !== only) || !overlaps(region, s)) {
      if (i === only) selected = next.length
      next.push(s)
      return
    }
    changed = true
    const pieces = parts(combine(ClipperLib.ClipType.ctDifference, solid(s), region))
    if (i === only && pieces.length === 1) selected = next.length
    pieces.forEach((points) => next.push({ ...accepted(s), shape_type: 'polygon', points }))
  })
  return { shapes: changed ? next : shapes, selected }
}
