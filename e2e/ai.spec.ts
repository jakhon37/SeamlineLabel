import { expect, test } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import sharp from 'sharp'
import { click, doc, finish, launch, onImage, open, project, saved, shapesIn, square, W, H } from './helpers'

const MODEL = path.resolve(__dirname, '../tests/fixtures/models/discs.onnx')

// A grey image with a red and a blue disc, as the test model knows them
async function discs(dir: string, name: string, items: { cx: number; cy: number; r: number; color: string }[]) {
  const svg = `<svg width="${W}" height="${H}">${items.map((d) => `<circle cx="${d.cx}" cy="${d.cy}" r="${d.r}" fill="${d.color}"/>`).join('')}</svg>`
  await sharp({ create: { width: W, height: H, channels: 3, background: '#707478' } })
    .composite([{ input: Buffer.from(svg) }]).png().toFile(path.join(dir, `${name}.png`))
}

test('pre-label with a segmentation model, then review what it proposed', async () => {
  const dir = await project('prelabel', { done: doc('done', [square('red', 10, 10, 50, 50)]) })
  await discs(dir, 'p1', [{ cx: 100, cy: 100, r: 40, color: '#ff0000' }, { cx: 280, cy: 180, r: 50, color: '#0000ff' }])
  await discs(dir, 'p2', [{ cx: 200, cy: 150, r: 60, color: '#ff0000' }])
  const { app, page, errors } = await launch(dir, ['--labels', 'red,blue'])
  // The file dialog answers with the test model
  await app.evaluate(({ dialog }, model) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [model] })) as any
  }, MODEL)
  // Images someone labelled are left alone
  await page.getByRole('button', { name: 'Pre-label 2 images' }).click()
  await expect(page.locator('.loading.notice')).toContainText('Pre-labelled 2 of 2 images')
  const p1 = shapesIn(dir, 'p1')
  expect(p1.map((s: any) => s.label).sort()).toEqual(['blue', 'red'])
  for (const s of p1) {
    expect(s.flags.ai).toBe(true)
    expect(s.score).toBeGreaterThan(0.5)
    expect(s.score).toBeLessThanOrEqual(1)
  }
  const red = p1.find((s: any) => s.label === 'red')
  const xs = red.points.map((p: number[]) => p[0]), ys = red.points.map((p: number[]) => p[1])
  expect(Math.min(...xs)).toBeGreaterThan(55)
  expect(Math.max(...xs)).toBeLessThan(145)
  expect(Math.min(...ys)).toBeGreaterThan(55)
  expect(Math.max(...ys)).toBeLessThan(145)
  expect(shapesIn(dir, 'done')).toHaveLength(1)
  const filter = (name: string) => page.locator('.filters button', { hasText: name })
  await expect(filter('Review')).toContainText('2')

  // Review: W goes to the least certain shape, W again accepts it
  await open(page, 'p1.png')
  await page.keyboard.press('w')
  await expect(page.getByTestId('review-bar')).toContainText('this one')
  await page.keyboard.press('w')
  await saved(page)
  await expect.poll(() => shapesIn(dir, 'p1').filter((s: any) => !s.flags.ai).length).toBe(1)
  await page.keyboard.press('s')
  await expect(page.locator('.file.on')).toContainText('p2.png')
  await expect.poll(() => shapesIn(dir, 'p1').length).toBe(1)
  // Pre-label just this image again, from the toolbar
  await open(page, 'p1.png')
  await expect(page.getByRole('button', { name: 'Pre-label 1 image' })).toBeVisible()
  await finish(app, errors)
})

test("a model's classes must match its outputs", async () => {
  const dir = await project('prelabel-bad', {})
  await discs(dir, 'q', [{ cx: 100, cy: 100, r: 40, color: '#ff0000' }])
  const side = path.join(dir, 'three.json')
  writeFileSync(side, JSON.stringify({ classes: ['a', 'b', 'c'], mean: [0, 0, 0], std: [1, 1, 1] }))
  const { app, page, errors } = await launch(dir, ['--labels', 'a'])
  const copy = path.join(dir, 'three.onnx')
  writeFileSync(copy, (await import('fs')).readFileSync(MODEL))
  const result = await page.evaluate(([root, model]) => window.api.prelabelRun(root, model, ['q.png'], []), [dir, copy])
  expect(result.failed[0]).toContain('3 classes')
  expect(existsSync(path.join(dir, 'q.json'))).toBe(false)
  await finish(app, errors)
})

// Needs efficientsam:10m in SEAMTAG_MODELS, about 40 MB, so it's left out by default
test('AI points makes polygons and masks with SAM, and boxes in Pascal VOC', async () => {
  test.skip(!process.env.SEAMTAG_MODELS, 'set SEAMTAG_MODELS to a folder with efficientsam:10m')
  const dir = await project('sam', {})
  await discs(dir, 'd', [{ cx: 200, cy: 150, r: 70, color: '#e0a030' }])
  const { app, page, errors } = await launch(dir, ['--labels', 'disc'])
  await open(page, 'd.png')
  await page.getByRole('menuitem', { name: 'AI' }).click()
  await page.getByRole('menuitem', { name: 'Model for AI points and box' }).hover()
  await page.getByRole('menuitemcheckbox', { name: 'EfficientSam (speed)' }).click()
  await page.getByRole('toolbar').getByRole('button', { name: 'AI points', exact: true }).click()
  await click(page, 200, 150)
  await expect(page.locator('.loading.notice')).toHaveCount(0, { timeout: 60000 })
  await page.keyboard.press('Enter')
  await saved(page)
  // labelme 7 traces every part of the mask: the disc, and any speck beside it, grouped
  const polygons = shapesIn(dir, 'd')
  expect(polygons.every((s: any) => s.shape_type === 'polygon')).toBe(true)
  if (polygons.length > 1) expect(new Set(polygons.map((s: any) => s.group_id)).size).toBe(1)
  const area = (s: any) => Math.abs(s.points.reduce((a: number, p: number[], k: number) => a + p[0] * s.points[(k + 1) % s.points.length][1] - s.points[(k + 1) % s.points.length][0] * p[1], 0)) / 2
  const polygon = polygons.reduce((a: any, b: any) => (area(b) > area(a) ? b : a))
  const xs = polygon.points.map((p: number[]) => p[0])
  expect(Math.min(...xs)).toBeGreaterThan(120)
  expect(Math.max(...xs)).toBeLessThan(280)
  await page.getByLabel('AI output').selectOption('mask')
  await click(page, 200, 150)
  await expect(page.locator('.loading.notice')).toHaveCount(0, { timeout: 60000 })
  await page.keyboard.press('Enter')
  await saved(page)
  const mask = shapesIn(dir, 'd').find((s: any) => s.shape_type === 'mask')
  expect(mask).toBeTruthy()
  // labelme's layout: an inclusive box, and a one-channel PNG of 0s and 1s that size
  const png = Buffer.from(mask.mask, 'base64')
  expect((await sharp(png).metadata()).channels).toBe(1)
  const { data, info } = await sharp(png).extractChannel(0).raw().toBuffer({ resolveWithObject: true })
  const [[x0, y0], [x1, y1]] = mask.points
  expect([info.width, info.height]).toEqual([x1 - x0 + 1, y1 - y0 + 1])
  expect(Math.max(...data)).toBe(1)
  // Nearly all of it on the disc: the model may add a speck elsewhere, as it would in labelme
  let on = 0, all = 0
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (!data[y * info.width + x]) continue
    all++
    if (Math.hypot(x0 + x + 0.5 - 200, y0 + y + 0.5 - 150) <= 72) on++
  }
  expect(on / all).toBeGreaterThan(0.95)
  expect(all).toBeGreaterThan(Math.PI * 65 * 65)
  // In Pascal VOC, which keeps boxes, AI points makes a box
  await page.getByLabel('Save format').selectOption('voc')
  await expect.poll(() => existsSync(path.join(dir, 'd.xml'))).toBe(true)
  await expect(page.getByLabel('AI output')).toBeDisabled()
  await click(page, 200, 150)
  await expect(page.locator('.loading.notice')).toHaveCount(0, { timeout: 60000 })
  await page.keyboard.press('Enter')
  const before = polygons.length + 1
  await expect.poll(() => readFileSync(path.join(dir, 'd.xml'), 'utf8').match(/<object>/g)?.length).toBe(before + 1)
  const last = readFileSync(path.join(dir, 'd.xml'), 'utf8').split('<object>')[before + 1]
  const [bx0, by0, bx1, by1] = ['xmin', 'ymin', 'xmax', 'ymax'].map((k) => Number(new RegExp(`<${k}>(\\d+)</${k}>`).exec(last)![1]))
  // labelme 7's rectangle is the box of the model's whole mask, specks included: it holds the disc
  expect(bx0).toBeLessThan(135)
  expect(bx1).toBeGreaterThan(265)
  expect(by0).toBeLessThan(85)
  expect(by1).toBeGreaterThan(215)
  await finish(app, errors)
})

// Asked while the button was still down, the question kept the window's hold on the pointer on X11
test('the download question waits for the mouse button to come up', async () => {
  const dir = await project('ai-ask', {})
  await discs(dir, 'd', [{ cx: 200, cy: 150, r: 70, color: '#e0a030' }])
  // With no model downloaded, the first click asks to download one
  const models = process.env.SEAMTAG_MODELS
  delete process.env.SEAMTAG_MODELS
  const { app, page, errors } = await launch(dir, ['--labels', 'disc']).finally(() => {
    if (models !== undefined) process.env.SEAMTAG_MODELS = models
  })
  await app.evaluate(({ dialog }) => {
    const asked: string[] = (globalThis as any).asked = []
    dialog.showMessageBox = (async (_win: unknown, o: { message: string }) => {
      asked.push(o.message)
      return { response: 1, checkboxChecked: false }
    }) as any
  })
  const asked = () => app.evaluate(() => (globalThis as any).asked as string[])
  await open(page, 'd.png')
  await page.getByRole('toolbar').getByRole('button', { name: 'AI points', exact: true }).click()
  await page.mouse.move(...(await onImage(page, 200, 150)))
  await page.mouse.down()
  await page.waitForTimeout(500)
  expect(await asked()).toEqual([])
  await page.mouse.up()
  await expect.poll(asked).toEqual([expect.stringMatching(/^Download .+\?$/)])
  // Cancelled, so nothing is drawn or saved
  await expect(page.locator('.shape')).toHaveCount(0)
  expect(existsSync(path.join(dir, 'd.json'))).toBe(false)
  await finish(app, errors)
})
