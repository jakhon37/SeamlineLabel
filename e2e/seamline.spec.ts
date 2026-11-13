import { _electron as electron, type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import sharp from 'sharp'
import { appEnv, BASE, click, discs, doc, drag, finish, H, HEADLESS, launch, open, project, saved, shapesIn, square, W } from './helpers'

// Seamline and Seamtag on one folder: Seamline trains there and exports its runs' models for
// Seamtag's pre-labelling, and either app may save labels while the other has them open

const MODEL = path.resolve(__dirname, '../tests/fixtures/models/discs.onnx')
const CHANGED = 'These labels changed in another app (such as Seamline), so they were reloaded.'

/** A run folder as Seamline's training leaves it, with its Export for Seamtag unless `exported` is false */
function run(dir: string, name: string, classes: string[], options: Record<string, unknown>, ious: number[], exported = true) {
  const at = path.join(dir, '.myseg', 'runs', name)
  mkdirSync(at, { recursive: true })
  writeFileSync(path.join(at, 'options.json'), JSON.stringify({ image_size: 64, tile: 1024, ...options }, null, 2))
  const events = ious.map((iou, i) => JSON.stringify({ type: 'epoch', epoch: i + 1, epochs: ious.length, iou }))
  writeFileSync(path.join(at, 'events.jsonl'), [...events, JSON.stringify({ type: 'done' })].join('\n') + '\n')
  if (!exported) return
  copyFileSync(MODEL, path.join(at, 'model.onnx'))
  writeFileSync(path.join(at, 'model.json'), JSON.stringify({ classes, mean: [0, 0, 0], std: [1, 1, 1], tile: 1024, input_size: [64, 64] }))
}

/**
 * A big grey image with red blocks of 4 pixels scattered over it at random: in tiles of the test
 * model's own size, it gives the noisy map a model early in training does, of many parts and holes
 */
async function speckle(dir: string, name: string, size: number) {
  const pixels = Buffer.alloc(size * size * 3)
  for (let i = 0; i < size * size; i++) pixels.set([0x70, 0x74, 0x78], i * 3)
  let seed = 7
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let y0 = 0; y0 < size; y0 += 4) {
    for (let x0 = 0; x0 < size; x0 += 4) {
      if (random() >= 0.45) continue
      for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) pixels.set([255, 0, 0], (y * size + x) * 3)
    }
  }
  await sharp(pixels, { raw: { width: size, height: size, channels: 3 } }).png().toFile(path.join(dir, `${name}.png`))
}

// The window comes back from another app
const focus = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].emit('focus') })

async function listed(page: Page) {
  await page.getByRole('menuitem', { name: 'AI', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Model for pre-labelling' }).hover()
  const items = await page.locator('.item.sub.open .menu .item').evaluateAll((all) =>
    all.map((b) => `${b.getAttribute('aria-checked') === 'true' ? '✓ ' : ''}${b.querySelector('.label')?.textContent}`))
  await page.keyboard.press('Escape')
  return items
}

test("the AI menu lists the models Seamline exported from the folder's runs, newest first, and pre-labels with them", async () => {
  const dir = await project('seamline-runs', {})
  await discs(dir, 'p1', [{ cx: 100, cy: 100, r: 40, color: '#ff0000' }, { cx: 280, cy: 180, r: 50, color: '#0000ff' }])
  await discs(dir, 'p2', [{ cx: 200, cy: 150, r: 60, color: '#ff0000' }])
  run(dir, '20261110_090000', ['red', 'blue'], { architecture: 'Unet', encoder: 'resnet34' }, [0.5, 0.65])
  // The same model under other names, to tell which one was used
  run(dir, '20261112_101500', ['scarlet', 'navy'], { architecture: 'DeepLabV3Plus', encoder: 'efficientnet-b0' }, [0.7, 0.812, 0.8])
  // Still training: nothing exported yet
  run(dir, '20261112_120000', ['red', 'blue'], { architecture: 'Unet', encoder: 'resnet18' }, [0.3], false)
  const { app, page, errors } = await launch(dir)
  const newest = '20261112_101500 · DeepLabV3Plus · efficientnet-b0 · IoU 0.812'
  const older = '20261110_090000 · Unet · resnet34 · IoU 0.650'
  // With none chosen, pre-labelling takes the newest run
  await expect.poll(() => listed(page)).toEqual(['✓ Newest run', newest, older])
  await expect(page.getByRole('button', { name: 'Pre-label 2 images' })).toHaveAttribute('title', `Run ${newest} on every image with no label file or only AI shapes`)
  await page.getByRole('button', { name: 'Pre-label 2 images' }).click()
  await expect(page.locator('.loading.notice')).toContainText('Pre-labelled 2 of 2 images')
  expect(shapesIn(dir, 'p1').map((s: any) => s.label).sort()).toEqual(['navy', 'scarlet'])
  expect(await listed(page)).toEqual(['✓ Newest run', newest, older])

  // Chosen from the menu, the older one labels with its own classes
  await page.getByRole('menuitem', { name: 'AI', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Model for pre-labelling' }).hover()
  await page.getByRole('menuitemcheckbox', { name: older }).click()
  await expect(page.getByRole('button', { name: 'Pre-label', exact: true })).toHaveAttribute('title', `Pre-label with ${older}`)
  await page.getByRole('button', { name: 'Pre-label 2 images' }).click()
  await expect.poll(() => shapesIn(dir, 'p2').map((s: any) => s.label)).toEqual(['red'])
  const p1 = shapesIn(dir, 'p1')
  expect(p1.map((s: any) => s.label).sort()).toEqual(['blue', 'red'])
  expect(p1.every((s: any) => s.flags.ai && s.score > 0.5)).toBe(true)
  await expect(page.getByRole('button', { name: 'Pre-label 2 images' })).toBeEnabled()

  // A run Seamline exports while Seamtag is open shows once the window comes back to it; the one chosen stays
  run(dir, '20261113_080000', ['red', 'blue'], { architecture: 'Unet', encoder: 'resnet50' }, [0.9])
  await focus(app)
  const latest = '20261113_080000 · Unet · resnet50 · IoU 0.900'
  await expect.poll(() => listed(page)).toEqual(['Newest run', latest, newest, `✓ ${older}`])

  // Newest run forgets the choice: pre-labelling takes the newest again, whichever that is
  const pick = async (item: string) => {
    await page.getByRole('menuitem', { name: 'AI', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Model for pre-labelling' }).hover()
    await page.getByRole('menuitemcheckbox', { name: item }).click()
  }
  await pick('Newest run')
  await expect(page.getByRole('button', { name: 'Pre-label 2 images' })).toHaveAttribute('title', `Run ${latest} on every image with no label file or only AI shapes`)
  expect(await listed(page)).toEqual(['✓ Newest run', latest, newest, older])
  // The newest run chosen by its name stays chosen when a newer one comes
  await pick(latest)
  expect(await listed(page)).toEqual(['Newest run', `✓ ${latest}`, newest, older])
  run(dir, '20261114_080000', ['red', 'blue'], { architecture: 'Unet', encoder: 'resnet101' }, [0.95])
  await focus(app)
  await expect.poll(() => listed(page)).toEqual(['Newest run', '20261114_080000 · Unet · resnet101 · IoU 0.950', `✓ ${latest}`, newest, older])
  await expect(page.getByRole('button', { name: 'Pre-label', exact: true })).toHaveAttribute('title', `Pre-label with ${latest}`)
  await finish(app, errors)
})

test('labels another app changed are reloaded, never written over, and the list follows the folder', async () => {
  const dir = await project('two-apps', { a: doc('a', [square('cat', 20, 20, 120, 120)]), b: null, c: null },
    [{ name: 'cat', color: '#4f8cff' }, { name: 'dog', color: '#ff6b6b' }])
  const { app, page, errors } = await launch(dir)
  await open(page, 'a.png')
  await expect(page.locator('.shape')).toHaveCount(1)

  // Seamline saves the image meanwhile, in its own way
  const theirs = JSON.stringify(JSON.parse(doc('a', [square('dog', 200, 50, 300, 150), square('dog', 50, 180, 150, 280)])), null, 4)
  writeFileSync(path.join(dir, 'a.json'), theirs)
  // A change here would be saved over it
  await page.locator('.shape').first().click()
  await page.keyboard.press('Delete')
  await expect(page.locator('.error')).toHaveText(`${CHANGED} Your last change wasn't saved.`)
  await expect(page.locator('.shape')).toHaveCount(2)
  await expect(page.locator('.shape').first()).toContainText('dog')
  // The image list and the label totals count the labels reloaded, not the change that wasn't saved
  const tally = (label: string) => page.locator('section[aria-label="Labels"] .class', { hasText: label }).locator('.muted')
  await expect(page.locator('.file.on .muted')).toHaveText('2')
  await expect(tally('dog')).toHaveText('2 · 2')
  await expect(tally('cat')).toHaveText('0 · 0')
  await saved(page)
  await page.waitForTimeout(700)
  expect(readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe(theirs)
  await page.locator('.error').click()

  // Seamline changes it again, adds an image with labels and deletes another; coming back, the window follows
  const again = doc('a', [square('dog', 200, 50, 300, 150)])
  writeFileSync(path.join(dir, 'a.json'), again)
  await sharp({ create: { width: W, height: H, channels: 3, background: '#445566' } }).png().toFile(path.join(dir, 'd.png'))
  writeFileSync(path.join(dir, 'd.json'), doc('d', [square('cat', 10, 10, 50, 50), square('dog', 60, 60, 90, 90)]))
  rmSync(path.join(dir, 'c.png'))
  await focus(app)
  await expect(page.locator('.file .name')).toHaveText(['a.png', 'b.png', 'd.png'])
  await expect(page.locator('.file', { hasText: 'd.png' })).toContainText('2')
  await expect(page.locator('.file.on')).toContainText('a.png')
  await expect(page.locator('.shape')).toHaveCount(1)
  await expect(page.locator('.loading.notice')).toHaveText(CHANGED)
  await expect(page.locator('.error')).toHaveCount(0)

  // Read again, a change here is saved as usual, and undo doesn't reach back past the reload
  await page.locator('.shape').first().click()
  await page.keyboard.press('Delete')
  await saved(page)
  await expect.poll(() => shapesIn(dir, 'a').length).toBe(0)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.shape')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => shapesIn(dir, 'a').length).toBe(1)
  await page.waitForTimeout(700)
  expect(shapesIn(dir, 'a').map((s: any) => s.label)).toEqual(['dog'])

  // An image another app removes stays in the list while it's on screen, and goes once the window moves on
  rmSync(path.join(dir, 'a.png'))
  await sharp({ create: { width: W, height: H, channels: 3, background: '#445566' } }).png().toFile(path.join(dir, 'e.png'))
  await focus(app)
  await expect(page.locator('.file .name')).toHaveText(['a.png', 'b.png', 'd.png', 'e.png'])
  await expect(page.locator('.file.on')).toContainText('a.png')
  await open(page, 'b.png')
  await focus(app)
  await expect(page.locator('.file .name')).toHaveText(['b.png', 'd.png', 'e.png'])
  await expect(page.locator('.file.on')).toContainText('b.png')
  await expect(page.getByTestId('counter')).toHaveText('1 / 3')
  await finish(app, errors)
})

test('saving by hand, coming back says the labels changed, and saving then reloads them rather than writing over them', async () => {
  const dir = await project('two-apps-manual', { a: doc('a', [square('cat', 20, 20, 120, 120)]) }, [{ name: 'cat', color: '#4f8cff' }])
  const { app, page, errors } = await launch(dir, ['--no-auto-save'])
  await open(page, 'a.png')
  await page.locator('.shape').first().click()
  await page.keyboard.press('Delete')
  await expect(page.getByTestId('save-state')).toHaveText('Not saved')
  const theirs = doc('a', [square('dog', 200, 50, 300, 150)])
  writeFileSync(path.join(dir, 'a.json'), theirs)
  await focus(app)
  await expect(page.locator('.error')).toContainText('Saving will reload them, and the changes made here since will be lost')
  // Not reloaded meanwhile: the change here is still on screen
  await expect(page.locator('.shape')).toHaveCount(0)
  await page.locator('.error').click()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.locator('.error')).toHaveText(`${CHANGED} Your last change wasn't saved.`)
  await expect(page.locator('.shape')).toHaveCount(1)
  await expect(page.getByTestId('save-state')).toHaveText('Saved')
  expect(readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe(theirs)
  await finish(app, errors)
})

test('pre-labelling leaves the image on screen alone when another app changed its labels', async () => {
  const dir = await project('seamline-prelabel', {})
  await discs(dir, 'p', [{ cx: 100, cy: 100, r: 40, color: '#ff0000' }, { cx: 280, cy: 180, r: 50, color: '#0000ff' }])
  run(dir, '20261112_101500', ['red', 'blue'], { architecture: 'Unet', encoder: 'resnet34' }, [0.8])
  const { app, page, errors } = await launch(dir)
  await open(page, 'p.png')
  // Seamline pre-labels it meanwhile
  const theirs = doc('p', [square('red', 10, 10, 60, 60, 0.4)])
  writeFileSync(path.join(dir, 'p.json'), theirs)
  await page.getByRole('button', { name: 'Pre-label', exact: true }).click()
  await expect(page.locator('.loading.notice')).toHaveText(CHANGED)
  await expect(page.locator('.shape')).toHaveCount(1)
  expect(readFileSync(path.join(dir, 'p.json'), 'utf8')).toBe(theirs)
  // Read again, it pre-labels as asked
  await page.getByRole('button', { name: 'Pre-label', exact: true }).click()
  await expect.poll(() => shapesIn(dir, 'p').map((s: any) => s.label).sort()).toEqual(['blue', 'red'])
  await expect(page.locator('.shape')).toHaveCount(2)
  await finish(app, errors)
})

test("pre-labelling writes no label file where the model finds nothing, as Seamline: the image stays to label, and proposals it had stay", async () => {
  // A person's labels, a file a person emptied, an older model's proposals, and two images with no labels
  const dir = await project('prelabel-nothing', {
    done: doc('done', [square('red', 10, 10, 50, 50)]), empty: doc('empty', []), older: doc('older', [square('red', 10, 10, 50, 50, 0.4)]), none: null
  })
  await discs(dir, 'p', [{ cx: 100, cy: 100, r: 40, color: '#ff0000' }])
  run(dir, '20261112_101500', ['red', 'blue'], { architecture: 'Unet', encoder: 'resnet34' }, [0.8])
  const text = (name: string) => readFileSync(path.join(dir, `${name}.json`), 'utf8')
  const kept = Object.fromEntries(['done', 'empty', 'older'].map((name) => [name, text(name)]))
  const { app, page, errors } = await launch(dir)
  await expect(page.locator('.topbar')).toContainText('2/5 labelled')
  await page.getByRole('button', { name: 'Pre-label 3 images' }).click()
  await expect(page.locator('.loading.notice')).toContainText('Pre-labelled 3 of 3 images')
  expect(shapesIn(dir, 'p').map((s: any) => [s.label, s.flags.ai])).toEqual([['red', true]])
  // The grey images have nothing the model knows: no file for one, and the other keeps its proposals
  expect(existsSync(path.join(dir, 'none.json'))).toBe(false)
  for (const name of Object.keys(kept)) expect(text(name)).toBe(kept[name])
  await expect(page.locator('.topbar')).toContainText('2/5 labelled')
  await expect(page.locator('.filters button', { hasText: 'Label' })).toHaveText('1Label')
  await expect(page.getByRole('button', { name: 'Pre-label 3 images' })).toBeEnabled()
  await finish(app, errors)
})

test('a label file emptied while pre-labelling runs, as by rejecting every proposal, stays empty, as in Seamline', async () => {
  const dir = await project('prelabel-emptied', {})
  // A noisy image first, which takes a while; z has an older model's proposal
  await speckle(dir, 'a', 2000)
  await discs(dir, 'z', [{ cx: 100, cy: 100, r: 40, color: '#ff0000' }])
  writeFileSync(path.join(dir, 'z.json'), doc('z', [square('red', 10, 10, 50, 50, 0.4)]))
  run(dir, '20261112_101500', ['red', 'blue'], { architecture: 'Unet', encoder: 'resnet34' }, [0.3])
  writeFileSync(path.join(dir, '.myseg', 'runs', '20261112_101500', 'model.json'), JSON.stringify({ classes: ['red', 'blue'], mean: [0, 0, 0], std: [1, 1, 1], tile: 64, input_size: [64, 64] }))
  const { app, page, errors } = await launch(dir, ['--config', '{prelabel: {min_area: 400}}'])
  await page.getByRole('button', { name: 'Pre-label 2 images' }).click()
  await expect(page.locator('button.batch')).toContainText('Stop · 0 / 2')
  // Someone rejects z's proposal meanwhile, in Seamline: no shapes, so the image is done
  const emptied = doc('z', [])
  writeFileSync(path.join(dir, 'z.json'), emptied)
  await expect(page.locator('button.batch')).toContainText('Stop · 0 / 2')
  await expect(page.locator('.loading.notice')).toContainText('Pre-labelled 2 of 2 images', { timeout: 120000 })
  expect(shapesIn(dir, 'a').length).toBeGreaterThan(0)
  expect(readFileSync(path.join(dir, 'z.json'), 'utf8')).toBe(emptied)
  await finish(app, errors)
})

test("pre-labelling one image the model finds nothing on says so, in Seamline's words, and its labels stay as they were", async () => {
  const dir = await project('prelabel-one-nothing', { none: null, older: doc('older', [square('red', 10, 10, 50, 50, 0.4)]) })
  mkdirSync(path.join(dir, 'line2'))
  await sharp({ create: { width: W, height: H, channels: 3, background: '#445566' } }).png().toFile(path.join(dir, 'line2', 'grey.png'))
  run(dir, '20261112_101500', ['red', 'blue'], { architecture: 'Unet', encoder: 'resnet34' }, [0.8])
  const older = readFileSync(path.join(dir, 'older.json'), 'utf8')
  const { app, page, errors } = await launch(dir)
  for (const name of ['line2/grey.png', 'none.png', 'older.png']) {
    await open(page, name)
    await page.getByRole('button', { name: 'Pre-label', exact: true }).click()
    await expect(page.locator('.loading.notice')).toHaveText(`The model found nothing on ${name}, so its labels stay as they were.`)
  }
  expect(existsSync(path.join(dir, 'line2', 'grey.json'))).toBe(false)
  expect(existsSync(path.join(dir, 'none.json'))).toBe(false)
  expect(readFileSync(path.join(dir, 'older.json'), 'utf8')).toBe(older)
  await expect(page.locator('.shape')).toHaveCount(1)
  await finish(app, errors)
})

test('saved automatically, a shape drawn and undone on an image with no label file leaves it none, so it stays to pre-label; saved by hand, the empty file is written, as in labelme', async () => {
  const dir = await project('autosave-undone', { a: null, b: null, c: null })
  const { app, page, errors } = await launch(dir, ['--labels', 'cat'])
  const has = (name: string) => existsSync(path.join(dir, `${name}.json`))
  const box = async () => {
    await page.keyboard.press('r')
    await drag(page, [40, 40], [140, 120])
    await expect(page.locator('.shape')).toHaveCount(1)
  }
  const undo = async () => {
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.locator('.shape')).toHaveCount(0)
  }
  await open(page, 'a.png')
  await box()
  await undo()
  await saved(page)
  await page.waitForTimeout(700)
  expect(has('a')).toBe(false)
  // Saved, then undone: the file the save made goes, and the image is to label again
  await box()
  await expect.poll(() => has('a') && shapesIn(dir, 'a').length).toBe(1)
  await expect(page.locator('.topbar')).toContainText('1/3 labelled')
  await undo()
  await expect.poll(() => has('a')).toBe(false)
  await expect(page.locator('.topbar')).toContainText('0/3 labelled')
  await expect(page.getByRole('button', { name: 'Pre-label 3 images' })).toBeVisible()
  // Undone once back on the image, as undo reaches back
  await box()
  await expect.poll(() => has('a')).toBe(true)
  await open(page, 'b.png')
  await open(page, 'a.png')
  await undo()
  await expect.poll(() => has('a')).toBe(false)
  // Saved by hand, an image with nothing on it gets its empty file, and keeps it
  await open(page, 'b.png')
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => has('b') && shapesIn(dir, 'b').length).toBe(0)
  await box()
  await expect.poll(() => shapesIn(dir, 'b').length).toBe(1)
  await undo()
  await expect.poll(() => shapesIn(dir, 'b').length).toBe(0)
  await page.waitForTimeout(700)
  expect(has('b')).toBe(true)
  await expect(page.locator('.topbar')).toContainText('1/3 labelled')
  await expect(page.getByRole('button', { name: 'Pre-label 2 images' })).toBeVisible()
  await finish(app, errors)
})

test('saving by hand, an image with nothing on it saved when asked gets its empty label file, as in labelme', async () => {
  const dir = await project('manual-undone', { a: null, b: null })
  const { app, page, errors } = await launch(dir, ['--labels', 'cat', '--no-auto-save'])
  const { asked, respond } = await answering(app)
  await open(page, 'a.png')
  await page.keyboard.press('r')
  await drag(page, [40, 40], [140, 120])
  await expect(page.locator('.shape')).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.shape')).toHaveCount(0)
  await respond(0)
  await open(page, 'b.png')
  expect(await asked()).toEqual(['Save the changes to a.png?'])
  await expect.poll(() => existsSync(path.join(dir, 'a.json')) && shapesIn(dir, 'a').length).toBe(0)
  await finish(app, errors)
})

test("with no model chosen, each folder pre-labels with its own newest run, and a model picked as a file serves folders with no runs", async () => {
  const blobs = [{ cx: 100, cy: 100, r: 40, color: '#ff0000' }, { cx: 280, cy: 180, r: 50, color: '#0000ff' }]
  const a = await project('runs-a', {})
  await discs(a, 'p', blobs)
  run(a, '20261110_090000', ['a_red', 'a_blue'], { architecture: 'Unet', encoder: 'resnet34' }, [0.5])
  const b = await project('runs-b', {})
  await discs(b, 'q', blobs)
  run(b, '20261111_090000', ['b_red', 'b_blue'], { architecture: 'FPN', encoder: 'resnet18' }, [0.6])
  const c = await project('runs-none', {})
  await discs(c, 'r', blobs)
  // Pre-labels the folder's one image, and gives the labels it then has
  const prelabel = async (page: Page, dir: string, name: string, labels: string[]) => {
    await page.getByRole('button', { name: 'Pre-label 1 image' }).click()
    await expect.poll(() => {
      try {
        return shapesIn(dir, name).map((s: any) => s.label).sort()
      } catch {
        return null
      }
    }).toEqual(labels)
  }

  const first = await launch(a)
  await prelabel(first.page, a, 'p', ['a_blue', 'a_red'])
  // Seamline exports a newer run meanwhile: the next pre-label takes it, as nothing was chosen
  run(a, '20261112_090000', ['new_red', 'new_blue'], { architecture: 'Unet', encoder: 'resnet50' }, [0.7])
  await focus(first.app)
  await prelabel(first.page, a, 'p', ['new_blue', 'new_red'])
  await finish(first.app, first.errors)

  // Another folder, on the same profile: its own run, not the one the last folder used
  const second = await launch(b, [], first.home)
  const newestB = '20261111_090000 · FPN · resnet18 · IoU 0.600'
  await expect(second.page.getByRole('button', { name: 'Pre-label 1 image' })).toHaveAttribute('title', `Run ${newestB} on every image with no label file or only AI shapes`)
  expect(await listed(second.page)).toEqual(['✓ Newest run', newestB])
  await prelabel(second.page, b, 'q', ['b_blue', 'b_red'])
  // A model picked as a file is this folder's choice now
  const models = path.join(path.dirname(b), 'runs-models')
  mkdirSync(models, { recursive: true })
  copyFileSync(MODEL, path.join(models, 'discs.onnx'))
  writeFileSync(path.join(models, 'discs.json'), JSON.stringify({ classes: ['c_red', 'c_blue'], mean: [0, 0, 0], std: [1, 1, 1] }))
  // The dialog answers with this model, and keeps what it was asked with
  const answer = (app: ElectronApplication, model: string) => app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async (_win: unknown, options: unknown) => {
      (globalThis as any).asked = options
      return { canceled: false, filePaths: [file] }
    }) as any
  }, model)
  const asked = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).asked)
  await answer(second.app, path.join(models, 'discs.onnx'))
  await second.page.getByRole('menuitem', { name: 'AI', exact: true }).click()
  await second.page.getByRole('menuitem', { name: 'Choose a model…' }).click()
  await expect.poll(() => listed(second.page)).toEqual(['Newest run', newestB, '✓ discs.onnx'])
  // It starts among the folder's runs, which Seamline keeps in a hidden folder, and shows hidden files
  expect(await asked(second.app)).toMatchObject({ defaultPath: path.join(b, '.myseg', 'runs'), properties: ['openFile', 'showHiddenFiles'] })
  await prelabel(second.page, b, 'q', ['c_blue', 'c_red'])
  await finish(second.app, second.errors)

  // A folder with no runs takes the model last picked as a file; folder A still takes its own newest
  const third = await launch(c, [], first.home)
  await expect(third.page.getByRole('button', { name: 'Pre-label 1 image' })).toHaveAttribute('title', 'Run discs.onnx on every image with no label file or only AI shapes')
  await prelabel(third.page, c, 'r', ['c_blue', 'c_red'])
  // A run another folder exported, picked as a file, says which folder
  await answer(third.app, path.join(a, '.myseg', 'runs', '20261112_090000', 'model.onnx'))
  await third.page.getByRole('menuitem', { name: 'AI', exact: true }).click()
  await third.page.getByRole('menuitem', { name: 'Choose a model…' }).click()
  await expect(third.page.getByRole('button', { name: 'Pre-label 1 image' }))
    .toHaveAttribute('title', 'Run 20261112_090000 · Unet · resnet50 · IoU 0.700 · from runs-a on every image with no label file or only AI shapes')
  // A folder with no runs: the dialog starts where the system says
  const options = await asked(third.app)
  expect([options.defaultPath, options.properties]).toEqual([undefined, ['openFile', 'showHiddenFiles']])
  await finish(third.app, third.errors)
  const fourth = await launch(a, [], first.home)
  await expect.poll(() => listed(fourth.page)).toEqual(['✓ Newest run', '20261112_090000 · Unet · resnet50 · IoU 0.700', '20261110_090000 · Unet · resnet34 · IoU 0.500'])
  await finish(fourth.app, fourth.errors)
})

test('a model chosen while pre-labelling runs is used from the next run on, and the run in progress keeps its own', async () => {
  const dir = await project('seamline-switch', {})
  // Big images in small tiles, so pre-labelling takes a while
  const images = Array.from({ length: 8 }, (_, i) => `p${i}`)
  for (const name of images) {
    const svg = '<svg width="1200" height="900"><circle cx="300" cy="300" r="120" fill="#ff0000"/></svg>'
    await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#707478' } }).composite([{ input: Buffer.from(svg) }]).png().toFile(path.join(dir, `${name}.png`))
  }
  for (const [name, classes] of [['20261110_090000', ['old_red', 'old_blue']], ['20261112_090000', ['new_red', 'new_blue']]] as const) {
    run(dir, name, [...classes], { architecture: 'Unet', encoder: 'resnet34' }, [0.5])
    writeFileSync(path.join(dir, '.myseg', 'runs', name, 'model.json'), JSON.stringify({ classes, mean: [0, 0, 0], std: [1, 1, 1], tile: 64, input_size: [64, 64] }))
  }
  const { app, page, errors } = await launch(dir)
  await page.getByRole('button', { name: 'Pre-label 8 images' }).click()
  await expect(page.locator('button.batch')).toContainText(/Stop · [1-9]/)
  // The older run, chosen while the newest pre-labels
  await page.getByRole('menuitem', { name: 'AI', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Model for pre-labelling' }).hover()
  await page.getByRole('menuitemcheckbox', { name: /^20261110_090000/ }).click()
  await expect(page.locator('.loading.notice')).toContainText('Pre-labelled 8 of 8 images', { timeout: 120000 })
  await expect(page.locator('.error')).toHaveCount(0)
  for (const name of images) expect(shapesIn(dir, name).map((s: any) => s.label)).toEqual(['new_red'])
  await expect(page.getByRole('button', { name: 'Pre-label', exact: true })).toHaveAttribute('title', /^Pre-label with 20261110_090000/)
  await finish(app, errors)
})

test("classes another app adds to the folder's class list show when the window comes back, and Seamtag's own changes keep them", async () => {
  const dir = await project('two-apps-classes', { a: doc('a', [square('cat', 20, 20, 120, 120)]) }, [{ name: 'cat', color: '#4f8cff' }, { name: 'dog', color: '#ff6b6b' }])
  const file = path.join(dir, '.myseg', 'project.json')
  const theirs = () => JSON.parse(readFileSync(file, 'utf8'))
  const { app, page, errors } = await launch(dir)
  const labels = page.locator('section[aria-label="Labels"] .class .name')
  await expect(labels).toHaveText(['cat', 'dog'])
  // Seamline adds a class, deletes one no shape has, and keeps its settings in the same file
  writeFileSync(file, JSON.stringify({ ...theirs(), classes: [{ name: 'cat', color: '#4f8cff' }, { name: 'bird', color: '#00aa00' }], train: { epochs: 50 } }))
  await focus(app)
  await expect(labels).toHaveText(['cat', 'bird'])
  // Seamline adds another while Seamtag's window is in front, and a label added here keeps it
  writeFileSync(file, JSON.stringify({ ...theirs(), classes: [...theirs().classes, { name: 'fox', color: '#aa5500' }] }))
  await page.getByLabel('New label').fill('owl')
  await page.getByLabel('New label').press('Enter')
  await expect.poll(() => theirs().classes.map((k: { name: string }) => k.name)).toEqual(['cat', 'bird', 'owl', 'fox'])
  expect(theirs().train).toEqual({ epochs: 50 })
  await expect(labels).toHaveText(['cat', 'bird', 'owl', 'fox'])
  await finish(app, errors)
})

test("a label added or recoloured here goes alone into the folder's class list, and the label list keeps every label where it was", async () => {
  // a holds cat, old and dog: cat and old are classes, dog is only found in the file; cfg comes from the command line
  const dir = await project('two-apps-one-label', {
    a: doc('a', [square('cat', 20, 20, 120, 120), square('old', 150, 150, 200, 200), square('dog', 250, 50, 350, 150)]), b: null
  }, [{ name: 'cat', color: '#4f8cff' }, { name: 'old', color: '#ff6b6b' }])
  const file = path.join(dir, '.myseg', 'project.json')
  const theirs = () => JSON.parse(readFileSync(file, 'utf8'))
  const classNames = () => theirs().classes.map((k: { name: string }) => k.name)
  const { app, page, errors } = await launch(dir, ['--labels', 'cfg'])
  const labels = page.locator('section[aria-label="Labels"] .class .name')
  const colours = () => page.locator('section[aria-label="Labels"] .class .swatch input').evaluateAll((all) => all.map((i) => (i as HTMLInputElement).value))
  await expect(labels).toHaveText(['cfg', 'cat', 'old', 'dog'])
  // Seamline deletes old, which a still uses: it stays in the label list, as a label the files have
  writeFileSync(file, JSON.stringify({ ...theirs(), classes: [{ name: 'cat', color: '#4f8cff' }] }))
  await focus(app)
  await expect(labels).toHaveText(['cfg', 'cat', 'dog', 'old'])
  const shown = await colours()
  // Added here, owl alone joins the classes: not cfg or dog, and old doesn't come back
  await page.getByLabel('New label').fill('owl')
  await page.getByLabel('New label').press('Enter')
  await expect.poll(classNames).toEqual(['cat', 'owl'])
  await expect(labels).toHaveText(['cfg', 'cat', 'dog', 'old', 'owl'])
  expect((await colours()).slice(0, 4)).toEqual(shown)
  // Recoloured, a label that isn't a class joins the classes alone, and a class changes its colour
  await page.getByLabel('Colour of dog').fill('#123456')
  await expect.poll(classNames).toEqual(['cat', 'owl', 'dog'])
  expect(theirs().classes[2]).toEqual({ name: 'dog', color: '#123456' })
  await page.getByLabel('Colour of cat').fill('#654321')
  await expect.poll(() => theirs().classes[0]).toEqual({ name: 'cat', color: '#654321' })
  expect(classNames()).toEqual(['cat', 'owl', 'dog'])
  await expect(labels).toHaveText(['cfg', 'cat', 'dog', 'old', 'owl'])
  expect((await colours()).slice(0, 4)).toEqual([shown[0], '#654321', '#123456', shown[3]])
  await finish(app, errors)
})

test("in a folder with no class list yet, a label added here starts one as Seamline would: with the labels of the folder's shapes", async () => {
  // Labelled in labelme or LabelImg: no .myseg yet, and a line, which no model trains on
  const line = { label: 'edge', shape_type: 'line', group_id: null, description: '', points: [[10, 10], [90, 90]], flags: {} }
  const dir = await project('two-apps-first-list', { a: doc('a', [square('dog', 20, 20, 120, 120), line]), b: doc('b', [square('cat', 20, 20, 120, 120)]) })
  const file = path.join(dir, '.myseg', 'project.json')
  const { page, app, errors } = await launch(dir)
  const labels = page.locator('section[aria-label="Labels"] .class .name')
  const colours = () => page.locator('section[aria-label="Labels"] .class .swatch input').evaluateAll((all) => all.map((i) => (i as HTMLInputElement).value))
  await expect(labels).toHaveText(['cat', 'dog', 'edge'])
  const shown = await colours()
  await page.getByLabel('New label').fill('owl')
  await page.getByLabel('New label').press('Enter')
  await expect(labels).toHaveText(['cat', 'dog', 'edge', 'owl'])
  // Seamline, finding this list, trains on cat and dog too; the label list keeps its colours
  await expect.poll(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).classes).toEqual([
    { name: 'cat', color: shown[0] }, { name: 'dog', color: shown[1] }, { name: 'owl', color: (await colours())[3] }
  ])
  expect((await colours()).slice(0, 3)).toEqual(shown)
  await finish(app, errors)
})

test('the label picked for new shapes stays picked when another app adds or deletes classes, and once it has gone, new shapes ask', async () => {
  // cat, dog and fox are classes; bird is only in a's file
  const dir = await project('two-apps-picked', { a: doc('a', [square('bird', 20, 20, 60, 60)]), b: null },
    [{ name: 'cat', color: '#4f8cff' }, { name: 'dog', color: '#ff6b6b' }, { name: 'fox', color: '#aa5500' }])
  const file = path.join(dir, '.myseg', 'project.json')
  const classesAre = (...names: string[]) => writeFileSync(file, JSON.stringify({ name: 'two-apps-picked', classes: names.map((name) => ({ name, color: '#123456' })) }))
  const { app, page, errors } = await launch(dir)
  const labels = page.locator('section[aria-label="Labels"] .class .name')
  const picked = page.locator('section[aria-label="Labels"] .class.on .name')
  const pick = (name: string) => page.locator('section[aria-label="Labels"] .class', { hasText: name }).click()
  const box = async (x: number) => {
    await page.keyboard.press('r')
    await drag(page, [x, 20], [x + 40, 60])
  }
  await open(page, 'b.png')
  await expect(labels).toHaveText(['cat', 'dog', 'fox', 'bird'])
  await pick('bird')
  await box(20)
  await saved(page)
  // Seamline deletes cat, a class before bird in the list, and then adds emu, which goes before it too
  classesAre('dog', 'fox')
  await focus(app)
  await expect(labels).toHaveText(['dog', 'fox', 'bird'])
  await expect(picked).toHaveText('bird')
  await box(80)
  await saved(page)
  classesAre('dog', 'fox', 'emu')
  await focus(app)
  await expect(labels).toHaveText(['dog', 'fox', 'emu', 'bird'])
  await expect(picked).toHaveText('bird')
  await box(140)
  await saved(page)
  await expect.poll(() => shapesIn(dir, 'b').map((s: any) => s.label)).toEqual(['bird', 'bird', 'bird'])
  // A class picked that Seamline then deletes, and no file uses, is gone: the next shape asks for its label
  await page.keyboard.press('Escape')
  await pick('emu')
  await expect(picked).toHaveText('emu')
  classesAre('dog', 'fox')
  await focus(app)
  await expect(labels).toHaveText(['dog', 'fox', 'bird'])
  await expect(picked).toHaveCount(0)
  await box(200)
  const dialog = page.getByRole('dialog', { name: 'Label' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Label', { exact: true }).fill('owl')
  await dialog.getByRole('button', { name: 'OK' }).click()
  await saved(page)
  await expect.poll(() => shapesIn(dir, 'b').map((s: any) => s.label)).toEqual(['bird', 'bird', 'bird', 'owl'])
  await finish(app, errors)
})

// Chromium can't take the lock under a temp folder too deep for its socket, as on some test
// machines: then the message a second start sends stands in for it
const lockable = process.platform === 'win32' || path.join(tmpdir(), 'scoped_dir000000', 'SingletonSocket').length < (process.platform === 'darwin' ? 104 : 108)
/** Seamtag started again on the profile of the one that's open, as Seamline's Label in Seamtag starts it */
async function startAgain(app: ElectronApplication, home: string, target: string) {
  if (!lockable) {
    return app.evaluate(({ app: electronApp }, filename) => { electronApp.emit('second-instance', {}, [], '', { filename, output: null }) }, target)
  }
  const said = execFileSync(require('electron'), [path.resolve(__dirname, '..'), ...HEADLESS, target], { env: appEnv(home), encoding: 'utf8', timeout: 60000 })
  expect(said).toContain('Seamtag is already open')
}
/** Questions wait, open, until `respond` answers them; its answer stands for the ones after */
async function answering(app: ElectronApplication) {
  await app.evaluate(({ dialog }) => {
    const state = (globalThis as any).questions = { asked: [] as string[], answer: null as number | null, waiting: [] as ((n: number) => void)[] }
    dialog.showMessageBox = ((_win: unknown, o: { message: string }) => new Promise((done) => {
      state.asked.push(o.message)
      const reply = (response: number) => done({ response, checkboxChecked: false })
      if (state.answer === null) state.waiting.push(reply)
      else reply(state.answer)
    })) as any
  })
  return {
    asked: () => app.evaluate(() => (globalThis as any).questions.asked as string[]),
    respond: (answer: number) => app.evaluate((_electron, n) => {
      const state = (globalThis as any).questions
      state.answer = n
      for (const reply of state.waiting.splice(0)) reply(n)
    }, answer)
  }
}

test('started again on its profile, as Seamline starts it, Seamtag opens what it was given in the window it has open', async () => {
  const dir = await project('started-again', { a: doc('a', [square('cat', 20, 20, 120, 120)]), b: null })
  const { app, page, errors, home } = await launch(dir)
  await open(page, 'a.png')
  expect(await app.evaluate(({ app: electronApp }) => electronApp.hasSingleInstanceLock())).toBe(lockable)
  // An edit made just before is saved first
  await page.locator('.shape').first().click()
  await page.keyboard.press('Delete')
  await startAgain(app, home, path.join(dir, 'b.png'))
  await expect(page.locator('.file.on')).toContainText('b.png')
  expect(shapesIn(dir, 'a')).toEqual([])
  // An image another app added since the list was read opens too
  await sharp({ create: { width: W, height: H, channels: 3, background: '#445566' } }).png().toFile(path.join(dir, 'c.png'))
  await startAgain(app, home, path.join(dir, 'c.png'))
  await expect(page.locator('.file.on')).toContainText('c.png')
  await expect(page.locator('.file .name')).toHaveText(['a.png', 'b.png', 'c.png'])
  // Once the window has asked what to open, a start is sent to it, even while its page still loads something
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.isLoading = () => true })
  await startAgain(app, home, path.join(dir, 'a.png'))
  await expect(page.locator('.file.on')).toContainText('a.png')
  // Another folder opens in the same window
  const other = await project('started-again-other', { d: null })
  await startAgain(app, home, other)
  await expect(page.locator('.file .name')).toHaveText(['d.png'])
  expect(app.windows()).toHaveLength(1)
  await finish(app, errors)
})

test("started again with a dialog open or a shape being drawn, Seamtag opens nothing over it and says so", async () => {
  const dir = await project('started-again-busy', { a: null, b: null })
  const other = await project('started-again-busy-other', { c: null })
  // Each new shape asks for its label
  const { app, page, errors, home } = await launch(dir, ['--labels', 'cat', '--config', '{display_label_popup: true}'])
  await open(page, 'a.png')
  const dialog = page.getByRole('dialog', { name: 'Label' })
  const name = async () => {
    await dialog.getByLabel('Label', { exact: true }).fill('cat')
    await dialog.getByRole('button', { name: 'OK' }).click()
  }
  // A box waiting for its label
  await page.keyboard.press('r')
  await drag(page, [40, 40], [140, 120])
  await expect(dialog).toBeVisible()
  await startAgain(app, home, path.join(dir, 'b.png'))
  await expect(page.locator('.error')).toHaveText("b.png wasn't opened. A dialog or menu is open here: close it, then try again.")
  await startAgain(app, home, other)
  await expect(page.locator('.error')).toHaveText(`${other} wasn't opened. A dialog or menu is open here: close it, then try again.`)
  // Named, it's saved on the image it was drawn on
  await name()
  await saved(page)
  await expect(page.locator('.file.on')).toContainText('a.png')
  await expect.poll(() => existsSync(path.join(dir, 'a.json')) && shapesIn(dir, 'a').length).toBe(1)
  expect(existsSync(path.join(dir, 'b.json'))).toBe(false)
  // A polygon half drawn stays too
  await page.locator('.error').click()
  await page.keyboard.press('p')
  await click(page, 200, 50)
  await click(page, 300, 60)
  await startAgain(app, home, path.join(dir, 'b.png'))
  await expect(page.locator('.error')).toHaveText("b.png wasn't opened. A shape is being drawn here: finish it, then try again.")
  await page.locator('.error').click()
  await click(page, 250, 150)
  await page.keyboard.press('Enter')
  await name()
  await saved(page)
  await expect.poll(() => shapesIn(dir, 'a').length).toBe(2)
  // An image added since the list was read opens once the folder is read again, which takes a while
  // in a big folder: a box drawn meanwhile stays on its image, and the image waits
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as any)._invokeHandlers as Map<string, (...args: unknown[]) => unknown>
    const refresh = handlers.get('project:refresh')!
    handlers.set('project:refresh', async (...args: unknown[]) => {
      await new Promise((done) => setTimeout(done, 4000))
      return refresh(...args)
    })
  })
  await sharp({ create: { width: W, height: H, channels: 3, background: '#445566' } }).png().toFile(path.join(dir, 'c.png'))
  await startAgain(app, home, path.join(dir, 'c.png'))
  await page.keyboard.press('r')
  await drag(page, [40, 160], [140, 240])
  await expect(dialog).toBeVisible()
  await expect(page.locator('.error')).toHaveText("c.png wasn't opened. A dialog or menu is open here: close it, then try again.", { timeout: 15000 })
  await name()
  await saved(page)
  await expect(page.locator('.file.on')).toContainText('a.png')
  await expect.poll(() => shapesIn(dir, 'a').length).toBe(3)
  expect(existsSync(path.join(dir, 'c.json'))).toBe(false)
  await page.locator('.error').click()
  // With nothing waiting, it opens
  await startAgain(app, home, path.join(dir, 'b.png'))
  await expect(page.locator('.file.on')).toContainText('b.png')
  await expect(page.locator('.error')).toHaveCount(0)
  await finish(app, errors)
})

test("what's said of an image's labels changed in another app goes once another image is on screen; other errors stay", async () => {
  const dir = await project('two-apps-notice', { a: doc('a', [square('cat', 20, 20, 120, 120)]), b: doc('b', [square('cat', 20, 20, 120, 120)]), c: null },
    [{ name: 'cat', color: '#4f8cff' }])
  const { app, page, errors, home } = await launch(dir)
  // Seamline saves the image; the change made here meanwhile isn't saved, and the window says so
  const refused = async (name: string) => {
    writeFileSync(path.join(dir, `${name}.json`), doc(name, [square('cat', 200, 50, 300, 150), square('cat', 50, 180, 150, 280)]))
    await page.locator('.shape').first().click()
    await page.keyboard.press('Delete')
    await expect(page.locator('.error')).toHaveText(`${CHANGED} Your last change wasn't saved.`)
  }
  await open(page, 'a.png')
  await refused('a')
  // Seamline's Label in Seamtag brings b to the screen: what was said was of a, so it goes
  await startAgain(app, home, path.join(dir, 'b.png'))
  await expect(page.locator('.file.on')).toContainText('b.png')
  await expect(page.locator('.error')).toHaveCount(0)
  // The same with another image opened from the list
  await refused('b')
  await open(page, 'c.png')
  await expect(page.locator('.error')).toHaveCount(0)
  // A message of no one image stays
  const gone = path.join(dir, 'gone.png')
  await startAgain(app, home, gone)
  await expect(page.locator('.error')).toHaveText(`Could not open ${gone}: there's no such file or folder.`)
  await open(page, 'a.png')
  await expect(page.locator('.error')).toHaveText(`Could not open ${gone}: there's no such file or folder.`)
  await finish(app, errors)
})

test('saving by hand, the warning that labels changed in another app goes once another image is on screen', async () => {
  const dir = await project('two-apps-manual-notice', { a: doc('a', [square('cat', 20, 20, 120, 120)]), b: null }, [{ name: 'cat', color: '#4f8cff' }])
  const { app, page, errors } = await launch(dir, ['--no-auto-save'])
  const { asked, respond } = await answering(app)
  await open(page, 'a.png')
  await page.locator('.shape').first().click()
  await page.keyboard.press('Delete')
  writeFileSync(path.join(dir, 'a.json'), doc('a', [square('cat', 200, 50, 300, 150)]))
  await focus(app)
  await expect(page.locator('.error')).toContainText('Saving will reload them')
  // Not saved, b opens
  await respond(1)
  await open(page, 'b.png')
  expect(await asked()).toEqual(['Save the changes to a.png?'])
  await expect(page.locator('.error')).toHaveCount(0)
  await finish(app, errors)
})

test('started on an image in a subfolder of a Seamline project, Seamtag opens the project on that image; a folder with no project opens as before', async () => {
  const dir = await project('started-in-project', { a: null }, [{ name: 'cat', color: '#4f8cff' }])
  const plain = await project('started-in-folder', { a: null })
  const other = await project('started-in-other', { o: null })
  for (const top of [dir, plain]) {
    mkdirSync(path.join(top, 'line2'))
    for (const name of ['x', 'y']) await sharp({ create: { width: W, height: H, channels: 3, background: '#445566' } }).png().toFile(path.join(top, 'line2', `${name}.png`))
  }
  const names = (page: Page) => page.locator('.file .name')
  // Started cold
  const cold = await launch(path.join(dir, 'line2', 'x.png'))
  await expect(names(cold.page)).toHaveText(['a.png', 'line2/x.png', 'line2/y.png'])
  await expect(cold.page.locator('.file.on')).toContainText('line2/x.png')
  await expect(cold.page.locator('.topbar')).toContainText('started-in-project · 0/3 labelled')
  await finish(cold.app, cold.errors)
  const plainCold = await launch(path.join(plain, 'line2', 'x.png'))
  await expect(names(plainCold.page)).toHaveText(['x.png', 'y.png'])
  await expect(plainCold.page.locator('.file.on')).toContainText('x.png')
  await finish(plainCold.app, plainCold.errors)

  // Started again, with another folder open
  const { app, page, errors, home } = await launch(other)
  await startAgain(app, home, path.join(dir, 'line2', 'x.png'))
  await expect(names(page)).toHaveText(['a.png', 'line2/x.png', 'line2/y.png'])
  await expect(page.locator('.file.on')).toContainText('line2/x.png')
  await expect(page.locator('.topbar')).toContainText('started-in-project · 0/3 labelled')
  // An image of the folder open shows, as before
  await startAgain(app, home, path.join(dir, 'line2', 'y.png'))
  await expect(page.locator('.file.on')).toContainText('line2/y.png')
  // Opened by hand, an image opens its own folder, as in labelme
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as any
  }, path.join(dir, 'line2', 'y.png'))
  await page.getByRole('menuitem', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: 'Open…' }).click()
  await expect(page.locator('.topbar')).toContainText('line2 · 0/2 labelled')
  await expect(names(page)).toHaveText(['x.png', 'y.png'])
  await expect(page.locator('.file.on')).toContainText('y.png')
  // No project above: its own folder opens
  await startAgain(app, home, path.join(plain, 'line2', 'x.png'))
  await expect(page.locator('.file.on')).toContainText('x.png')
  await expect(names(page)).toHaveText(['x.png', 'y.png'])
  expect(app.windows()).toHaveLength(1)
  await finish(app, errors)
})

test('the project such a start opened is remembered on that image, as the last folder and in Open recent; an image opened by hand is remembered as in labelme', async () => {
  const dir = await project('remembered-project', { a: null }, [{ name: 'cat', color: '#4f8cff' }])
  const other = await project('remembered-other', { o: null })
  mkdirSync(path.join(dir, 'line2'))
  for (const name of ['x', 'y']) await sharp({ create: { width: W, height: H, channels: 3, background: '#445566' } }).png().toFile(path.join(dir, 'line2', `${name}.png`))
  const x = path.join(dir, 'line2', 'x.png'), y = path.join(dir, 'line2', 'y.png')
  const names = (page: Page) => page.locator('.file .name')
  const inProject = async (page: Page) => {
    await expect(names(page)).toHaveText(['a.png', 'line2/x.png', 'line2/y.png'])
    await expect(page.locator('.file.on')).toContainText('line2/x.png')
    await expect(page.locator('.topbar')).toContainText('remembered-project · 0/3 labelled')
  }
  const recent = async (page: Page) => {
    await page.getByRole('menuitem', { name: 'File' }).click()
    await page.getByRole('menuitem', { name: 'Open recent' }).hover()
    const entries = page.locator('.item.sub.open .menu .item .label')
    await expect(entries.first()).toBeVisible()
    return entries.allTextContents()
  }
  // Started again on line2/x.png, as Seamline's Label in Seamtag starts it, then quit
  const first = await launch(other)
  await startAgain(first.app, first.home, x)
  await inProject(first.page)
  await finish(first.app, first.errors)
  // Started with no file, as from the desktop menu: the project, on that image
  const { app, page, errors, home } = await launch(null, [], first.home)
  await inProject(page)
  // Open recent lists the project, which opens on that image
  expect(await recent(page)).toEqual([dir, other])
  await page.getByRole('menuitem', { name: other, exact: true }).click()
  await expect(names(page)).toHaveText(['o.png'])
  await recent(page)
  await page.getByRole('menuitem', { name: dir, exact: true }).click()
  await inProject(page)
  // Opened by hand, an image is remembered as itself, so its own folder opens again, on it
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as any
  }, y)
  await page.getByRole('menuitem', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: 'Open…' }).click()
  await expect(names(page)).toHaveText(['x.png', 'y.png'])
  await finish(app, errors)
  const byHand = await launch(null, [], home)
  await expect(names(byHand.page)).toHaveText(['x.png', 'y.png'])
  await expect(byHand.page.locator('.file.on')).toContainText('y.png')
  expect(await recent(byHand.page)).toEqual([y, dir, other])
  await finish(byHand.app, byHand.errors)
  // Started cold on the image, the project is in the list of recent folders a start with none shows
  const cold = await launch(x)
  await inProject(cold.page)
  await finish(cold.app, cold.errors)
  const empty = await launch(null, [], cold.home)
  await expect(empty.page.locator('.recent .file .name')).toHaveText([dir])
  await empty.page.locator('.recent .file').click()
  await inProject(empty.page)
  await finish(empty.app, empty.errors)
})

test('started again while saving by hand, Seamtag asks once about unsaved work, and opens nothing that isn\'t there', async () => {
  const dir = await project('started-again-manual', { a: doc('a', [square('cat', 20, 20, 120, 120)]), b: null })
  const other = await project('started-again-manual-other', { c: null })
  const { app, page, errors, home } = await launch(dir, ['--no-auto-save'])
  const { asked, respond } = await answering(app)
  await open(page, 'a.png')
  await page.locator('.shape').first().click()
  await page.keyboard.press('Delete')
  await expect(page.getByTestId('save-state')).toHaveText('Not saved')
  // Not there: nothing is asked, and the image stays as it is
  const gone = path.join(dir, 'gone.png')
  await startAgain(app, home, gone)
  await expect(page.locator('.error')).toHaveText(`Could not open ${gone}: there's no such file or folder.`)
  await page.locator('.error').click()
  await expect(page.getByTestId('save-state')).toHaveText('Not saved')
  await expect(page.locator('.shape')).toHaveCount(0)
  expect(await asked()).toEqual([])
  // Another folder: asked once; a start while it asks opens nothing under the question
  await startAgain(app, home, other)
  await expect.poll(asked).toEqual(['Save the changes to a.png?'])
  await startAgain(app, home, path.join(dir, 'b.png'))
  await expect(page.locator('.error')).toHaveText("b.png wasn't opened. A dialog or menu is open here: close it, then try again.")
  // Cancelled, everything stays
  await respond(2)
  await page.waitForTimeout(300)
  await expect(page.locator('.file.on')).toContainText('a.png')
  await expect(page.getByTestId('save-state')).toHaveText('Not saved')
  expect(await asked()).toHaveLength(1)
  // Saved, the other folder opens
  await respond(0)
  await startAgain(app, home, other)
  await expect(page.locator('.file .name')).toHaveText(['c.png'])
  expect(await asked()).toHaveLength(2)
  expect(shapesIn(dir, 'a')).toEqual([])
  await finish(app, errors)
})

test('started again on another folder while pre-labelling runs, Seamtag asks before stopping it, and stops it cleanly', async () => {
  const dir = await project('started-again-batch', {})
  // Big images in small tiles, so pre-labelling takes a while
  const images = Array.from({ length: 24 }, (_, i) => `p${String(i).padStart(2, '0')}`)
  for (const name of images) {
    const svg = '<svg width="1200" height="900"><circle cx="300" cy="300" r="120" fill="#ff0000"/></svg>'
    await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#707478' } }).composite([{ input: Buffer.from(svg) }]).png().toFile(path.join(dir, `${name}.png`))
  }
  run(dir, '20261112_101500', ['red', 'blue'], { architecture: 'Unet', encoder: 'resnet34' }, [0.8])
  writeFileSync(path.join(dir, '.myseg', 'runs', '20261112_101500', 'model.json'), JSON.stringify({ classes: ['red', 'blue'], mean: [0, 0, 0], std: [1, 1, 1], tile: 64, input_size: [64, 64] }))
  const other = await project('started-again-batch-other', { c: null })
  const { app, page, errors, home } = await launch(dir)
  const { asked, respond } = await answering(app)
  const labelled = () => images.filter((n) => existsSync(path.join(dir, `${n}.json`))).length
  await page.getByRole('button', { name: 'Pre-label 24 images' }).click()
  await expect(page.locator('button.batch')).toContainText(/Stop · [1-9]/)
  // Cancelled, pre-labelling goes on in this folder
  await respond(1)
  await startAgain(app, home, other)
  await expect.poll(asked).toEqual(['Stop pre-labelling?'])
  await page.waitForTimeout(300)
  await expect(page.locator('.file .name').first()).toHaveText('p00.png')
  await expect(page.locator('button.batch')).toContainText('Stop ·')
  // The same from the menu: a new output folder would take the rest of its proposals
  const out = path.join(BASE, 'started-again-batch-out')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any }, out)
  await page.getByRole('menuitem', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: 'Change output folder…' }).click()
  await expect.poll(asked).toHaveLength(2)
  await expect(page.locator('button.batch')).toContainText('Stop ·')
  // Stopped, the image it's on is finished first, then the other folder opens
  await respond(0)
  await startAgain(app, home, other)
  await expect(page.locator('.file .name')).toHaveText(['c.png'])
  expect(await asked()).toEqual(['Stop pre-labelling?', 'Stop pre-labelling?', 'Stop pre-labelling?'])
  expect(readdirSync(out)).toEqual([])
  const done = labelled()
  expect(done).toBeGreaterThan(0)
  expect(done).toBeLessThan(images.length)
  await page.waitForTimeout(1500)
  expect(labelled()).toBe(done)
  for (const n of images.slice(0, done)) expect(shapesIn(dir, n).map((s: any) => s.label)).toEqual(['red'])
  await expect(page.locator('.error')).toHaveCount(0)
  await finish(app, errors)
})

test('pre-labelling outlines shapes in a thread of its own, so Seamtag keeps answering, a second start too, on a noisy map', async () => {
  const dir = await project('prelabel-noisy', { b: null })
  await speckle(dir, 'a', 2000)
  run(dir, '20261112_101500', ['red', 'blue'], { architecture: 'Unet', encoder: 'resnet34' }, [0.3])
  writeFileSync(path.join(dir, '.myseg', 'runs', '20261112_101500', 'model.json'), JSON.stringify({ classes: ['red', 'blue'], mean: [0, 0, 0], std: [1, 1, 1], tile: 64, input_size: [64, 64] }))
  // Every part is outlined still, but only the bigger ones are kept, for the main process to save
  const { app, page, errors, home } = await launch(dir, ['--config', '{prelabel: {min_area: 400}}'])
  // The longest the main process goes without a break, by a timer of its own. Chromium ends an app
  // that doesn't answer a second start within 20 s.
  await app.evaluate(() => {
    const kept = globalThis as any
    let last = Date.now()
    kept.longest = 0
    kept.timer = setInterval(() => {
      kept.longest = Math.max(kept.longest, Date.now() - last)
      last = Date.now()
    }, 20)
  })
  await page.getByRole('button', { name: 'Pre-label 2 images' }).click()
  await expect(page.locator('button.batch')).toBeVisible()
  await page.waitForTimeout(1000)
  await startAgain(app, home, path.join(dir, 'b.png'))
  await expect(page.locator('.file.on')).toContainText('b.png')
  await expect(page.locator('.loading.notice')).toContainText('Pre-labelled 2 of 2 images', { timeout: 120000 })
  const longest = await app.evaluate(() => {
    const kept = globalThis as any
    clearInterval(kept.timer)
    return kept.longest as number
  })
  expect(longest).toBeLessThan(2000)
  expect(shapesIn(dir, 'a').length).toBeGreaterThan(10)
  await expect(page.locator('.error')).toHaveCount(0)
  await finish(app, errors)
})

test("an installed Seamtag started by an app's development run, as Seamline's npm run dev starts it, shows its own window", async () => {
  const dir = await project('started-installed', { a: null })
  // Seamtag as an installer leaves it: packaged, with no app folder among its arguments
  const main = path.join(BASE, 'installed-main.js')
  writeFileSync(main, [
    "const { app } = require('electron')",
    "Object.defineProperty(app, 'isPackaged', { get: () => true })",
    'process.argv.splice(1, 1)',
    `require(${JSON.stringify(path.resolve(__dirname, '../out/main/index.js'))})`
  ].join('\n'))
  // That app's development server, where nothing answers now
  const env = { ...appEnv(mkdtempSync(path.join(tmpdir(), 'seamtag-home-'))), ELECTRON_RENDERER_URL: 'http://127.0.0.1:9/' }
  const app = await electron.launch({ args: [main, ...HEADLESS, dir], env })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true)
  await expect(page.locator('.file .name')).toHaveText(['a.png'])
  await finish(app, errors)
})

test('coming back, the image on screen is reloaded before a big folder is read again, so an edit made at once is kept', async () => {
  const dir = await project('two-apps-big', { a: doc('a', [square('cat', 20, 20, 120, 120), square('cat', 200, 50, 300, 150)]) }, [{ name: 'cat', color: '#4f8cff' }, { name: 'dog', color: '#ff6b6b' }])
  // 5000 images, half of them labelled: reading them all again takes a while
  for (let i = 1; i < 5000; i++) {
    const sub = path.join(dir, `line${i % 10}`)
    mkdirSync(sub, { recursive: true })
    writeFileSync(path.join(sub, `img_${i}.png`), '')
    if (i % 2 === 0) writeFileSync(path.join(sub, `img_${i}.json`), doc(`img_${i}`, [square('cat', 1, 1, 9, 9)]))
  }
  const { app, page, errors } = await launch(dir)
  await expect(page.locator('.topbar')).toContainText('2500/5000 labelled', { timeout: 120000 })
  await expect(page.locator('.shape')).toHaveCount(2)
  // Seamline saves the image on screen while Seamtag is in the background; back in Seamtag, a shape is deleted at once
  writeFileSync(path.join(dir, 'a.json'), doc('a', [square('dog', 200, 50, 300, 150), square('dog', 20, 20, 60, 60), square('dog', 100, 100, 150, 150)]))
  await focus(app)
  await page.waitForTimeout(400)
  await page.locator('.shape').first().click()
  await page.keyboard.press('Delete')
  await saved(page)
  await expect.poll(() => shapesIn(dir, 'a').map((s: any) => s.label)).toEqual(['dog', 'dog'])
  await expect(page.locator('.error')).toHaveCount(0)
  // Coming back again while the folder is still being read: what changed meanwhile is read once more
  await focus(app)
  await page.waitForTimeout(30)
  await sharp({ create: { width: W, height: H, channels: 3, background: '#445566' } }).png().toFile(path.join(dir, 'added.png'))
  await focus(app)
  await expect(page.locator('.file', { hasText: 'added.png' })).toHaveCount(1, { timeout: 30000 })
  await finish(app, errors)
})
