import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, test } from 'vitest'
import {
  asBox, bndBox, parseXml, pyFixed, pyRound, readClasses, readCreateML, readVoc, readYolo, removeCreateML, writeClasses,
  writeCreateML, writeVoc, writeYolo
} from '../../src/shared/formats'
import { LabelFileError, newShape, type Shape } from '../../src/shared/labelfile'

// Files written by LabelImg's own code, and what LabelImg reads back from them:
// tests/fixtures/labelimg/make_labelimg_files.py
const FIXTURES = path.join(__dirname, '../fixtures/labelimg')
const read = (...p: string[]) => readFileSync(path.join(FIXTURES, ...p), 'utf8')
type Case = {
  image: string; path: string; size: [number, number]; depth: number; verified: boolean; classes: string[]
  shapes: { label: string; points: number[][]; difficult: boolean }[]
  read: Record<string, { verified?: boolean; shapes: { label: string; points: number[][]; difficult: boolean }[] }>
}
const cases = (version: string): Case[] => JSON.parse(read(version, 'labelimg.json'))
const stem = (c: { image: string }) => c.image.replace(/\.png$/, '')
const toShapes = (c: Case) => c.shapes.map((s) => newShape(s.label, 'rectangle', s.points, s.difficult ? { flags: { difficult: true } } : {}))
/** What a reader gives, as LabelImg's corners: first, then the one across */
const corners = (shapes: Shape[]) => shapes.map((s) => [s.label, s.points[0], s.points[1]])
const labelimgCorners = (shapes: Case['read'][string]['shapes']) => shapes.map((s) => [s.label, s.points[0], s.points[2]])
const voc = (c: Case) => ({ folder: 'images', filename: c.image, path: c.path, width: c.size[0], height: c.size[1], depth: c.depth })

describe.each(['1.8.6', 'master'])('LabelImg %s', (version) => {
  test('Pascal VOC: the same bytes, and the same boxes, difficult flags and verified marks', () => {
    for (const c of cases(version).filter((x) => x.shapes)) {
      expect(writeVoc(voc(c), toShapes(c), c.verified), c.image).toBe(read(version, 'voc', `${stem(c)}.xml`))
      const got = readVoc(read(version, 'voc', `${stem(c)}.xml`))
      expect(got.verified).toBe(c.read.voc.verified)
      expect(corners(got.shapes)).toEqual(labelimgCorners(c.read.voc.shapes))
      expect(got.shapes.map((s) => s.flags.difficult === true)).toEqual(c.read.voc.shapes.map((s) => s.difficult))
    }
  })

  test("YOLO: the same lines and classes.txt, saved one image after another; the same boxes read back", () => {
    let classes = ['dog', 'cat']
    for (const c of cases(version).filter((x) => x.shapes)) {
      const out = writeYolo(toShapes(c), classes, c.size[0], c.size[1])
      expect(out.text, c.image).toBe(read(version, 'yolo', `${stem(c)}.txt`))
      expect(out.classes).toEqual(c.classes)
      classes = out.classes
      const got = readYolo(read(version, 'yolo', `${stem(c)}.txt`), readClasses(read(version, 'yolo', 'classes.txt')), c.size[0], c.size[1])
      expect(corners(got)).toEqual(labelimgCorners(c.read.yolo.shapes))
    }
    expect(writeClasses(classes)).toBe(read(version, 'yolo', 'classes.txt'))
  })

  test('YOLO written by others: halves of a pixel round to even, as Python rounds them', () => {
    const half = cases(version).find((c) => c.image === 'half.png')!
    const got = readYolo(read(version, 'yolo-hand', 'half.txt'), readClasses(read(version, 'yolo-hand', 'classes.txt')), half.size[0], half.size[1])
    expect(corners(got)).toEqual(labelimgCorners(half.read.yolo.shapes))
  })

  test('CreateML: the boxes as LabelImg reads them, and as master writes them, byte for byte', () => {
    for (const c of cases(version).filter((x) => x.shapes)) {
      const text = read(version, 'createml', `${stem(c)}.json`)
      const got = readCreateML(text, c.image)
      expect(got.found).toBe(true)
      expect(corners(got.shapes)).toEqual(labelimgCorners(c.read.createml.shapes))
      // 1.8.6 wrote no verified key and read every file as verified; master writes and reads it
      if (version === 'master') {
        expect(got.verified).toBe(c.read.createml.verified)
        expect(writeCreateML(null, c.image, toShapes(c), c.verified), c.image).toBe(text)
      } else {
        expect(writeCreateML(null, c.image, toShapes(c), c.verified)).toBe(text.replace(/^\[\{"image": "[^"]+", /, `$&"verified": ${c.verified}, `))
      }
    }
  })
})

describe("Python's numbers, which LabelImg's files hold", () => {
  const numbers = JSON.parse(read('python_numbers.json')) as { fixed: [number, string][]; round: [number, number][] }
  test("'%.6f' rounds halves to even, where toFixed rounds them up", () => {
    for (const [x, s] of numbers.fixed) expect(pyFixed(x), String(x)).toBe(s)
    expect((0.0078125).toFixed(6)).toBe('0.007813')
  })
  test('round() does too', () => {
    for (const [x, n] of numbers.round) expect(pyRound(x), String(x)).toBe(n)
  })
})

describe('Pascal VOC from other tools', () => {
  const file = (objects: string, attrs = '') => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE annotation [ <!ENTITY x "y"> ]>
<!-- written by hand -->
<annotation${attrs}>
  <folder>VOC2012</folder>
  <filename>2007_000027.jpg</filename>
  ${objects}
</annotation>`
  test('declarations, comments, CDATA, entities and extra elements are read; fractions stay', () => {
    const got = readVoc(file(`<object>
    <name><![CDATA[cat & dog]]></name><occluded>0</occluded>
    <difficult>1</difficult>
    <bndbox><xmin>10.5</xmin><ymin> 20 </ymin><xmax>30</xmax><ymax>40.25</ymax></bndbox>
    <part><name>head</name><bndbox><xmin>1</xmin><ymin>1</ymin><xmax>2</xmax><ymax>2</ymax></bndbox></part>
  </object>
  <object><name>caf&#233; &amp; bar</name><bndbox><xmin>1</xmin><ymin>2</ymin><xmax>3</xmax><ymax>4</ymax></bndbox></object>`, " verified='yes'"))
    expect(got.verified).toBe(true)
    expect(got.shapes.map((s) => [s.label, s.points, s.flags])).toEqual([
      ['cat & dog', [[10.5, 20], [30, 40.25]], { difficult: true }],
      ['café & bar', [[1, 2], [3, 4]], {}]
    ])
  })
  test("what can't be read is refused with a reason, so the file is never written over", () => {
    const bad = (text: string, message: RegExp) => {
      expect(() => readVoc(text)).toThrow(LabelFileError)
      expect(() => readVoc(text)).toThrow(message)
    }
    bad('<annotations></annotations>', /isn't a Pascal VOC file/)
    bad('<annotation><object><name>a</name></object></annotation>', /no <bndbox>/)
    bad(file('<object><name>a</name><bndbox><xmin>x</xmin><ymin>1</ymin><xmax>2</xmax><ymax>2</ymax></bndbox></object>'), /number in <xmin>/)
    bad('<annotation><object></annotation>', /closes nothing/)
    bad('<annotation>', /never closed/)
    bad('<a/><b/>', /two top elements/)
    bad('caption text', /text outside/)
  })
  test('the XML reader keeps attributes and nesting', () => {
    const root = parseXml('<a x="1" y=\'&lt;2\'><b>t<c/>u</b></a>')
    expect(root.attrs).toEqual({ x: '1', y: '<2' })
    expect(root.children[0].text).toBe('tu')
    expect(root.children[0].children[0].name).toBe('c')
  })
  test("only labels are escaped; LabelImg's double spaces stay spaces here", () => {
    const text = writeVoc({ folder: 'f', filename: 'a.png', path: '/f/a.png', width: 10, height: 10, depth: 3 }, [newShape('two  spaces', 'rectangle', [[2, 2], [5, 5]])], false)
    expect(text).toContain('<name>two  spaces</name>')
  })
})

describe('YOLO from other tools', () => {
  test('blank lines are skipped, a class missing from classes.txt is refused', () => {
    expect(readYolo('\n0 0.5 0.5 0.5 0.5\n\n', ['a'], 100, 100).map((s) => s.points)).toEqual([[[25, 25], [75, 75]]])
    expect(() => readYolo('3 0.5 0.5 0.1 0.1', ['a'], 10, 10)).toThrow(/class 3 isn't in classes.txt/)
    expect(() => readYolo('0 0.5 0.5 0.1', ['a'], 10, 10)).toThrow(/four numbers/)
    expect(() => readYolo('0 0.5 0.5 0.1 0.1 0.2 0.3', ['a'], 10, 10)).toThrow(/four numbers/)
  })
  test('classes.txt keeps blank lines inside it, so the numbers after them stay; Windows line ends read too', () => {
    expect(readClasses('a\n\nc\n')).toEqual(['a', '', 'c'])
    expect(readClasses('a\r\nb\r\n')).toEqual(['a', 'b'])
  })
})

describe('CreateML', () => {
  test("one image's entry is put in place of its old one; the rest stay as Python wrote them", () => {
    const before = '[{"image": "a.png", "verified": false, "annotations": []}, {"image": "b.png", "annotations": [{"label": "x", "coordinates": {"x": 10.0, "y": 5, "width": 2.5, "height": 1e-05}}]}]'
    const after = writeCreateML(before, 'a.png', [newShape('cat', 'rectangle', [[0, 0], [4, 2]])], true)
    expect(after).toBe('[{"image": "a.png", "verified": true, "annotations": [{"label": "cat", "coordinates": {"x": 2.0, "y": 1.0, "width": 4.0, "height": 2.0}}]}, ' +
      '{"image": "b.png", "annotations": [{"label": "x", "coordinates": {"x": 10.0, "y": 5, "width": 2.5, "height": 1e-05}}]}]')
    expect(readCreateML(after, 'b.png').shapes[0].label).toBe('x')
    expect(readCreateML(after, 'c.png')).toEqual({ shapes: [], verified: false, found: false })
    expect(removeCreateML(after, 'a.png')).toBe('[{"image": "b.png", "annotations": [{"label": "x", "coordinates": {"x": 10.0, "y": 5, "width": 2.5, "height": 1e-05}}]}]')
    expect(removeCreateML('[{"image": "a.png", "annotations": []}]', 'a.png')).toBeNull()
  })
  test("files it can't read are refused", () => {
    expect(() => readCreateML('{"image": "a.png"}', 'a.png')).toThrow(/top level must be a list/)
    expect(() => readCreateML('[{"image": "a.png", "annotations": [{"label": "x"}]}]', 'a.png')).toThrow(/needs a label and coordinates/)
    expect(() => writeCreateML('[1', 'a.png', [], false)).toThrow(LabelFileError)
  })
})

test("shapes become the boxes LabelImg's formats keep, and saved boxes are whole pixels from 1", () => {
  expect(asBox(newShape('a', 'polygon', [[5, 1], [9, 4], [2, 8]])).points).toEqual([[2, 1], [9, 8]])
  expect(asBox(newShape('a', 'circle', [[10, 10], [13, 14]])).points).toEqual([[5, 5], [15, 15]])
  const mask = asBox(newShape('a', 'mask', [[1, 2], [3, 4]], { mask: 'iVBOR' }))
  expect([mask.shape_type, mask.mask]).toEqual(['rectangle', null])
  expect(bndBox(newShape('a', 'rectangle', [[0.4, 0], [10.9, 7.99]]))).toEqual([1, 1, 10, 7])
})
