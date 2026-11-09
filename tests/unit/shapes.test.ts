import { expect, test } from 'vitest'
import { newShape } from '../../src/shared/labelfile'
import {
  addPointsToEdge, bounds, canRemovePoint, contains, insertPoint, mergePolygons, moveCorner, moveShapes, nearestEdge, nearestVertex,
  squareFrom, toEdge, vertices
} from '../../src/renderer/src/shapes'

const square = (x0: number, y0: number, x1: number, y1: number, label = 'a') =>
  newShape(label, 'polygon', [[x0, y0], [x1, y0], [x1, y1], [x0, y1]])

test('each shape type knows what it covers', () => {
  expect(contains(square(0, 0, 10, 10), [5, 5], 1)).toBe(true)
  expect(contains(newShape('a', 'rectangle', [[10, 10], [0, 0]]), [5, 5], 1)).toBe(true)
  expect(contains(newShape('a', 'circle', [[50, 50], [60, 50]]), [57, 57], 1)).toBe(true)
  expect(contains(newShape('a', 'circle', [[50, 50], [60, 50]]), [58, 58], 1)).toBe(false)
  expect(contains(newShape('a', 'line', [[0, 0], [100, 0]]), [50, 2], 3)).toBe(true)
  expect(contains(newShape('a', 'line', [[0, 0], [100, 0]]), [50, 5], 3)).toBe(false)
  expect(contains(newShape('a', 'linestrip', [[0, 0], [10, 0], [10, 10]]), [10, 5], 1)).toBe(true)
  expect(contains(newShape('a', 'point', [[5, 5]]), [6, 6], 2)).toBe(true)
  expect(bounds(newShape('a', 'circle', [[50, 50], [60, 50]]))).toEqual([40, 40, 60, 60])
})

test('vertices and edges are found within the tolerance', () => {
  const s = square(0, 0, 100, 100)
  expect(nearestVertex(s, [98, 3], 5)).toBe(1)
  expect(nearestVertex(s, [50, 50], 5)).toBe(-1)
  expect(nearestEdge(s, [50, 2], 5)).toBe(0)
  expect(nearestEdge(s, [2, 50], 5)).toBe(3)
  // Only polygons and line strips take new points
  expect(nearestEdge(newShape('a', 'rectangle', [[0, 0], [100, 100]]), [50, 0], 5)).toBe(-1)
})

test("labelme's point limits: a polygon keeps 3, a line strip 2", () => {
  expect(canRemovePoint(newShape('a', 'polygon', [[0, 0], [1, 0], [1, 1]]))).toBe(false)
  expect(canRemovePoint(square(0, 0, 1, 1))).toBe(true)
  expect(canRemovePoint(newShape('a', 'linestrip', [[0, 0], [1, 0]]))).toBe(false)
  expect(canRemovePoint(newShape('a', 'rectangle', [[0, 0], [1, 1]]))).toBe(false)
})

test('points go in where the edge is, and Ctrl+M spreads them evenly', () => {
  const s = square(0, 0, 100, 100)
  expect(insertPoint(s, 0, [50, 0]).points).toEqual([[0, 0], [50, 0], [100, 0], [100, 100], [0, 100]])
  // The closing edge, from the last point back to the first
  expect(insertPoint(s, 3, [0, 50]).points.at(-1)).toEqual([0, 50])
  expect(addPointsToEdge(s, 0, 3).points.slice(0, 5)).toEqual([[0, 0], [25, 0], [50, 0], [75, 0], [100, 0]])
})

test('moving stops at the image edge, for the whole selection together', () => {
  const shapes = [square(10, 10, 20, 20), square(80, 10, 90, 20)]
  const moved = moveShapes(shapes, [0, 1], 50, 0, 100, 100)
  expect(moved[1].points[1]).toEqual([100, 10])
  expect(moved[0].points[0]).toEqual([20, 10])
  expect(moveShapes(shapes, [1], 0, 0, 100, 100)).toBe(shapes)
})

test("all four corners of a box move, as in LabelImg; the box stays two points, as labelme keeps it", () => {
  const box = newShape('a', 'rectangle', [[10, 20], [50, 60]])
  expect(vertices(box)).toEqual([[10, 20], [50, 20], [50, 60], [10, 60]])
  expect(nearestVertex(box, [49, 59], 3)).toBe(2)
  expect(nearestVertex(box, [11, 59], 3)).toBe(3)
  // Each corner, moved: the one across stays where it was
  expect(moveCorner(box, 0, [5, 5]).points).toEqual([[5, 5], [50, 60]])
  expect(moveCorner(box, 1, [70, 15]).points).toEqual([[10, 15], [70, 60]])
  expect(moveCorner(box, 2, [40, 30]).points).toEqual([[10, 20], [40, 30]])
  expect(moveCorner(box, 3, [0, 80]).points).toEqual([[0, 20], [50, 80]])
  // Past the corner across, it turns inside out and is still the same box
  expect(bounds(moveCorner(box, 1, [0, 70]))).toEqual([0, 60, 10, 70])
})

test('Shift keeps rectangles square, and lines drawn off the image stop at its edge', () => {
  expect(squareFrom([0, 0], [10, -4])).toEqual([4, -4])
  expect(toEdge([50, 50], [150, 50], 100, 100)).toEqual([100, 50])
  expect(toEdge([50, 50], [60, 70], 100, 100)).toEqual([60, 70])
})

test('merging joins overlapping shapes and keeps the rest apart, with the first label', () => {
  const shapes = [square(0, 0, 10, 10, 'car'), square(5, 5, 15, 15, 'truck'), square(50, 50, 60, 60, 'car'), newShape('x', 'point', [[1, 1]])]
  const result = mergePolygons(shapes, [0, 1, 2])!
  expect(result.shapes).toHaveLength(3)
  expect(result.shapes.filter((s) => s.label === 'car')).toHaveLength(2)
  expect(result.shapes.at(-1)!.shape_type).toBe('point')
  expect(result.selected).toEqual([0, 1])
  expect(mergePolygons(shapes, [0])).toBeNull()
})
