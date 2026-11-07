import { _electron as electron, ElectronApplication, expect, Page, test } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import path from 'path'
import sharp from 'sharp'

// Each of these once could lose or misplace someone's labels
const BASE = process.env.E2E_SAFETY_DIR || '/tmp/myseg-e2e-safety'
const W = 400, H = 300

const square = (x0: number, y0: number, x1: number, y1: number, score?: number) => ({
  label: 'cat', shape_type: 'polygon', group_id: null, description: '',
  points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
  flags: score === undefined ? {} : { ai: true },
  ...(score === undefined ? {} : { score })
})
const doc = (name: string, shapes: unknown[]) => JSON.stringify({
  version: '5.5.0', flags: {}, shapes, imagePath: `${name}.png`, imageData: null, imageWidth: W, imageHeight: H
})

async function project(folder: string, files: Record<string, string | null>) {
  const dir = path.join(BASE, folder)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(path.join(dir, '.myseg'), { recursive: true })
  writeFileSync(path.join(dir, '.myseg/project.json'), JSON.stringify({ name: folder, classes: [{ name: 'cat', color: '#4f8cff' }] }))
  for (const [name, text] of Object.entries(files)) {
    await sharp({ create: { width: W, height: H, channels: 3, background: '#445566' } }).png().toFile(path.join(dir, `${name}.png`))
    if (text !== null) writeFileSync(path.join(dir, `${name}.json`), text)
  }
  return dir
}

async function launch(dir: string) {
  const app = await electron.launch({
    args: [path.resolve(__dirname, '..')],
    env: { ...process.env, MYSEG_PROJECT: dir } as Record<string, string>
  })
  const page = await app.firstWindow()
  await expect(page.locator('.file').first()).toBeVisible()
  await page.waitForTimeout(300)
  return { app, page }
}

const onImage = async (page: Page, x: number, y: number) => {
  const box = (await page.getByTestId('canvas').boundingBox())!
  const scale = Math.min((box.width - 48) / W, (box.height - 48) / H)
  return [box.x + (box.width - W * scale) / 2 + x * scale, box.y + (box.height - H * scale) / 2 + y * scale] as const
}
const open = async (page: Page, name: string) => {
  await page.locator('.file', { hasText: `${name}.png` }).click()
  await page.waitForTimeout(250)
}
const stroke = async (page: Page, from: number[], to: number[]) => {
  await page.mouse.move(...await onImage(page, from[0], from[1]))
  await page.mouse.down()
  await page.mouse.move(...await onImage(page, to[0], to[1]), { steps: 8 })
  await page.mouse.up()
}
const shapesIn = (dir: string, name: string) => JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8')).shapes
const finish = async (app: ElectronApplication) => { await app.close() }

test('a label file that can\'t be read is shown as such and never written over', async () => {
  const bad = '{"shapes": [ {"label": "cat", '
  const dir = await project('broken', { x: bad, y: null })
  const { app, page } = await launch(dir)
  await expect(page.locator('.error')).toContainText('x.png')
  await expect(page.locator('.file', { hasText: 'x.png' }).locator('.dot')).toHaveClass(/broken/)
  // Not offered for pre-labelling, which would replace it
  await expect(page.getByRole('button', { name: 'Pre-label 1 image', exact: true })).toBeVisible()
  await open(page, 'x')
  await page.keyboard.press('b')
  await stroke(page, [100, 100], [200, 100])
  await page.waitForTimeout(700)
  expect(readFileSync(path.join(dir, 'x.json'), 'utf8')).toBe(bad)
  const save = await page.evaluate(async (root) => {
    try {
      await window.api.saveLabels(root, 'x.png', [], [400, 300])
      return 'saved'
    } catch (e: any) {
      return e.message
    }
  }, dir)
  expect(save).toContain('x.json')
  expect(readFileSync(path.join(dir, 'x.json'), 'utf8')).toBe(bad)
  await finish(app)
})

test('the brush previews in the colour it will paint', async () => {
  const dir = await project('preview', { p: doc('p', [{ ...square(50, 50, 120, 120), label: 'dog' }]) })
  writeFileSync(path.join(dir, '.myseg/project.json'), JSON.stringify({
    name: 'preview', classes: [{ name: 'cat', color: '#4f8cff' }, { name: 'dog', color: '#ff6b6b' }]
  }))
  const { app, page } = await launch(dir)
  await open(page, 'p')
  // Cat stays the active class; selecting the shape means the brush continues its class, dog
  await page.locator('.shape').first().click()
  await page.keyboard.press('b')
  await page.mouse.move(...await onImage(page, 200, 200))
  await page.mouse.down()
  await page.mouse.move(...await onImage(page, 320, 200), { steps: 8 })
  await page.waitForTimeout(200)
  const [x, y] = await onImage(page, 260, 200)
  const [red, , blue] = await page.getByTestId('canvas').evaluate((c: HTMLCanvasElement, [cssX, cssY]) => {
    const box = c.getBoundingClientRect()
    const at = [(cssX - box.left) * (c.width / box.width), (cssY - box.top) * (c.height / box.height)]
    return [...c.getContext('2d')!.getImageData(at[0], at[1], 1, 1).data]
  }, [x, y])
  expect(red).toBeGreaterThan(blue)
  await page.mouse.up()
  await expect.poll(() => shapesIn(dir, 'p').map((s: any) => s.label).join()).toContain('dog')
  expect(shapesIn(dir, 'p').every((s: any) => s.label === 'dog')).toBe(true)
  await finish(app)
})

test('keys can\'t move a stroke onto another image', async () => {
  const dir = await project('stroke', { p: null, q: null })
  const { app, page } = await launch(dir)
  await open(page, 'p')
  await page.keyboard.press('b')
  await page.mouse.move(...await onImage(page, 100, 100))
  await page.mouse.down()
  await page.mouse.move(...await onImage(page, 200, 100), { steps: 8 })
  await page.keyboard.press('d')
  await page.waitForTimeout(400)
  await page.keyboard.press('e')
  await page.mouse.up()
  await expect(page.locator('.file.on')).toContainText('p.png')
  await expect(page.locator('.shape')).toHaveCount(1)
  await expect.poll(() => existsSync(path.join(dir, 'p.json')) && shapesIn(dir, 'p').length).toBe(1)
  expect(existsSync(path.join(dir, 'q.json'))).toBe(false)
  await finish(app)
})

test('a slip during a click leaves an AI shape alone; a real drag moves and accepts it', async () => {
  const dir = await project('slip', { a: doc('a', [square(100, 100, 200, 200, 0.5)]) })
  const { app, page } = await launch(dir)
  await open(page, 'a')
  await page.keyboard.press('v')
  const [x, y] = await onImage(page, 150, 150)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 2, y + 1)
  await page.mouse.up()
  await expect(page.locator('.shape.on')).toContainText('AI 50%')
  await page.waitForTimeout(700)
  expect(shapesIn(dir, 'a')[0].flags.ai).toBe(true)
  expect(shapesIn(dir, 'a')[0].points[0]).toEqual([100, 100])

  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 60, y, { steps: 4 })
  await page.mouse.up()
  await expect(page.locator('.tag')).toHaveCount(0)
  await expect.poll(() => shapesIn(dir, 'a')[0].flags.ai).toBeUndefined()
  expect(shapesIn(dir, 'a')[0].points[0][0]).toBeGreaterThan(110)
  await finish(app)
})

test('an edit made while another folder opens is saved in its own folder', async () => {
  const a = await project('folder-a', { n: null })
  const inB = doc('n', [square(10, 10, 50, 50)])
  const b = await project('folder-b', { n: inB })
  const { app, page } = await launch(a)
  await open(page, 'n')
  // The main process moves to B while this window is still showing A
  await page.evaluate((dir) => window.api.openProject(dir), b)
  await page.keyboard.press('b')
  await stroke(page, [100, 100], [200, 100])
  await expect(page.locator('.shape')).toHaveCount(1)
  await expect(page.getByTestId('save-state')).toHaveText('Saved')
  await page.waitForTimeout(700)
  expect(readFileSync(path.join(b, 'n.json'), 'utf8')).toBe(inB)
  expect(shapesIn(a, 'n')).toHaveLength(1)
  await finish(app)
})

test('closing right after an edit keeps it', async () => {
  const dir = await project('close', { c: null })
  const { app, page } = await launch(dir)
  await open(page, 'c')
  await page.keyboard.press('b')
  await stroke(page, [100, 100], [200, 100])
  await app.close()
  expect(shapesIn(dir, 'c')).toHaveLength(1)
})

test('undo reaches back across the jump to the next image', async () => {
  const dir = await project('undo', {
    u: doc('u', [square(100, 100, 200, 200, 0.2)]),
    v: doc('v', [square(150, 150, 250, 250, 0.3)])
  })
  const { app, page } = await launch(dir)
  await open(page, 'u')
  await page.keyboard.press('Shift+w')
  await expect(page.locator('.file.on')).toContainText('v.png')
  await expect(page.locator('.shape.on')).toContainText('AI 30%')
  await expect.poll(() => shapesIn(dir, 'u')[0].flags.ai).toBeUndefined()
  await page.keyboard.press('Control+z')
  await expect(page.locator('.file.on')).toContainText('u.png')
  await expect(page.locator('.shape.on')).toContainText('AI 20%')
  await expect.poll(() => shapesIn(dir, 'u')[0].flags.ai).toBe(true)
  expect(shapesIn(dir, 'u')[0].score).toBe(0.2)
  await finish(app)
})
