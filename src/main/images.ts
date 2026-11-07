import { existsSync, promises as fs } from 'fs'
import path from 'path'
import sharp from 'sharp'
import { cacheKey, imagePath, isEmbedded, readDoc } from './project'

sharp.cache(false)

const TILE = 512
// Bigger images, and any the window can't decode itself, are shown from a tile pyramid
const DIRECT_MAX = 4096
const KEEP_PYRAMIDS = 40

let cacheDir = ''
export function setCacheDir(dir: string) {
  cacheDir = dir
}
export const cacheRoot = () => cacheDir

export type OpenImage = {
  width: number
  height: number
  /** The file the window loads, through the app's own protocol */
  file: string
  pyramid: { dir: string; maxLevel: number; tile: number } | null
  ms: number
}

// libvips can't read BMP, but the window can, so only its size is needed here
async function bmpSize(file: string) {
  const handle = await fs.open(file, 'r')
  try {
    const head = Buffer.alloc(26)
    await handle.read(head, 0, 26, 0)
    if (head.toString('ascii', 0, 2) !== 'BM') throw new Error("It isn't a BMP file")
    return { width: Math.abs(head.readInt32LE(18)), height: Math.abs(head.readInt32LE(22)) }
  } finally {
    await handle.close()
  }
}

/** An image kept inside a label file, written out once so it opens like any other */
async function embeddedFile(json: string) {
  const stat = await fs.stat(json)
  const key = cacheKey(json, stat.size, stat.mtimeMs)
  const doc = await readDoc(json)
  if (!doc?.imageData) throw new Error(`${path.basename(json)} has no image data`)
  const data = Buffer.from(doc.imageData, 'base64')
  const ext = data[0] === 0xff && data[1] === 0xd8 ? '.jpg' : data.toString('ascii', 1, 4) === 'PNG' ? '.png' : '.img'
  const file = path.join(cacheDir, 'embedded', key + ext)
  if (!existsSync(file)) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, data)
  }
  return file
}

async function prune(dir: string) {
  const entries = await fs.readdir(dir).catch(() => [] as string[])
  if (entries.length <= KEEP_PYRAMIDS) return
  const dated = await Promise.all(entries.map(async (e) => ({ e, t: (await fs.stat(path.join(dir, e)).catch(() => null))?.mtimeMs ?? 0 })))
  dated.sort((a, b) => a.t - b.t)
  for (const { e } of dated.slice(0, entries.length - KEEP_PYRAMIDS)) {
    await fs.rm(path.join(dir, e), { recursive: true, force: true })
  }
}

export async function openImage(root: string, name: string): Promise<OpenImage> {
  const started = Date.now()
  const file = isEmbedded(root, name) ? await embeddedFile(imagePath(root, name)) : imagePath(root, name)
  const stat = await fs.stat(file)
  if (path.extname(file).toLowerCase() === '.bmp') {
    return { ...(await bmpSize(file)), file, pyramid: null, ms: Date.now() - started }
  }
  const info = await sharp(file, { limitInputPixels: false }).metadata()
  // EXIF orientations 5-8 swap the sides, and the window shows photos upright, as labelme does
  const swapped = (info.orientation ?? 1) >= 5
  const width = swapped ? info.height! : info.width!
  const height = swapped ? info.width! : info.height!
  const direct = ['jpeg', 'png', 'webp', 'gif'].includes(info.format ?? '')
  if (direct && Math.max(width, height) <= DIRECT_MAX) {
    return { width, height, file, pyramid: null, ms: Date.now() - started }
  }
  // Large or TIFF: build a tile pyramid once and reuse it until the file changes
  const tiles = path.join(cacheDir, 'tiles')
  const dir = path.join(tiles, cacheKey(file, stat.size, stat.mtimeMs))
  if (!existsSync(path.join(dir, 'done'))) {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.mkdir(dir, { recursive: true })
    await sharp(file, { limitInputPixels: false })
      .rotate()
      .toColourspace('srgb')
      .jpeg({ quality: 92 })
      .tile({ size: TILE, overlap: 0, layout: 'dz' })
      .toFile(path.join(dir, 't'))
    await fs.writeFile(path.join(dir, 'done'), '')
    await prune(tiles)
  } else {
    // Recently used pyramids are kept longest
    const now = new Date()
    await fs.utimes(dir, now, now).catch(() => {})
  }
  const maxLevel = Math.ceil(Math.log2(Math.max(width, height)))
  return { width, height, file, pyramid: { dir: path.join(dir, 't_files'), maxLevel, tile: TILE }, ms: Date.now() - started }
}

/**
 * The image as labelme stores it in a label file: upright, as JPEG for JPEG files and
 * PNG for the rest. Upright JPEG and PNG files go in as they are, with no recompression.
 */
export async function imageData(root: string, name: string): Promise<string> {
  const file = imagePath(root, name)
  const input = await fs.readFile(file)
  const ext = path.extname(file).toLowerCase()
  const jpeg = ['.jpg', '.jpeg', '.jfif'].includes(ext)
  if (ext === '.bmp') return input.toString('base64')
  const info = await sharp(input, { limitInputPixels: false }).metadata()
  const upright = (info.orientation ?? 1) === 1
  if (upright && ((jpeg && info.format === 'jpeg') || (!jpeg && info.format === 'png'))) return input.toString('base64')
  const image = sharp(input, { limitInputPixels: false }).rotate()
  const out = jpeg ? await image.jpeg({ quality: 92 }).toBuffer() : await image.png().toBuffer()
  return out.toString('base64')
}

/** RGB pixels of an image, upright, no bigger than maxSide; with the size of the whole image */
export async function rgbPixels(root: string, name: string, maxSide?: number) {
  const file = isEmbedded(root, name) ? await embeddedFile(imagePath(root, name)) : imagePath(root, name)
  if (path.extname(file).toLowerCase() === '.bmp') throw new Error("AI tools can't read BMP files yet")
  const info = await sharp(file, { limitInputPixels: false }).metadata()
  const swapped = (info.orientation ?? 1) >= 5
  const fullWidth = swapped ? info.height! : info.width!
  const fullHeight = swapped ? info.width! : info.height!
  let image = sharp(file, { limitInputPixels: false }).rotate().removeAlpha().toColourspace('srgb')
  if (maxSide) image = image.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
  const { data, info: out } = await image.raw().toBuffer({ resolveWithObject: true })
  if (out.channels !== 3) throw new Error(`Expected RGB pixels, got ${out.channels} channels`)
  return { data, width: out.width, height: out.height, fullWidth, fullHeight }
}
