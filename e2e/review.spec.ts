import { expect, test } from '@playwright/test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import path from 'path'
import sharp from 'sharp'
import { BASE, drag as dragOn, H, labelAt, launch, onImage as onImageOf, read as readDoc, square, W } from './helpers'

const DIR = path.join(BASE, 'review')
const SHOTS = process.env.E2E_SHOTS || DIR

const FILES: Record<string, any[] | null> = {
  a: [square('cat', 20, 20, 80, 80, 0.9), square('cat', 200, 100, 280, 180, 0.4)],
  b: [square('cat', 30, 30, 90, 90, 0.2)],
  c: [square('cat', 60, 40, 340, 260)],
  d: null,
  e: [square('cat', 40, 100, 120, 200), square('cat', 200, 100, 280, 200), square('dog', 320, 20, 380, 80)],
  f: [square('dog', 111, 111, 171, 171, 0.95)],
  g: [square('dog', 222, 122, 282, 182, 0.96)]
}
const read = (name: string) => readDoc(DIR, name).shapes
// What a training mask would give these pixels
const label = (name: string, x: number, y: number) => labelAt(read(name), x, y)

test('review AI shapes, then fix shapes with the brush and eraser', async () => {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  for (const [name, shapes] of Object.entries(FILES)) {
    await sharp({ create: { width: W, height: H, channels: 3, background: '#445566' } }).png().toFile(path.join(DIR, `${name}.png`))
    if (shapes) {
      writeFileSync(path.join(DIR, `${name}.json`), JSON.stringify({
        version: '5.5.0', flags: {}, shapes, imagePath: `${name}.png`, imageData: null, imageWidth: W, imageHeight: H
      }))
    }
  }
  writeFileSync(path.join(DIR, 'classes.txt'), 'cat\ndog\n')
  const { app, page, errors } = await launch(DIR, ['--labels', path.join(DIR, 'classes.txt')])

  const filter = (name: string) => page.locator('.filters button', { hasText: name })
  await expect(filter('All')).toContainText('7')
  await expect(filter('Label')).toContainText('1')
  await expect(filter('Review')).toContainText('4')
  await expect(filter('Done')).toContainText('2')
  // Accepted shapes only: AI ones don't train
  await expect(page.locator('.class', { hasText: 'cat' })).toContainText('3')
  await expect(page.getByRole('button', { name: 'Pre-label 5 images' })).toBeVisible()

  const onImage = (x: number, y: number) => onImageOf(page, x, y, W, H)
  const saved = () => expect(page.getByTestId('save-state')).toHaveText('Saved')
  const open = async (name: string) => {
    await page.locator('.file', { hasText: `${name}.png` }).click()
    await expect(page.locator('.file.on')).toContainText(`${name}.png`)
    await page.waitForTimeout(200)
  }
  const drag = (from: number[], to: number[]) => dragOn(page, from, to)

  // Least certain first, by each image's least certain shape
  await page.getByLabel('Order').selectOption('certainty')
  await expect(page.locator('.file .name').first()).toHaveText('b.png')
  await expect(page.locator('.file .name').nth(1)).toHaveText('a.png')
  await expect(page.locator('.file').first()).toContainText('20%')

  // Clicking an AI shape to look at it doesn't accept it
  await open('a')
  await page.keyboard.press('v')
  await page.mouse.click(...await onImage(50, 50))
  await expect(page.locator('.shape.on')).toContainText('AI 90%')
  await page.waitForTimeout(600)
  expect(read('a').every((s: any) => s.flags.ai)).toBe(true)
  await page.keyboard.press('Escape')

  // W starts with the least certain shape and accepts nothing yet
  await page.keyboard.press('w')
  await expect(page.locator('.shape.on')).toContainText('AI 40%')
  await expect(page.getByTestId('review-bar')).toContainText('this one 40%')
  await page.screenshot({ path: `${SHOTS}/review.png` })
  expect(read('a').every((s: any) => s.flags.ai)).toBe(true)

  // Accept, then move to the next shape
  await page.keyboard.press('w')
  await expect(page.locator('.shape.on')).toContainText('AI 90%')
  await saved()
  await expect.poll(() => read('a').filter((s: any) => !s.flags.ai).length).toBe(1)
  const kept = read('a').find((s: any) => !s.flags.ai)
  expect(kept.points[0]).toEqual([200, 100])
  expect(kept.score).toBeUndefined()

  // Undo takes the acceptance back
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.tag')).toHaveCount(2)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(page.locator('.tag')).toHaveCount(1)

  // Reject the last one here: the next image opens on its least certain shape
  await page.locator('.shape', { hasText: 'AI 90%' }).click()
  await page.keyboard.press('s')
  await expect(page.locator('.file.on')).not.toContainText('a.png')
  await expect(page.locator('.shape.on')).toContainText('AI')
  await expect.poll(() => read('a').length).toBe(1)

  // A mistake on the last shape can still be undone from the next image
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.file.on')).toContainText('a.png')
  await expect(page.locator('.shape.on')).toContainText('AI 90%')
  await expect.poll(() => read('a').length).toBe(2)
  await page.keyboard.press('s')
  await expect(page.locator('.file.on')).not.toContainText('a.png')
  await expect.poll(() => read('a').length).toBe(1)

  // Fast keys never put one image's shapes on another
  const before = { f: read('f')[0].points, g: read('g')[0].points, b: read('b')[0].points }
  for (let i = 0; i < 10; i++) await page.keyboard.press('w', { delay: 0 })
  await expect(page.locator('.loading.notice')).toContainText('Nothing left to review')
  await saved()
  await expect(filter('Review')).toContainText('0')
  for (const name of ['f', 'g', 'b'] as const) {
    await expect.poll(() => read(name)[0].flags.ai).toBeUndefined()
    expect(read(name)).toHaveLength(1)
    expect(read(name)[0].points).toEqual(before[name])
  }
  await expect(filter('Done')).toContainText('6')

  // Brush across two shapes of a class joins them; the other class stays
  await open('e')
  await page.keyboard.press('1')
  await page.keyboard.press('b')
  await page.keyboard.press(']')
  await drag([110, 150], [210, 150])
  await expect(page.locator('.shape')).toHaveCount(2)
  await saved()
  await expect.poll(() => read('e').length).toBe(2)
  expect(label('e', 160, 150)).toBe('cat')
  expect(label('e', 350, 50)).toBe('dog')
  await page.screenshot({ path: `${SHOTS}/brush.png` })
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.shape')).toHaveCount(3)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(page.locator('.shape')).toHaveCount(2)

  // Eraser across the joined shape splits it in two
  await page.keyboard.press('e')
  await drag([160, 60], [160, 240])
  await expect(page.locator('.shape')).toHaveCount(3)
  await saved()
  await expect.poll(() => read('e').length).toBe(3)
  expect(label('e', 160, 150)).toBe('')
  expect(label('e', 60, 150)).toBe('cat')
  expect(label('e', 260, 150)).toBe('cat')

  // A hole stays out of the training mask, then painting heals it
  await open('c')
  await page.keyboard.press('e')
  for (let i = 0; i < 6; i++) await page.keyboard.press(']')
  await page.mouse.click(...await onImage(200, 150))
  await saved()
  await expect.poll(() => read('c')[0].points.length).toBeGreaterThan(4)
  expect(read('c')).toHaveLength(1)
  expect(label('c', 200, 150)).toBe('')
  expect(label('c', 80, 60)).toBe('cat')
  await page.screenshot({ path: `${SHOTS}/hole.png` })
  await page.keyboard.press('b')
  await page.mouse.click(...await onImage(200, 150))
  await expect(page.locator('.shape')).toHaveCount(1)
  await saved()
  await expect.poll(() => label('c', 200, 150)).toBe('cat')

  // Brush with a chosen class on an empty image makes a new shape there
  await open('d')
  await page.keyboard.press('2')
  await page.keyboard.press('b')
  await drag([100, 100], [200, 100])
  await expect(page.locator('.shape')).toContainText('dog')
  await saved()
  await expect.poll(() => read('d')[0]?.label).toBe('dog')
  await expect(filter('Label')).toContainText('0')

  // The smallest window: nothing spills out
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640))
  await page.waitForTimeout(400)
  writeFileSync(path.join(DIR, 'a.json'), JSON.stringify({ shapes: [square('cat', 20, 20, 80, 80, 0.5)], imagePath: 'a.png' }))
  await open('b')
  await open('a')
  await page.keyboard.press('w')
  await expect(page.getByTestId('review-bar')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/small-window.png` })
  const spill = await page.evaluate(() => {
    const stage = document.querySelector('.stage')!.getBoundingClientRect()
    const parts = [...document.querySelectorAll('.review-bar, .review-bar *, .toolbar > *')].map((el) => el.getBoundingClientRect())
    return { bar: parts.every((r) => r.left >= stage.left && r.right <= stage.right), page: document.documentElement.scrollWidth <= innerWidth }
  })
  expect(spill).toEqual({ bar: true, page: true })

  expect(errors).toEqual([])
  await app.close()
})
