import { readFileSync } from 'fs'
import path from 'path'
import { gunzipSync } from 'zlib'
import { describe, expect, test } from 'vitest'
import { Tokenizer } from '../../src/main/clip'
import { type Detection, type ExistingShape, matchExisting, nms, shapesFromDetections, suppressGreedy } from '../../src/main/detections'
import { circleFromMask, type Grid, orientedRectFromMask, polygonsFromMask } from '../../src/main/polygonize'

// What labelme 7.9.1 and osam 0.10.2 make of the same inputs: tests/fixtures/labelme7/make_ai_shapes.py
const ref = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/labelme7/ai_shapes.json'), 'utf8'))

const grid = (rows: string[]): Grid => {
  const height = rows.length, width = rows[0]?.length ?? 0
  const data = new Uint8Array(width * height)
  rows.forEach((row, y) => { for (let x = 0; x < width; x++) data[y * width + x] = row[x] === '1' ? 1 : 0 })
  return { data, width, height }
}

const detection = (d: any): Detection => ({ box: d.box, mask: d.rows ? grid(d.rows) : null, label: d.label ?? undefined, score: d.score })

function expectPoints(actual: number[][], expected: number[][], what: string) {
  expect(actual.length, `${what}: number of points`).toBe(expected.length)
  actual.forEach((p, i) => {
    expect(Math.abs(p[0] - expected[i][0]), `${what} point ${i} x`).toBeLessThan(1e-3)
    expect(Math.abs(p[1] - expected[i][1]), `${what} point ${i} y`).toBeLessThan(1e-3)
  })
}

// Distance from a point to a closed polygon's outline
function toOutline(p: number[], polygon: number[][]) {
  let best = Infinity
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy))
  }
  return best
}

const area = (q: number[][]) => Math.abs(q.reduce((s, p, i) => s + p[0] * q[(i + 1) % q.length][1] - q[(i + 1) % q.length][0] * p[1], 0)) / 2

// On a perfectly round mask, many points are equally far from a line, and the last bit of sin
// and cos (the C library's in numpy, V8's here) decides which becomes a vertex. Both are right,
// so for these the polygons must trace the same outline, and the rectangles have the same area.
const SYMMETRIC = ['disc', 'ring']

describe("masks to shapes, as labelme 7's _geometry.py makes them", () => {
  for (const [name, entry] of Object.entries<any>(ref.masks)) {
    test(name, () => {
      const g = grid(entry.rows)
      for (const [detail, polygons] of Object.entries<number[][][]>(entry.polygons)) {
        const ours = polygonsFromMask(g, Number(detail))
        const what = `${name} at detail ${detail}`
        expect(ours.length, `${what}: number of polygons`).toBe(polygons.length)
        ours.forEach((p, i) => {
          if (!SYMMETRIC.includes(name)) return expectPoints(p, polygons[i], `${what}, polygon ${i}`)
          expect(Math.abs(p.length - polygons[i].length), `${what}: number of points`).toBeLessThanOrEqual(2)
          for (const q of p) expect(toOutline(q, polygons[i]), `${what}: off labelme's outline`).toBeLessThan(1)
          for (const q of polygons[i]) expect(toOutline(q, p), `${what}: labelme's point off ours`).toBeLessThan(1)
        })
      }
      const circle = circleFromMask(g)
      if (entry.circle === null) expect(circle).toBeNull()
      else {
        expect(circle!.cx).toBeCloseTo(entry.circle[0], 9)
        expect(circle!.cy).toBeCloseTo(entry.circle[1], 9)
        expect(circle!.radius).toBeCloseTo(entry.circle[2], 9)
      }
      const rect = orientedRectFromMask(g)
      if (entry.oriented_rectangle === null) expect(rect).toBeNull()
      else if (SYMMETRIC.includes(name)) expect(area(rect!)).toBeCloseTo(area(entry.oriented_rectangle), 3)
      else expectPoints(rect!, entry.oriented_rectangle, `${name} rotated rectangle`)
    })
  }
})

describe("repeats and shapes already drawn, as labelme 7's _suppression.py finds them", () => {
  test('greedy suppression keeps the first of each overlapping or nested group, per label', () => {
    const detections = ref.greedy.detections.map(detection)
    for (const [threshold, kept] of Object.entries<number[]>(ref.greedy.kept)) {
      expect(suppressGreedy(detections, Number(threshold)).map((d) => detections.indexOf(d)), `IoU ${threshold}`).toEqual(kept)
    }
  })

  test('detections over drawn shapes are dropped, and those shapes named', () => {
    const existing: ExistingShape[] = ref.match.existing.map((s: any) => ({ ...s, mask: s.rows ? grid(s.rows) : undefined }))
    const detections = ref.match.detections.map(detection)
    const { fresh, matched } = matchExisting(detections, existing)
    expect(fresh.map((d) => detections.indexOf(d))).toEqual(ref.match.fresh)
    expect(matched).toEqual(ref.match.matched)
  })
})

describe("detections to shapes of every kind, as labelme 7's _shape_builders.py builds them", () => {
  for (const [type, shapes] of Object.entries<any[]>(ref.built.shapes)) {
    test(type, () => {
      const ours = shapesFromDetections(ref.built.detections.map(detection), type as any, [100, 100], 60)
      expect(ours.map((s) => [s.shape_type, s.label, s.group_id ?? null])).toEqual(shapes.map((s) => [s.shape_type, s.label, s.group_id]))
      ours.forEach((s, i) => expectPoints(s.points, shapes[i].points, `${type} ${i}`))
    })
  }
})

describe("osam's non-maximum suppression", () => {
  for (const run of ref.nms.runs) {
    test(`IoU ${run.iou}, score over ${run.score}, at most ${run.max}`, () => {
      const kept = nms(ref.nms.boxes, ref.nms.scores, run.iou, run.score, run.max)
      expect(kept.map((k) => k.index)).toEqual(run.indices)
      expect(kept.map((k) => k.label)).toEqual(run.labels)
      expect(kept.map((k) => k.score)).toEqual(run.scores.map(Math.fround))
    })
  }
})

describe("CLIP's tokens, as osam's tokenizer gives them", () => {
  const merges = gunzipSync(readFileSync(path.join(__dirname, '../../resources/clip/bpe_simple_vocab_16e6.txt.gz'))).toString('utf8')
  const tokenizer = new Tokenizer(merges)
  for (const [text, tokens] of Object.entries<number[]>(ref.tokens)) {
    test(JSON.stringify(text), () => {
      const ours = [...tokenizer.tokenize([text], 77)].map(Number).filter(Boolean)
      expect(ours).toEqual(tokens)
    })
  }
  test('a prompt longer than the context is refused', () => {
    expect(() => tokenizer.tokenize(['word '.repeat(40)], 32)).toThrow(/too long/)
  })
})
