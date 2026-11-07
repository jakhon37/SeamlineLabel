import { existsSync, promises as fs } from 'fs'
import path from 'path'
import { InferenceSession, Tensor } from 'onnxruntime-node'
import sharp from 'sharp'
import { FORMAT_VERSION, isAi, newShape, serializeLabelFile, type Shape } from '../shared/labelfile'
import { rgbPixels } from './images'
import { outerRings, simplifyRing } from './masks'
import { imagePath, labelPath, readDoc, serial, writeAtomic } from './project'

// Seamline's pre-labelling, for a segmentation model exported to ONNX: the image goes through
// tile by tile, each pixel takes its most likely class, and each blob of a class becomes an
// AI polygon whose score is the model's mean confidence inside it.

export type PrelabelModel = {
  path: string
  name: string
  /** Without the background, which is class 0 */
  classes: string[]
  inputSize: number[]
  tile: number
  mean: number[]
  std: number[]
}

// Optional, beside the model as <name>.json
type Sidecar = { classes?: string[]; mean?: number[]; std?: number[]; tile?: number; input_size?: number[] }

const sessions = new Map<string, InferenceSession>()
async function session(file: string) {
  if (!sessions.has(file)) {
    for (const [k, s] of sessions) {
      await s.release()
      sessions.delete(k)
    }
    sessions.set(file, await InferenceSession.create(file, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' }))
  }
  return sessions.get(file)!
}

export async function modelInfo(file: string): Promise<PrelabelModel> {
  if (!existsSync(file)) throw new Error(`${file} doesn't exist`)
  const sidecars = [file.replace(/\.onnx$/i, '.json'), `${file}.json`]
  let side: Sidecar = {}
  for (const s of sidecars) {
    if (s !== file && existsSync(s)) {
      side = JSON.parse(await fs.readFile(s, 'utf8'))
      break
    }
  }
  const s = await session(file)
  const shape = (s as any).inputMetadata?.[0]?.shape as (number | string)[] | undefined
  const fixed = shape && typeof shape[2] === 'number' && typeof shape[3] === 'number' ? [shape[2] as number, shape[3] as number] : null
  return {
    path: file,
    name: path.basename(file),
    classes: side.classes ?? [],
    inputSize: side.input_size ?? fixed ?? [512, 512],
    tile: side.tile ?? 1024,
    // Seamline trains with ImageNet's mean and spread, as albumentations' Normalize defaults to
    mean: side.mean ?? [0.485, 0.456, 0.406],
    std: side.std ?? [0.229, 0.224, 0.225]
  }
}

/** Where tiles start along one side: they cover all of it, the last moved back to stay whole */
export function tileStarts(size: number, tile: number) {
  if (size <= tile) return [0]
  const starts: number[] = []
  for (let s = 0; s < size - tile; s += tile) starts.push(s)
  starts.push(size - tile)
  return starts
}

async function predictImage(model: PrelabelModel, root: string, name: string) {
  const s = await session(model.path)
  const image = await rgbPixels(root, name)
  const { width: W, height: H } = image
  const labels = new Uint8Array(W * H)
  const confidence = new Uint8Array(W * H)
  const [inH, inW] = model.inputSize
  const step = Math.max(W, H) > model.tile ? model.tile : Math.max(W, H)
  for (const top of tileStarts(H, step)) {
    for (const left of tileStarts(W, step)) {
      const pw = Math.min(step, W - left), ph = Math.min(step, H - top)
      const pixels = await sharp(image.data, { raw: { width: W, height: H, channels: 3 } })
        .extract({ left, top, width: pw, height: ph })
        .resize(inW, inH, { fit: 'fill', kernel: 'linear' })
        .raw().toBuffer()
      const input = new Float32Array(3 * inW * inH)
      for (let i = 0; i < inW * inH; i++) {
        for (let c = 0; c < 3; c++) input[c * inW * inH + i] = (pixels[i * 3 + c] / 255 - model.mean[c]) / model.std[c]
      }
      const out = await s.run({ [s.inputNames[0]]: new Tensor('float32', input, [1, 3, inH, inW]) })
      const result = out[s.outputNames[0]]
      const [C, oh, ow] = result.dims.slice(-3)
      if (model.classes.length && C !== model.classes.length + 1) {
        throw new Error(`The model gives ${C} classes, but ${model.classes.length} were named, plus background`)
      }
      const data = result.data as Float32Array
      // Softmax over classes, unless the model already gives probabilities
      const best = new Uint8Array(ow * oh)
      const prob = new Float32Array(ow * oh)
      for (let i = 0; i < ow * oh; i++) {
        let max = -Infinity, arg = 0
        for (let c = 0; c < C; c++) {
          const v = data[c * ow * oh + i]
          if (v > max) { max = v; arg = c }
        }
        let sum = 0
        for (let c = 0; c < C; c++) sum += Math.exp(data[c * ow * oh + i] - max)
        best[i] = arg
        prob[i] = 1 / sum
      }
      // Back to the tile's own size: classes nearest, confidence bilinear, as Seamline does
      for (let y = 0; y < ph; y++) {
        const fy = Math.max(0, Math.min(oh - 1, ((y + 0.5) * oh) / ph - 0.5))
        const y0 = Math.floor(fy), y1 = Math.min(oh - 1, y0 + 1), ty = fy - y0
        const ny = Math.min(oh - 1, Math.floor((y * oh) / ph))
        for (let x = 0; x < pw; x++) {
          const fx = Math.max(0, Math.min(ow - 1, ((x + 0.5) * ow) / pw - 0.5))
          const x0 = Math.floor(fx), x1 = Math.min(ow - 1, x0 + 1), tx = fx - x0
          const p = prob[y0 * ow + x0] * (1 - tx) * (1 - ty) + prob[y0 * ow + x1] * tx * (1 - ty) + prob[y1 * ow + x0] * (1 - tx) * ty + prob[y1 * ow + x1] * tx * ty
          const c = Math.round(p * 255)
          const at = (top + y) * W + left + x
          // Tiles overlap near the edges: keep whichever is surer
          if (c > confidence[at]) {
            confidence[at] = c
            labels[at] = best[ny * ow + Math.min(ow - 1, Math.floor((x * ow) / pw))]
          }
        }
      }
    }
  }
  return { labels, confidence, width: W, height: H }
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

/** Polygons for each class. A score is for ranking, not a probability. */
export async function predictShapes(model: PrelabelModel, root: string, name: string, classes: string[], minArea: number): Promise<Shape[]> {
  const { labels, confidence, width, height } = await predictImage(model, root, name)
  const shapes: Shape[] = []
  classes.forEach((label, k) => {
    const index = k + 1
    const data = new Uint8Array(width * height)
    let any = false
    for (let i = 0; i < data.length; i++) if (labels[i] === index) { data[i] = 1; any = true }
    if (!any) return
    for (const { ring, area } of outerRings({ data, width, height })) {
      if (area < minArea) continue
      let perimeter = 0
      ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]; perimeter += Math.hypot(q[0] - p[0], q[1] - p[1]) })
      const points = simplifyRing(ring, Math.max(1, 0.002 * perimeter)).map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100])
      if (points.length < 3) continue
      const score = Math.round(meanInside(ring, confidence, width, height) * 1000) / 1000
      shapes.push(newShape(label, 'polygon', points, { flags: { ai: true }, other: { score } }))
    }
  })
  return shapes
}

let stopped = false
let running = false
export const stopPrelabel = () => { stopped = true }

export type Progress = { root: string; name: string; shapes: Shape[] | null; done: number; total: number }

/** Saves as it goes, so stopping keeps what's done. Images someone has labelled are left alone. */
export async function prelabel(root: string, file: string, names: string[], classes: string[], minArea: number, progress: (p: Progress) => void) {
  if (running) throw new Error('Pre-labelling is already running')
  running = true
  stopped = false
  const failed: string[] = []
  let done = 0
  try {
    const model = await modelInfo(file)
    const named = model.classes.length ? model.classes : classes
    if (!named.length) throw new Error('Name the classes: add labels, or list them in the model\'s .json file')
    for (const name of names) {
      if (stopped) break
      let shapes: Shape[] | null = null
      try {
        const found = await predictShapes(model, root, name, named, minArea)
        const out = labelPath(root, name)
        const image = imagePath(root, name)
        shapes = await serial(async () => {
          const doc = await readDoc(out)
          // Someone labelled it meanwhile: their shapes win
          if (doc?.shapes.some((s) => !isAi(s))) return null
          const meta = await sharp(image, { limitInputPixels: false }).metadata()
          const swapped = (meta.orientation ?? 1) >= 5
          await writeAtomic(out, serializeLabelFile({
            version: doc?.version ?? FORMAT_VERSION,
            flags: doc?.flags ?? {},
            shapes: found,
            imagePath: path.relative(path.dirname(out), image).split(path.sep).join('/'),
            imageData: doc?.imageData ?? null,
            imageHeight: swapped ? meta.width! : meta.height!,
            imageWidth: swapped ? meta.height! : meta.width!,
            other: doc?.other ?? {}
          }))
          return found
        })
      } catch (e: any) {
        failed.push(`${name}: ${e.message}`)
      }
      done++
      progress({ root, name, shapes, done, total: names.length })
    }
    return { done, total: names.length, stopped, failed }
  } finally {
    running = false
  }
}
