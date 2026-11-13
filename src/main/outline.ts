import { contours } from 'd3-contour'

// The parts of a mask as rings, and pre-labelling's polygons from a model's label map. Nothing
// here loads a native module, so pre-labelling can outline in a worker thread of its own (outliner.ts).

export type Mask = { data: Uint8Array; width: number; height: number }

export function ringArea(ring: number[][]) {
  let sum = 0
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length]
    sum += x0 * y1 - x1 * y0
  }
  return Math.abs(sum) / 2
}

function segmentDistance(p: number[], a: number[], b: number[]) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

/** Douglas-Peucker on a closed ring, as skimage's approximate_polygon and OpenCV's approxPolyDP do */
export function simplifyRing(ring: number[][], tolerance: number): number[][] {
  if (ring.length <= 4) return ring
  // Split at the two points furthest apart, so the closing edge is treated like any other
  let far = 0, best = -1
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1])
    if (d > best) { best = d; far = i }
  }
  const keep = new Uint8Array(ring.length)
  keep[0] = keep[far] = 1
  const walk = (from: number, to: number) => {
    const stack = [[from, to]]
    while (stack.length) {
      const [a, b] = stack.pop()!
      let index = -1, dist = tolerance
      for (let i = a + 1; i < b; i++) {
        const d = segmentDistance(ring[i % ring.length], ring[a % ring.length], ring[b % ring.length])
        if (d > dist) { dist = d; index = i }
      }
      if (index >= 0) {
        keep[index % ring.length] = 1
        stack.push([a, index], [index, b])
      }
    }
  }
  walk(0, far)
  walk(far, ring.length)
  return ring.filter((_, i) => keep[i])
}

/** The outer rings of the parts of a mask, each with its area, largest first */
export function outerRings(mask: Mask): { ring: number[][]; area: number }[] {
  const values = new Float32Array(mask.width * mask.height)
  for (let i = 0; i < values.length; i++) values[i] = mask.data[i] ? 1 : 0
  const [contour] = contours().size([mask.width, mask.height]).thresholds([0.5])(values as unknown as number[])
  const rings = (contour?.coordinates ?? []).map((polygon) => {
    // GeoJSON closes each ring by repeating its first point
    const ring = polygon[0].slice(0, -1)
    return { ring, area: ringArea(ring) }
  })
  return rings.sort((a, b) => b.area - a.area)
}

/**
 * A ring of outerRings, which runs along the edges of a part's outer pixels, moved onto the centres
 * of those pixels, with pixel (x, y) at (x, y). labelme's shapes_to_label fills whole-number points
 * as pixel centres, so this ring gives back the part's own pixels, as OpenCV's findContours outlines
 * them, where the ring along the edges gives a column and a row more.
 */
export function throughCentres(ring: number[][], mask: Mask): number[][] {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < mask.width && y < mask.height && mask.data[y * mask.width + x] !== 0
  const out: number[][] = []
  for (const [x, y] of ring) {
    // Each point is on the edge between two pixels, the part's and another
    const p = Number.isInteger(x) ? [on(x, y - 0.5) ? x : x - 1, y - 0.5] : [x - 0.5, on(x - 0.5, y) ? y : y - 1]
    const last = out[out.length - 1]
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p)
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop()
  return out
}

function meanInside(ring: number[][], values: Uint8Array, width: number, height: number) {
  // Scanline fill of the ring, even-odd
  let total = 0, count = 0
  const ys = ring.map((p) => p[1])
  const yStart = Math.max(0, Math.floor(Math.min(...ys))), yEnd = Math.min(height - 1, Math.ceil(Math.max(...ys)))
  for (let y = yStart; y <= yEnd; y++) {
    const cy = y + 0.5
    const xs: number[] = []
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j]
      if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi))
    }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(width - 1, Math.floor(xs[k + 1] - 0.5)); x++) {
        total += values[y * width + x]
        count++
      }
    }
  }
  return count ? total / count / 255 : 0
}

/** Is the point inside the ring? Even-odd. */
function inside(ring: number[][], x: number, y: number) {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) hit = !hit
  }
  return hit
}

/**
 * The polygons of a class's pixels, as Seamline's own pre-labelling makes them with OpenCV: one
 * around each part, through the centres of its outer pixels, so that Seamline, filling them by
 * labelme's rules, trains on the pixels the model found. A part whose area, measured so, is under
 * minArea is left out, and so is a part in the hole of another, which that one's polygon covers.
 * Each comes with its ring along the pixels' edges, which holds the part's pixels, for its score.
 */
export function partPolygons(mask: Mask, minArea: number) {
  const parts = outerRings(mask).map(({ ring }) => {
    const box = [Infinity, Infinity, -Infinity, -Infinity]
    for (const [x, y] of ring) {
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y)
    }
    return { ring, box }
  })
  const polygons: { points: number[][]; ring: number[][] }[] = []
  parts.forEach(({ ring }, k) => {
    const centres = throughCentres(ring, mask)
    if (ringArea(centres) < minArea) return
    // Larger parts come first, so a part in another's hole comes after it
    const [x, y] = ring[0]
    for (let j = 0; j < k; j++) {
      const { ring: outer, box } = parts[j]
      if (x > box[0] && x < box[2] && y > box[1] && y < box[3] && inside(outer, x, y)) return
    }
    let perimeter = 0
    centres.forEach((p, i) => { const q = centres[(i + 1) % centres.length]; perimeter += Math.hypot(q[0] - p[0], q[1] - p[1]) })
    const points = simplifyRing(centres, Math.max(1, 0.002 * perimeter)).map(([px, py]) => [Math.round(px * 100) / 100, Math.round(py * 100) / 100])
    if (points.length >= 3) polygons.push({ points, ring })
  })
  return polygons
}

/** One image as a model sees it: each pixel's class, 0 for background, and how sure it is, 0-255 */
export type LabelMap = { labels: Uint8Array; confidence: Uint8Array; width: number; height: number; classes: number; minArea: number }
/** A polygon of class `k`, counted from 1, and its score: the model's mean confidence inside it */
export type Outline = { k: number; points: number[][]; score: number }

/** The polygons of every class, in order. A score is for ranking, not a probability. */
export function outlineClasses({ labels, confidence, width, height, classes, minArea }: LabelMap): Outline[] {
  const out: Outline[] = []
  for (let k = 1; k <= classes; k++) {
    const data = new Uint8Array(width * height)
    let any = false
    for (let i = 0; i < data.length; i++) if (labels[i] === k) { data[i] = 1; any = true }
    if (!any) continue
    for (const { points, ring } of partPolygons({ data, width, height }, minArea)) {
      out.push({ k, points, score: Math.round(meanInside(ring, confidence, width, height) * 1000) / 1000 })
    }
  }
  return out
}
