import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import path from 'path'
import { expect, test } from 'vitest'
import { cvResize, pilResize } from '../../src/main/resize'

// Pillow's output at each size is kept as its SHA-256; make_pil_bilinear.py writes the fixture
test("Pillow's bilinear resize, to the bit, up and down", () => {
  const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/resize/pil_bilinear.json'), 'utf8'))
  const input = Uint8Array.from(fixture.pixels)
  for (const [size, expected] of Object.entries(fixture.sha256) as [string, string][]) {
    const [w, h] = size.split('x').map(Number)
    const out = pilResize(input, fixture.width, fixture.height, w, h)
    expect(createHash('sha256').update(out).digest('hex'), size).toBe(expected)
  }
})

// OpenCV's output at each size, in colour and in grey, is kept as its SHA-256; make_cv_linear.py writes the fixture
test("OpenCV's bilinear resize, to the bit, up and down, as Seamline's predict resizes each tile", () => {
  const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/resize/cv_linear.json'), 'utf8'))
  const rgb = Uint8Array.from(fixture.pixels)
  const grey = rgb.filter((_, i) => i % 3 === 0)
  for (const [input, channels, sizes] of [[rgb, 3, fixture.rgb], [grey, 1, fixture.grey]] as [Uint8Array, number, Record<string, string>][]) {
    for (const [size, expected] of Object.entries(sizes)) {
      const [w, h] = size.split('x').map(Number)
      const out = cvResize(input, fixture.width, fixture.height, w, h, channels)
      expect(createHash('sha256').update(out).digest('hex'), `${size} × ${channels}`).toBe(expected)
    }
  }
})
