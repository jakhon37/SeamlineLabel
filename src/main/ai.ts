import { createHash } from 'crypto'
import { createWriteStream, existsSync, promises as fs } from 'fs'
import { homedir } from 'os'
import path from 'path'
import { net } from 'electron'
import { InferenceSession, Tensor } from 'onnxruntime-node'
import { rgbPixels } from './images'
import { type Mask, maskShape, polygonFromMask } from './masks'
import { pilResize } from './resize'

// labelme's AI polygon and AI mask, with the models labelme offers through osam: the same
// files from the same addresses, kept in osam's cache so either app can use a download.

type Blob = { url: string; hash: string; size: number }
type Kind = 'sam' | 'sam2' | 'efficientsam'
type ModelDef = { name: string; title: string; kind: Kind; encoder: Blob; decoder: Blob }

const EFFICIENT = 'https://github.com/labelmeai/efficient-sam/releases/download/onnx-models-20231225'
const SAM = 'https://github.com/wkentaro/labelme/releases/download/sam-20230416'
const SAM2 = 'https://github.com/wkentaro/osam/releases/download/sam2.1'

export const MODELS: ModelDef[] = [
  {
    name: 'efficientsam:10m', title: 'EfficientSam (speed)', kind: 'efficientsam',
    encoder: { url: `${EFFICIENT}/efficient_sam_vitt_encoder.onnx`, hash: 'sha256:7a73ee65aa2c37237c89b4b18e73082f757ffb173899609c5d97a2bbd4ebb02d', size: 24799761 },
    decoder: { url: `${EFFICIENT}/efficient_sam_vitt_decoder.onnx`, hash: 'sha256:e1afe46232c3bfa3470a6a81c7d3181836a94ea89528aff4e0f2d2c611989efd', size: 16565728 }
  },
  {
    name: 'efficientsam:latest', title: 'EfficientSam (accuracy)', kind: 'efficientsam',
    encoder: { url: `${EFFICIENT}/efficient_sam_vits_encoder.onnx`, hash: 'sha256:4cacbb23c6903b1acf87f1d77ed806b840800c5fcd4ac8f650cbffed474b8896', size: 89558337 },
    decoder: { url: `${EFFICIENT}/efficient_sam_vits_decoder.onnx`, hash: 'sha256:4727baf23dacfb51d4c16795b2ac382c403505556d0284e84c6ff3d4e8e36f22', size: 16565728 }
  },
  {
    name: 'sam:100m', title: 'Sam (speed)', kind: 'sam',
    encoder: { url: `${SAM}/sam_vit_b_01ec64.quantized.encoder.onnx`, hash: 'sha256:3346b9cc551c9902fbf3b203935e933592b22e042365f58321c17fc12641fd6a', size: 99827688 },
    decoder: { url: `${SAM}/sam_vit_b_01ec64.quantized.decoder.onnx`, hash: 'sha256:edbcf1a0afaa55621fb0abe6b3db1516818b609ea9368f309746a3afc68f7613', size: 8743656 }
  },
  {
    name: 'sam:300m', title: 'Sam (balanced)', kind: 'sam',
    encoder: { url: `${SAM}/sam_vit_l_0b3195.quantized.encoder.onnx`, hash: 'sha256:f7158a4a1fe7f670ef47ea2f7f852685425c1ed6caa40f5df86cbe2b0502034f', size: 322569107 },
    decoder: { url: `${SAM}/sam_vit_l_0b3195.quantized.decoder.onnx`, hash: 'sha256:552ebb23bf52c5e5b971ac710d1eb8dccfd88b36cc6aff881d1536d1662e6d7b', size: 8743656 }
  },
  {
    name: 'sam:latest', title: 'Sam (accuracy)', kind: 'sam',
    encoder: { url: `${SAM}/sam_vit_h_4b8939.quantized.encoder.onnx`, hash: 'sha256:a5c745fd4279efc5e5436b412200e983dafc2249ce172af6cc0002a71bb5f485', size: 656243518 },
    decoder: { url: `${SAM}/sam_vit_h_4b8939.quantized.decoder.onnx`, hash: 'sha256:020b385a45ffe51097e1acd10cd791075a86171153505f789a793bc382eef210', size: 8743656 }
  },
  {
    name: 'sam2:small', title: 'Sam2 (speed)', kind: 'sam2',
    encoder: { url: `${SAM2}/sam2.1_small_preprocess.onnx`, hash: 'sha256:06016c6dfb146ce10e4dadfdf49e88a05c8d1f97a6b7c57e150e60d2d46a72e7', size: 162703365 },
    decoder: { url: `${SAM2}/sam2.1_small.onnx`, hash: 'sha256:153aaef5047a3b95285d90cbb39dad6c7b5821bfd944dbf56483f3f735936941', size: 20642497 }
  },
  {
    name: 'sam2:latest', title: 'Sam2 (balanced)', kind: 'sam2',
    encoder: { url: `${SAM2}/sam2.1_base_plus_preprocess.onnx`, hash: 'sha256:ce95c44082b4532c25ae01e11da3c9337dab7b04341455c09ae599dc9ae5c438', size: 306084742 },
    decoder: { url: `${SAM2}/sam2.1_base_plus.onnx`, hash: 'sha256:2ad091af889b20ad2035503b4355cd8924fcf0e29fa6536924c48dc220ecdc56', size: 20642497 }
  },
  {
    name: 'sam2:large', title: 'Sam2 (accuracy)', kind: 'sam2',
    encoder: { url: `${SAM2}/sam2.1_large_preprocess.onnx`, hash: 'sha256:ab676f957528918496990f242163fd6b41a7222ae255862e846d9ab35115c12e', size: 889342060 },
    decoder: { url: `${SAM2}/sam2.1_large.onnx`, hash: 'sha256:a3ebc6b8e254bd4ca1346901b9472bc2fae9e827cfd67d67e162d0ae2b1ec9a0', size: 20642521 }
  }
]

// Bigger images are segmented on a smaller copy: SAM works at 1024 anyway, and EfficientSAM
// takes the image as it is, which costs memory
const MAX_SIDE: Record<Kind, number> = { sam: 4096, sam2: 4096, efficientsam: 2048 }

const cacheDir = () => process.env.SEAMLINE_LABEL_MODELS || path.join(homedir(), '.cache', 'osam', 'models', 'blobs')
// osam names a blob by its hash, "sha256-…" since Windows can't have ":" in a name.
// Older osam used the hash as it is, and those downloads are used too.
export function blobPath(b: Blob) {
  const current = path.join(cacheDir(), b.hash.replace('sha256:', 'sha256-'))
  const older = path.join(cacheDir(), b.hash)
  return process.platform !== 'win32' && !existsSync(current) && existsSync(older) ? older : current
}

function modelDef(name: string) {
  const m = MODELS.find((x) => x.name === name)
  if (!m) throw new Error(`Unknown model ${name}`)
  return m
}

export function listModels() {
  return MODELS.map((m) => ({
    name: m.name, title: m.title, size: m.encoder.size + m.decoder.size,
    downloaded: existsSync(blobPath(m.encoder)) && existsSync(blobPath(m.decoder))
  }))
}

async function fetchBlob(blob: Blob, progress: (done: number) => void) {
  const target = blobPath(blob)
  if (existsSync(target)) return
  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.part`
  const response = await net.fetch(blob.url)
  if (!response.ok || !response.body) throw new Error(`${path.basename(blob.url)}: HTTP ${response.status}`)
  const hash = createHash('sha256')
  const out = createWriteStream(tmp)
  let done = 0
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done: end, value } = await reader.read()
      if (end) break
      hash.update(value)
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
      done += value.length
      progress(done)
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
    const digest = `sha256:${hash.digest('hex')}`
    // A download that doesn't match is never used
    if (digest !== blob.hash) throw new Error(`${path.basename(blob.url)} didn't match its checksum`)
    await fs.rename(tmp, target)
  } catch (e) {
    out.destroy()
    await fs.rm(tmp, { force: true })
    throw e
  }
}

const downloading = new Map<string, Promise<void>>()
export function download(name: string, progress: (p: { name: string; done: number; total: number }) => void) {
  const m = modelDef(name)
  if (!downloading.has(name)) {
    const total = m.encoder.size + m.decoder.size
    const job = (async () => {
      await fetchBlob(m.encoder, (d) => progress({ name: m.title, done: d, total }))
      await fetchBlob(m.decoder, (d) => progress({ name: m.title, done: m.encoder.size + d, total }))
      progress({ name: m.title, done: total, total })
    })().finally(() => downloading.delete(name))
    downloading.set(name, job)
  }
  return downloading.get(name)!
}

// One model in memory at a time; the embeddings of the last three images, as labelme keeps
let loaded: { name: string; encoder: InferenceSession; decoder: InferenceSession } | null = null
type Embedding = { key: string; width: number; height: number; full: number[]; tensors: Record<string, Tensor> }
const embeddings: Embedding[] = []

async function sessions(name: string) {
  if (loaded?.name === name) return loaded
  const m = modelDef(name)
  if (!existsSync(blobPath(m.encoder)) || !existsSync(blobPath(m.decoder))) throw new Error(`${m.title} isn't downloaded yet`)
  if (loaded) {
    await loaded.encoder.release()
    await loaded.decoder.release()
    loaded = null
  }
  embeddings.length = 0
  const opts: InferenceSession.SessionOptions = { executionProviders: ['cpu'], graphOptimizationLevel: 'all' }
  loaded = { name, encoder: await InferenceSession.create(blobPath(m.encoder), opts), decoder: await InferenceSession.create(blobPath(m.decoder), opts) }
  return loaded
}

const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225]

async function encode(kind: Kind, encoder: InferenceSession, image: { data: Buffer; width: number; height: number }): Promise<Record<string, Tensor>> {
  const { width, height } = image
  if (kind === 'efficientsam') {
    const input = new Float32Array(3 * width * height)
    for (let i = 0; i < width * height; i++) for (let c = 0; c < 3; c++) input[c * width * height + i] = image.data[i * 3 + c] / 255
    const out = await encoder.run({ batched_images: new Tensor('float32', input, [1, 3, height, width]) })
    return { image_embeddings: out[encoder.outputNames[0]] }
  }
  const size = (encoder as any).inputMetadata?.[0]?.shape?.[2] ?? 1024
  if (kind === 'sam') {
    // Longest side to the input size, padded with zeros below and to the right
    const s = size / Math.max(width, height)
    const w = Math.round(width * s), h = Math.round(height * s)
    const pixels = pilResize(image.data, width, height, w, h)
    const input = new Float32Array(3 * size * size)
    const mean = [123.675, 116.28, 103.53], std = [58.395, 57.12, 57.375]
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 3
        for (let c = 0; c < 3; c++) input[c * size * size + y * size + x] = (pixels[p + c] - mean[c]) / std[c]
      }
    }
    const out = await encoder.run({ x: new Tensor('float32', input, [1, 3, size, size]) })
    return { image_embeddings: out[encoder.outputNames[0]] }
  }
  // SAM2 takes the image squeezed to its input size, standardised as osam 0.10 does
  const pixels = pilResize(image.data, width, height, size, size)
  const input = new Float32Array(3 * size * size)
  for (let i = 0; i < size * size; i++) for (let c = 0; c < 3; c++) input[c * size * size + i] = (pixels[i * 3 + c] / 255 - MEAN[c]) / STD[c]
  const out = await encoder.run({ input: new Tensor('float32', input, [1, 3, size, size]) })
  const [embed, feats1, feats2] = encoder.outputNames
  return { image_embeddings: out[embed], high_res_features1: out[feats1], high_res_features2: out[feats2] }
}

async function decode(kind: Kind, decoder: InferenceSession, e: Embedding, points: number[][], labels: number[], inputSize: number): Promise<Mask> {
  const { width, height } = e
  const n = points.length
  let feeds: Record<string, Tensor>
  if (kind === 'efficientsam') {
    feeds = {
      image_embeddings: e.tensors.image_embeddings,
      batched_point_coords: new Tensor('float32', Float32Array.from(points.flat()), [1, 1, n, 2]),
      batched_point_labels: new Tensor('float32', Float32Array.from(labels), [1, 1, n]),
      orig_im_size: new Tensor('int64', BigInt64Array.from([BigInt(height), BigInt(width)]), [2])
    }
  } else if (kind === 'sam') {
    const s = inputSize / Math.max(width, height)
    const w = Math.round(width * s), h = Math.round(height * s)
    const coords = [...points.map(([x, y]) => [x * (w / width), y * (h / height)]), [0, 0]].flat()
    feeds = {
      image_embeddings: e.tensors.image_embeddings,
      point_coords: new Tensor('float32', Float32Array.from(coords), [1, n + 1, 2]),
      point_labels: new Tensor('float32', Float32Array.from([...labels, -1]), [1, n + 1]),
      mask_input: new Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask_input: new Tensor('float32', Float32Array.from([-1]), [1]),
      orig_im_size: new Tensor('float32', Float32Array.from([height, width]), [2])
    }
  } else {
    const coords = points.map(([x, y]) => [x / (width / inputSize), y / (height / inputSize)]).flat()
    feeds = {
      image_embeddings: e.tensors.image_embeddings,
      high_res_features1: e.tensors.high_res_features1,
      high_res_features2: e.tensors.high_res_features2,
      point_coords: new Tensor('float32', Float32Array.from(coords), [1, n, 2]),
      point_labels: new Tensor('float32', Float32Array.from(labels), [1, n]),
      mask_input: new Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask_input: new Tensor('float32', Float32Array.from([0]), [1]),
      orig_im_size: new Tensor('int64', BigInt64Array.from([BigInt(height), BigInt(width)]), [2])
    }
  }
  const out = await decoder.run(feeds)
  const masks = out[decoder.outputNames[0]]
  const [mh, mw] = masks.dims.slice(-2)
  let pick = 0
  if (kind === 'sam2') {
    // SAM2 proposes several masks: the one it scores highest, as osam takes
    const scores = out[decoder.outputNames[1]].data as Float32Array
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[pick]) pick = i
  }
  const all = masks.data as Float32Array
  const data = new Uint8Array(mw * mh)
  const offset = pick * mw * mh
  for (let i = 0; i < data.length; i++) data[i] = all[offset + i] > 0 ? 1 : 0
  return { data, width: mw, height: mh }
}

export type SegmentResult =
  | { kind: 'polygon'; points: number[][] }
  | { kind: 'mask'; box: number[][]; mask: string }
  | { kind: 'none' }

/** Points are in the image's own pixels; label 1 is the object, 0 background, as in labelme */
export async function segment(root: string, name: string, model: string, points: number[][], labels: number[], mode: 'polygon' | 'mask'): Promise<SegmentResult> {
  const m = modelDef(model)
  const s = await sessions(model)
  const key = `${model}\0${root}\0${name}`
  let found = embeddings.find((x) => x.key === key)
  if (!found) {
    const image = await rgbPixels(root, name, MAX_SIDE[m.kind])
    const tensors = await encode(m.kind, s.encoder, image)
    found = { key, width: image.width, height: image.height, full: [image.fullWidth, image.fullHeight], tensors }
    embeddings.push(found)
    if (embeddings.length > 3) embeddings.shift()
  }
  const e = found
  const inputSize = (s.encoder as any).inputMetadata?.[0]?.shape?.[2] ?? 1024
  const [fullWidth, fullHeight] = e.full
  const scale = e.width / fullWidth
  const scaled = points.map(([x, y]) => [x * scale, y * scale])
  const mask = await decode(m.kind, s.decoder, e, scaled, labels, inputSize)
  if (!mask.data.some((v) => v)) return { kind: 'none' }
  if (mode === 'mask') {
    const shape = await maskShape(mask, fullWidth, fullHeight)
    return shape ? { kind: 'mask', ...shape } : { kind: 'none' }
  }
  const polygon = polygonFromMask(mask, mask.width / fullWidth)
  return polygon.length >= 3 ? { kind: 'polygon', points: polygon } : { kind: 'none' }
}

export async function release() {
  embeddings.length = 0
  if (loaded) {
    await loaded.encoder.release()
    await loaded.decoder.release()
    loaded = null
  }
}
