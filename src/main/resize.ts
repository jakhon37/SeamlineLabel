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

const taps = (inSize: number, outSize: number) => Math.ceil(Math.max(inSize / outSize, 1)) * 2 + 1

/** Interleaved 8-bit pixels with `channels` per pixel, resized as PIL's Image.resize(BILINEAR) */
export function pilResize(data: Uint8Array, width: number, height: number, outWidth: number, outHeight: number, channels = 3): Uint8Array {
  if (outWidth === width && outHeight === height) return data
  if (outHeight === height) return horizontal(data, width, height, outWidth, channels)
  if (outWidth === width) return vertical(data, width, height, outHeight, channels)
  // Pillow does the cheaper pass order, which changes how the two roundings fall
  const hFirst = outWidth * height * taps(width, outWidth) + outWidth * outHeight * taps(height, outHeight)
  const vFirst = width * outHeight * taps(height, outHeight) + outWidth * outHeight * taps(width, outWidth)
  if (hFirst <= vFirst) return vertical(horizontal(data, width, height, outWidth, channels), outWidth, height, outHeight, channels)
  return horizontal(vertical(data, width, height, outHeight, channels), width, outHeight, outWidth, channels)
}
