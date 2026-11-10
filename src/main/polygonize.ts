// labelme 7's masks to shapes (its _automation/_geometry.py): polygons around every part of
// a mask that's big enough for the detail asked for, smoothed and simplified; the circle of
// the same area; and the smallest rotated rectangle. scikit-image's find_contours and
// approximate_polygon and SciPy's morphology are ported with them, so the shapes come out as
// labelme's do.

/** A mask the size of its own box: 1 for the object */
export type Grid = { data: Uint8Array; width: number; height: number }

type Point = [number, number]

const F32_EPS = 1.1920928955078125e-7

/** labelme's _compute_polygon_deviation: how far, in pixels, a polygon may stray from the mask */
export function polygonDeviation(detail: number) {
  const loss = (100 - detail) / 20
  return 0.5 * loss ** 1.5
}

// scikit-image's _get_contour_segments at level 0.5, low values face-connected
function contourSegments(g: Grid): [Point, Point][] {
  const { data, width: w, height: h } = g
  const segments: [Point, Point][] = []
  const frac = (from: number, to: number) => (to === from ? 0 : (0.5 - from) / (to - from))
  for (let r0 = 0; r0 < h - 1; r0++) {
    for (let c0 = 0; c0 < w - 1; c0++) {
      const r1 = r0 + 1, c1 = c0 + 1
      const ul = data[r0 * w + c0], ur = data[r0 * w + c1], ll = data[r1 * w + c0], lr = data[r1 * w + c1]
      const square = (ul > 0.5 ? 1 : 0) + (ur > 0.5 ? 2 : 0) + (ll > 0.5 ? 4 : 0) + (lr > 0.5 ? 8 : 0)
      if (square === 0 || square === 15) continue
      const top: Point = [r0, c0 + frac(ul, ur)]
      const bottom: Point = [r1, c0 + frac(ll, lr)]
      const left: Point = [r0 + frac(ul, ll), c0]
      const right: Point = [r0 + frac(ur, lr), c1]
      switch (square) {
        case 1: segments.push([top, left]); break
        case 2: segments.push([right, top]); break
        case 3: segments.push([right, left]); break
        case 4: segments.push([left, bottom]); break
        case 5: segments.push([top, bottom]); break
        case 6: segments.push([right, top], [left, bottom]); break
        case 7: segments.push([right, bottom]); break
        case 8: segments.push([bottom, right]); break
        case 9: segments.push([top, left], [bottom, right]); break
        case 10: segments.push([bottom, top]); break
        case 11: segments.push([bottom, left]); break
        case 12: segments.push([left, right]); break
        case 13: segments.push([top, right]); break
        case 14: segments.push([left, top]); break
      }
    }
  }
  return segments
}

/** A deque of points: what scikit-image builds contours in */
class Chain {
  front: Point[] = []
  back: Point[] = []
  id: number
  constructor(id: number) {
    this.id = id
  }
  first() { return this.front.length ? this.front[this.front.length - 1] : this.back[0] }
  last() { return this.back.length ? this.back[this.back.length - 1] : this.front[0] }
  appendLeft(p: Point) { this.front.push(p) }
  append(p: Point) { this.back.push(p) }
  points() { return [...this.front].reverse().concat(this.back) }
}

const key = (p: Point) => `${p[0]},${p[1]}`

/** scikit-image's find_contours(image, 0.5, fully_connected='low', positive_orientation='low'): rows and columns */
export function findContours(g: Grid): Point[][] {
  let next = 0
  const contours = new Map<number, Chain>()
  const starts = new Map<string, Chain>()
  const ends = new Map<string, Chain>()
  for (const [from, to] of contourSegments(g)) {
    if (from[0] === to[0] && from[1] === to[1]) continue
    const tail = starts.get(key(to))
    starts.delete(key(to))
    const head = ends.get(key(from))
    ends.delete(key(from))
    if (tail && head) {
      if (tail === head) {
        head.append(to)
      } else if (tail.id > head.id) {
        // Keep the contour made first, so they stay in order left to right, top to bottom
        for (const p of tail.points()) head.append(p)
        contours.delete(tail.id)
        starts.set(key(head.first()), head)
        ends.set(key(head.last()), head)
      } else {
        const hp = head.points()
        for (let i = hp.length - 1; i >= 0; i--) tail.appendLeft(hp[i])
        starts.delete(key(head.first()))
        contours.delete(head.id)
        starts.set(key(tail.first()), tail)
        ends.set(key(tail.last()), tail)
      }
    } else if (!tail && !head) {
      const chain = new Chain(next++)
      chain.append(from)
      chain.append(to)
      contours.set(chain.id, chain)
      starts.set(key(from), chain)
      ends.set(key(to), chain)
    } else if (tail) {
      tail.appendLeft(from)
      starts.set(key(from), tail)
    } else {
      head!.append(to)
      ends.set(key(to), head!)
    }
  }
  return [...contours.values()].sort((a, b) => a.id - b.id).map((c) => c.points())
}

/** SciPy's binary_fill_holes with a 3x3 structure: background not 8-connected to the edge becomes object */
export function fillHoles(g: Grid): Uint8Array {
  const { data, width: w, height: h } = g
  const outside = new Uint8Array(w * h)
  const stack: number[] = []
  const visit = (i: number) => {
    if (!data[i] && !outside[i]) {
      outside[i] = 1
      stack.push(i)
    }
  }
  for (let x = 0; x < w; x++) { visit(x); visit((h - 1) * w + x) }
  for (let y = 0; y < h; y++) { visit(y * w); visit(y * w + w - 1) }
  while (stack.length) {
    const i = stack.pop()!
    const x = i % w, y = (i - x) / w
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) visit(ny * w + nx)
      }
    }
  }
  const out = new Uint8Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1
  return out
}

// Squared distance to the nearest 0, along one line (Felzenszwalb and Huttenlocher)
function distance1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
}

/**
 * SciPy's binary_erosion with a disc of this radius, the outside counting as background: a
 * pixel stays when no background pixel lies within the disc, which an exact distance
 * transform answers in one pass instead of a test per pixel of the disc.
 */
export function erodeDisc(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const pad = Math.ceil(radius) + 1
  const W = w + 2 * pad, H = h + 2 * pad
  const big = 1e20
  const grid = new Float64Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = x >= pad && y >= pad && x < pad + w && y < pad + h && mask[(y - pad) * w + (x - pad)]
      grid[y * W + x] = inside ? big : 0
    }
  }
  const n = Math.max(W, H)
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1)
  const v = new Int32Array(n)
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = grid[y * W + x]
    distance1d(f, H, d, v, z)
    for (let y = 0; y < H; y++) grid[y * W + x] = d[y]
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = grid[y * W + x]
    distance1d(f, W, d, v, z)
    for (let x = 0; x < W; x++) grid[y * W + x] = d[x]
  }
  const r2 = radius * radius
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = grid[(y + pad) * W + x + pad] > r2 ? 1 : 0
  return out
}

/** SciPy's binary_propagation: the 4-connected parts of `within` that hold a seed */
export function propagate(seed: Uint8Array, within: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  const stack: number[] = []
  for (let i = 0; i < seed.length; i++) if (seed[i] && within[i]) { out[i] = 1; stack.push(i) }
  while (stack.length) {
    const i = stack.pop()!
    const x = i % w, y = (i - x) / w
    const near = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]
    for (const j of near) if (j >= 0 && within[j] && !out[j]) { out[j] = 1; stack.push(j) }
  }
  return out
}

/** labelme's _filter_lands_beyond_deviation: drop the parts of a mask a polygon this loose couldn't hold */
function keepLands(g: Grid, deviation: number): Grid {
  const { width: w, height: h } = g
  const filled = fillHoles(g)
  const eroded = erodeDisc(filled, w, h, deviation + 0.5)
  const lands = propagate(eroded, filled, w, h)
  const data = new Uint8Array(w * h)
  for (let i = 0; i < data.length; i++) data[i] = g.data[i] & lands[i]
  return { data, width: w, height: h }
}

/** numpy's sum of a float64 array (pairwise, eight running sums), so the rounding is numpy's */
function numpySum(a: number[]): number {
  const n = a.length
  if (n < 8) {
    let s = -0
    for (const v of a) s += v
    return s
  }
  if (n > 128) {
    const half = Math.floor(n / 2 / 8) * 8
    return numpySum(a.slice(0, half)) + numpySum(a.slice(half))
  }
  const r = a.slice(0, 8)
  let i = 8
  for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[i + j]
  let s = (r[0] + r[1] + (r[2] + r[3])) + (r[4] + r[5] + (r[6] + r[7]))
  for (; i < n; i++) s += a[i]
  return s
}

/**
 * SciPy's gaussian_filter1d along a closed ring of points (mode 'wrap', truncate 4), summed in
 * SciPy's order: the centre, then each pair of neighbours from the outside in. Polygon
 * vertices are chosen by the furthest point, so rounding decides between equal ones.
 */
export function smoothRing(points: Point[], sigma: number): Point[] {
  const radius = Math.trunc(4 * sigma + 0.5)
  const sigma2 = sigma * sigma
  const raw: number[] = []
  for (let x = -radius; x <= radius; x++) raw.push(Math.exp((-0.5 / sigma2) * (x * x)))
  const total = numpySum(raw)
  const w = raw.map((v) => v / total)
  const n = points.length
  const at = (i: number) => points[((i % n) + n) % n]
  return points.map((p, i) => {
    let x = p[0] * w[radius], y = p[1] * w[radius]
    for (let j = -radius; j < 0; j++) {
      const a = at(i + j), b = at(i - j)
      x += (a[0] + b[0]) * w[radius + j]
      y += (a[1] + b[1]) * w[radius + j]
    }
    return [x, y] as Point
  })
}

/** scikit-image's approximate_polygon (Douglas-Peucker), step for step */
export function approximatePolygon(coords: Point[], tolerance: number): Point[] {
  if (tolerance <= 0) return coords
  const n = coords.length
  const chain = new Uint8Array(n)
  const dists = new Float64Array(n)
  chain[0] = chain[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [start, end] = stack.pop()!
    const [r0, c0] = coords[start]
    const [r1, c1] = coords[end]
    const dr = r1 - r0, dc = c1 - c0
    const angle = -Math.atan2(dr, dc)
    const cos = Math.cos(angle), sin = Math.sin(angle)
    const segmentDist = c0 * sin + r0 * cos
    let best = -1, bestDist = -Infinity, over = false
    for (let i = start + 1; i < end; i++) {
      const [r, c] = coords[i]
      const dr0 = r - r0, dc0 = c - c0, dr1 = r - r1, dc1 = c - c1
      const perp = dr0 * dr + dc0 * dc > 0 && -dr1 * dr - dc1 * dc > 0
      dists[i] = perp
        ? Math.abs(r * cos + c * sin - segmentDist)
        : Math.min(Math.sqrt(dc0 * dc0 + dr0 * dr0), Math.sqrt(dc1 * dc1 + dr1 * dr1))
      if (dists[i] > tolerance) over = true
      if (dists[i] > bestDist) { bestDist = dists[i]; best = i }
    }
    if (over) {
      stack.push([best, end], [start, best])
      chain[best] = 1
    }
  }
  return coords.filter((_, i) => chain[i])
}

function signedArea(points: Point[]) {
  const [x0, y0] = points[0]
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i], [bx, by] = points[(i + 1) % points.length]
    sum += (ax - x0) * (by - y0) - (bx - x0) * (ay - y0)
  }
  return sum / 2
}

const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1]

/** labelme's _simplify_contour: a contour, in rows and columns, to a polygon of x and y */
function simplifyContour(contour: Point[], detail: number, w: number, h: number): Point[] {
  let points: Point[] = contour.map(([r, c]) => [c, r])
  if (same(points[0], points[points.length - 1])) points = points.slice(0, -1)
  const deviation = polygonDeviation(detail)
  const sigma = deviation / 2
  let tolerance = deviation
  if (sigma > 0) {
    let smoothed = smoothRing(points, sigma)
    let shift = 0
    for (let i = 0; i < points.length; i++) {
      const dx = smoothed[i][0] - points[i][0], dy = smoothed[i][1] - points[i][1]
      shift = Math.max(shift, Math.sqrt(dx * dx + dy * dy))
    }
    const budget = deviation / 2
    // Smoothing spends part of the error the simplification may make
    if (shift > budget) {
      const k = budget / shift
      smoothed = points.map((p, i) => [p[0] + (smoothed[i][0] - p[0]) * k, p[1] + (smoothed[i][1] - p[1]) * k])
      shift = budget
    }
    points = smoothed
    tolerance -= shift
  }
  let simplified = approximatePolygon([...points, points[0]], Math.max(tolerance, F32_EPS))
  if (same(simplified[0], simplified[simplified.length - 1])) simplified = simplified.slice(0, -1)
  simplified = simplified.map(([x, y]) => [Math.min(Math.max(x, 0), w), Math.min(Math.max(y, 0), h)])
  simplified = simplified.filter((p, i) => i === 0 || !same(p, simplified[i - 1]))
  const final = approximatePolygon([...simplified, simplified[0]], F32_EPS).slice(0, -1)
  return final.map(([x, y]) => [Math.fround(x), Math.fround(y)])
}

/** labelme's compute_polygons_from_mask: one polygon per part of the mask, holes left out */
export function polygonsFromMask(g: Grid, detail = 60): Point[][] {
  if (!(detail >= 0 && detail <= 100)) throw new Error(`detail must be between 0 and 100, got ${detail}`)
  if (!g.data.some((v) => v)) return []
  const deviation = polygonDeviation(detail)
  if (deviation > 0) g = keepLands(g, deviation)
  if (!g.data.some((v) => v)) return []
  // A row and column of background around it, so parts at the edge close too
  const W = g.width + 2, H = g.height + 2
  const padded = new Uint8Array(W * H)
  for (let y = 0; y < g.height; y++) padded.set(g.data.subarray(y * g.width, (y + 1) * g.width), (y + 1) * W + 1)
  const polygons: Point[][] = []
  for (const contour of findContours({ data: padded, width: W, height: H })) {
    const local = contour.map(([r, c]) => [r - 1, c - 1] as Point)
    if (signedArea(local.map(([r, c]) => [c, r])) <= 0) continue
    const polygon = simplifyContour(local, detail, g.width, g.height)
    if (polygon.length >= 3) polygons.push(polygon)
  }
  return polygons
}

/** labelme's compute_circle_from_mask: the centre of the pixels, and the radius of a disc of their area */
export function circleFromMask(g: Grid): { cx: number; cy: number; radius: number } | null {
  let n = 0, sx = 0, sy = 0
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (!g.data[y * g.width + x]) continue
      n++
      sx += x
      sy += y
    }
  }
  if (!n) return null
  return { cx: sx / n, cy: sy / n, radius: Math.sqrt(n / Math.PI) }
}

const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

/** The convex hull, counter-clockwise, without points along its edges; null when all are in a line */
export function convexHull(points: Point[]): Point[] | null {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const lower: Point[] = [], upper: Point[] = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1))
  return hull.length >= 3 ? hull : null
}

/** labelme's _min_area_rect: rotating calipers over the hull, corners in a fixed order */
export function minAreaRect(hull: Point[]): Point[] {
  let bestArea = Infinity
  let best: Point[] = []
  const n = hull.length
  for (let i = 0; i < n; i++) {
    const a = hull[i], b = hull[(i + 1) % n]
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (length === 0) continue
    const u: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length]
    const perp: Point = [-u[1], u[0]]
    let uMin = Infinity, uMax = -Infinity, pMin = Infinity, pMax = -Infinity
    for (const p of hull) {
      const pu = p[0] * u[0] + p[1] * u[1], pp = p[0] * perp[0] + p[1] * perp[1]
      uMin = Math.min(uMin, pu); uMax = Math.max(uMax, pu)
      pMin = Math.min(pMin, pp); pMax = Math.max(pMax, pp)
    }
    const uExtent = uMax - uMin, pExtent = pMax - pMin
    const area = uExtent * pExtent
    if (area >= bestArea) continue
    bestArea = area
    const cu = (uMin + uMax) / 2, cp = (pMin + pMax) / 2
    const center: Point = [cu * u[0] + cp * perp[0], cu * u[1] + cp * perp[1]]
    let [long, halfLong, halfShort] = uExtent >= pExtent ? [u, uExtent / 2, pExtent / 2] as const : [perp, pExtent / 2, uExtent / 2] as const
    // The long axis points right, or down when upright, so the corners come in the same order everywhere
    if (long[0] < 0 || (long[0] === 0 && long[1] < 0)) long = [-long[0], -long[1]]
    const short: Point = [-long[1], long[0]]
    const corner = (sl: number, ss: number): Point => [
      center[0] + long[0] * halfLong * sl + short[0] * halfShort * ss,
      center[1] + long[1] * halfLong * sl + short[1] * halfShort * ss
    ]
    best = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]
  }
  return best
}

/** labelme's compute_oriented_rectangle_from_mask */
export function orientedRectFromMask(g: Grid): Point[] | null {
  const points: Point[] = []
  for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) if (g.data[y * g.width + x]) points.push([x, y])
  if (points.length < 3) return null
  const hull = convexHull(points)
  if (!hull) return null
  return minAreaRect(hull).map(([x, y]) => [Math.fround(x), Math.fround(y)])
}
