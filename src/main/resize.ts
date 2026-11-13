// Pillow's bilinear resize (Resample.c), to the bit: osam resizes with it before SAM sees the
// image, so the masks here come out as labelme's do. Fixed point with 22 bits, a horizontal
// pass, then a vertical one, each rounded to 8 bits.

const PRECISION_BITS = 32 - 8 - 2

function coefficients(inSize: number, outSize: number) {
  const scale = inSize / outSize
  const filterScale = Math.max(scale, 1)
  const support = 1 * filterScale
  const ksize = Math.ceil(support) * 2 + 1
  const bounds = new Int32Array(outSize * 2)
  const kk = new Float64Array(outSize * ksize)
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale
    const ss = 1 / filterScale
    const xmin = Math.max(Math.trunc(center - support + 0.5), 0)
    const xmax = Math.min(Math.trunc(center + support + 0.5), inSize) - xmin
    let ww = 0
    const k = new Float64Array(ksize)
    for (let x = 0; x < xmax; x++) {
      const t = Math.abs((x + xmin - center + 0.5) * ss)
      const w = t < 1 ? 1 - t : 0
      k[x] = w
      ww += w
    }
    for (let x = 0; x < xmax; x++) {
      const v = ww !== 0 ? k[x] / ww : k[x]
      kk[xx * ksize + x] = v < 0 ? Math.trunc(-0.5 + v * (1 << PRECISION_BITS)) : Math.trunc(0.5 + v * (1 << PRECISION_BITS))
    }
    bounds[xx * 2] = xmin
    bounds[xx * 2 + 1] = xmax
  }
  return { bounds, kk, ksize }
}

const clip8 = (v: number) => {
  const r = Math.floor(v / (1 << PRECISION_BITS))
  return r < 0 ? 0 : r > 255 ? 255 : r
}

function horizontal(src: Uint8Array, w: number, h: number, outWidth: number, channels: number) {
  const { bounds, kk, ksize } = coefficients(w, outWidth)
  const out = new Uint8Array(outWidth * h * channels)
  for (let y = 0; y < h; y++) {
    for (let xx = 0; xx < outWidth; xx++) {
      const xmin = bounds[xx * 2], xmax = bounds[xx * 2 + 1]
      for (let c = 0; c < channels; c++) {
        let ss = 1 << (PRECISION_BITS - 1)
        for (let x = 0; x < xmax; x++) ss += src[(y * w + x + xmin) * channels + c] * kk[xx * ksize + x]
        out[(y * outWidth + xx) * channels + c] = clip8(ss)
      }
    }
  }
  return out
}

function vertical(src: Uint8Array, w: number, h: number, outHeight: number, channels: number) {
  const { bounds, kk, ksize } = coefficients(h, outHeight)
  const out = new Uint8Array(w * outHeight * channels)
  for (let yy = 0; yy < outHeight; yy++) {
    const ymin = bounds[yy * 2], ymax = bounds[yy * 2 + 1]
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        let ss = 1 << (PRECISION_BITS - 1)
        for (let y = 0; y < ymax; y++) ss += src[((y + ymin) * w + x) * channels + c] * kk[yy * ksize + y]
        out[(yy * w + x) * channels + c] = clip8(ss)
      }
    }
  }
  return out
}

/** Interleaved 8-bit pixels with `channels` per pixel, resized as PIL's Image.resize(BILINEAR) */
export function pilResize(data: Uint8Array, width: number, height: number, outWidth: number, outHeight: number, channels = 3): Uint8Array {
  if (outWidth === width && outHeight === height) return data
  if (outHeight === height) return horizontal(data, width, height, outWidth, channels)
  if (outWidth === width) return vertical(data, width, height, outHeight, channels)
  // Pillow 13 runs the vertical pass first when the height shrinks more than twice as much as
  // the width (Pillow 12 and before always ran the horizontal one first). The order changes how
  // the two roundings fall.
  const horizontalFirst = !(height - outHeight > 0 && height - outHeight > (width - outWidth) * 2)
  if (horizontalFirst) return vertical(horizontal(data, width, height, outWidth, channels), outWidth, height, outHeight, channels)
  return horizontal(vertical(data, width, height, outHeight, channels), width, outHeight, outWidth, channels)
}


// OpenCV's bilinear resize of 8-bit images (cv::resize with INTER_LINEAR, imgproc/src/resize.cpp),
// to the bit: Seamline's predict resizes each tile to its model's input with it, through
// albumentations' Resize, so a model sees the same pixels in both apps. Pixel centres map onto
// pixel centres, in float32, with 11-bit weights: a horizontal pass into integers, then a vertical
// one that drops 4 and 16 bits before rounding. Columns past an edge take the edge's pixel; rows
// past one take the edge row on both sides. Halving both sides exactly averages 2 x 2 blocks instead.

const COEF_BITS = 11
const COEF_SCALE = 1 << COEF_BITS

/** cvRound: to the nearest whole number, halves to the even one */
function roundEven(v: number) {
  const r = Math.round(v)
  return r - v === 0.5 && r % 2 !== 0 ? r - 1 : r
}

/** Where each output pixel along a side samples: the first source pixel, and the two weights */
function positions(inSize: number, outSize: number) {
  const scale = 1 / (outSize / inSize)
  const start = new Int32Array(outSize), w0 = new Int32Array(outSize), w1 = new Int32Array(outSize)
  for (let d = 0; d < outSize; d++) {
    let f = Math.fround((d + 0.5) * scale - 0.5)
    const s = Math.floor(f)
    f = Math.fround(f - s)
    start[d] = s
    w0[d] = roundEven(Math.fround(1 - f) * COEF_SCALE)
    w1[d] = roundEven(f * COEF_SCALE)
  }
  return { start, w0, w1 }
}

/** Interleaved 8-bit pixels with `channels` per pixel, resized as OpenCV's cv2.resize(INTER_LINEAR) */
export function cvResize(data: Uint8Array, width: number, height: number, outWidth: number, outHeight: number, channels = 3): Uint8Array {
  if (outWidth === width && outHeight === height) return data
  const out = new Uint8Array(outWidth * outHeight * channels)
  const row = width * channels, outRow = outWidth * channels
  if (width === outWidth * 2 && height === outHeight * 2) {
    for (let y = 0; y < outHeight; y++) {
      const top = 2 * y * row, below = top + row
      for (let i = 0; i < outRow; i++) {
        const at = 2 * i - (i % channels)
        out[y * outRow + i] = (data[top + at] + data[top + at + channels] + data[below + at] + data[below + at + channels] + 2) >> 2
      }
    }
    return out
  }
  const xs = positions(width, outWidth), ys = positions(height, outHeight)
  for (let x = 0; x < outWidth; x++) {
    if (xs.start[x] >= 0 && xs.start[x] < width - 1) continue
    xs.start[x] = Math.min(Math.max(xs.start[x], 0), width - 1)
    xs.w0[x] = COEF_SCALE
    xs.w1[x] = 0
  }
  // Source rows through the horizontal pass, each once: the rows they're needed for come in order
  const passed = new Map<number, Int32Array>()
  const horizontal = (y: number) => {
    let r = passed.get(y)
    if (r) return r
    r = new Int32Array(outRow)
    for (let x = 0; x < outWidth; x++) {
      const a = y * row + xs.start[x] * channels, b = y * row + Math.min(xs.start[x] + 1, width - 1) * channels
      for (let c = 0; c < channels; c++) r[x * channels + c] = data[a + c] * xs.w0[x] + data[b + c] * xs.w1[x]
    }
    passed.set(y, r)
    return r
  }
  for (let y = 0; y < outHeight; y++) {
    const top = Math.min(Math.max(ys.start[y], 0), height - 1), below = Math.min(Math.max(ys.start[y] + 1, 0), height - 1)
    for (const k of passed.keys()) if (k < top) passed.delete(k)
    const r0 = horizontal(top), r1 = horizontal(below), b0 = ys.w0[y], b1 = ys.w1[y]
    for (let i = 0; i < outRow; i++) out[y * outRow + i] = (((b0 * (r0[i] >> 4)) >> 16) + ((b1 * (r1[i] >> 4)) >> 16) + 2) >> 2
  }
  return out
}
