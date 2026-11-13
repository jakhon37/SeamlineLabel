import sharp from 'sharp'
import { roundHalfEven } from './detections'
import { type Mask, outerRings, simplifyRing } from './outline'

// Masks to the shapes labelme makes of them: a polygon around the largest part, or a
// labelme mask shape (a box and the pixels inside it as a PNG of 0s and 1s).

/** labelme's compute_polygon_from_mask: the largest part, simplified by 0.4% of its size */
export function polygonFromMask(mask: Mask, scale = 1): number[][] {
  const [largest] = outerRings(mask)
  if (!largest) return []
  const xs = largest.ring.map((p) => p[0]), ys = largest.ring.map((p) => p[1])
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  const ring = simplifyRing(largest.ring, Math.max(0.5, size * 0.004))
  return ring.map(([x, y]) => [Math.round((x / scale) * 100) / 100, Math.round((y / scale) * 100) / 100])
}

/** A mask's pixels as labelme stores them in a mask shape: a greyscale PNG of 0s and 1s, base64 */
export async function encodeMask(data: Uint8Array, width: number, height: number) {
  // Greyscale, as labelme writes it: sharp would otherwise widen one channel to RGB
  const png = await sharp(Buffer.from(data), { raw: { width, height, channels: 1 } }).toColourspace('b-w').png().toBuffer()
  return png.toString('base64')
}

/** A mask shape's PNG back to pixels: 1 wherever the PNG isn't 0 */
export async function decodeMask(base64: string): Promise<Mask> {
  const { data, info } = await sharp(Buffer.from(base64, 'base64')).extractChannel(0).raw().toBuffer({ resolveWithObject: true })
  const out = new Uint8Array(info.width * info.height)
  for (let i = 0; i < out.length; i++) out[i] = data[i * info.channels] ? 1 : 0
  return { data: out, width: info.width, height: info.height }
}

/**
 * labelme's mask shape: the box of the mask, both corners inclusive as imgviz gives it, and
 * the pixels inside as a PNG of 0s and 1s, exactly what labelme's shapes_to_label puts back.
 */
export async function maskShape(mask: Mask, fullWidth: number, fullHeight: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (!mask.data[y * mask.width + x]) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return null
  // A mask computed on a smaller copy of the image is scaled up to the image's own pixels
  const sx = fullWidth / mask.width, sy = fullHeight / mask.height
  const box = [Math.floor(x0 * sx), Math.floor(y0 * sy), Math.min(fullWidth, Math.ceil((x1 + 1) * sx)) - 1, Math.min(fullHeight, Math.ceil((y1 + 1) * sy)) - 1]
  const w = box[2] - box[0] + 1, h = box[3] - box[1] + 1
  const crop = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const my = Math.min(mask.height - 1, Math.floor((box[1] + y + 0.5) / sy))
    for (let x = 0; x < w; x++) {
      const mx = Math.min(mask.width - 1, Math.floor((box[0] + x + 0.5) / sx))
      crop[y * w + x] = mask.data[my * mask.width + mx] ? 1 : 0
    }
  }
  // Greyscale, as labelme writes it: sharp would otherwise widen one channel to RGB
  const png = await sharp(Buffer.from(crop), { raw: { width: w, height: h, channels: 1 } }).toColourspace('b-w').png().toBuffer()
  return { box: [[box[0], box[1]], [box[2], box[3]]], mask: png.toString('base64') }
}

/**
 * labelme 7's merge_masks: mask shapes of one label become one, every pixel kept. The box
 * covers all of them, and each mask's own pixels where they reach past its box.
 */
export async function mergeMasks(shapes: { points: number[][]; mask: string }[]) {
  const placed = await Promise.all(shapes.map(async (s) => {
    const [[x0, y0], [x1, y1]] = s.points.map((p) => p.map(roundHalfEven))
    return { x0, y0, x1, y1, m: await decodeMask(s.mask) }
  }))
  const xmin = Math.min(...placed.map((p) => p.x0)), ymin = Math.min(...placed.map((p) => p.y0))
  const xmax = Math.max(...placed.map((p) => p.x1)), ymax = Math.max(...placed.map((p) => p.y1))
  const height = Math.max(ymax - ymin + 1, ...placed.map((p) => p.y0 - ymin + p.m.height))
  const width = Math.max(xmax - xmin + 1, ...placed.map((p) => p.x0 - xmin + p.m.width))
  const data = new Uint8Array(width * height)
  for (const { x0, y0, m } of placed) {
    for (let y = 0; y < m.height; y++) {
      for (let x = 0; x < m.width; x++) if (m.data[y * m.width + x]) data[(y0 - ymin + y) * width + (x0 - xmin + x)] = 1
    }
  }
  return { points: [[xmin, ymin], [xmin + width - 1, ymin + height - 1]], mask: await encodeMask(data, width, height) }
}
