import { expect, test } from 'vitest'
import { newShape, type Shape } from '../../src/shared/labelfile'
import { eraseShapes, paintShapes, strokeRegion } from '../../src/renderer/src/geometry'
import { outline } from '../../src/renderer/src/shapes'

const SIZE = [400, 300]
const stroke = (points: number[][], radius = 10) => strokeRegion(points, radius, 0.5, SIZE)
const poly = (label: string, x0: number, y0: number, x1: number, y1: number): Shape =>
  newShape(label, 'polygon', [[x0, y0], [x1, y0], [x1, y1], [x0, y1]])

// Even-odd, as the canvas, PIL and LabelMe fill these polygons
function inRing(p: number[], ring: number[][]) {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}
const covered = (shapes: Shape[], p: number[]) => shapes.some((s) => inRing(p, outline(s)))

test('painting across two shapes of a class joins them, and leaves other classes alone', () => {
  const shapes = [poly('a', 10, 10, 50, 50), poly('b', 200, 200, 250, 250), poly('a', 80, 10, 120, 50)]
  const next = paintShapes(shapes, stroke([[45, 30], [85, 30]]), 'a')
  expect(next.filter((s) => s.label === 'a')).toHaveLength(1)
  expect(next.filter((s) => s.label === 'b')).toEqual([shapes[1]])
  expect(covered(next, [65, 30])).toBe(true)
})

test('paint that only meets a shape at its edge still joins it', () => {
  const holed = eraseShapes([poly('a', 50, 50, 250, 250)], stroke([[150, 150]], 30), null).shapes
  const healed = paintShapes(holed, stroke([[150, 150]], 30), 'a')
  expect(healed).toHaveLength(1)
  expect(covered(healed, [150, 150])).toBe(true)
})

test('a stroke touching nothing of its class makes a new shape on top', () => {
  const shapes = [poly('b', 10, 10, 50, 50)]
  const next = paintShapes(shapes, stroke([[30, 30]]), 'a')
  expect(next.map((s) => s.label)).toEqual(['b', 'a'])
})

test('painting a shape keeps its layer, so it can\'t cover another class in training', () => {
  const road = poly('road', 10, 10, 300, 280), car = poly('car', 100, 100, 150, 150)
  const next = paintShapes([road, car], stroke([[300, 100]]), 'road')
  expect(next.map((s) => s.label)).toEqual(['road', 'car'])
  expect(next[1]).toBe(car)
})

test('editing an AI shape accepts it', () => {
  const ai = { ...poly('a', 10, 10, 50, 50), flags: { ai: true }, other: { score: 0.4 } }
  const [painted] = paintShapes([ai], stroke([[50, 30]]), 'a')
  expect(painted.flags.ai).toBeUndefined()
  expect(painted.other.score).toBeUndefined()
  const { shapes: [erased] } = eraseShapes([ai], stroke([[50, 30]]), null)
  expect(erased.flags.ai).toBeUndefined()
  expect(erased.other.score).toBeUndefined()
})

test('erasing across a shape splits it; with a selection only that shape changes', () => {
  const shapes = [poly('a', 10, 10, 110, 50), poly('b', 10, 10, 110, 50)]
  const line = stroke([[60, 0], [60, 60]])
  expect(eraseShapes(shapes, line, null).shapes).toHaveLength(4)
  const one = eraseShapes(shapes, line, 1)
  expect(one.shapes).toHaveLength(3)
  expect(one.shapes[0]).toBe(shapes[0])
  expect(one.selected).toBeNull()
})

test('erasing keeps the selection on a shape that stays whole, and reports no change when nothing is touched', () => {
  const shapes = [poly('a', 10, 10, 110, 50), poly('a', 200, 10, 300, 50)]
  const edge = eraseShapes(shapes, stroke([[110, 30]]), 1)
  expect(edge.shapes).toBe(shapes)
  const bite = eraseShapes(shapes, stroke([[200, 30]]), 1)
  expect(bite.shapes).toHaveLength(2)
  expect(bite.selected).toBe(1)
})

test('erasing a whole shape removes it', () => {
  const shapes = [poly('a', 10, 10, 30, 30)]
  expect(eraseShapes(shapes, stroke([[20, 20]], 40), null).shapes).toEqual([])
})

test('a hole survives as one outline and heals when painted over', () => {
  const shapes = [poly('a', 50, 50, 250, 250)]
  const holed = eraseShapes(shapes, stroke([[150, 150]], 30), null).shapes
  expect(holed).toHaveLength(1)
  expect(covered(holed, [150, 150])).toBe(false)
  expect(covered(holed, [70, 70])).toBe(true)
  const twice = eraseShapes(holed, stroke([[100, 100]], 15), null).shapes
  expect(twice).toHaveLength(1)
  expect(covered(twice, [100, 100])).toBe(false)
  expect(covered(twice, [150, 150])).toBe(false)
  expect(covered(twice, [220, 220])).toBe(true)
  const healed = paintShapes(twice, stroke([[150, 150], [100, 100]], 40), 'a')
  expect(healed).toHaveLength(1)
  expect(covered(healed, [150, 150])).toBe(true)
  expect(covered(healed, [100, 100])).toBe(true)
})

test('strokes stop at the image edge', () => {
  const [shape] = paintShapes([], stroke([[0, 0]], 30), 'a')
  for (const [x, y] of shape.points) {
    expect(x).toBeGreaterThanOrEqual(0)
    expect(y).toBeGreaterThanOrEqual(0)
  }
})

// Random strokes, checked point by point against plain arithmetic on the same strokes
test('random paint and erase sequences match an independent model', () => {
  let seed = 12345
  const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
  const dist = (p: number[], a: number[], b: number[]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
  }
  const grid: number[][] = []
  for (let x = 2; x < SIZE[0]; x += 6) for (let y = 2; y < SIZE[1]; y += 6) grid.push([x, y])

  let slowest = 0, compared = 0
  for (let round = 0; round < 6; round++) {
    let shapes: Shape[] = []
    const expected = grid.map(() => false)
    const unsure = grid.map(() => false)
    for (let op = 0; op < 25; op++) {
      const radius = 6 + random() * 30
      const points = [[random() * SIZE[0], random() * SIZE[1]]]
      const length = Math.floor(random() * 40)
      for (let i = 0; i < length; i++) {
        const last = points[points.length - 1]
        points.push([
          Math.max(-20, Math.min(SIZE[0] + 20, last[0] + (random() - 0.5) * radius * 2)),
          Math.max(-20, Math.min(SIZE[1] + 20, last[1] + (random() - 0.5) * radius * 2))
        ])
      }
      const started = performance.now()
      const region = strokeRegion(points, radius, 0.5, SIZE)
      const erase = random() < 0.4
      if (region.length) {
        shapes = erase ? eraseShapes(shapes, region, null).shapes : paintShapes(shapes, region, 'a')
      }
      slowest = Math.max(slowest, performance.now() - started)
      grid.forEach((p, g) => {
        let d = Math.hypot(p[0] - points[0][0], p[1] - points[0][1])
        for (let i = 1; i < points.length; i++) d = Math.min(d, dist(p, points[i - 1], points[i]))
        // Close to a stroke's edge the answer depends on rounding, and specks are dropped on purpose
        if (Math.abs(d - radius) < 3) unsure[g] = true
        if (d < radius) expected[g] = !erase
      })
    }
    grid.forEach((p, g) => {
      if (unsure[g]) return
      compared++
      expect(covered(shapes, p), `round ${round} at ${p}`).toBe(expected[g])
    })
    // Painting a single class merges what it touches, so shapes never pile up on each other
    expect(shapes.length).toBeLessThan(25)
  }
  console.log(`geometry fuzz: ${compared} points checked, slowest stroke ${Math.round(slowest)} ms`)
  expect(compared).toBeGreaterThan(10000)
})

test('lines, points and masks are left out of paint and cuts', () => {
  const line = newShape('a', 'line', [[0, 30], [100, 30]])
  const point = newShape('a', 'point', [[40, 30]])
  const painted = paintShapes([line, point], stroke([[40, 30]], 20), 'a')
  expect(painted.slice(0, 2)).toEqual([line, point])
  expect(eraseShapes([line, point], stroke([[40, 30]], 20), null).shapes).toEqual([line, point])
})
