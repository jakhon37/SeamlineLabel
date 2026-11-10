import { expect, test } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import sharp from 'sharp'
import { click, doc, drag, finish, launch, onImage, open, project, saved, shapesIn, square } from './helpers'

const near = (a: number, b: number, tolerance = 1.5) => expect(Math.abs(a - b), `${a} near ${b}`).toBeLessThan(tolerance)
const side = (a: number[], b: number[]) => Math.hypot(b[0] - a[0], b[1] - a[1])
function isRectangle(points: number[][]) {
  expect(points).toHaveLength(4)
  for (let i = 0; i < 4; i++) {
    const a = points[i], b = points[(i + 1) % 4], c = points[(i + 2) % 4]
    const cos = ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / (side(a, b) * side(b, c))
    expect(Math.abs(cos), 'corners square').toBeLessThan(1e-6)
  }
}

test("labelme 7's rotated box: three clicks draw it, a corner reshapes it square, a handle turns it", async () => {
  const dir = await project('rotated', { r: null })
  const { app, page, errors } = await launch(dir, ['--labels', 'car'])
  await open(page, 'r.png')
  await page.getByRole('toolbar').getByRole('button', { name: 'Rotated box', exact: true }).click()
  await click(page, 100, 100)
  await click(page, 200, 140)
  await click(page, 180, 190)
  await saved(page)
  let [box] = shapesIn(dir, 'r')
  expect(box.shape_type).toBe('oriented_rectangle')
  isRectangle(box.points)
  near(box.points[0][0], 100)
  near(box.points[0][1], 100)
  // The first side keeps its direction; the third click sets the width
  const along = Math.atan2(box.points[1][1] - box.points[0][1], box.points[1][0] - box.points[0][0])
  near(along, Math.atan2(40, 100), 0.03)

  // A corner moves; the one across stays and the shape stays a rectangle
  await page.keyboard.press('v')
  await click(page, 150, 140)
  const before = box.points
  await drag(page, before[2], [before[2][0] + 25, before[2][1] + 15])
  await saved(page)
  ;[box] = shapesIn(dir, 'r')
  isRectangle(box.points)
  near(box.points[0][0], before[0][0], 0.01)
  near(box.points[0][1], before[0][1], 0.01)
  near(box.points[2][0], before[2][0] + 25)
  near(box.points[2][1], before[2][1] + 15)

  // A handle at the middle of a side turns it about its centre
  const center = [(box.points[0][0] + box.points[2][0]) / 2, (box.points[0][1] + box.points[2][1]) / 2]
  const handle = [(box.points[0][0] + box.points[1][0]) / 2, (box.points[0][1] + box.points[1][1]) / 2]
  const turn = Math.PI / 6
  const dx = handle[0] - center[0], dy = handle[1] - center[1]
  const sides = [side(box.points[0], box.points[1]), side(box.points[1], box.points[2])]
  await drag(page, handle, [center[0] + dx * Math.cos(turn) - dy * Math.sin(turn), center[1] + dx * Math.sin(turn) + dy * Math.cos(turn)])
  await saved(page)
  const turned = shapesIn(dir, 'r')[0].points
  isRectangle(turned)
  near((turned[0][0] + turned[2][0]) / 2, center[0], 0.01)
  near((turned[0][1] + turned[2][1]) / 2, center[1], 0.01)
  near(side(turned[0], turned[1]), sides[0], 0.01)
  near(side(turned[1], turned[2]), sides[1], 0.01)
  const angle = (p: number[][]) => Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0])
  near(angle(turned) - angle(box.points), turn, 0.05)
  await finish(app, errors)
})

test('Lock Shapes on Ctrl+Shift+L: kept in the file, and the shape stays put', async () => {
  const dir = await project('lock', { l: doc('l', [square('cat', 50, 50, 150, 150)]) })
  const { app, page, errors } = await launch(dir)
  await open(page, 'l.png')
  await page.keyboard.press('v')
  await click(page, 100, 100)
  await page.keyboard.press('ControlOrMeta+Shift+l')
  await saved(page)
  expect(shapesIn(dir, 'l')[0].locked).toBe(true)
  await drag(page, [100, 100], [200, 180])
  await page.waitForTimeout(300)
  expect(shapesIn(dir, 'l')[0].points).toEqual([[50, 50], [150, 50], [150, 150], [50, 150]])
  await page.keyboard.press('ControlOrMeta+Shift+l')
  await saved(page)
  expect(shapesIn(dir, 'l')[0]).not.toHaveProperty('locked')
  await finish(app, errors)
})

test('Ctrl+arrow picks the neighbouring shape, and Fit to Selection follows the selection', async () => {
  const dir = await project('neighbours', {
    n: doc('n', [square('a', 20, 120, 80, 180), square('b', 170, 120, 230, 180), square('c', 320, 120, 380, 180), square('d', 180, 240, 220, 280)])
  })
  const { app, page, errors } = await launch(dir)
  await open(page, 'n.png')
  const selected = () => page.locator('.shape.on .name')
  await page.keyboard.press('v')
  await click(page, 200, 150)
  await expect(selected()).toHaveText('b')
  await page.keyboard.press('ControlOrMeta+ArrowRight')
  await expect(selected()).toHaveText('c')
  await page.keyboard.press('ControlOrMeta+ArrowLeft')
  await page.keyboard.press('ControlOrMeta+ArrowLeft')
  await expect(selected()).toHaveText('a')
  // Nothing that way: the selection stays
  await page.keyboard.press('ControlOrMeta+ArrowUp')
  await expect(selected()).toHaveText('a')
  await page.keyboard.press('ControlOrMeta+ArrowRight')
  await page.keyboard.press('ControlOrMeta+ArrowDown')
  await expect(selected()).toHaveText('d')
  const zoom = async () => parseFloat((await page.locator('.zoom').textContent())!)
  const fitted = await zoom()
  await page.keyboard.press('ControlOrMeta+Shift+f')
  await expect.poll(zoom).toBeGreaterThan(fitted * 3)
  const onD = await zoom()
  await page.keyboard.press('ControlOrMeta+ArrowUp')
  await expect(selected()).toHaveText('b')
  // b is bigger than d, so the view zooms out to fit it
  await expect.poll(zoom).toBeLessThan(onD)
  await finish(app, errors)
})

test('with Fit to Selection on, a shape pressed and dragged moves by the drag, and the view fits it once let go', async () => {
  const dir = await project('fit-drag', { f: doc('f', [square('a', 40, 40, 100, 100), square('b', 220, 120, 300, 200)]) })
  const { app, page, errors } = await launch(dir)
  await open(page, 'f.png')
  await page.keyboard.press('v')
  // On with nothing selected: the view stays as it is
  await page.keyboard.press('ControlOrMeta+Shift+f')
  const zoom = async () => parseFloat((await page.locator('.zoom').textContent())!)
  const before = await zoom()
  await drag(page, [260, 160], [290, 180])
  await saved(page)
  expect(shapesIn(dir, 'f')[1].points).toEqual([[250, 140], [330, 140], [330, 220], [250, 220]].map(([x, y]) => [expect.closeTo(x, 0), expect.closeTo(y, 0)]))
  await expect.poll(zoom).toBeGreaterThan(before * 2)
  await finish(app, errors)
})

test("Add Point to Edge from the shape's menu; hiding shapes is undone like any change, for the whole selection", async () => {
  const dir = await project('edge', { e: doc('e', [square('cat', 50, 50, 150, 150), square('dog', 200, 50, 300, 150)]) })
  const { app, page, errors } = await launch(dir)
  await open(page, 'e.png')
  await page.keyboard.press('v')
  await click(page, 100, 100)
  await page.mouse.click(...(await onImage(page, 110, 52)), { button: 'right' })
  await page.getByRole('menuitem', { name: 'Add point to edge' }).click()
  await saved(page)
  const cat = shapesIn(dir, 'e')[0]
  expect(cat.points).toHaveLength(5)
  near(cat.points[1][0], 110)
  near(cat.points[1][1], 50, 0.01)

  await page.keyboard.down('ControlOrMeta')
  await click(page, 250, 100)
  await page.keyboard.up('ControlOrMeta')
  const shown = page.locator('.shape input[type="checkbox"]')
  await shown.first().uncheck()
  await expect(shown.nth(0)).not.toBeChecked()
  await expect(shown.nth(1)).not.toBeChecked()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(shown.nth(0)).toBeChecked()
  await expect(shown.nth(1)).toBeChecked()
  await finish(app, errors)
})

test('Space finishes a polygon being drawn', async () => {
  const dir = await project('space', { s: null })
  const { app, page, errors } = await launch(dir, ['--labels', 'cat'])
  await open(page, 's.png')
  await page.keyboard.press('p')
  await click(page, 100, 100)
  await click(page, 200, 100)
  await click(page, 150, 180)
  await page.keyboard.press('Space')
  await saved(page)
  const [polygon] = shapesIn(dir, 's')
  expect(polygon.shape_type).toBe('polygon')
  expect(polygon.points).toHaveLength(3)
  await finish(app, errors)
})

test("Merge Shapes joins masks of one label, every pixel kept, as labelme 7 does", async () => {
  const png = async (w: number, h: number) =>
    (await sharp(Buffer.alloc(w * h, 1), { raw: { width: w, height: h, channels: 1 } }).toColourspace('b-w').png().toBuffer()).toString('base64')
  const mask = async (label: string, x: number, y: number, w: number, h: number) => ({
    label, shape_type: 'mask', group_id: null, description: '', flags: {}, points: [[x, y], [x + w - 1, y + h - 1]], mask: await png(w, h)
  })
  const dir = await project('merge', { m: doc('m', [await mask('leaf', 40, 40, 30, 20), await mask('leaf', 100, 60, 20, 40)]) })
  const { app, page, errors } = await launch(dir)
  await open(page, 'm.png')
  await page.keyboard.press('v')
  await click(page, 55, 50)
  await page.keyboard.down('ControlOrMeta')
  await click(page, 110, 80)
  await page.keyboard.up('ControlOrMeta')
  await page.keyboard.press('ControlOrMeta+Shift+m')
  // The masks are merged in the main process: "Saved" shows until the result comes back
  await expect.poll(() => shapesIn(dir, 'm').length).toBe(1)
  await saved(page)
  const shapes = shapesIn(dir, 'm')
  expect(shapes[0].points).toEqual([[40, 40], [119, 99]])
  const { data, info } = await sharp(Buffer.from(shapes[0].mask, 'base64')).extractChannel(0).raw().toBuffer({ resolveWithObject: true })
  expect([info.width, info.height]).toEqual([80, 60])
  expect(data.reduce((a, v) => a + (v ? 1 : 0), 0)).toBe(30 * 20 + 20 * 40)
  await finish(app, errors)
})

test("labelme 7's settings and command line: colours by label, --label-flags, points past the image's edge", async () => {
  const dir = await project('labelme7-config', { c: null })
  const config = path.join(dir, 'labelme7rc.yaml')
  writeFileSync(config, 'shape_color:\n  mode: by_label\n  by_label:\n    colors:\n      cat: [255, 0, 0]\ncanvas:\n  allow_out_of_bounds_points: true\n')
  const { app, page, errors } = await launch(dir, ['--config', config, '--labels', 'cat', '--label-flags', '{cat: [occluded]}', '--no-auto-save'])
  await open(page, 'c.png')
  await expect(page.locator('.class', { hasText: 'cat' }).locator('.swatch')).toHaveCSS('background-color', 'rgb(255, 0, 0)')
  await page.keyboard.press('p')
  await click(page, 360, 100)
  await click(page, 410, 150)
  await click(page, 360, 200)
  await page.keyboard.press('Enter')
  // --no-auto-save: saved by hand
  expect(existsSync(path.join(dir, 'c.json'))).toBe(false)
  await page.keyboard.press('ControlOrMeta+s')
  await saved(page)
  const [cat] = shapesIn(dir, 'c')
  expect(Math.max(...cat.points.map((p: number[]) => p[0]))).toBeGreaterThan(400)
  expect(cat.flags).toEqual({ occluded: false })
  await finish(app, errors)
})

test("the image list's footer: how many images are annotated, and where their label files go", async () => {
  const dir = await project('footer', { a: doc('a', [square('cat', 10, 10, 50, 50)]), b: null })
  const out = path.join(dir, 'labels')
  mkdirSync(out)
  const { app, page, errors } = await launch(dir)
  const footer = page.getByTestId('annotation-folder')
  await expect(footer).toContainText('1 of 2 annotated · next to images')
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any
  }, out)
  await footer.getByRole('button', { name: 'Change…' }).click()
  await expect(footer).toContainText('0 of 2 annotated · in labels')
  await footer.getByRole('button', { name: 'Next to images' }).click()
  await expect(footer).toContainText('1 of 2 annotated · next to images')
  await finish(app, errors)
})

// These need models in SEAMTAG_MODELS: efficientsam:10m for AI box, yoloworld:latest for the text prompt
const models = process.env.SEAMTAG_MODELS
const has = (hash: string) => !!models && existsSync(path.join(models, `sha256-${hash}`))

test('AI box makes each kind of shape labelme 7 makes', async () => {
  test.skip(!has('7a73ee65aa2c37237c89b4b18e73082f757ffb173899609c5d97a2bbd4ebb02d'), 'set SEAMTAG_MODELS to a folder with efficientsam:10m')
  const dir = await project('aibox', {})
  const svg = '<svg width="400" height="300"><circle cx="200" cy="150" r="70" fill="#e0a030"/></svg>'
  await sharp({ create: { width: 400, height: 300, channels: 3, background: '#707478' } }).composite([{ input: Buffer.from(svg) }]).png().toFile(path.join(dir, 'd.png'))
  const { app, page, errors } = await launch(dir, ['--labels', 'disc'])
  await open(page, 'd.png')
  await page.getByRole('menuitem', { name: 'AI', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Model for AI points and box' }).hover()
  await page.getByRole('menuitemcheckbox', { name: 'EfficientSam (speed)' }).click()
  await page.getByRole('toolbar').getByRole('button', { name: 'AI box', exact: true }).click()
  for (const [k, type] of ['rectangle', 'circle', 'oriented_rectangle', 'polygon', 'mask'].entries()) {
    await page.getByLabel('AI output').selectOption(type)
    await drag(page, [120, 70], [280, 230])
    await expect.poll(() => existsSync(path.join(dir, 'd.json')) && shapesIn(dir, 'd').length, { timeout: 60000 }).toBeGreaterThan(k)
    await saved(page)
    const made = shapesIn(dir, 'd').filter((s: any) => s.shape_type === type)
    expect(made.length, type).toBeGreaterThan(0)
    const xs = made.flatMap((s: any) => s.points.map((p: number[]) => p[0]))
    expect(Math.min(...xs), type).toBeGreaterThan(type === 'circle' ? 190 : 120)
    expect(Math.max(...xs), type).toBeLessThan(282)
  }
  const circle = shapesIn(dir, 'd').find((s: any) => s.shape_type === 'circle')
  // The circle of the mask's area: about the disc's own radius
  near(Math.hypot(circle.points[1][0] - circle.points[0][0], circle.points[1][1] - circle.points[0][1]), 70, 4)
  await finish(app, errors)
})

test('on an image bigger than the model sees, an AI mask at the edge stops at its last row', async () => {
  test.skip(!has('7a73ee65aa2c37237c89b4b18e73082f757ffb173899609c5d97a2bbd4ebb02d'), 'set SEAMTAG_MODELS to a folder with efficientsam:10m')
  // EfficientSAM sees 2048 x 1536 of it: rounding makes that copy's height a little off its width's scale
  const [W, H] = [5000, 3749]
  const dir = await project('aibig', {})
  const svg = `<svg width="${W}" height="${H}"><circle cx="2500" cy="3600" r="500" fill="#e0a030"/></svg>`
  await sharp({ create: { width: W, height: H, channels: 3, background: '#707478' } }).composite([{ input: Buffer.from(svg) }]).png().toFile(path.join(dir, 'big.png'))
  const { app, page, errors } = await launch(dir, ['--labels', 'disc'])
  await open(page, 'big.png')
  await page.getByRole('menuitem', { name: 'AI', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Model for AI points and box' }).hover()
  await page.getByRole('menuitemcheckbox', { name: 'EfficientSam (speed)' }).click()
  await page.getByRole('toolbar').getByRole('button', { name: 'AI box', exact: true }).click()
  await page.getByLabel('AI output').selectOption('mask')
  const at = async (x: number, y: number) => onImage(page, x, y, W, H)
  await page.mouse.move(...(await at(1950, 3050)))
  await page.mouse.down()
  await page.mouse.move(...(await at(3050, 3749)), { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => existsSync(path.join(dir, 'big.json')) && shapesIn(dir, 'big').length, { timeout: 120000 }).toBe(1)
  await saved(page)
  const [mask] = shapesIn(dir, 'big')
  const [[x0, y0], [x1, y1]] = mask.points
  expect(y1).toBe(H - 1)
  expect(x0).toBeGreaterThan(1950)
  expect(x1).toBeLessThan(3050)
  const { info } = await sharp(Buffer.from(mask.mask, 'base64')).raw().toBuffer({ resolveWithObject: true })
  expect([info.width, info.height]).toEqual([x1 - x0 + 1, y1 - y0 + 1])
  await finish(app, errors)
})

test('the text prompt finds each person in a photo with YOLO-World, and leaves the ones drawn', async () => {
  test.skip(!has('92660c6456766439a2670cf19a8a258ccd3588118622a15959f39e253731c05d'), 'set SEAMTAG_MODELS to a folder with yoloworld:latest')
  const dir = await project('textprompt', {})
  copyFileSync(path.join(__dirname, '../tests/data/raw/2011_000003.jpg'), path.join(dir, 'p.jpg'))
  const { app, page, errors } = await launch(dir)
  await open(page, 'p.jpg')
  await page.getByRole('toolbar').getByRole('button', { name: 'AI box', exact: true }).click()
  await page.getByLabel('AI output').selectOption('rectangle')
  await page.getByLabel('Text prompt model').selectOption('yoloworld:latest')
  await page.getByLabel('Words to find').fill('person')
  await page.getByRole('button', { name: 'Find' }).click()
  await expect(page.locator('.loading.notice')).toContainText('Found', { timeout: 120000 })
  await saved(page)
  const found = shapesIn(dir, 'p')
  expect(found.length).toBeGreaterThan(0)
  for (const s of found) {
    expect(s.label).toBe('person')
    expect(s.shape_type).toBe('rectangle')
    expect(JSON.parse(s.description)).toMatchObject({ text: 'person' })
  }
  // Asked again, the people drawn already aren't found twice
  await page.getByRole('button', { name: 'Find' }).click()
  await expect(page.locator('.loading.notice')).toContainText('Nothing new', { timeout: 120000 })
  expect(shapesIn(dir, 'p')).toHaveLength(found.length)
  await finish(app, errors)
})

test('YOLO-World finds the boxes labelme 7.9.1 finds in the same photo, scores and all', async () => {
  test.skip(!has('92660c6456766439a2670cf19a8a258ccd3588118622a15959f39e253731c05d'), 'set SEAMTAG_MODELS to a folder with yoloworld:latest')
  // labelme's own results: tests/fixtures/labelme7/make_text_prompt.py
  const ref = JSON.parse(readFileSync(path.join(__dirname, '../tests/fixtures/labelme7/text_prompt.json'), 'utf8'))
  const dir = await project('yoloworld', {})
  copyFileSync(path.join(__dirname, '../tests/data/raw/2011_000003.jpg'), path.join(dir, 'p.jpg'))
  const { app, page, errors } = await launch(dir)
  await open(page, 'p.jpg')
  for (const words of ['person', 'person,bottle']) {
    const result = await page.evaluate(([root, texts]: any) => window.api.aiText({
      root, name: 'p.jpg', model: 'yoloworld:latest', texts, output: 'rectangle', detail: 60, drawn: [], groups: [], outside: false, iou: 0.5, score: 0.1
    }), [dir, words.split(',')])
    const expected = ref[words]
    expect(result.shapes.map((s) => s.label), words).toEqual(expected.map((s: any) => s.label))
    for (const [i, shape] of result.shapes.entries()) {
      shape.points.forEach((p: number[], k: number) => {
        near(p[0], expected[i].points[k][0], 1.01)
        near(p[1], expected[i].points[k][1], 1.01)
      })
      const [ours, theirs] = [JSON.parse(shape.description!), JSON.parse(expected[i].description)]
      expect(ours.text).toBe(theirs.text)
      near(ours.score, theirs.score, 2e-3)
    }
  }
  await finish(app, errors)
})
