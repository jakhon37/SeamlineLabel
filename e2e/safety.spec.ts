import { expect, test } from '@playwright/test'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { click, doc, drag, finish, launch, onImage, open, project, saved, shapesIn, square } from './helpers'

// Each of these once could lose or misplace someone's labels

test("a label file that can't be read is shown as such and never written over", async () => {
  const bad = '{"shapes": [ {"label": "cat", '
  const dir = await project('broken', { x: bad, y: null }, [{ name: 'cat', color: '#4f8cff' }])
  const { app, page, errors } = await launch(dir)
  await expect(page.locator('.error')).toContainText('x.png')
  await expect(page.locator('.file', { hasText: 'x.png' }).locator('.dot')).toHaveClass(/broken/)
  // Not offered for pre-labelling, which would replace it
  await expect(page.getByRole('button', { name: 'Pre-label 1 image', exact: true })).toBeVisible()
  await open(page, 'x.png')
  await expect(page.locator('.readonly')).toBeVisible()
  await expect(page.getByTestId('save-state')).toHaveText('Read only')
  await page.keyboard.press('b')
  await drag(page, [100, 100], [200, 100])
  await click(page, 50, 50)
  await page.waitForTimeout(700)
  expect(readFileSync(path.join(dir, 'x.json'), 'utf8')).toBe(bad)
  const save = await page.evaluate(async (root) => {
    try {
      await window.api.saveLabels(root, 'x.png', { shapes: [], flags: {}, size: [400, 300], storeData: false })
      return 'saved'
    } catch (e: any) {
      return e.message
    }
  }, dir)
  expect(save).toContain('x.json')
  expect(readFileSync(path.join(dir, 'x.json'), 'utf8')).toBe(bad)
  await finish(app, errors)
})

test('the brush previews in the colour it will paint', async () => {
  const dir = await project('preview', { p: doc('p', [{ ...square('dog', 50, 50, 120, 120) }]) },
    [{ name: 'cat', color: '#4f8cff' }, { name: 'dog', color: '#ff6b6b' }])
  const { app, page, errors } = await launch(dir)
  await open(page, 'p.png')
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
  await finish(app, errors)
})

test("keys can't move a stroke onto another image", async () => {
  const dir = await project('stroke', { p: null, q: null }, [{ name: 'cat', color: '#4f8cff' }])
  const { app, page, errors } = await launch(dir)
  await open(page, 'p.png')
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
  await finish(app, errors)
})

test('a slip during a click leaves an AI shape alone; a real drag moves and accepts it', async () => {
  const dir = await project('slip', { a: doc('a', [square('cat', 100, 100, 200, 200, 0.5)]) })
  const { app, page, errors } = await launch(dir)
  await open(page, 'a.png')
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
  await finish(app, errors)
})

test('an edit made while another folder opens is saved in its own folder', async () => {
  const a = await project('folder-a', { n: null }, [{ name: 'cat', color: '#4f8cff' }])
  const inB = doc('n', [square('cat', 10, 10, 50, 50)])
  const b = await project('folder-b', { n: inB })
  const { app, page, errors } = await launch(a)
  await open(page, 'n.png')
  // The main process opens B while this window still shows A
  await page.evaluate((dir) => window.api.openProject(dir, null), b)
  await page.keyboard.press('b')
  await drag(page, [100, 100], [200, 100])
  await expect(page.locator('.shape')).toHaveCount(1)
  await saved(page)
  await page.waitForTimeout(700)
  expect(readFileSync(path.join(b, 'n.json'), 'utf8')).toBe(inB)
  expect(shapesIn(a, 'n')).toHaveLength(1)
  await finish(app, errors)
})

test('closing right after an edit keeps it', async () => {
  const dir = await project('close', { c: null }, [{ name: 'cat', color: '#4f8cff' }])
  const { app, page } = await launch(dir)
  await open(page, 'c.png')
  await page.keyboard.press('b')
  await drag(page, [100, 100], [200, 100])
  await app.close()
  expect(shapesIn(dir, 'c')).toHaveLength(1)
})

test('without autosave, leaving asks first, and the answer is kept to', async () => {
  const dir = await project('manual', { m: null, n: null }, [{ name: 'cat', color: '#4f8cff' }])
  const { app, page, errors } = await launch(dir, ['--config', '{auto_save: false}'])
  await open(page, 'm.png')
  await page.keyboard.press('b')
  await drag(page, [100, 100], [200, 100])
  await expect(page.getByTestId('save-state')).toHaveText('Not saved')
  await page.waitForTimeout(700)
  expect(existsSync(path.join(dir, 'm.json'))).toBe(false)
  // Cancel stays; "Don't save" leaves without writing; Save writes
  const answer = (n: number) => app.evaluate(({ dialog }, choice) => {
    dialog.showMessageBox = (async () => ({ response: choice, checkboxChecked: false })) as any
  }, n)
  await answer(2)
  await page.keyboard.press('d')
  await page.waitForTimeout(400)
  await expect(page.locator('.file.on')).toContainText('m.png')
  await answer(1)
  await page.keyboard.press('d')
  await expect(page.locator('.file.on')).toContainText('n.png')
  expect(existsSync(path.join(dir, 'm.json'))).toBe(false)
  await page.keyboard.press('b')
  await drag(page, [100, 100], [200, 100])
  await page.keyboard.press('Control+s')
  await saved(page)
  expect(shapesIn(dir, 'n')).toHaveLength(1)
  await finish(app, errors)
})

test('undo reaches back across the jump to the next image', async () => {
  const dir = await project('undo', {
    u: doc('u', [square('cat', 100, 100, 200, 200, 0.2)]),
    v: doc('v', [square('cat', 150, 150, 250, 250, 0.3)])
  })
  const { app, page, errors } = await launch(dir)
  await open(page, 'u.png')
  await page.keyboard.press('Shift+w')
  await expect(page.locator('.file.on')).toContainText('v.png')
  await expect(page.locator('.shape.on')).toContainText('AI 30%')
  await expect.poll(() => shapesIn(dir, 'u')[0].flags.ai).toBeUndefined()
  await page.keyboard.press('Control+z')
  await expect(page.locator('.file.on')).toContainText('u.png')
  await expect(page.locator('.shape.on')).toContainText('AI 20%')
  await expect.poll(() => shapesIn(dir, 'u')[0].flags.ai).toBe(true)
  expect(shapesIn(dir, 'u')[0].score).toBe(0.2)
  await finish(app, errors)
})
