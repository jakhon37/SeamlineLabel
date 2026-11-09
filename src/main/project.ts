import { createHash } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import path from 'path'
import {
  FORMAT_EXT, FORMAT_NAMES, type LabelFormat, looksLikeCreateML, readClasses, readCreateML, readVoc, readYolo, removeCreateML, writeClasses,
  writeCreateML, writeVoc, writeYolo, YOLO_CLASSES
} from '../shared/formats'
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
  /** Marked as checked, LabelImg's Verify Image */
  verified?: boolean
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

type Root = {
  dir: string; outputDir: string | null; outputFile: string | null; images: Map<string, ImageItem>; embedded: Map<string, string>
  /** File names, without extensions, that more than one image has, in different folders */
  shared: Set<string>
}
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

/** Where an image's labels live in a format: beside it, or in the output folder. */
export function labelPath(dir: string, name: string, format: LabelFormat = 'labelme'): string {
  const r = getRoot(dir)
  const embedded = r.embedded.get(name)
  if (embedded) return embedded
  imagePath(dir, name)
  const ext = FORMAT_EXT[format]
  const stem = stemOf(name)
  // labelme and LabelImg put every label file straight in the output folder, by its image's file name.
  // Images in different folders with the same name each keep their own, in folders as the images are.
  const alone = !r.shared.has(path.basename(stem))
  // One output file holds LabelMe's labels, or CreateML's list of images; VOC and YOLO files go beside it
  if (r.outputFile) return ext === '.json' ? r.outputFile : path.join(path.dirname(r.outputFile), (alone ? path.basename(stem) : stem) + ext)
  if (!r.outputDir) return path.join(r.dir, stem + ext)
  const nested = path.join(r.outputDir, stem + ext)
  const flat = path.join(r.outputDir, path.basename(stem) + ext)
  return alone && nested !== flat && !existsSync(nested) && existsSync(flat) ? flat : nested
}

const stemOf = (name: string) => name.replace(/\.[^./]+$/, '')

/**
 * The name an image has in a CreateML list: its file name, as LabelImg writes it, or in one
 * output file for every image, its path in the folder, so images of the same name stay apart
 */
const createmlName = (dir: string, name: string) => (getRoot(dir).outputFile ? name : path.basename(name))

/** Has the image labels in this very format? For CreateML, an entry in the list. */
export async function hasLabelsIn(dir: string, name: string, format: LabelFormat) {
  const file = labelPath(dir, name, format)
  if (format === 'yolo') return isYolo(file)
  if (!existsSync(file)) return false
  if (format === 'voc') return true
  const text = await readText(file)
  if (text === null) return false
  if (!looksLikeCreateML(text)) return format === 'labelme'
  if (format !== 'createml') return false
  try {
    return readCreateML(text, createmlName(dir, name)).found
  } catch {
    // Unreadable, so it counts: it's never written over
    return true
  }
}

export type Found = { format: LabelFormat; file: string }

const yoloClasses = (file: string) => path.join(path.dirname(file), YOLO_CLASSES)
// A .txt file is YOLO's only beside a classes.txt, as LabelImg writes them: other .txt files, such as captions, aren't labels
const isYolo = (file: string) => path.basename(file) !== YOLO_CLASSES && existsSync(file) && existsSync(yoloClasses(file))

/** CreateML's files take LabelMe's name: a list is CreateML's, anything else LabelMe's */
async function jsonFormat(file: string): Promise<LabelFormat> {
  const handle = await fs.open(file, 'r')
  try {
    const head = Buffer.alloc(256)
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    return looksLikeCreateML(head.subarray(0, bytesRead).toString('utf8')) ? 'createml' : 'labelme'
  } finally {
    await handle.close()
  }
}

/** Has the image a label file in any format? */
export function hasLabels(dir: string, name: string) {
  return existsSync(labelPath(dir, name)) || existsSync(labelPath(dir, name, 'voc')) || isYolo(labelPath(dir, name, 'yolo'))
}

/**
 * The image's label file, in whichever format it has one: the preferred format first, then
 * LabelMe JSON or CreateML, Pascal VOC and YOLO.
 */
export async function findLabels(dir: string, name: string, prefer: LabelFormat = 'labelme'): Promise<Found | null> {
  const json = labelPath(dir, name)
  if (getRoot(dir).embedded.has(name)) return { format: 'labelme', file: json }
  const xml = labelPath(dir, name, 'voc')
  const txt = labelPath(dir, name, 'yolo')
  if (prefer === 'voc' && existsSync(xml)) return { format: 'voc', file: xml }
  if (prefer === 'yolo' && isYolo(txt)) return { format: 'yolo', file: txt }
  if (existsSync(json)) return { format: await jsonFormat(json), file: json }
  if (existsSync(xml)) return { format: 'voc', file: xml }
  if (isYolo(txt)) return { format: 'yolo', file: txt }
  return null
}

export type Labels = Found & { doc: LabelDoc; verified: boolean }
/** The image's size, which YOLO's shares of it need */
export type SizeOf = () => Promise<[number, number]>

/** A label file in any format, as a LabelMe document. Throws LabelFileError when it can't be read. */
export async function readLabels(dir: string, name: string, found: Found, size: SizeOf): Promise<Labels | null> {
  const text = await readText(found.file)
  if (text === null) return null
  const image = imagePath(dir, name)
  const boxes = async (shapes: Shape[], verified: boolean): Promise<Labels> => {
    const [w, h] = await size()
    return {
      ...found, verified,
      doc: { version: FORMAT_VERSION, flags: {}, shapes, imagePath: posix(path.relative(path.dirname(found.file), image)), imageData: null, imageHeight: h, imageWidth: w, other: {} }
    }
  }
  if (found.format === 'voc') {
    const voc = readVoc(text)
    return boxes(voc.shapes, voc.verified)
  }
  if (found.format === 'yolo') {
    const classes = await readText(yoloClasses(found.file))
    if (classes === null) throw new LabelFileError(`There's no ${YOLO_CLASSES} beside it to name its classes`)
    const [w, h] = await size()
    return boxes(readYolo(text, classes.trim() ? readClasses(classes) : [], w, h), false)
  }
  if (looksLikeCreateML(text)) {
    const list = readCreateML(text, createmlName(dir, name))
    // A list that doesn't name this image holds no labels of it
    return list.found ? boxes(list.shapes, list.verified) : null
  }
  const doc = parseLabelFile(text)
  return { format: 'labelme', file: found.file, doc, verified: doc.other.verified === true }
}

/** A label file picked by hand, for this image: its format from its name, or for .json from what's in it */
export async function readLabelFile(dir: string, name: string, file: string, size: SizeOf): Promise<Labels> {
  const ext = path.extname(file).toLowerCase()
  const format: LabelFormat = ext === '.xml' ? 'voc' : ext === '.txt' ? 'yolo' : 'labelme'
  if (format === 'yolo' && !existsSync(yoloClasses(file))) throw new Error(`There's no ${YOLO_CLASSES} beside ${path.basename(file)} to name its classes`)
  const labels = await readLabels(dir, name, { format, file }, size)
  if (!labels) throw new Error(existsSync(file) ? `${path.basename(file)} lists nothing for ${path.basename(imagePath(dir, name))}` : `${path.basename(file)} doesn't exist`)
  return labels
}

// Label files that are replaced go to the trash: the window sets the system's, tests use none
let trash = (file: string) => fs.rm(file, { force: true })
export function setTrash(fn: (file: string) => Promise<void>) {
  trash = fn
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
  const r: Root = { dir, outputDir, outputFile, images: new Map(), embedded: new Map(), shared: new Set() }
  if (embeddedFile) {
    const name = posix(path.relative(dir, embeddedFile))
    r.embedded.set(name, embeddedFile)
    names.push(name)
    select = name
  }
  const seen = new Set<string>()
  for (const name of names) {
    const base = stemOf(path.basename(name))
    if (seen.has(base)) r.shared.add(base)
    seen.add(base)
  }
  roots.set(dir, r)
  const images: ImageItem[] = names.map((name) => {
    const labelled = hasLabels(dir, name)
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
const anySize: SizeOf = async () => [1, 1]

export async function summarizeAll(dir: string, send: (batch: { root: string; items: ImageItem[]; labels: string[] }) => void, prefer: LabelFormat = 'labelme') {
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
    const found = await findLabels(dir, name, prefer).catch(() => null)
    const stat = found && await fs.stat(found.file).catch(() => null)
    // YOLO's names come from classes.txt, so a change there counts too
    const classes = found?.format === 'yolo' ? await fs.stat(yoloClasses(found.file)).catch(() => null) : null
    const key = found && stat ? `${found.format}:${stat.size}:${stat.mtimeMs}:${classes?.mtimeMs ?? ''}` : 'none'
    // By image too: one CreateML file can hold every image's labels
    const id = `${found?.file ?? ''}\0${name}`
    let cached = summaryCache.get(id)
    if (!cached || cached.key !== key) {
      let item: Partial<ImageItem> = { ...EMPTY_SUMMARY }
      let labels: string[] = []
      if (found && stat) {
        try {
          const read = await readLabels(dir, name, found, anySize)
          item = { ...summarize(read?.doc.shapes ?? [], !!read), verified: read?.verified || undefined }
          labels = (read?.doc.shapes ?? []).map((s) => s.label)
        } catch (e: any) {
          item = { ...EMPTY_SUMMARY, labelled: true, broken: e.message }
        }
      }
      cached = { key, item, labels }
      summaryCache.set(id, cached)
    }
    if (roots.get(dir) !== r) return
    const merged: ImageItem = { ...EMPTY_SUMMARY, broken: undefined, verified: undefined, ...cached.item, name, embedded: r.images.get(name)?.embedded }
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
  format?: LabelFormat
  /** LabelImg's Verify Image */
  verified?: boolean
  /** The label list, which YOLO's classes.txt starts from */
  classes?: string[]
  /** Pascal VOC's depth: 1 for grey images, 3 for colour */
  depth?: number
  /** The format the image is being switched from: its old file goes to the trash once the new one is written */
  from?: LabelFormat
}
export type Saved = { file: string; item: ImageItem; format: LabelFormat; replaced?: string; kept?: string }
/** What a save reads from the image, read in its turn so saves of one image can't overtake each other */
export type FromImage = { imageData?: () => Promise<string | null>; depth?: () => Promise<number> }

const unreadable = (file: string, e: unknown, as = '') =>
  new Error(`${path.basename(file)} can't be read${as}, so it's left unchanged: ${(e as Error).message}`)

/**
 * Saves in the image's format. labelme's own is merged into what the file holds so unknown
 * keys survive; LabelImg's are written whole, as LabelImg writes them. A file that can't be
 * read in its format is never written over.
 */
export async function saveLabels(dir: string, name: string, req: SaveRequest, fromImage: FromImage = {}): Promise<Saved> {
  const r = getRoot(dir)
  const embedded = r.embedded.has(name)
  // An image kept inside its label file can only be saved there
  const format: LabelFormat = embedded ? 'labelme' : req.format ?? 'labelme'
  return serial(async () => {
    const file = req.target ? path.resolve(req.target) : labelPath(dir, name, format)
    const image = imagePath(dir, name)
    const verified = !!req.verified
    // A switch converts this image's labels: labels it already has in the new format are never written over
    const switching = !!req.from && req.from !== format && !req.target
    if (switching && await hasLabelsIn(dir, name, format)) {
      throw new Error(`${path.basename(file)} already holds labels of ${name} as ${FORMAT_NAMES[format]}, so it's left unchanged`)
    }
    const imageData = fromImage.imageData ? await fromImage.imageData() : req.imageData
    const text = await readText(file)
    let replaced: string | undefined
    if (format === 'labelme') {
      let doc: LabelDoc | null = null
      if (text !== null && looksLikeCreateML(text)) {
        // A CreateML file of this image alone gives way: LabelMe's file takes the same name
        let rest: string | null
        try {
          rest = removeCreateML(text, createmlName(dir, name))
        } catch (e) {
          throw unreadable(file, e)
        }
        if (rest !== null) throw new Error(`${path.basename(file)} holds CreateML labels of other images too, so it's left unchanged`)
        await trash(file)
        replaced = file
      } else if (text !== null) {
        try {
          doc = parseLabelFile(text)
        } catch (e) {
          throw unreadable(file, e)
        }
      }
      const other = { ...(doc?.other ?? {}) }
      if (verified) other.verified = true
      else delete other.verified
      await writeAtomic(file, serializeLabelFile({
        version: doc?.version ?? FORMAT_VERSION,
        flags: req.flags,
        shapes: req.shapes,
        // An image shown from imageData keeps the path it had
        imagePath: embedded ? doc?.imagePath ?? '' : posix(path.relative(path.dirname(file), image)),
        imageData: embedded ? doc?.imageData ?? null : imageData,
        imageHeight: req.size[1],
        imageWidth: req.size[0],
        other
      }))
    } else if (format === 'voc') {
      if (text !== null) {
        try {
          readVoc(text)
        } catch (e) {
          throw unreadable(file, e, ' as Pascal VOC')
        }
      }
      await writeAtomic(file, writeVoc({
        folder: path.basename(path.dirname(image)), filename: path.basename(image), path: image,
        width: req.size[0], height: req.size[1], depth: fromImage.depth ? await fromImage.depth() : req.depth ?? 3
      }, req.shapes, verified))
    } else if (format === 'yolo') {
      if (path.basename(file) === YOLO_CLASSES) throw new Error(`${YOLO_CLASSES} holds YOLO's class names, so ${name} can't have a YOLO file`)
      const classesFile = yoloClasses(file)
      const classesText = await readText(classesFile)
      const known = classesText?.trim() ? readClasses(classesText) : []
      if (text !== null) {
        if (classesText === null) throw new Error(`${path.basename(file)} isn't a YOLO file (there's no ${YOLO_CLASSES} beside it), so it's left unchanged`)
        try {
          readYolo(text, known, 1, 1)
        } catch (e) {
          throw unreadable(file, e, ' as YOLO')
        }
      }
      // Class numbers never move: new labels go after the ones classes.txt has
      const out = writeYolo(req.shapes, [...known, ...(req.classes ?? []).filter((c) => !known.includes(c))], req.size[0], req.size[1])
      if (classesText === null || out.classes.length !== known.length) await writeAtomic(classesFile, writeClasses(out.classes))
      await writeAtomic(file, out.text)
    } else {
      let existing: string | null = null
      if (text !== null && looksLikeCreateML(text)) existing = text
      else if (text !== null) {
        // This image's LabelMe file gives way to CreateML's, which takes its name
        try {
          parseLabelFile(text)
        } catch (e) {
          throw unreadable(file, e)
        }
        await trash(file)
        replaced = file
      }
      let out: string
      try {
        out = writeCreateML(existing, createmlName(dir, name), req.shapes, verified)
      } catch (e) {
        throw unreadable(file, e, ' as CreateML')
      }
      await writeAtomic(file, out)
    }
    // Switched to another format: one image, one label file, so which one opens is never in doubt
    let kept: string | undefined
    // A single LabelMe output file isn't this image's alone
    const shared = r.outputFile && req.from === 'labelme'
    const old = switching && !shared ? labelPath(dir, name, req.from!) : null
    if (old && old !== file && (req.from === 'yolo' ? isYolo(old) : existsSync(old))) {
      try {
        await dropLabels(dir, name, { format: req.from!, file: old })
        replaced = old
      } catch (e: any) {
        kept = `${path.basename(old)} couldn't go to the trash: ${e.message}`
      }
    }
    const item: ImageItem = { ...summarize(req.shapes, true), name, embedded: embedded || undefined, verified: verified || undefined }
    if (!req.target) r.images.set(name, item)
    return { file, item, format, replaced, kept }
  })
}

export async function loadLabels(dir: string, name: string, prefer: LabelFormat = 'labelme', size: SizeOf = anySize) {
  return serial(async () => {
    const found = await findLabels(dir, name, prefer)
    const labels = found && await readLabels(dir, name, found, size)
    if (!labels) return { file: labelPath(dir, name, prefer), format: null, verified: false, doc: null }
    // imageData can be megabytes: the window doesn't need it
    return { file: labels.file, format: labels.format, verified: labels.verified, doc: { ...labels.doc, imageData: labels.doc.imageData ? '' : null } }
  })
}

/** Where Delete label file looks: the file the image has, or the one it would get */
export async function labelsFile(dir: string, name: string, prefer: LabelFormat) {
  return (await findLabels(dir, name, prefer))?.file ?? labelPath(dir, name, prefer)
}

/** Takes an image's labels away: to the trash, or out of a CreateML list that holds other images too */
async function dropLabels(dir: string, name: string, found: Found) {
  const text = found.format === 'createml' ? await readText(found.file) : null
  if (text !== null) {
    let rest: string | null
    try {
      rest = removeCreateML(text, createmlName(dir, name))
    } catch (e) {
      // The one output file holds every image's labels: one that can't be read stays as it is
      if (found.file === getRoot(dir).outputFile) throw unreadable(found.file, e)
      rest = null
    }
    if (rest !== null) return writeAtomic(found.file, rest)
  }
  await trash(found.file)
}

export async function trashLabels(dir: string, name: string, prefer: LabelFormat) {
  return serial(async () => {
    const found = await findLabels(dir, name, prefer)
    if (found) await dropLabels(dir, name, found)
    return found?.file ?? null
  })
}

/** LabelImg's Delete Image, to the trash here, with the image's label files in every format */
export async function trashImage(dir: string, name: string) {
  return serial(async () => {
    const r = getRoot(dir)
    if (r.embedded.has(name)) throw new Error('This image lives inside its label file: delete the label file instead')
    const image = imagePath(dir, name)
    const labels: Found[] = []
    const json = labelPath(dir, name)
    // A single LabelMe output file isn't this image's alone
    if (existsSync(json) && (!r.outputFile || (await jsonFormat(json)) === 'createml')) labels.push({ format: await jsonFormat(json), file: json })
    if (existsSync(labelPath(dir, name, 'voc'))) labels.push({ format: 'voc', file: labelPath(dir, name, 'voc') })
    if (isYolo(labelPath(dir, name, 'yolo'))) labels.push({ format: 'yolo', file: labelPath(dir, name, 'yolo') })
    // The image first: if it can't go, its labels stay with it
    await trash(image)
    r.images.delete(name)
    const kept: string[] = []
    for (const found of labels) {
      try {
        await dropLabels(dir, name, found)
      } catch (e: any) {
        kept.push(e.message)
      }
    }
    return { image, kept: kept.length ? kept.join('; ') : undefined }
  })
}

export function cacheKey(file: string, size: number, mtime: number) {
  return createHash('sha1').update(`${file}\0${size}\0${Math.floor(mtime)}`).digest('hex').slice(0, 20)
}
