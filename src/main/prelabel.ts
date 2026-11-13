import { existsSync, promises as fs } from 'fs'
import path from 'path'
import { InferenceSession, Tensor } from 'onnxruntime-node'
import sharp from 'sharp'
import { Worker } from 'worker_threads'
import { FORMAT_VERSION, isAi, newShape, serializeLabelFile, type Shape } from '../shared/labelfile'
import { rgbPixels } from './images'
import type { LabelMap, Outline } from './outline'
import { changedSince, editing, findLabels, imagePath, labelPath, readDoc, serial, writeAtomic, wrote } from './project'
import { cvResize } from './resize'
import { exportedFrom, exportedTitle } from './runs'

// Seamline's pre-labelling, for a segmentation model exported to ONNX: the image goes through
// tile by tile, each pixel takes its most likely class, and each blob of a class becomes an
// AI polygon whose score is the model's mean confidence inside it.

export type PrelabelModel = {
  path: string
  name: string
  /** The folder whose Seamline run exported it, or null */
  project: string | null
  /** Without the background, which is class 0 */
  classes: string[]
  inputSize: number[]
  tile: number
  mean: number[]
  std: number[]
}

// Optional, beside the model as <name>.json, as Seamline's export writes model.json beside model.onnx
type Sidecar = { classes?: string[]; mean?: number[]; std?: number[]; tile?: number; input_size?: number[] }

const sessions = new Map<string, InferenceSession>()
// The model pre-labelling runs with: another model read meanwhile, as when one is chosen in the menu, leaves it be
let inUse: string | null = null
async function session(file: string) {
  if (!sessions.has(file)) {
    for (const [k, s] of sessions) {
      if (k === inUse) continue
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
    name: (await exportedTitle(file)) ?? path.basename(file),
    project: exportedFrom(file),
    classes: side.classes ?? [],
    inputSize: side.input_size ?? fixed ?? [512, 512],
    tile: side.tile ?? 1024,
    // Seamline's runs take pixels scaled to 0-1, mean 0 and spread 1, and the model.json it
    // exports says so. A model without a sidecar gets ImageNet's mean and spread, which many
    // models trained elsewhere expect.
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

/** The class of each pixel, and the model's confidence in it (0-255) */
export async function predictImage(model: PrelabelModel, root: string, name: string) {
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
      const tile = new Uint8Array(pw * ph * 3)
      for (let y = 0; y < ph; y++) tile.set(image.data.subarray(((top + y) * W + left) * 3, ((top + y) * W + left + pw) * 3), y * pw * 3)
      // To the model's input as Seamline's predict resizes it, with OpenCV's bilinear: libvips' resize
      // smooths as it shrinks, which moved the uncertain pixels of small parts
      const pixels = cvResize(tile, pw, ph, inW, inH)
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
      // Softmax over classes, so the model must give raw scores, as Seamline's export does:
      // probabilities would come out flattened, and so would the shapes' scores
      const best = new Uint8Array(ow * oh)
      // The confidence as Seamline keeps it: 0-255, cut rather than rounded
      const sure = new Uint8Array(ow * oh)
      for (let i = 0; i < ow * oh; i++) {
        let max = -Infinity, arg = 0
        for (let c = 0; c < C; c++) {
          const v = data[c * ow * oh + i]
          if (v > max) { max = v; arg = c }
        }
        let sum = 0
        for (let c = 0; c < C; c++) sum += Math.exp(data[c * ow * oh + i] - max)
        best[i] = arg
        sure[i] = Math.floor(Math.fround(Math.fround(1 / sum) * 255))
      }
      // Back to the tile's own size as Seamline does it, with OpenCV's resizes: classes nearest,
      // confidence bilinear. Where tiles overlap, near the edges, the surer one's class wins, so the
      // two apps' confidences must agree for their classes to.
      const tileSure = cvResize(sure, ow, oh, pw, ph, 1)
      // OpenCV's nearest: each pixel takes the one at its place times 1 / (pw / ow), rounded down
      const nx = 1 / (pw / ow), ny = 1 / (ph / oh)
      for (let y = 0; y < ph; y++) {
        const from = Math.min(oh - 1, Math.floor(y * ny)) * ow
        for (let x = 0; x < pw; x++) {
          const c = tileSure[y * pw + x]
          const at = (top + y) * W + left + x
          if (c > confidence[at]) {
            confidence[at] = c
            labels[at] = best[from + Math.min(ow - 1, Math.floor(x * nx))]
          }
        }
      }
    }
  }
  return { labels, confidence, width: W, height: H }
}

// The worker thread a pre-label run outlines in, one image after another, so it starts once
let outliner: Worker | null = null

/**
 * The label map's polygons, worked out in a worker thread: on a big image, or on the noisy map of a
 * model early in training, that takes long enough to keep the main process from saving the window's
 * labels, and from answering a second start, which Chromium takes for a hung app after 20 s and ends
 */
function outline(map: LabelMap): Promise<Outline[]> {
  const worker = (outliner ??= new Worker(path.join(__dirname, 'outliner.js')))
  return new Promise((resolve, reject) => {
    // A worker that fails is done with: the next image starts another
    const failed = (e: Error) => {
      if (outliner === worker) outliner = null
      reject(e)
    }
    const exited = (code: number) => failed(new Error(`The shapes couldn't be outlined (code ${code})`))
    worker.once('message', (parts: Outline[]) => {
      worker.off('error', failed).off('exit', exited)
      resolve(parts)
    })
    worker.once('error', failed).once('exit', exited)
    worker.postMessage(map, [map.labels.buffer as ArrayBuffer, map.confidence.buffer as ArrayBuffer])
  })
}

/** Polygons for each class. A score is for ranking, not a probability. */
export async function predictShapes(model: PrelabelModel, root: string, name: string, classes: string[], minArea: number): Promise<Shape[]> {
  const { labels, confidence, width, height } = await predictImage(model, root, name)
  const parts = await outline({ labels, confidence, width, height, classes: classes.length, minArea })
  return parts.map(({ k, points, score }) => newShape(classes[k - 1], 'polygon', points, { flags: { ai: true }, other: { score } }))
}

let stopped = false
let running = false
export const stopPrelabel = () => { stopped = true }

export type Progress = {
  root: string; name: string; shapes: Shape[] | null; done: number; total: number
  /** Left alone: the image on screen, whose labels another app changed since the window read them */
  changed: boolean
}

/**
 * Saves as it goes, so stopping keeps what's done. Images someone has labelled are left alone, and so
 * are images the model finds nothing on, as in Seamline: a label file of no shapes would read as
 * labelled by someone. A `batch` takes images with no labels or AI shapes only, so a file emptied
 * since, as by rejecting every shape, is someone's too. `nothing` lists the images the model found nothing on.
 */
export async function prelabel(
  root: string, file: string, names: string[], classes: string[], minArea: number, progress: (p: Progress) => void, batch = false
) {
  if (running) throw new Error('Pre-labelling is already running')
  running = true
  stopped = false
  inUse = file
  const failed: string[] = []
  const nothing: string[] = []
  let done = 0
  try {
    const model = await modelInfo(file)
    const named = model.classes.length ? model.classes : classes
    if (!named.length) throw new Error('Name the classes: add labels, or list them in the model\'s .json file')
    for (const name of names) {
      if (stopped) break
      let shapes: Shape[] | null = null
      let changed = false
      try {
        const found = await predictShapes(model, root, name, named, minArea)
        const out = labelPath(root, name)
        const image = imagePath(root, name)
        shapes = await serial(async () => {
          // The window holds the labels of the image it shows: if another app changed them since it
          // read them, they're left for the window to read again. Other images are read just below.
          if (editing(root) === name && await changedSince(root, name)) {
            changed = true
            return null
          }
          // The image stays to label, or keeps the proposals it has
          if (!found.length) {
            nothing.push(name)
            return null
          }
          // Someone labelled it meanwhile, in any format: their labels win
          const existing = await findLabels(root, name)
          if (existing && existing.format !== 'labelme') return null
          const doc = await readDoc(out)
          if (doc?.shapes.some((s) => !isAi(s)) || (batch && doc && !doc.shapes.length)) return null
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
          await wrote(root, name, out, 'labelme')
          return found
        })
      } catch (e: any) {
        failed.push(`${name}: ${e.message}`)
      }
      done++
      progress({ root, name, shapes, done, total: names.length, changed })
    }
    return { done, total: names.length, stopped, failed, nothing }
  } finally {
    running = false
    inUse = null
    outliner?.terminate()
    outliner = null
  }
}
