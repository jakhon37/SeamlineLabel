import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import path from 'path'
import { expect, test } from 'vitest'
import { pilResize } from '../../src/main/resize'

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
