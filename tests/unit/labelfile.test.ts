import { readdirSync, readFileSync, statSync } from 'fs'
import path from 'path'
import { describe, expect, test } from 'vitest'
import { accepted, LabelFileError, newShape, parseLabelFile, serializeLabelFile } from '../../src/shared/labelfile'
import { summarize } from '../../src/shared/labels'

const DATA = path.resolve(__dirname, '../data')
const FIXTURES = path.resolve(__dirname, '../fixtures')
const EXAMPLES = path.resolve(__dirname, '../../examples')

function labelFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return labelFiles(full)
    if (!name.endsWith('.json')) return []
    const doc = JSON.parse(readFileSync(full, 'utf8'))
    return Array.isArray(doc.shapes) ? [full] : []
  })
}

describe('reading', () => {
  test("every label file in labelme's examples and test data reads", () => {
    const files = [...labelFiles(DATA), ...labelFiles(EXAMPLES)]
    expect(files.length).toBeGreaterThan(20)
    for (const file of files) {
      const doc = parseLabelFile(readFileSync(file, 'utf8'))
      expect(doc.shapes.every((s) => s.points.length > 0), file).toBe(true)
    }
  })

  test('keys labelme leaves to others survive, in the file and in each shape', () => {
    const doc = parseLabelFile(readFileSync(path.join(FIXTURES, 'labelme5/all_shapes.json'), 'utf8'))
    expect(doc.other).toEqual({ reviewer: 'jn', extra: { a: [1, 2] } })
    expect(doc.shapes[7].other).toEqual({ score: 0.873 })
    expect(doc.shapes.map((s) => s.shape_type)).toEqual(['polygon', 'rectangle', 'circle', 'line', 'point', 'linestrip', 'mask', 'polygon'])
    expect(doc.shapes[6].mask).toMatch(/^iVBOR/)
  })

  test('labelme on Windows writes backslashes; they read as slashes', () => {
    const doc = parseLabelFile(JSON.stringify({ shapes: [], imagePath: 'a\\b\\c.jpg', imageData: null }))
    expect(doc.imagePath).toBe('a/b/c.jpg')
  })

  test('what labelme would refuse is refused, with a reason', () => {
    const bad = [
      ['{"shapes": [ {"label": "cat", ', /valid JSON/],
      ['[]', /top level/],
      ['{"imagePath": "a.jpg"}', /shapes/],
      ['{"shapes": [{"points": [[1, 2]], "shape_type": "point"}]}', /label/],
      ['{"shapes": [{"label": "a", "points": [], "shape_type": "point"}]}', /points/],
      ['{"shapes": [{"label": "a", "points": [[1]], "shape_type": "point"}]}', /\[x, y\]/],
      ['{"shapes": [{"label": "a", "points": [[1, 2]], "shape_type": "blob"}]}', /unknown shape_type/],
      ['{"shapes": [{"label": "a", "points": [[1, 2]], "shape_type": "point", "group_id": "1"}]}', /group_id/],
      ['{"shapes": [{"label": "a", "points": [[1, 2]], "shape_type": "point", "flags": {"x": 1}}]}', /flags/],
      ['{"shapes": [], "imageHeight": -3}', /imageHeight/]
    ] as const
    for (const [text, reason] of bad) {
      expect(() => parseLabelFile(text), text).toThrow(LabelFileError)
      expect(() => parseLabelFile(text), text).toThrow(reason)
    }
  })
})

// Files Seamline's engine and app check in these same words, so all three read alike: a copy of
// Seamline's tests/fixtures/seamtag/labelme_checks.json, which both of them run
describe("the LabelMe checks Seamline shares", () => {
  const cases: { name: string; text: string; error: string | null }[] = JSON.parse(
    readFileSync(path.join(FIXTURES, 'seamline', 'labelme_checks.json'), 'utf8')
  )
  // Each language's JSON parser words its own errors after these words
  const NOT_JSON = "It isn't valid JSON"
  test.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    if (c.error === null) {
      expect(() => parseLabelFile(c.text)).not.toThrow()
      return
    }
    expect(() => parseLabelFile(c.text)).toThrow(LabelFileError)
    let message = ''
    try {
      parseLabelFile(c.text)
    } catch (e) {
      message = (e as Error).message
    }
    if (c.error === NOT_JSON) expect(message.startsWith(`${NOT_JSON} (`), message).toBe(true)
    else expect(message).toBe(c.error)
  })
})

describe('writing', () => {
  test('a file labelme 5 wrote comes back byte for byte', () => {
    const text = readFileSync(path.join(FIXTURES, 'labelme5/all_shapes.json'), 'utf8')
    expect(serializeLabelFile(parseLabelFile(text))).toBe(text)
  })

  test('older files come back in the current layout, with nothing lost', () => {
    const text = readFileSync(path.join(DATA, 'annotated/2011_000003.json'), 'utf8')
    const doc = parseLabelFile(text)
    const again = parseLabelFile(serializeLabelFile(doc))
    expect(again).toEqual(doc)
    const raw = JSON.parse(serializeLabelFile(doc))
    expect(Object.keys(raw.shapes[0])).toEqual(['label', 'points', 'group_id', 'description', 'shape_type', 'flags', 'mask'])
    expect(Object.keys(raw).slice(0, 7)).toEqual(['version', 'flags', 'shapes', 'imagePath', 'imageData', 'imageHeight', 'imageWidth'])
  })

  test('whole-number points keep the ".0" Python writes', () => {
    const doc = parseLabelFile(JSON.stringify({ shapes: [], imagePath: 'a.png', imageData: null }))
    doc.shapes = [newShape('a', 'point', [[3, 4.5]])]
    expect(serializeLabelFile(doc)).toContain('[\n          3.0,\n          4.5\n        ]')
  })
})

describe('AI shapes', () => {
  test('accepting drops the ai flag and the score, and nothing else', () => {
    const s = { ...newShape('a', 'polygon', [[0, 0], [1, 0], [1, 1]]), flags: { ai: true, occluded: true }, other: { score: 0.4, source: 'x' } }
    const a = accepted(s)
    expect(a.flags).toEqual({ occluded: true })
    expect(a.other).toEqual({ source: 'x' })
    const plain = newShape('a', 'point', [[1, 1]])
    expect(accepted(plain)).toBe(plain)
  })

  test('the list counts accepted shapes and the least certain AI one', () => {
    const ai = (score: number) => ({ ...newShape('cat', 'polygon', [[0, 0]]), flags: { ai: true }, other: { score } })
    const s = summarize([ai(0.9), ai(0.4), newShape('dog', 'point', [[0, 0]])])
    expect(s).toEqual({ count: 1, ai: 2, score: 0.4, classes: { dog: 1 }, labelled: true })
  })
})

describe('labelme 7', () => {
  test('oriented rectangles and locked shapes read, and write back as labelme 7 writes them', () => {
    const text = JSON.stringify({
      version: '7.9.1', flags: {}, imagePath: 'a.png', imageData: null, imageHeight: 10, imageWidth: 10,
      shapes: [
        { label: 'box', points: [[1, 1], [5, 2], [4, 6], [0, 5]], group_id: null, description: '', shape_type: 'oriented_rectangle', flags: {}, mask: null, locked: true },
        { label: 'p', points: [[1, 2]], group_id: null, description: '', shape_type: 'point', flags: {}, mask: null }
      ]
    })
    const doc = parseLabelFile(text)
    expect(doc.shapes[0]).toMatchObject({ shape_type: 'oriented_rectangle', locked: true, other: {} })
    expect(doc.shapes[1].locked).toBeUndefined()
    const out = JSON.parse(serializeLabelFile(doc))
    expect(Object.keys(out.shapes[0]).at(-1)).toBe('locked')
    expect('locked' in out.shapes[1]).toBe(false)
    expect(() => parseLabelFile(text.replace('"locked":true', '"locked":1'))).toThrow(/locked/)
    expect(() => parseLabelFile(text.replace('[[1,1],[5,2],[4,6],[0,5]]', '[[1,1],[5,2]]'))).toThrow(/4 points/)
  })
})
