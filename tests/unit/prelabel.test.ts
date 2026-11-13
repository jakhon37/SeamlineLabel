import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { describe, expect, test } from 'vitest'
import { outlineClasses, partPolygons } from '../../src/main/outline'
import { modelInfo, predictImage } from '../../src/main/prelabel'
import { openProject } from '../../src/main/project'

const MODEL = path.resolve(__dirname, '../fixtures/models/discs.onnx')

test("a model Seamline exported is read with its model.json: classes, pixels scaled to 0-1, tile and input size", async () => {
  const project = mkdtempSync(path.join(tmpdir(), 'seamtag-run-'))
  const run = path.join(project, '.myseg', 'runs', '20261112_101500')
  mkdirSync(run, { recursive: true })
  copyFileSync(MODEL, path.join(run, 'model.onnx'))
  writeFileSync(path.join(run, 'model.json'), JSON.stringify({ classes: ['red', 'blue'], mean: [0, 0, 0], std: [1, 1, 1], tile: 768, input_size: [64, 64] }))
  writeFileSync(path.join(run, 'options.json'), JSON.stringify({ architecture: 'Unet', encoder: 'resnet34', image_size: 64, tile: 768 }))
  const info = await modelInfo(path.join(run, 'model.onnx'))
  expect(info).toMatchObject({
    name: '20261112_101500 · Unet · resnet34', project, classes: ['red', 'blue'], mean: [0, 0, 0], std: [1, 1, 1], tile: 768, inputSize: [64, 64]
  })
})

test("without a sidecar, ImageNet's mean and spread, and the model's own input size", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'seamtag-model-'))
  copyFileSync(MODEL, path.join(dir, 'plain.onnx'))
  const info = await modelInfo(path.join(dir, 'plain.onnx'))
  expect(info).toMatchObject({ name: 'plain.onnx', project: null, classes: [], mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], tile: 1024, inputSize: [64, 64] })
})

test("a tile is resized to the model's input and back as Seamline's predict resizes it, so the classes and confidence are Seamline's", async () => {
  // Noise, so a resize that smooths moves pixels across the model's line; make_tile.py gives Seamline's answer
  const dir = mkdtempSync(path.join(tmpdir(), 'seamtag-tile-'))
  copyFileSync(path.resolve(__dirname, '../fixtures/models/tile.png'), path.join(dir, 'tile.png'))
  await openProject(dir, null)
  const { labels, confidence, width, height } = await predictImage(await modelInfo(MODEL), dir, 'tile.png')
  const seamline = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/models/tile.json'), 'utf8'))
  const rows = Array.from({ length: height }, (_, y) => Array.from(labels.subarray(y * width, (y + 1) * width)).join(''))
  expect(rows).toEqual(seamline.labels)
  // Cut to whole numbers, then resized: PyTorch and onnxruntime may put the odd one 1 apart
  const theirs = Buffer.from(seamline.confidence.join(''), 'hex')
  const gaps = Array.from(confidence, (c, i) => Math.abs(c - theirs[i]))
  expect(Math.max(...gaps)).toBeLessThanOrEqual(1)
  expect(gaps.filter((g) => g > 0).length).toBeLessThan(confidence.length / 100)
})

describe("pre-labelling's polygons, filled as Seamline trains on them", () => {
  const W = 160, H = 100

  /** A mask with these pixels on */
  function mask(on: (x: number, y: number) => boolean) {
    const data = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = on(x, y) ? 1 : 0
    return { data, width: W, height: H }
  }
  /**
   * The pixels a polygon covers as labelme's shapes_to_label fills it with Pillow, which Seamline
   * trains with: whole-number points are pixel centres, and centres on an edge count as inside
   */
  function fill(points: number[][]) {
    const out = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let hit = false
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
          const [xi, yi] = points[i], [xj, yj] = points[j]
          if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) hit = !hit
          const dx = xj - xi, dy = yj - yi
          const t = Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / (dx * dx + dy * dy || 1)))
          if (Math.hypot(x - xi - t * dx, y - yi - t * dy) < 1e-6) {
            hit = true
            break
          }
        }
        if (hit) out[y * W + x] = 1
      }
    }
    return out
  }
  /** The polygons filled, against the pixels: IoU, and their area as a share of the pixels' */
  function compare(polygons: { points: number[][] }[], pixels: Uint8Array) {
    const drawn = new Uint8Array(W * H)
    for (const { points } of polygons) fill(points).forEach((v, i) => { if (v) drawn[i] = 1 })
    let both = 0, either = 0, had = 0, got = 0
    for (let i = 0; i < drawn.length; i++) {
      both += drawn[i] & pixels[i]
      either += drawn[i] | pixels[i]
      had += pixels[i]
      got += drawn[i]
    }
    return { iou: both / either, area: got / had }
  }

  test('boxes and thin cracks come back as the very pixels found, with no column or row more', () => {
    const box = mask((x, y) => x >= 5 && x <= 14 && y >= 5 && y <= 10)
    expect(compare(partPolygons(box, 25), box.data)).toEqual({ iou: 1, area: 1 })
    // A crack 3 pixels wide would train 4 wide
    const crack = mask((x, y) => x >= 20 && x <= 139 && y >= 40 && y <= 42)
    expect(compare(partPolygons(crack, 25), crack.data)).toEqual({ iou: 1, area: 1 })
    // Against the image's edges, the points stay on it
    const corner = mask((x, y) => x >= W - 12 && y >= H - 9)
    const [{ points }] = partPolygons(corner, 25)
    expect(Math.max(...points.map((p) => p[0]))).toBe(W - 1)
    expect(Math.max(...points.map((p) => p[1]))).toBe(H - 1)
    expect(compare(partPolygons(corner, 25), corner.data)).toEqual({ iou: 1, area: 1 })
  })

  test('round and slanted parts keep their pixels to within 2%', () => {
    const blob = mask((x, y) => Math.hypot(x - 40, y - 50) <= 25 || (Math.abs((y - 20) - 0.6 * (x - 90)) <= 2.5 && x >= 90 && x <= 150))
    const { iou, area } = compare(partPolygons(blob, 25), blob.data)
    expect(iou).toBeGreaterThan(0.93)
    expect(Math.abs(area - 1)).toBeLessThan(0.02)
  })

  test('parts under the minimum area, measured as Seamline measures it, and parts in a hole are left out', () => {
    // 6 by 5 pixels measure 5 by 4 through their centres, as OpenCV's contourArea measures them
    expect(partPolygons(mask((x, y) => x >= 10 && x <= 15 && y >= 10 && y <= 14), 25)).toEqual([])
    expect(partPolygons(mask((x, y) => x >= 10 && x <= 15 && y >= 10 && y <= 15), 25)).toHaveLength(1)
    // A frame with a part in its hole: the frame's polygon covers it
    const frame = mask((x, y) => (x >= 20 && x <= 79 && y >= 10 && y <= 69 && !(x >= 30 && x <= 69 && y >= 20 && y <= 59)) || (x >= 40 && x <= 59 && y >= 30 && y <= 49))
    const polygons = partPolygons(frame, 25)
    expect(polygons).toHaveLength(1)
    expect(compare(polygons, mask((x, y) => x >= 20 && x <= 79 && y >= 10 && y <= 69).data)).toEqual({ iou: 1, area: 1 })
  })

  test("a label map's classes are outlined in order, each polygon with its class's number and the model's mean confidence inside", () => {
    // What pre-labelling's worker thread is given: class 2 sure, class 1 less so, class 3 nowhere
    const labels = new Uint8Array(W * H), confidence = new Uint8Array(W * H)
    const fillBox = (k: number, sure: number, x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { labels[y * W + x] = k; confidence[y * W + x] = sure }
    }
    fillBox(2, 255, 10, 10, 29, 29)
    fillBox(1, 102, 100, 50, 129, 69)
    fillBox(1, 102, 60, 80, 62, 81)
    const out = outlineClasses({ labels, confidence, width: W, height: H, classes: 3, minArea: 25 })
    expect(out.map(({ k, score }) => [k, score])).toEqual([[1, 0.4], [2, 1]])
    expect(compare(out.filter((o) => o.k === 1), mask((x, y) => x >= 100 && x <= 129 && y >= 50 && y <= 69).data)).toEqual({ iou: 1, area: 1 })
  })
})
