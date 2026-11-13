import fs, { existsSync, mkdirSync, mkdtempSync, promises, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { syncBuiltinESMExports } from 'module'
import { tmpdir } from 'os'
import path from 'path'
import { describe, expect, test, vi } from 'vitest'
import { defaultConfig } from '../../src/shared/config'
import { newShape, type Shape } from '../../src/shared/labelfile'
import { labelList, recolored, withClass } from '../../src/renderer/src/colors'
import {
  findLabels, type ImageItem, type LabelClass, labelPath, labelsChanged, LabelsChanged, loadLabels, mergeClasses, openHere, openProject, refreshProject,
  reloadProjectFile, saveLabels, saveProjectFile, type SaveRequest, setTrash, summarizeAll, trashImage, trashLabels
} from '../../src/main/project'

// Saving, switching formats and deleting, on folders of their own. The trash is a folder too.
const bin = mkdtempSync(path.join(tmpdir(), 'seamtag-trash-'))
let trashed: string[] = []
setTrash(async (file) => {
  renameSync(file, path.join(bin, `${trashed.length}-${path.basename(file)}`))
  trashed.push(file)
})

/** A folder of images, which only need their names here, and files beside them */
function folder(files: Record<string, string>, images = ['a.png']) {
  const dir = mkdtempSync(path.join(tmpdir(), 'seamtag-project-'))
  for (const [name, text] of [...images.map((i) => [i, ''] as const), ...Object.entries(files)]) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), text)
  }
  trashed = []
  return dir
}
const text = (dir: string, name: string) => readFileSync(path.join(dir, name), 'utf8')
const box = (label: string, x0 = 10, y0 = 10, x1 = 50, y1 = 40) => newShape(label, 'rectangle', [[x0, y0], [x1, y1]])
const request = (shapes: Shape[], extra: Partial<SaveRequest> = {}): SaveRequest =>
  ({ shapes, flags: {}, size: [100, 80], imageData: null, ...extra })
const LABELME = JSON.stringify({ version: '5.5.0', flags: {}, shapes: [
  { label: 'cat', points: [[1, 1], [9, 1], [5, 9]], group_id: null, description: '', shape_type: 'polygon', flags: {}, mask: null }
], imagePath: 'a.png', imageData: null, imageHeight: 80, imageWidth: 100 })
const VOC = '<annotation><object><name>dog</name><bndbox><xmin>2</xmin><ymin>3</ymin><xmax>20</xmax><ymax>30</ymax></bndbox></object></annotation>'

describe('switching formats', () => {
  test('saves the new format, then moves the old file to the trash', async () => {
    const dir = folder({ 'a.json': LABELME })
    await openProject(dir, null)
    const saved = await saveLabels(dir, 'a.png', request([box('cat')], { format: 'voc', from: 'labelme' }))
    expect(saved.replaced).toBe(path.join(dir, 'a.json'))
    expect(text(dir, 'a.xml')).toContain('<name>cat</name>')
    expect(trashed).toEqual([path.join(dir, 'a.json')])
  })

  test('never writes over labels the image already has in the new format', async () => {
    const dir = folder({ 'a.json': LABELME, 'a.xml': VOC })
    await openProject(dir, null)
    await expect(saveLabels(dir, 'a.png', request([box('dog')], { format: 'labelme', from: 'voc' }))).rejects.toThrow(/already holds labels/)
    expect(text(dir, 'a.json')).toBe(LABELME)
    expect(text(dir, 'a.xml')).toBe(VOC)
    expect(trashed).toEqual([])
  })

  test('the preferred format opens first, then LabelMe JSON, Pascal VOC and YOLO', async () => {
    const dir = folder({ 'a.json': LABELME, 'a.xml': VOC, 'b.txt': 'a caption, not labels' }, ['a.png', 'b.png'])
    await openProject(dir, null)
    expect((await loadLabels(dir, 'a.png', 'voc')).format).toBe('voc')
    expect((await loadLabels(dir, 'a.png', 'yolo')).format).toBe('labelme')
    // A .txt with no classes.txt beside it isn't YOLO's
    expect(await findLabels(dir, 'b.png', 'yolo')).toBeNull()
  })
})

describe('YOLO', () => {
  test("classes.txt keeps its numbers, new labels go at its end, and a caption .txt is never written over", async () => {
    const dir = folder({ 'b.txt': 'a caption' }, ['a.png', 'b.png'])
    await openProject(dir, null)
    await expect(saveLabels(dir, 'b.png', request([box('cat')], { format: 'yolo' }))).rejects.toThrow(/isn't a YOLO file/)
    expect(text(dir, 'b.txt')).toBe('a caption')
    writeFileSync(path.join(dir, 'classes.txt'), 'dog\ncat\n')
    await saveLabels(dir, 'a.png', request([box('cat'), box('bird')], { format: 'yolo', classes: ['bird', 'cat', 'dog'] }))
    expect(text(dir, 'classes.txt')).toBe('dog\ncat\nbird\n')
    expect(text(dir, 'a.txt').split('\n').map((l) => l.split(' ')[0])).toEqual(['1', '2', ''])
  })

  test('a byte order mark before classes.txt is no part of the first class: its boxes keep its name and number', async () => {
    const dir = folder({ 'classes.txt': '\uFEFFdog\n\ncat\n', 'a.txt': '0 0.5 0.5 0.2 0.2\n2 0.25 0.25 0.1 0.1\n' })
    await openProject(dir, null)
    const loaded = await loadLabels(dir, 'a.png', 'yolo', async () => [100, 80], true)
    expect(loaded.doc!.shapes.map((s) => s.label)).toEqual(['dog', 'cat'])
    // dog is class 0, not a new class; bird goes at the end, after the others in their order
    await saveLabels(dir, 'a.png', request([box('dog'), box('cat'), box('bird')], { format: 'yolo' }))
    expect(text(dir, 'classes.txt')).toBe('\uFEFFdog\n\ncat\nbird\n')
    expect(text(dir, 'a.txt').split('\n').map((l) => l.split(' ')[0])).toEqual(['0', '2', '3', ''])
  })

  test("classes a save adds go at the end of classes.txt, which stays as it was, so no other class's number moves", async () => {
    // A byte order mark and a blank line: class 0 has no name, dog is 1 and cat 2, as LabelImg and Seamline read it
    const dir = folder({ 'classes.txt': '\uFEFF\ndog\ncat\n', 'a.txt': '1 0.5 0.5 0.2 0.2\n2 0.25 0.25 0.1 0.1\n' }, ['a.png', 'b.png', 'c.png'])
    await openProject(dir, null)
    const labels = async (name: string) => (await loadLabels(dir, name, 'yolo', async () => [100, 80])).doc!.shapes.map((s) => s.label)
    expect(await labels('a.png')).toEqual(['dog', 'cat'])
    await saveLabels(dir, 'b.png', request([box('bird')], { format: 'yolo' }))
    expect(text(dir, 'classes.txt')).toBe('\uFEFF\ndog\ncat\nbird\n')
    expect(await labels('a.png')).toEqual(['dog', 'cat'])
    expect(await labels('b.png')).toEqual(['bird'])
    // Windows' line ends stay too
    writeFileSync(path.join(dir, 'classes.txt'), 'dog\r\ncat\r\n')
    await saveLabels(dir, 'c.png', request([box('cat'), box('owl')], { format: 'yolo' }))
    expect(text(dir, 'classes.txt')).toBe('dog\r\ncat\r\nowl\r\n')
    expect(await labels('c.png')).toEqual(['cat', 'owl'])
  })
})

describe('output folders and files', () => {
  test('images of the same name in different folders keep their own label files', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'seamtag-out-'))
    writeFileSync(path.join(out, 'a.xml'), VOC)
    writeFileSync(path.join(out, 'c.json'), LABELME)
    const dir = folder({}, ['a.png', 'sub/a.png', 'deep/c.png'])
    await openProject(dir, out)
    expect(labelPath(dir, 'a.png', 'voc')).toBe(path.join(out, 'a.xml'))
    expect(labelPath(dir, 'sub/a.png', 'voc')).toBe(path.join(out, 'sub', 'a.xml'))
    expect((await loadLabels(dir, 'sub/a.png', 'voc')).doc).toBeNull()
    // A name only one image has still finds labelme's flat file
    expect(labelPath(dir, 'deep/c.png')).toBe(path.join(out, 'c.json'))
  })

  test('one CreateML file lists every image by its path; one that can not be read is never trashed whole', async () => {
    const dir = folder({}, ['a.png', 'sub/a.png', 'b.png'])
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'seamtag-out-')), 'labels.json')
    await openProject(dir, file)
    await saveLabels(dir, 'a.png', request([box('cat')], { format: 'createml' }))
    await saveLabels(dir, 'sub/a.png', request([box('dog'), box('dog', 60, 10, 90, 40)], { format: 'createml' }))
    expect(JSON.parse(readFileSync(file, 'utf8')).map((e: any) => e.image)).toEqual(['a.png', 'sub/a.png'])
    expect((await loadLabels(dir, 'sub/a.png', 'createml')).doc!.shapes.map((s) => s.label)).toEqual(['dog', 'dog'])
    expect((await loadLabels(dir, 'b.png', 'createml')).doc).toBeNull()
    writeFileSync(file, '[{"image": "a.png"')
    const gone = await trashImage(dir, 'a.png')
    expect(gone.kept).toMatch(/can't be read/)
    expect(existsSync(file)).toBe(true)
    expect(trashed).toEqual([path.join(dir, 'a.png')])
  })
})

test('Delete image: the image goes first, then its label files in every format; classes.txt stays', async () => {
  const dir = folder({ 'a.json': LABELME, 'a.xml': VOC, 'a.txt': '0 0.5 0.5 0.2 0.2\n', 'classes.txt': 'dog\n' })
  await openProject(dir, null)
  expect((await trashImage(dir, 'a.png')).kept).toBeUndefined()
  expect(trashed).toEqual(['a.png', 'a.json', 'a.xml', 'a.txt'].map((f) => path.join(dir, f)))
  expect(existsSync(path.join(dir, 'classes.txt'))).toBe(true)
})

describe('another app, such as Seamline, changing label files while the folder is open', () => {
  // What the window does as it opens an image: read its labels to edit them
  const edit = (dir: string, name = 'a.png', prefer: SaveRequest['format'] = 'labelme') => loadLabels(dir, name, prefer, undefined, true)
  const THEIRS = LABELME.replace('"cat"', '"dog"')

  test("a save never writes over labels changed since they were read; read again, they're saved over", async () => {
    const dir = folder({ 'a.json': LABELME })
    await openProject(dir, null)
    expect((await edit(dir)).changed).toBe(false)
    writeFileSync(path.join(dir, 'a.json'), THEIRS)
    expect(await labelsChanged(dir, 'a.png')).toBe(true)
    await expect(saveLabels(dir, 'a.png', request([box('cat')]))).rejects.toThrow(LabelsChanged)
    expect(text(dir, 'a.json')).toBe(THEIRS)
    const again = await edit(dir)
    expect(again.changed).toBe(true)
    expect(again.doc!.shapes.map((s) => s.label)).toEqual(['dog'])
    expect(await labelsChanged(dir, 'a.png')).toBe(false)
    // Seamtag's own saves follow one another
    await saveLabels(dir, 'a.png', request([box('dog')]))
    await saveLabels(dir, 'a.png', request([box('dog'), box('cat')]))
    expect(JSON.parse(text(dir, 'a.json')).shapes.map((s: any) => s.label)).toEqual(['dog', 'cat'])
  })

  test('a change that keeps the size and the time is found by what the file holds, and a file another app deleted counts too', async () => {
    const dir = folder({ 'a.json': LABELME })
    const file = path.join(dir, 'a.json')
    // Within one tick of a coarse file clock, such as FAT's 2 s, the other app's save gets the same time
    const tick = new Date(Math.floor(statSync(file).mtimeMs / 1000) * 1000)
    utimesSync(file, tick, tick)
    await openProject(dir, null)
    await edit(dir)
    writeFileSync(file, THEIRS)
    utimesSync(file, tick, tick)
    expect(statSync(file)).toMatchObject({ size: LABELME.length, mtimeMs: tick.getTime() })
    expect(await labelsChanged(dir, 'a.png')).toBe(true)
    await expect(saveLabels(dir, 'a.png', request([]))).rejects.toThrow(LabelsChanged)
    expect(text(dir, 'a.json')).toBe(THEIRS)
    // Touched with nothing changed, it's as it was
    await edit(dir)
    const later = new Date(statSync(file).mtimeMs + 5000)
    utimesSync(file, later, later)
    expect(await labelsChanged(dir, 'a.png')).toBe(false)
    rmSync(file)
    await expect(saveLabels(dir, 'a.png', request([box('cat')]))).rejects.toThrow(LabelsChanged)
    expect(existsSync(file)).toBe(false)
  })

  test('a label file another app wrote in another format, where there was none, counts', async () => {
    const dir = folder({})
    await openProject(dir, null)
    expect((await edit(dir)).doc).toBeNull()
    writeFileSync(path.join(dir, 'a.xml'), VOC)
    await expect(saveLabels(dir, 'a.png', request([box('cat')]))).rejects.toThrow(LabelsChanged)
    expect(existsSync(path.join(dir, 'a.json'))).toBe(false)
    // A caption beside the image isn't a label file: no classes.txt, no YOLO
    const other = folder({})
    await openProject(other, null)
    await edit(other)
    writeFileSync(path.join(other, 'a.txt'), 'a caption')
    await saveLabels(other, 'a.png', request([box('cat')]))
    expect(text(other, 'a.txt')).toBe('a caption')
  })

  test('switching formats, deleting the label file and deleting the image leave changed labels alone', async () => {
    const dir = folder({ 'a.json': LABELME })
    await openProject(dir, null)
    await edit(dir)
    writeFileSync(path.join(dir, 'a.json'), THEIRS)
    await expect(saveLabels(dir, 'a.png', request([box('cat')], { format: 'voc', from: 'labelme' }))).rejects.toThrow(LabelsChanged)
    await expect(trashLabels(dir, 'a.png', 'labelme')).rejects.toThrow(LabelsChanged)
    await expect(trashImage(dir, 'a.png')).rejects.toThrow(LabelsChanged)
    expect(existsSync(path.join(dir, 'a.xml'))).toBe(false)
    expect(text(dir, 'a.json')).toBe(THEIRS)
    expect(existsSync(path.join(dir, 'a.png'))).toBe(true)
    expect(trashed).toEqual([])
    // Once read again, the switch goes ahead, and the next save follows it
    await edit(dir)
    await saveLabels(dir, 'a.png', request([box('cat')], { format: 'voc', from: 'labelme' }))
    expect(trashed).toEqual([path.join(dir, 'a.json')])
    await saveLabels(dir, 'a.png', request([box('cat'), box('dog')], { format: 'voc' }))
    expect(text(dir, 'a.xml').match(/<object>/g)).toHaveLength(2)
  })

  test("Save as onto the image's own label file counts as a save; anywhere else it doesn't", async () => {
    const dir = folder({ 'a.json': LABELME })
    await openProject(dir, null)
    await edit(dir)
    writeFileSync(path.join(dir, 'a.json'), THEIRS)
    await expect(saveLabels(dir, 'a.png', request([box('cat')], { target: path.join(dir, 'a.json') }))).rejects.toThrow(LabelsChanged)
    await saveLabels(dir, 'a.png', request([box('cat')], { target: path.join(dir, 'copy.json') }))
    expect(JSON.parse(text(dir, 'copy.json')).shapes).toHaveLength(1)
    expect(text(dir, 'a.json')).toBe(THEIRS)
  })

  test("a CreateML list another app changed isn't written over", async () => {
    const dir = folder({}, ['a.png', 'b.png'])
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'seamtag-out-')), 'labels.json')
    await openProject(dir, file)
    await saveLabels(dir, 'a.png', request([box('cat')], { format: 'createml' }))
    await edit(dir, 'a.png', 'createml')
    // LabelImg saves another image in the same list
    const theirs = JSON.stringify([...JSON.parse(readFileSync(file, 'utf8')), { image: 'b.png', verified: false, annotations: [] }])
    writeFileSync(file, theirs)
    await expect(saveLabels(dir, 'a.png', request([box('dog')], { format: 'createml' }))).rejects.toThrow(LabelsChanged)
    expect(readFileSync(file, 'utf8')).toBe(theirs)
  })

  test("in one CreateML list, Seamtag's saves of one image don't count against the others; another app's do", async () => {
    const dir = folder({}, ['a.png', 'b.png'])
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'seamtag-out-')), 'labels.json')
    await openProject(dir, file)
    await edit(dir, 'a.png', 'createml')
    await saveLabels(dir, 'a.png', request([box('cat')], { format: 'createml' }))
    await edit(dir, 'b.png', 'createml')
    await saveLabels(dir, 'b.png', request([box('dog')], { format: 'createml' }))
    expect((await edit(dir, 'a.png', 'createml')).changed).toBe(false)
    await saveLabels(dir, 'a.png', request([box('cat'), box('cat', 60, 10, 90, 40)], { format: 'createml' }))
    // LabelImg changes b.png's boxes meanwhile
    writeFileSync(file, readFileSync(file, 'utf8').replace('"dog"', '"bird"'))
    expect((await edit(dir, 'b.png', 'createml')).changed).toBe(true)
    expect((await loadLabels(dir, 'b.png', 'createml')).doc!.shapes.map((s) => s.label)).toEqual(['bird'])
  })

  test('labels Seamtag never read are judged by what the file holds, as before', async () => {
    const dir = folder({ 'a.json': LABELME })
    await openProject(dir, null)
    await saveLabels(dir, 'a.png', request([box('cat')]))
    expect(JSON.parse(text(dir, 'a.json')).shapes[0].shape_type).toBe('rectangle')
    expect(await labelsChanged(dir, 'a.png')).toBe(false)
  })

  test('a refresh finds images added and removed, and tells only the label files that changed', async () => {
    const dir = folder({ 'a.json': LABELME, 'd.json': LABELME }, ['a.png', 'b.png', 'd.png'])
    await openProject(dir, null)
    const told = async () => {
      const items: ImageItem[] = []
      await summarizeAll(dir, (b) => items.push(...b.items), 'labelme', true)
      return items.map((i) => [i.name, i.count])
    }
    await summarizeAll(dir, () => {})
    expect(await told()).toEqual([])
    writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ ...JSON.parse(LABELME), shapes: [] }))
    writeFileSync(path.join(dir, 'c.png'), '')
    writeFileSync(path.join(dir, 'c.json'), LABELME)
    rmSync(path.join(dir, 'b.png'))
    const { names, added } = await refreshProject(dir)
    expect(names).toEqual(['a.png', 'c.png', 'd.png'])
    expect(added.map((i) => [i.name, i.labelled])).toEqual([['c.png', true]])
    expect((await told()).sort()).toEqual([['a.png', 0], ['c.png', 1]])
    expect(await told()).toEqual([])
  })

  test("a refresh looks only at label files the folders list, and at each folder's classes.txt once", async () => {
    const images = Array.from({ length: 40 }, (_, i) => `${i % 2 ? 'sub/' : ''}img_${i}.png`)
    const dir = folder({ 'img_0.json': LABELME, 'sub/img_1.txt': '0 0.5 0.5 0.2 0.2\n', 'sub/classes.txt': 'dog\n' }, images)
    await openProject(dir, null)
    await summarizeAll(dir, () => {})
    const stat = vi.spyOn(promises, 'stat'), read = vi.spyOn(promises, 'readFile')
    try {
      const items: ImageItem[] = []
      await summarizeAll(dir, (b) => items.push(...b.items), 'labelme', true)
      expect(items).toEqual([])
      expect(stat.mock.calls.map(([f]) => path.relative(dir, String(f))).sort()).toEqual(['img_0.json', path.join('sub', 'img_1.txt')])
      // classes.txt by what it holds, once for its folder
      expect(read.mock.calls.map(([f]) => path.relative(dir, String(f)))).toEqual([path.join('sub', 'classes.txt')])
      // classes.txt changes the names of every YOLO file beside it
      writeFileSync(path.join(dir, 'sub', 'classes.txt'), 'cat\nbird\n')
      await summarizeAll(dir, (b) => items.push(...b.items), 'labelme', true)
      expect(items.find((i) => i.name === 'sub/img_1.png')?.classes).toEqual({ cat: 1 })
    } finally {
      stat.mockRestore()
      read.mockRestore()
    }
  })

  test('the counts follow a classes.txt rewritten at the same size within one tick of a coarse file clock', async () => {
    const dir = folder({ 'classes.txt': 'cat\ndog\n', 'a.txt': '0 0.5 0.5 0.2 0.2\n' })
    const file = path.join(dir, 'classes.txt')
    const tick = new Date(Math.floor(statSync(file).mtimeMs / 1000) * 1000)
    utimesSync(file, tick, tick)
    await openProject(dir, null)
    const told = async (changedOnly: boolean) => {
      const items: ImageItem[] = []
      await summarizeAll(dir, (b) => items.push(...b.items), 'labelme', changedOnly)
      return items.map((i) => i.classes)
    }
    expect(await told(false)).toEqual([{ cat: 1 }])
    // Two names swapped: the same size, and within the tick, the same time
    writeFileSync(file, 'dog\ncat\n')
    utimesSync(file, tick, tick)
    expect(await told(true)).toEqual([{ dog: 1 }])
  })
})

describe('saved automatically with nothing to keep: an empty label file says someone cleared the image, as in Seamline', () => {
  const edit = (dir: string, name = 'a.png') => loadLabels(dir, name, 'labelme', undefined, true)
  const auto = (shapes: Shape[], extra: Partial<SaveRequest> = {}) => request(shapes, { auto: true, ...extra })
  const shapesOf = (dir: string, name = 'a.json') => JSON.parse(text(dir, name)).shapes

  test('an image with no label file gets none, and the one these saves made for it goes again, as when a shape drawn is undone', async () => {
    const dir = folder({}, ['a.png'])
    await openProject(dir, null)
    await edit(dir)
    const none = await saveLabels(dir, 'a.png', auto([]))
    expect([none.format, none.item.labelled, existsSync(path.join(dir, 'a.json'))]).toEqual([null, false, false])
    await saveLabels(dir, 'a.png', auto([box('cat')]))
    await saveLabels(dir, 'a.png', auto([box('cat'), box('dog')]))
    expect(shapesOf(dir)).toHaveLength(2)
    const gone = await saveLabels(dir, 'a.png', auto([]))
    expect([gone.format, gone.item.labelled, existsSync(path.join(dir, 'a.json'))]).toEqual([null, false, false])
    expect(trashed).toEqual([])
    expect(await labelsChanged(dir, 'a.png')).toBe(false)
    // Drawn again, it's saved as before
    expect((await saveLabels(dir, 'a.png', auto([box('cat')]))).format).toBe('labelme')
    expect(shapesOf(dir)).toHaveLength(1)
  })

  test('saved by hand, as in labelme, the empty file is written and stays: from then on the file is the person\'s', async () => {
    const dir = folder({}, ['a.png', 'b.png'])
    await openProject(dir, null)
    await edit(dir)
    expect((await saveLabels(dir, 'a.png', request([]))).format).toBe('labelme')
    expect(shapesOf(dir)).toEqual([])
    await saveLabels(dir, 'a.png', auto([box('cat')]))
    await saveLabels(dir, 'a.png', auto([]))
    expect(shapesOf(dir)).toEqual([])
    // Made by these saves, then saved by hand
    await edit(dir, 'b.png')
    await saveLabels(dir, 'b.png', auto([box('cat')]))
    await saveLabels(dir, 'b.png', request([box('cat')]))
    await saveLabels(dir, 'b.png', auto([]))
    expect(shapesOf(dir, 'b.json')).toEqual([])
  })

  test('a file the image had, an image flag, a verified mark, or one output file for every image keep the file written', async () => {
    const dir = folder({ 'a.json': LABELME }, ['a.png', 'b.png', 'c.png'])
    await openProject(dir, null)
    await edit(dir)
    await saveLabels(dir, 'a.png', auto([]))
    expect(shapesOf(dir)).toEqual([])
    await edit(dir, 'b.png')
    await saveLabels(dir, 'b.png', auto([], { flags: { occluded: true, truncated: false } }))
    expect(JSON.parse(text(dir, 'b.json')).flags).toEqual({ occluded: true, truncated: false })
    await edit(dir, 'c.png')
    await saveLabels(dir, 'c.png', auto([], { format: 'voc', verified: true }))
    expect(text(dir, 'c.xml')).toContain('<annotation verified="yes">')
    const one = folder({}, ['a.png'])
    await openProject(one, path.join(one, 'out.json'))
    await saveLabels(one, 'a.png', auto([]))
    expect(shapesOf(one, 'out.json')).toEqual([])
  })

  test("the file goes only as these saves wrote it: another app's labels, cleared here, leave the empty file", async () => {
    const dir = folder({}, ['a.png'])
    await openProject(dir, null)
    await edit(dir)
    await saveLabels(dir, 'a.png', auto([box('cat')]))
    const theirs = LABELME.replace('"cat"', '"dog"')
    writeFileSync(path.join(dir, 'a.json'), theirs)
    await expect(saveLabels(dir, 'a.png', auto([]))).rejects.toThrow(LabelsChanged)
    expect(text(dir, 'a.json')).toBe(theirs)
    // Read again, and cleared: someone cleared it
    await edit(dir)
    expect((await saveLabels(dir, 'a.png', auto([]))).format).toBe('labelme')
    expect(shapesOf(dir)).toEqual([])
  })

  test("in YOLO, the image's .txt goes the same way, and classes.txt stays", async () => {
    const dir = folder({}, ['a.png'])
    await openProject(dir, null)
    await edit(dir)
    await saveLabels(dir, 'a.png', auto([], { format: 'yolo', classes: ['cat'] }))
    expect([existsSync(path.join(dir, 'a.txt')), existsSync(path.join(dir, 'classes.txt'))]).toEqual([false, false])
    await saveLabels(dir, 'a.png', auto([box('cat')], { format: 'yolo', classes: ['cat'] }))
    expect(text(dir, 'classes.txt')).toBe('cat\n')
    await saveLabels(dir, 'a.png', auto([], { format: 'yolo', classes: ['cat'] }))
    expect([existsSync(path.join(dir, 'a.txt')), text(dir, 'classes.txt')]).toEqual([false, 'cat\n'])
  })
})

test("opening a folder lists each label folder once, rather than asking after each image's label files, which is slow on a network share", async () => {
  const images = Array.from({ length: 40 }, (_, i) => `${i % 2 ? 'sub/' : ''}img_${i}.png`)
  const dir = folder({
    'img_0.json': LABELME, 'img_2.xml': VOC, 'sub/img_1.txt': '0 0.5 0.5 0.2 0.2\n', 'sub/classes.txt': 'dog\n', 'img_4.txt': 'a caption'
  }, images)
  // existsSync as the code under test imports it too
  const asked = vi.spyOn(fs, 'existsSync'), listed = vi.spyOn(promises, 'readdir')
  syncBuiltinESMExports()
  try {
    const opened = await openProject(dir, null)
    expect(opened.images.filter((i) => i.labelled).map((i) => i.name).sort()).toEqual(['img_0.png', 'img_2.png', 'sub/img_1.png'])
    expect(asked).not.toHaveBeenCalled()
    // Once to find the images, and once more for the listings
    expect(listed.mock.calls.map(([f]) => path.relative(dir, String(f))).sort()).toEqual(['', '', 'sub', 'sub'])
  } finally {
    asked.mockRestore()
    listed.mockRestore()
    syncBuiltinESMExports()
  }
})

describe('Seamtag started again, as Seamline starts it', () => {
  test('a folder open here, or one of its images, even one added since, is found; anything else is not', async () => {
    const dir = folder({}, ['a.png', 'sub/b.png', '.hidden/c.png'])
    await openProject(dir, null)
    expect(openHere(dir)).toEqual({ root: dir, name: null })
    expect(openHere(path.join(dir, 'sub', 'b.png'))).toEqual({ root: dir, name: 'sub/b.png' })
    writeFileSync(path.join(dir, 'new.png'), '')
    expect(openHere(path.join(dir, 'new.png'))).toEqual({ root: dir, name: 'new.png' })
    expect(openHere(path.join(dir, 'gone.png'))).toBeNull()
    expect(openHere(path.join(dir, '.hidden', 'c.png'))).toBeNull()
    expect(openHere(path.join(dir, 'a.json'))).toBeNull()
    expect(openHere(path.dirname(dir))).toBeNull()
  })
})

describe('started on an image in a subfolder of a Seamline project, as Seamline starts it', () => {
  const PROJECT = JSON.stringify({ name: 'parts', classes: [] })

  test('the whole project opens, on that image; opened by hand, or with no project above, its own folder does', async () => {
    const dir = folder({ '.myseg/project.json': PROJECT }, ['a.png', 'line2/x.png', 'line2/y.png'])
    const target = path.join(dir, 'line2', 'x.png')
    const started = await openProject(target, null, true)
    expect([started.root, started.select, started.project.name]).toEqual([dir, 'line2/x.png', 'parts'])
    expect(started.images.map((i) => i.name)).toEqual(['a.png', 'line2/x.png', 'line2/y.png'])
    const byHand = await openProject(target, null)
    expect([byHand.root, byHand.select]).toEqual([path.join(dir, 'line2'), 'x.png'])
    // No project above
    const plain = folder({}, ['a.png', 'line2/x.png'])
    const alone = await openProject(path.join(plain, 'line2', 'x.png'), null, true)
    expect([alone.root, alone.select]).toEqual([path.join(plain, 'line2'), 'x.png'])
  })

  test('the nearest project counts; an image its project lists not, or a label file, opens as before', async () => {
    const dir = folder({ '.myseg/project.json': PROJECT, 'line2/.myseg/project.json': PROJECT, 'line2/deep/x.json': '' }, ['line2/deep/x.png', '.cache/c.png'])
    // The nearest project is line2
    const nearest = await openProject(path.join(dir, 'line2', 'deep', 'x.png'), null, true)
    expect([nearest.root, nearest.select]).toEqual([path.join(dir, 'line2'), 'deep/x.png'])
    // A hidden folder, and a link to a folder, aren't in the project's list
    const hidden = await openProject(path.join(dir, '.cache', 'c.png'), null, true)
    expect([hidden.root, hidden.select]).toEqual([path.join(dir, '.cache'), 'c.png'])
    const elsewhere = folder({}, ['w.png'])
    symlinkSync(elsewhere, path.join(dir, 'linked'), 'junction')
    const linked = await openProject(path.join(dir, 'linked', 'w.png'), null, true)
    expect([linked.root, linked.select]).toEqual([path.join(dir, 'linked'), 'w.png'])
    // A label file opens its image's folder, as labelme opens it
    writeFileSync(path.join(dir, 'line2', 'deep', 'x.json'), LABELME.replace('"a.png"', '"x.png"'))
    const label = await openProject(path.join(dir, 'line2', 'deep', 'x.json'), null, true)
    expect([label.root, label.select]).toEqual([path.join(dir, 'line2', 'deep'), 'x.png'])
  })

  test('Open recent and the last folder keep the project such a start opened; anything else is kept as it was opened, as in labelme', async () => {
    const dir = folder({ '.myseg/project.json': PROJECT }, ['a.png', 'line2/x.png'])
    const target = path.join(dir, 'line2', 'x.png')
    expect((await openProject(target, null, true)).remembered).toBe(dir)
    expect((await openProject(target, null)).remembered).toBe(target)
    expect((await openProject(dir, null)).remembered).toBe(dir)
    expect((await openProject(path.join(dir, 'a.png'), null, true)).remembered).toBe(path.join(dir, 'a.png'))
    const plain = folder({}, ['line2/x.png'])
    expect((await openProject(path.join(plain, 'line2', 'x.png'), null, true)).remembered).toBe(path.join(plain, 'line2', 'x.png'))
  })
})

describe("the class list in .myseg/project.json, which Seamline changes too", () => {
  const c = (name: string, color = '#111111'): LabelClass => ({ name, color })
  const X = c('x'), Y = c('y'), Z = c('z')

  test('classes added elsewhere are kept, after the ones added here', () => {
    expect(mergeClasses([X], [X], [X, Y])).toEqual([X, Y])
    expect(mergeClasses([X], [X, Z], [X])).toEqual([X, Z])
    expect(mergeClasses([X], [X, Z], [X, Y])).toEqual([X, Z, Y])
    // Both added the same name: this app's colour
    expect(mergeClasses([X], [X, c('y', '#ff0000')], [X, c('y', '#00ff00')])).toEqual([X, c('y', '#ff0000')])
  })

  test('a colour changed here stays; one changed elsewhere, on a class left as it was here, is taken', () => {
    expect(mergeClasses([X, Y], [c('x', '#ff0000'), Y], [X, Y])).toEqual([c('x', '#ff0000'), Y])
    expect(mergeClasses([X, Y], [X, Y], [c('x', '#00ff00'), Y])).toEqual([c('x', '#00ff00'), Y])
    // Changed in both: this app's
    expect(mergeClasses([X], [c('x', '#ff0000')], [c('x', '#00ff00')])).toEqual([c('x', '#ff0000')])
  })

  test('classes deleted on either side go; a class renamed here is not brought back', () => {
    expect(mergeClasses([X, Y], [X], [X, Y])).toEqual([X])
    expect(mergeClasses([X, Y], [X, Y], [X])).toEqual([X])
    // Deleted elsewhere but changed here: kept
    expect(mergeClasses([X, Y], [X, c('y', '#ff0000')], [X])).toEqual([X, c('y', '#ff0000')])
    expect(mergeClasses([X], [Z], [X])).toEqual([Z])
  })

  test('with no file to read, this list is written as it is', () => {
    expect(mergeClasses([X, Y], [X], null)).toEqual([X])
    expect(mergeClasses([X, Y], [X, Y, Z], null)).toEqual([X, Y, Z])
  })

  // The same case as Seamline's shared.spec.ts, so the two apps' merges can't drift apart
  test('a name the file has twice, new to both lists, is added once; names differing in case are two classes', () => {
    expect(mergeClasses([c('c')], [c('e'), c('b'), c('b'), c('c', '#222222')], [c('dog'), c('a'), c('a', '#333333'), c('Dog')]))
      .toEqual([c('e'), c('b'), c('b'), c('c', '#222222'), c('dog'), c('a'), c('Dog')])
  })

  const projectFile = (dir: string) => path.join(dir, '.myseg', 'project.json')
  const write = (dir: string, doc: unknown) => {
    mkdirSync(path.dirname(projectFile(dir)), { recursive: true })
    writeFileSync(projectFile(dir), JSON.stringify(doc))
  }
  const read = (dir: string) => JSON.parse(readFileSync(projectFile(dir), 'utf8'))

  test("a save keeps Seamline's other keys and the classes it added and deleted since the folder was read", async () => {
    const dir = folder({})
    write(dir, { name: 'parts', classes: [X, Y], train: { epochs: 30 } })
    const opened = await openProject(dir, null)
    expect(opened.project.classes).toEqual([X, Y])
    // Seamline adds a class, deletes one and changes its settings meanwhile
    write(dir, { name: 'parts', classes: [X, c('w')], train: { epochs: 50 }, runs: ['20261112_101500'] })
    const saved = await saveProjectFile(dir, { name: 'parts', classes: [X, Y, Z] })
    expect(saved.classes).toEqual([X, Z, c('w')])
    expect(read(dir)).toEqual({ name: 'parts', classes: [X, Z, c('w')], train: { epochs: 50 }, runs: ['20261112_101500'] })
    // What was written is the new starting point: Seamline deleting z now deletes it
    write(dir, { ...read(dir), classes: [X, c('w')] })
    expect((await saveProjectFile(dir, { name: 'parts', classes: [X, Z, c('w'), c('v')] })).classes).toEqual([X, c('w'), c('v')])
  })

  test('read again, as when the window comes back, the file is the new starting point', async () => {
    const dir = folder({})
    write(dir, { name: 'parts', classes: [X] })
    await openProject(dir, null)
    write(dir, { name: 'parts', classes: [X, Y] })
    expect(await reloadProjectFile(dir)).toEqual({ name: 'parts', classes: [X, Y] })
    // y is now known here, so a list without it deletes it
    expect((await saveProjectFile(dir, { name: 'parts', classes: [X] })).classes).toEqual([X])
    rmSync(projectFile(dir))
    expect(await reloadProjectFile(dir)).toBeNull()
  })

  test('a missing or unreadable file is written with this list alone', async () => {
    const dir = folder({})
    await openProject(dir, null)
    await saveProjectFile(dir, { name: 'parts', classes: [X, Y] })
    expect(read(dir)).toEqual({ name: 'parts', classes: [X, Y] })
    writeFileSync(projectFile(dir), '{"classes": [')
    await saveProjectFile(dir, { name: 'parts', classes: [X] })
    expect(read(dir)).toEqual({ name: 'parts', classes: [X] })
  })

  // The label list on screen holds config labels and labels found in the files too, which aren't classes
  const config = { ...defaultConfig(), labels: ['cfg'] }
  const names = (list: LabelClass[]) => list.map((k) => k.name)

  test('adding or recolouring a label writes that label alone; the label list still shows every label, where it was', async () => {
    const dir = folder({})
    write(dir, { name: 'parts', classes: [X] })
    const opened = await openProject(dir, null)
    const before = labelList(config, opened.project.classes, ['dog'])
    expect(names(before)).toEqual(['cfg', 'x', 'dog'])
    // Added here: the folder's classes and the new label, not cfg or dog
    const saved = await saveProjectFile(dir, { name: 'parts', classes: withClass(opened.project.classes, 'owl', '#00ff00') })
    expect(read(dir).classes).toEqual([X, c('owl', '#00ff00')])
    // Shown as before, with the new label last
    const after = labelList(config, saved.classes, ['dog'], [...names(before), 'owl'])
    expect(after.slice(0, 3)).toEqual(before)
    expect(after[3]).toEqual(c('owl', '#00ff00'))
    // Recoloured: a class changes its colour; another label joins the classes, alone, and keeps its place
    const recoloured = await saveProjectFile(dir, { name: 'parts', classes: recolored(recolored(saved.classes, 'x', '#0000ff'), 'dog', '#ff0000') })
    expect(read(dir).classes).toEqual([c('x', '#0000ff'), c('owl', '#00ff00'), c('dog', '#ff0000')])
    expect(labelList(config, recoloured.classes, ['dog'], names(after))).toEqual([
      { name: 'cfg', color: before[0].color }, c('x', '#0000ff'), c('dog', '#ff0000'), c('owl', '#00ff00')
    ])
  })

  test("a folder's first class list starts as Seamline starts one: the labels of the folder's shapes with an area", async () => {
    const shape = (label: string, extra: object = {}) => ({ label, points: [[1, 1], [9, 1], [5, 9]], group_id: null, description: '', shape_type: 'polygon', flags: {}, mask: null, ...extra })
    const file = (...shapes: object[]) => JSON.stringify({ ...JSON.parse(LABELME), shapes })
    // dog in LabelMe and Pascal VOC, cat in a subfolder; a line, a point and an AI proposal have no say
    const dir = folder({
      'a.json': file(shape('dog'), shape('line', { shape_type: 'line', points: [[1, 1], [9, 9]] }), shape('proposed', { flags: { ai: true } })),
      'b.xml': VOC, 'sub/c.json': file(shape('cat'), shape('point', { shape_type: 'point', points: [[3, 3]] }))
    }, ['a.png', 'b.png', 'sub/c.png'])
    const opened = await openProject(dir, null)
    expect(opened.hasProjectFile).toBe(false)
    // In the colours the label list shows them in
    const shown = [c('cfg', '#010101'), c('dog', '#020202'), c('line', '#030303'), c('proposed', '#040404'), c('cat', '#050505'), c('point', '#060606')]
    const saved = await saveProjectFile(dir, { name: 'parts', classes: withClass(opened.project.classes, 'owl', '#00ff00') }, shown)
    const first = [c('cat', '#050505'), c('dog', '#020202'), c('owl', '#00ff00')]
    expect(saved.classes).toEqual(first)
    expect(read(dir).classes).toEqual(first)
    // From then on, as any other list: the next label goes in alone
    expect((await saveProjectFile(dir, { name: 'parts', classes: withClass(saved.classes, 'emu', '#0000ff') }, shown)).classes).toEqual([...first, c('emu', '#0000ff')])
    // A label recoloured first keeps its place among them, with its new colour
    const other = folder({ 'a.json': file(shape('dog')), 'b.json': file(shape('cat')) }, ['a.png', 'b.png'])
    await openProject(other, null)
    await saveProjectFile(other, { name: 'parts', classes: recolored([], 'dog', '#123456') }, shown)
    expect(read(other).classes).toEqual([c('cat', '#050505'), c('dog', '#123456')])
  })

  test('a class Seamline deleted while label files still use it stays deleted when a label is added here', async () => {
    const dir = folder({ 'a.json': LABELME })
    write(dir, { name: 'parts', classes: [X, c('cat')] })
    await openProject(dir, null)
    // Seamline deletes cat, which a.json still uses; the window comes back and reads the file again
    write(dir, { name: 'parts', classes: [X] })
    const now = (await reloadProjectFile(dir))!
    // cat is still in the label list, as the files have it
    expect(names(labelList(config, now.classes, ['cat']))).toEqual(['cfg', 'x', 'cat'])
    await saveProjectFile(dir, { name: 'parts', classes: withClass(now.classes, 'owl', '#00ff00') })
    expect(names(read(dir).classes)).toEqual(['x', 'owl'])
  })
})
