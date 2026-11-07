import { createHash } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import path from 'path'
import { FORMAT_VERSION, type LabelDoc, LabelFileError, parseLabelFile, serializeLabelFile, type Shape } from '../shared/labelfile'
import { EMPTY_SUMMARY, type Summary, summarize } from '../shared/labels'

// What Chromium or libvips can show. labelme takes whatever Qt can read, which is much the same.
export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.bmp', '.gif', '.tif', '.tiff', '.webp', '.avif'])

export type LabelClass = { name: string; color: string }
export type ProjectInfo = { name: string; classes: LabelClass[] }
export type ImageItem = Summary & {
  name: string
  /** The label file can't be read, so it is never written over */
  broken?: string
  /** No image file: it's shown from the label file's imageData */
  embedded?: boolean
}
export type OpenProject = {
  root: string
  outputDir: string | null
  project: ProjectInfo
  /** .myseg/project.json exists, as in a Seamline project */
  hasProjectFile: boolean
  images: ImageItem[]
  /** The image to show first, when a file was opened rather than a folder */
  select: string | null
}

type Root = { dir: string; outputDir: string | null; outputFile: string | null; images: Map<string, ImageItem>; embedded: Map<string, string> }
const roots = new Map<string, Root>()

// Label files are read, changed and written back: one at a time, so nothing overtakes a save
let writes: Promise<unknown> = Promise.resolve()
export function serial<T>(fn: () => Promise<T>) {
  const result = writes.then(fn)
  writes = result.catch(() => {})
  return result
}

const posix = (p: string) => p.split(path.sep).join('/')
export const meta = (root: string, ...p: string[]) => path.join(root, '.myseg', ...p)

function getRoot(dir: string): Root {
  const r = roots.get(dir)
  if (!r) throw new Error('That folder is not open')
  return r
}

/** An image name from the renderer, as a path that can't leave its folder */
export function imagePath(dir: string, name: string): string {
  const r = getRoot(dir)
  if (r.embedded.has(name)) return r.embedded.get(name)!
  const full = path.resolve(r.dir, name)
  if (!full.startsWith(r.dir + path.sep)) throw new Error('Path outside the folder')
  return full
}

export function isEmbedded(dir: string, name: string) {
  return getRoot(dir).embedded.has(name)
}

/** Where an image's labels live: beside it, or in the output folder. */
export function labelPath(dir: string, name: string): string {
  const r = getRoot(dir)
  const embedded = r.embedded.get(name)
  if (embedded) return embedded
  imagePath(dir, name)
  if (r.outputFile) return r.outputFile
  const stem = name.replace(/\.[^./]+$/, '')
  if (!r.outputDir) return path.join(r.dir, stem + '.json')
  const nested = path.join(r.outputDir, stem + '.json')
  // labelme puts every label file straight in the output folder, by its image's file name
  const flat = path.join(r.outputDir, path.basename(stem) + '.json')
  return nested !== flat && !existsSync(nested) && existsSync(flat) ? flat : nested
}

export function rootsOpen() {
  return [...roots.keys()]
}

async function scan(dir: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (sub: string) => {
    let entries
    try {
      entries = await fs.readdir(path.join(dir, sub), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      // Hidden folders hold caches, such as Seamline's .myseg, not images to label
      if (e.name.startsWith('.')) continue
      const rel = sub ? `${sub}/${e.name}` : e.name
      if (e.isDirectory()) await walk(rel)
      else if (IMAGE_EXTS.has(path.extname(e.name).toLowerCase())) found.push(rel)
    }
  }
  await walk('')
  return found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

export async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (e: any) {
    if (e.code === 'ENOENT') return null
    throw new LabelFileError(`It can't be read (${e.code})`)
  }
}

/** No file is no labels yet. A file that can't be read is someone's labels, so this throws. */
export async function readDoc(file: string): Promise<LabelDoc | null> {
  const text = await readText(file)
  return text === null ? null : parseLabelFile(text)
}

export async function writeAtomic(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, text)
  try {
    await fs.rename(tmp, file)
  } catch (e) {
    await fs.rm(tmp, { force: true })
    throw e
  }
}

async function readProjectFile(dir: string): Promise<ProjectInfo | null> {
  const text = await readText(meta(dir, 'project.json')).catch(() => null)
  if (!text) return null
  try {
    const p = JSON.parse(text)
    if (!Array.isArray(p.classes)) return null
    return {
      name: typeof p.name === 'string' ? p.name : path.basename(dir),
      classes: p.classes.filter((c: any) => typeof c?.name === 'string').map((c: any) => ({
        name: c.name, color: typeof c.color === 'string' ? c.color : ''
      }))
    }
  } catch {
    return null
  }
}

export async function saveProjectFile(dir: string, project: ProjectInfo) {
  getRoot(dir)
  // Keeps keys Seamline writes there, such as its training settings
  const text = await readText(meta(dir, 'project.json')).catch(() => null)
  let doc: Record<string, unknown> = {}
  try {
    if (text) doc = JSON.parse(text)
  } catch {
    // Unreadable: replaced
  }
  await writeAtomic(meta(dir, 'project.json'), JSON.stringify({ ...doc, ...project }, null, 2))
}

/** A label file opened on its own: its image, or the image inside it */
async function imageOfLabelFile(file: string) {
  const doc = await readDoc(file)
  if (!doc) throw new Error(`${path.basename(file)} doesn't exist`)
  const image = doc.imagePath ? path.resolve(path.dirname(file), doc.imagePath) : ''
  if (image && existsSync(image)) return { image, embedded: false }
  if (doc.imageData) return { image: file, embedded: true }
  throw new Error(`The image of ${path.basename(file)} can't be found: ${image || 'it names none'}`)
}

export async function openProject(target: string, output: string | null): Promise<OpenProject> {
  const full = path.resolve(target)
  const stat = await fs.stat(full)
  let dir = full
  let select: string | null = null
  let embeddedFile: string | null = null
  if (!stat.isDirectory()) {
    dir = path.dirname(full)
    if (path.extname(full).toLowerCase() === '.json') {
      const found = await imageOfLabelFile(full)
      if (found.embedded) embeddedFile = full
      else if (found.image.startsWith(dir + path.sep)) select = posix(path.relative(dir, found.image))
      else {
        // Its image is in another folder: open that one
        dir = path.dirname(found.image)
        select = path.basename(found.image)
      }
    } else {
      select = path.basename(full)
    }
  }
  const outputFile = output && output.toLowerCase().endsWith('.json') ? path.resolve(output) : null
  const outputDir = output && !outputFile ? path.resolve(output) : null
  const names = await scan(dir)
  const r: Root = { dir, outputDir, outputFile, images: new Map(), embedded: new Map() }
  if (embeddedFile) {
    const name = posix(path.relative(dir, embeddedFile))
    r.embedded.set(name, embeddedFile)
    names.push(name)
    select = name
  }
  roots.set(dir, r)
  const images: ImageItem[] = names.map((name) => {
    const labelled = existsSync(labelPath(dir, name))
    const item: ImageItem = { ...EMPTY_SUMMARY, name, labelled, embedded: r.embedded.has(name) || undefined }
    r.images.set(name, item)
    return item
  })
  const file = await readProjectFile(dir)
  return {
    root: dir,
    outputDir: outputDir ?? (outputFile ? path.dirname(outputFile) : null),
    project: file ?? { name: path.basename(dir), classes: [] },
    hasProjectFile: !!file,
    images,
    select
  }
}

export function closeProject(dir: string) {
  roots.delete(dir)
}

// Reading every label file takes a while in a big folder, so the list shows first and
// counts follow in batches. Unchanged files aren't read again.
const summaryCache = new Map<string, { key: string; item: Partial<ImageItem>; labels: string[] }>()

export async function summarizeAll(dir: string, send: (batch: { root: string; items: ImageItem[]; labels: string[] }) => void) {
  const r = getRoot(dir)
  const names = [...r.images.keys()]
  let batch: ImageItem[] = []
  let labels = new Set<string>()
  let last = Date.now()
  const flush = () => {
    if (!batch.length) return
    send({ root: dir, items: batch, labels: [...labels] })
    batch = []
    labels = new Set()
    last = Date.now()
  }
  const one = async (name: string) => {
    const file = labelPath(dir, name)
    const stat = await fs.stat(file).catch(() => null)
    const key = stat ? `${stat.size}:${stat.mtimeMs}` : 'none'
    let cached = summaryCache.get(file)
    if (!cached || cached.key !== key) {
      let item: Partial<ImageItem> = { ...EMPTY_SUMMARY }
      let found: string[] = []
      if (stat) {
        try {
          const doc = await readDoc(file)
          item = summarize(doc?.shapes ?? [], !!doc)
          found = (doc?.shapes ?? []).map((s) => s.label)
        } catch (e: any) {
          item = { ...EMPTY_SUMMARY, labelled: true, broken: e.message }
        }
      }
      cached = { key, item, labels: found }
      summaryCache.set(file, cached)
    }
    if (roots.get(dir) !== r) return
    const merged: ImageItem = { ...EMPTY_SUMMARY, broken: undefined, ...cached.item, name, embedded: r.images.get(name)?.embedded }
    r.images.set(name, merged)
    batch.push(merged)
    cached.labels.forEach((l) => labels.add(l))
    if (batch.length >= 200 || Date.now() - last > 150) flush()
  }
  // A few at a time: enough to keep the disk busy without opening thousands of files at once
  let next = 0
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < names.length && roots.get(dir) === r) await one(names[next++])
  }))
  flush()
}

export type SaveRequest = {
  shapes: Shape[]
  flags: Record<string, boolean>
  size: [number, number]
  /** base64 of the image, when storing image data */
  imageData: string | null
  /** Save As: write here instead */
  target?: string
}

/** labelme's save, merged into what the file already holds so unknown keys survive */
export async function saveLabels(dir: string, name: string, req: SaveRequest): Promise<{ file: string; item: ImageItem }> {
  const file = req.target ? path.resolve(req.target) : labelPath(dir, name)
  const r = getRoot(dir)
  return serial(async () => {
    let doc: LabelDoc | null
    try {
      doc = await readDoc(file)
    } catch (e: any) {
      throw new Error(`${path.basename(file)} can't be read, so it's left unchanged: ${e.message}`)
    }
    const image = imagePath(dir, name)
    const embedded = r.embedded.has(name)
    const next: LabelDoc = {
      version: doc?.version ?? FORMAT_VERSION,
      flags: req.flags,
      shapes: req.shapes,
      // An image shown from imageData keeps the path it had
      imagePath: embedded ? doc?.imagePath ?? '' : posix(path.relative(path.dirname(file), image)),
      imageData: embedded ? doc?.imageData ?? null : req.imageData,
      imageHeight: req.size[1],
      imageWidth: req.size[0],
      other: doc?.other ?? {}
    }
    await writeAtomic(file, serializeLabelFile(next))
    const item: ImageItem = { ...summarize(req.shapes, true), name, embedded: embedded || undefined }
    if (!req.target) r.images.set(name, item)
    return { file, item }
  })
}

export async function loadLabels(dir: string, name: string) {
  const file = labelPath(dir, name)
  return serial(async () => {
    const doc = await readDoc(file)
    if (!doc) return { file, doc: null }
    // imageData can be megabytes: the window doesn't need it
    return { file, doc: { ...doc, imageData: doc.imageData ? '' : null } }
  })
}

export function cacheKey(file: string, size: number, mtime: number) {
  return createHash('sha1').update(`${file}\0${size}\0${Math.floor(mtime)}`).digest('hex').slice(0, 20)
}
