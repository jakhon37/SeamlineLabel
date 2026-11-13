import { createHash } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import path from 'path'
import {
  addClasses, FORMAT_EXT, FORMAT_NAMES, type LabelFormat, looksLikeCreateML, readClasses, readCreateML, readVoc, readYolo, removeCreateML, writeClasses,
  writeCreateML, writeVoc, writeYolo, YOLO_CLASSES
} from '../shared/formats'
import { FORMAT_VERSION, isAi, type LabelDoc, LabelFileError, parseLabelFile, serializeLabelFile, type Shape } from '../shared/labelfile'
import { EMPTY_SUMMARY, hasArea, type Summary, summarize } from '../shared/labels'

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
  /**
   * What Open recent and the last folder keep: what was opened, or the Seamline project a start on an
   * image in its subfolder opened, which is kept with that image
   */
  remembered: string
}

type Root = {
  dir: string; outputDir: string | null; outputFile: string | null; images: Map<string, ImageItem>; embedded: Map<string, string>
  /** File names, without extensions, that more than one image has, in different folders */
  shared: Set<string>
  /** The image whose labels the window opened last, to edit */
  editing: string | null
  /** Each image's label files as they were when the window was last told of them, so a refresh tells only changes */
  sent: Map<string, string>
  /** The classes in .myseg/project.json as Seamtag last read or wrote them, so a save keeps another app's changes since */
  classes: LabelClass[]
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

// One collator for the whole sort: localeCompare with options makes one for every comparison
const byName = new Intl.Collator(undefined, { numeric: true }).compare

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
  return found.sort(byName)
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

// Seamline, or any other app, may change label files while the folder is open here. The window
// holds an image's labels as it read them, so the image's label files are remembered as they were
// then, by what they hold, and again each time Seamtag writes one. A file that has changed since is
// never written over or trashed: the window reads it again instead.
const held = new Map<string, Map<string, string>>()
const heldKey = (dir: string, name: string) => `${dir}\0${name}`

/** Another app changed the image's labels since Seamtag last read or wrote them, so nothing was written */
export class LabelsChanged extends Error {
  constructor(readonly name: string) {
    super(`The labels of ${name} changed in another app since Seamtag read them, so they're left unchanged`)
  }
}

async function stampOf(file: string, format: LabelFormat) {
  // A .txt with no classes.txt beside it isn't YOLO's, so it's no label file
  if (format === 'yolo' && !isYolo(file)) return 'none'
  // What it holds, not its size and time: a coarse file clock, such as Windows' 16 ms tick or
  // FAT's 2 s, gives two saves of the same size within one tick the same time
  const bytes = await fs.readFile(file).catch(() => null)
  return bytes ? sha1(bytes) : 'none'
}
const sha1 = (bytes: Buffer) => createHash('sha1').update(bytes).digest('hex')

/** The image's label files in every format: the ones it has, and where it would get them */
function labelFiles(dir: string, name: string) {
  const files = new Map<string, LabelFormat>()
  for (const format of ['labelme', 'voc', 'yolo'] as const) {
    const file = labelPath(dir, name, format)
    if (!files.has(file)) files.set(file, format)
  }
  return files
}

async function stampsOf(dir: string, name: string) {
  const stamps = new Map<string, string>()
  for (const [file, format] of labelFiles(dir, name)) stamps.set(file, await stampOf(file, format))
  return stamps
}

/** Has another app changed the image's labels since Seamtag last read or wrote them? Not if Seamtag never has. */
export async function changedSince(dir: string, name: string) {
  const before = held.get(heldKey(dir, name))
  if (!before) return false
  for (const [file, stamp] of await stampsOf(dir, name)) {
    if ((before.get(file) ?? 'none') !== stamp) return true
  }
  return false
}

export const labelsChanged = (dir: string, name: string) => serial(() => changedSince(dir, name))

/** Seamtag has just written or trashed one of the image's label files */
export async function wrote(dir: string, name: string, file: string, format: LabelFormat) {
  const record = held.get(heldKey(dir, name))
  const before = record?.get(file)
  const stamp = await stampOf(file, format)
  // Other images whose labels share the file, as in one CreateML list, follow if they were as it was
  if (before !== undefined) {
    for (const [key, files] of held) if (key.startsWith(`${dir}\0`) && files.get(file) === before) files.set(file, stamp)
  }
  record?.set(file, stamp)
  return stamp
}

// An empty label file says someone cleared the image, so Seamtag and Seamline leave it out of
// pre-labelling. An automatic save with nothing to keep therefore writes no file for an image that
// has none, and removes the one these saves made for it while it holds what they wrote, as when a
// shape drawn is undone. Saved by hand, the empty file is written, as in labelme, and stays.
const made = new Map<string, { file: string; stamp: string }>()

export function editing(dir: string) {
  return getRoot(dir).editing
}

/** .myseg/project.json: its keys, or null when it's missing or unreadable, and its classes when it lists them */
async function readProjectDoc(dir: string) {
  const text = await readText(meta(dir, 'project.json')).catch(() => null)
  let doc: Record<string, unknown> | null = null
  try {
    const parsed = text ? JSON.parse(text) : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed
  } catch {
    // Unreadable: as if there were none
  }
  const list = doc?.classes
  const classes: LabelClass[] | null = Array.isArray(list)
    ? list.filter((c) => typeof c?.name === 'string').map((c) => ({ name: c.name, color: typeof c.color === 'string' ? c.color : '' }))
    : null
  return { doc, classes }
}

async function readProjectFile(dir: string): Promise<ProjectInfo | null> {
  const { doc, classes } = await readProjectDoc(dir)
  if (!doc || !classes) return null
  return { name: typeof doc.name === 'string' ? doc.name : path.basename(dir), classes }
}

/**
 * Seamtag's class list (ours), with the changes another app, such as Seamline, made to the file
 * (theirs) since Seamtag last read or wrote it (base): ours in its order, then the classes the other
 * app added. A class ours left as it was takes the other app's colour, and goes if the other app
 * deleted it. With no file to read, theirs is null, and ours is written as it is.
 */
export function mergeClasses(base: LabelClass[], ours: LabelClass[], theirs: LabelClass[] | null): LabelClass[] {
  if (!theirs) return ours
  const before = new Map(base.map((c) => [c.name, c.color]))
  const now = new Map(theirs.map((c) => [c.name, c.color]))
  const merged: LabelClass[] = []
  for (const c of ours) {
    if (before.get(c.name) !== c.color) merged.push(c)
    else if (now.has(c.name)) merged.push({ name: c.name, color: now.get(c.name)! })
  }
  const named = new Set(ours.map((c) => c.name))
  for (const c of theirs) {
    if (before.has(c.name) || named.has(c.name)) continue
    named.add(c.name)
    merged.push(c)
  }
  return merged
}

/**
 * The labels of the folder's shapes that have an area, AI proposals aside, in order: the class list
 * Seamline starts a folder with when it has none, as these are the shapes it trains on
 */
async function labelsWithArea(dir: string) {
  const names = [...getRoot(dir).images.keys()]
  const labels = new Set<string>()
  let next = 0
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < names.length) {
      const name = names[next++]
      const found = await findLabels(dir, name).catch(() => null)
      const read = found && await readLabels(dir, name, found, anySize).catch(() => null)
      for (const s of read?.doc.shapes ?? []) if (s.label && !isAi(s) && hasArea(s)) labels.add(s.label)
    }
  }))
  return [...labels].sort()
}

/**
 * Writes Seamtag's class list, merged with the file as it is now, and gives back what was written. A
 * folder with no class list yet gets the one Seamline would start it with, in the colours Seamtag's
 * label list `shown` gives those labels, with Seamtag's change: else Seamline, finding a list, would
 * never start its own, and would train on the one label changed here.
 */
export async function saveProjectFile(dir: string, project: ProjectInfo, shown: LabelClass[] = []): Promise<ProjectInfo> {
  const r = getRoot(dir)
  // Before the save's turn, as it reads every label file
  const first = (await readProjectDoc(dir)).classes ? null : await labelsWithArea(dir)
  return serial(async () => {
    // Keeps keys Seamline writes there, such as its training settings, and its changes to the classes
    const { doc, classes: theirs } = await readProjectDoc(dir)
    let ours = project.classes
    if (!theirs && first) {
      // A label added here goes after Seamline's, and a label given a colour here keeps its place
      const start = first.map((name) => ours.find((c) => c.name === name) ?? { name, color: shown.find((c) => c.name === name)?.color ?? '' })
      ours = [...start, ...ours.filter((c) => !first.includes(c.name))]
    }
    const classes = mergeClasses(r.classes, ours, theirs)
    const out = { name: project.name, ...doc, classes }
    await writeAtomic(meta(dir, 'project.json'), JSON.stringify(out, null, 2))
    r.classes = classes
    return { name: typeof out.name === 'string' ? out.name : project.name, classes }
  })
}

/** .myseg/project.json as it is now, which another app, such as Seamline, may have changed: null when there's none */
export async function reloadProjectFile(dir: string) {
  const r = getRoot(dir)
  return serial(async () => {
    const file = await readProjectFile(dir)
    r.classes = file?.classes ?? []
    return file
  })
}

function sharedStems(names: string[]) {
  const seen = new Set<string>()
  const shared = new Set<string>()
  for (const name of names) {
    const base = stemOf(path.basename(name))
    if (seen.has(base)) shared.add(base)
    seen.add(base)
  }
  return shared
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

/** The folder Seamline's project.json makes a project of: the nearest from `dir` up that has one, or null */
async function projectAbove(dir: string) {
  for (let at = dir; ; at = path.dirname(at)) {
    if (await fs.stat(meta(at, 'project.json')).then((s) => s.isFile(), () => false)) return at
    if (path.dirname(at) === at) return null
  }
}

/**
 * `started`: Seamtag was started on the target, as Seamline's Label in Seamtag starts it. An image in a
 * subfolder of a Seamline project then opens the whole project, on that image, as Seamline lists it.
 */
export async function openProject(target: string, output: string | null, started = false): Promise<OpenProject> {
  const full = path.resolve(target)
  const stat = await fs.stat(full)
  let dir = full
  let select: string | null = null
  let embeddedFile: string | null = null
  let names: string[] | null = null
  let remembered = target
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
      const top = started ? await projectAbove(dir) : null
      if (top && top !== dir) {
        // Unless the project doesn't list it: in a hidden folder, or under a link to a folder
        const listed = await scan(top)
        const name = posix(path.relative(top, full))
        if (listed.includes(name)) {
          dir = top
          select = name
          names = listed
          remembered = top
        }
      }
    }
  }
  const outputFile = output && output.toLowerCase().endsWith('.json') ? path.resolve(output) : null
  const outputDir = output && !outputFile ? path.resolve(output) : null
  names ??= await scan(dir)
  const r: Root = { dir, outputDir, outputFile, images: new Map(), embedded: new Map(), shared: new Set(), editing: null, sent: new Map(), classes: [] }
  if (embeddedFile) {
    const name = posix(path.relative(dir, embeddedFile))
    r.embedded.set(name, embeddedFile)
    names.push(name)
    select = name
  }
  r.shared = sharedStems(names)
  roots.set(dir, r)
  // Which images have labels, by their folders' listings: asked file by file, a big folder on a network
  // share keeps the main process from answering for as long as all those questions take
  const exists = listings()
  const images: ImageItem[] = await Promise.all(names.map(async (name) => {
    const txt = labelPath(dir, name, 'yolo')
    const labelled = (await exists(labelPath(dir, name))) || (await exists(labelPath(dir, name, 'voc')))
      || (path.basename(txt) !== YOLO_CLASSES && (await exists(txt)) && (await exists(yoloClasses(txt))))
    return { ...EMPTY_SUMMARY, name, labelled, embedded: r.embedded.has(name) || undefined }
  }))
  for (const item of images) r.images.set(item.name, item)
  const file = await readProjectFile(dir)
  r.classes = file?.classes ?? []
  return {
    root: dir,
    outputDir: outputDir ?? (outputFile ? path.dirname(outputFile) : null),
    project: file ?? { name: path.basename(dir), classes: [] },
    hasProjectFile: !!file,
    images,
    select,
    remembered
  }
}

export function closeProject(dir: string) {
  roots.delete(dir)
  for (const key of held.keys()) if (key.startsWith(`${dir}\0`)) held.delete(key)
  for (const key of made.keys()) if (key.startsWith(`${dir}\0`)) made.delete(key)
}

/**
 * A path Seamtag was started with again, as an image of a folder open here, perhaps one added since
 * the folder was read: its folder, and its name, or null for the folder itself
 */
export function openHere(target: string) {
  for (const r of roots.values()) {
    if (target === r.dir) return { root: r.dir, name: null }
    const name = posix(path.relative(r.dir, target))
    const inside = !name.startsWith('../') && !path.isAbsolute(name) && !name.split('/').some((part) => part.startsWith('.'))
    if (r.images.has(name) || (inside && IMAGE_EXTS.has(path.extname(name).toLowerCase()) && existsSync(target))) return { root: r.dir, name }
  }
  return null
}

/**
 * The folder as it is now, since another app, such as Seamline, may have added or removed images
 * while it was open: every image's name, in order, and the items of the new ones
 */
export async function refreshProject(dir: string) {
  const r = getRoot(dir)
  const scanned = [...await scan(dir), ...r.embedded.keys()]
  // In the save queue's turn, so no save sees label paths change halfway through
  return serial(async () => {
    if (roots.get(dir) !== r) throw new Error('That folder is not open')
    // An image trashed here since the scan is gone
    const names = scanned.filter((name) => r.images.has(name) || existsSync(imagePath(dir, name)))
    const now = new Set(names)
    for (const name of [...r.images.keys()]) {
      if (now.has(name)) continue
      r.images.delete(name)
      r.sent.delete(name)
    }
    r.shared = sharedStems(names)
    const added: ImageItem[] = []
    for (const name of names) {
      if (r.images.has(name)) continue
      const item: ImageItem = { ...EMPTY_SUMMARY, name, labelled: hasLabels(dir, name) }
      r.images.set(name, item)
      added.push(item)
    }
    return { names, added }
  })
}

// Reading every label file takes a while in a big folder, so the list shows first and
// counts follow in batches. Unchanged files aren't read again.
const summaryCache = new Map<string, { key: string; item: Partial<ImageItem>; labels: string[] }>()
const anySize: SizeOf = async () => [1, 1]

/**
 * Whether files exist, by their folders' listings, each read once: a pass over a big folder asks
 * about thousands of label files, and most of them don't exist
 */
function listings() {
  const folders = new Map<string, Promise<Set<string> | null>>()
  // As the file system finds them: Windows and macOS find A.JSON when asked for a.json
  const fold = process.platform === 'darwin' ? (s: string) => s.normalize('NFC').toLowerCase()
    : process.platform === 'win32' ? (s: string) => s.toLowerCase() : (s: string) => s
  return async (file: string) => {
    const dir = path.dirname(file)
    let names = folders.get(dir)
    if (!names) folders.set(dir, (names = fs.readdir(dir).then((list) => new Set(list.map(fold)), () => null)))
    return (await names)?.has(fold(path.basename(file))) ?? false
  }
}

/** `changedOnly` after a refresh: only images whose label files changed since the window was last told are sent */
export async function summarizeAll(
  dir: string, send: (batch: { root: string; items: ImageItem[]; labels: string[] }) => void, prefer: LabelFormat = 'labelme', changedOnly = false
) {
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
  const exists = listings()
  const stamp = async (file: string) => ((await exists(file)) ? fs.stat(file).then((s) => `${s.size}:${s.mtimeMs}`, () => '') : '')
  // One classes.txt serves a whole folder, and it's small: it goes by what it holds, as another app
  // renaming a class can leave its size as it was, and within one tick of a coarse file clock its time
  const classesStamps = new Map<string, Promise<string>>()
  const classesStamp = (file: string) => {
    if (!classesStamps.has(file)) classesStamps.set(file, exists(file).then((there) => (there ? fs.readFile(file).then(sha1, () => '') : '')))
    return classesStamps.get(file)!
  }
  const one = async (name: string) => {
    // Every label file the image has or could have, by size and time: a refresh skips images whose files are as they were
    const seen = (await Promise.all([...[...labelFiles(dir, name).keys()].map(stamp), classesStamp(yoloClasses(labelPath(dir, name, 'yolo')))])).join('\0')
    if (changedOnly && r.sent.get(name) === seen) return
    const found = await findLabels(dir, name, prefer).catch(() => null)
    const stat = found && await fs.stat(found.file).catch(() => null)
    // YOLO's names come from classes.txt, so a change there counts too
    const classes = found?.format === 'yolo' ? await classesStamp(yoloClasses(found.file)) : ''
    const key = found && stat ? `${found.format}:${stat.size}:${stat.mtimeMs}:${classes}` : 'none'
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
    r.sent.set(name, seen)
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
  /** Saved automatically, after a change, rather than by hand */
  auto?: boolean
}
/** `format` is null when the image has no label file now: saved automatically, it had nothing to keep */
export type Saved = { file: string; item: ImageItem; format: LabelFormat | null; replaced?: string; kept?: string }
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
    // Labels another app changed since the window read them are never written over, even by Save as
    const own = !req.target || labelFiles(dir, name).has(file)
    if (own && await changedSince(dir, name)) throw new LabelsChanged(name)
    // A switch converts this image's labels: labels it already has in the new format are never written over
    const switching = !!req.from && req.from !== format && !req.target
    if (switching && await hasLabelsIn(dir, name, format)) {
      throw new Error(`${path.basename(file)} already holds labels of ${name} as ${FORMAT_NAMES[format]}, so it's left unchanged`)
    }
    // Saved automatically: has the image no label file, or only one these saves made, as they wrote it?
    const key = heldKey(dir, name)
    let ours = false
    if (req.auto && !req.target && !embedded && !r.outputFile) {
      const found = await findLabels(dir, name, format)
      const last = made.get(key)
      ours = !found || (last?.file === found.file && last.stamp === await stampOf(found.file, found.format))
      // Then, with nothing to keep, it's left with none
      if (ours && !req.shapes.length && !verified && !Object.values(req.flags).some(Boolean)) {
        if (found) {
          await fs.rm(found.file, { force: true })
          await wrote(dir, name, found.file, found.format)
        }
        made.delete(key)
        const item: ImageItem = { ...EMPTY_SUMMARY, name, verified: undefined }
        r.images.set(name, item)
        return { file, item, format: null }
      }
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
        if (own) await wrote(dir, name, file, 'createml')
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
      if (classesText === null || out.classes.length !== known.length) {
        await writeAtomic(classesFile, known.length ? addClasses(classesText!, out.classes.slice(known.length)) : writeClasses(out.classes))
      }
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
        if (own) await wrote(dir, name, file, 'labelme')
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
    if (own) {
      const stamp = await wrote(dir, name, file, format)
      // Saved by hand, it's the person's file
      if (ours) made.set(key, { file, stamp })
      else made.delete(key)
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

/**
 * The image's labels. With `edit`, the window opens them to edit: their files are remembered as
 * they are, and `changed` says whether another app changed them since Seamtag last read or wrote them.
 */
export async function loadLabels(dir: string, name: string, prefer: LabelFormat = 'labelme', size: SizeOf = anySize, edit = false) {
  return serial(async () => {
    let changed = false
    if (edit) {
      // Remembered before reading, so a change made meanwhile is found when saving, not missed
      changed = await changedSince(dir, name)
      held.set(heldKey(dir, name), await stampsOf(dir, name))
      getRoot(dir).editing = name
    }
    const found = await findLabels(dir, name, prefer)
    const labels = found && await readLabels(dir, name, found, size)
    if (!labels) return { file: labelPath(dir, name, prefer), format: null, verified: false, doc: null, changed }
    // imageData can be megabytes: the window doesn't need it
    return { file: labels.file, format: labels.format, verified: labels.verified, doc: { ...labels.doc, imageData: labels.doc.imageData ? '' : null }, changed }
  })
}

/** Where Delete label file looks: the file the image has, or the one it would get */
export async function labelsFile(dir: string, name: string, prefer: LabelFormat) {
  return (await findLabels(dir, name, prefer))?.file ?? labelPath(dir, name, prefer)
}

/** Takes an image's labels away: to the trash, or out of a CreateML list that holds other images too */
async function dropLabels(dir: string, name: string, found: Found) {
  const text = found.format === 'createml' ? await readText(found.file) : null
  let rest: string | null = null
  if (text !== null) {
    try {
      rest = removeCreateML(text, createmlName(dir, name))
    } catch (e) {
      // The one output file holds every image's labels: one that can't be read stays as it is
      if (found.file === getRoot(dir).outputFile) throw unreadable(found.file, e)
    }
  }
  if (rest !== null) await writeAtomic(found.file, rest)
  else await trash(found.file)
  await wrote(dir, name, found.file, found.format)
}

export async function trashLabels(dir: string, name: string, prefer: LabelFormat) {
  return serial(async () => {
    if (await changedSince(dir, name)) throw new LabelsChanged(name)
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
    if (await changedSince(dir, name)) throw new LabelsChanged(name)
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
    r.sent.delete(name)
    const kept: string[] = []
    for (const found of labels) {
      try {
        await dropLabels(dir, name, found)
      } catch (e: any) {
        kept.push(e.message)
      }
    }
    held.delete(heldKey(dir, name))
    return { image, kept: kept.length ? kept.join('; ') : undefined }
  })
}

export function cacheKey(file: string, size: number, mtime: number) {
  return createHash('sha1').update(`${file}\0${size}\0${Math.floor(mtime)}`).digest('hex').slice(0, 20)
}
