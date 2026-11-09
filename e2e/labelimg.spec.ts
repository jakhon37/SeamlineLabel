import { type ElectronApplication, expect, type Page, test } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import path from 'path'
import sharp from 'sharp'
import { BASE, click, doc, drag, finish, launch, onImage, open, project, read, saved, shapesIn, square } from './helpers'

// LabelImg's features, checked in the files they write. tests/parity/labelimg_reads.py then
// reads the Pascal VOC, YOLO and CreateML files written here with LabelImg itself.

const FIXTURES = path.join(__dirname, '../tests/fixtures/labelimg/1.8.6')
const rect = (label: string, x0: number, y0: number, x1: number, y1: number, flags: Record<string, boolean> = {}) => ({
  label, shape_type: 'rectangle', group_id: null, description: '', points: [[x0, y0], [x1, y1]], flags
})
const text = (dir: string, file: string) => readFileSync(path.join(dir, file), 'utf8')
const appeared = (dir: string, file: string) => expect.poll(() => existsSync(path.join(dir, file))).toBe(true)

/** A trash folder of the test's own, with a list of what went in: the system's differs from one computer to the next */
async function fakeTrash(app: ElectronApplication, folder: string) {
  rmSync(folder, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  await app.evaluate(({ shell }, into) => {
    const fs = process.mainModule!.require('fs')
    const path = process.mainModule!.require('path')
    const trashed: string[] = (globalThis as any).trashed = []
    shell.trashItem = (async (file: string) => {
      fs.renameSync(file, path.join(into, `${trashed.length}-${path.basename(file)}`))
      trashed.push(file)
    }) as any
  }, folder)
  return () => app.evaluate(() => (globalThis as any).trashed as string[])
}
const chooseFormat = async (page: Page, name: string) => {
  await page.getByRole('menuitem', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: 'Save format' }).hover()
  await page.getByRole('menuitemcheckbox', { name, exact: true }).click()
}

test("LabelImg's formats: switching saves the image as LabelImg writes it, and the format follows the file opened", async () => {
  const dir = await project('labelimg', {
    v: doc('v', [rect('cat', 10.6, 12.2, 140.9, 90.5, { difficult: true }), square('dog', 200, 50, 300, 150)]),
    y: doc('y', [rect('dog', 0, 0, 120.5, 80.25)]),
    // Drawn from the bottom right
    c: doc('c', [rect('cat', 50.2, 40.7, 20.1, 5.3)]),
    n: null
  })
  const { app, page, errors } = await launch(dir, ['--labels', 'cat,dog'])
  const trashed = await fakeTrash(app, path.join(BASE, 'labelimg-trash'))
  await open(page, 'v.png')
  await expect(page.getByLabel('Save format')).toHaveValue('labelme')
  await page.getByLabel('Save format').selectOption('voc')
  await expect(page.locator('.notice')).toContainText('Pascal VOC keeps boxes only: 1 shape became a box')
  await appeared(dir, 'v.xml')
  await saved(page)
  // One image, one label file: the LabelMe one goes to the trash
  await expect(page.locator('.notice')).toContainText('Its old v.json went to the trash')
  expect(existsSync(path.join(dir, 'v.json'))).toBe(false)
  // The polygon is a box now, and the tools for other shapes are off
  await expect(page.locator('.shape', { hasText: 'dog' })).toContainText('box')
  await expect(page.getByRole('toolbar').getByRole('button', { name: 'Polygon', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Verify image' }).click()
  await expect(page.locator('.status')).toContainText('Verified')
  await expect.poll(() => text(dir, 'v.xml')).toContain('<annotation verified="yes">')
  const voc = text(dir, 'v.xml')
  expect(voc).toContain('\t\t<name>cat</name>\n\t\t<pose>Unspecified</pose>\n\t\t<truncated>0</truncated>\n\t\t<difficult>1</difficult>')
  expect(voc).toContain('<xmin>10</xmin>\n\t\t\t<ymin>12</ymin>\n\t\t\t<xmax>140</xmax>\n\t\t\t<ymax>90</ymax>')
  expect(voc).toContain(`<path>${path.join(dir, 'v.png')}</path>`)
  await expect(page.locator('.file', { hasText: 'v.png' }).getByLabel('Verified')).toBeVisible()

  // y has a LabelMe file, so it opens as LabelMe JSON; File > Save format makes it YOLO
  await open(page, 'y.png')
  await expect(page.getByLabel('Save format')).toHaveValue('labelme')
  await expect(page.locator('.status')).not.toContainText('Verified')
  await chooseFormat(page, 'YOLO')
  await appeared(dir, 'y.txt')
  await saved(page)
  expect(text(dir, 'classes.txt')).toBe('cat\ndog\n')
  expect(text(dir, 'y.txt')).toBe('1 0.151250 0.135000 0.297500 0.263333\n')
  expect(existsSync(path.join(dir, 'y.json'))).toBe(false)
  // YOLO has nowhere to keep a verified mark
  await expect(page.getByRole('button', { name: 'Verify image' })).toBeDisabled()

  // CreateML takes LabelMe's file name: the LabelMe file goes to the trash first
  await open(page, 'c.png')
  await page.getByLabel('Save format').selectOption('createml')
  await expect.poll(() => text(dir, 'c.json')).toMatch(/^\[\{"image": "c.png"/)
  await saved(page)
  expect(text(dir, 'c.json')).toBe('[{"image": "c.png", "verified": false, "annotations": [{"label": "cat", "coordinates": ' +
    '{"x": 35.150000000000006, "y": 23.000000000000004, "width": 30.1, "height": 35.400000000000006}}]}]')
  expect(await trashed()).toEqual(['v.json', 'y.json', 'c.json'].map((f) => path.join(dir, f)))
  // An image with no labels yet is saved in the format last used
  await open(page, 'n.png')
  await expect(page.getByLabel('Save format')).toHaveValue('createml')
  await page.keyboard.press('r')
  await drag(page, [40, 40], [140, 120])
  await expect.poll(() => existsSync(path.join(dir, 'n.json')) && text(dir, 'n.json')).toMatch(/"label": "cat"/)
  await saved(page)
  // Back on v, its VOC file is read again, verified, with its difficult box
  await open(page, 'v.png')
  await expect(page.getByLabel('Save format')).toHaveValue('voc')
  await expect(page.locator('.status')).toContainText('Verified')
  await expect(page.locator('.shape', { hasText: 'cat' }).locator('.tag.difficult')).toBeVisible()
  await finish(app, errors)
  // What the parity check compares with what LabelImg reads and writes
  writeFileSync(path.join(BASE, 'labelimg-expected.json'), JSON.stringify({
    'v.png': { format: 'voc', verified: true, shapes: [
      { label: 'cat', points: [[10.6, 12.2], [140.9, 90.5]], difficult: true }, { label: 'dog', points: [[200, 50], [300, 150]], difficult: false }] },
    'y.png': { format: 'yolo', shapes: [{ label: 'dog', points: [[0, 0], [120.5, 80.25]], difficult: false }] },
    'c.png': { format: 'createml', verified: false, shapes: [{ label: 'cat', points: [[50.2, 40.7], [20.1, 5.3]], difficult: false }] },
    'n.png': { format: 'createml', verified: false, labels: ['cat'] }
  }, null, 2))
})

test("LabelImg's own files open, keep their format, and save back in it", async () => {
  const cases = JSON.parse(readFileSync(path.join(FIXTURES, 'labelimg.json'), 'utf8')).filter((c: any) => c.shapes)
  const files = { voc: '.xml', yolo: '.txt', createml: '.json' }
  for (const [format, ext] of Object.entries(files)) {
    const dir = path.join(BASE, `from-labelimg-${format}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    for (const c of cases) {
      const [w, h] = c.size
      const image = sharp({ create: { width: w, height: h, channels: 3, background: '#445566' } })
      await (c.depth === 1 ? image.toColourspace('b-w') : image).png().toFile(path.join(dir, c.image))
      copyFileSync(path.join(FIXTURES, format, c.image.replace('.png', ext)), path.join(dir, c.image.replace('.png', ext)))
    }
    if (format === 'yolo') copyFileSync(path.join(FIXTURES, 'yolo/classes.txt'), path.join(dir, 'classes.txt'))
    const { app, page, errors } = await launch(dir)
    await open(page, 'cars.png')
    await expect(page.getByLabel('Save format')).toHaveValue(format)
    await expect(page.locator('.shape .name')).toHaveText(['car', 'a & <b>', '고양이', 'dog'])
    if (format === 'voc') {
      await expect(page.locator('.status')).toContainText('Verified')
      await expect(page.locator('.shape', { hasText: 'a & <b>' }).locator('.tag.difficult')).toBeVisible()
    }
    // A box moved one pixel, as LabelImg's arrow keys move it, is saved back in the same format
    const before = text(dir, `cars${ext}`)
    await page.locator('.shape', { hasText: 'car' }).first().click()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => text(dir, `cars${ext}`)).not.toBe(before)
    await saved(page)
    const after = text(dir, `cars${ext}`)
    if (format === 'voc') expect(after).toContain('<xmin>11</xmin>')
    if (format === 'yolo') expect(after.split('\n')[0]).toBe('2 0.406250 0.437500 0.468750 0.375000')
    if (format === 'createml') expect(after).toContain('{"x": 26.75, "y": 21.35, "width": 30.299999999999997, "height": 18.299999999999997}')
    expect(existsSync(path.join(dir, 'cars.json')) && format !== 'createml').toBe(false)
    await open(page, 'grey.png')
    await expect(page.locator('.shape')).toHaveCount(1)
    await finish(app, errors)
  }
})

test("LabelImg's box tools: squares with Ctrl or Draw Squares, any corner, the size, labels on boxes", async () => {
  const dir = await project('squares', { s: null })
  const { app, page, errors } = await launch(dir, ['--labels', 'cat,dog'])
  await open(page, 's.png')
  await expect(page.getByTestId('counter')).toHaveText('1 / 1')
  await page.keyboard.press('r')
  // Ctrl held while drawing, as in LabelImg
  await page.keyboard.down('ControlOrMeta')
  await drag(page, [50, 50], [150, 100])
  await page.keyboard.up('ControlOrMeta')
  await saved(page)
  let [a] = shapesIn(dir, 's')
  expect(Math.abs(a.points[1][0] - a.points[0][0])).toBeCloseTo(Math.abs(a.points[1][1] - a.points[0][1]), 5)
  // Draw Squares, from the Edit menu's key
  await page.keyboard.press('ControlOrMeta+Shift+r')
  await drag(page, [200, 50], [300, 90])
  await saved(page)
  const b = shapesIn(dir, 's')[1]
  expect(Math.abs(b.points[1][0] - b.points[0][0])).toBeCloseTo(Math.abs(b.points[1][1] - b.points[0][1]), 5)
  await page.keyboard.press('ControlOrMeta+Shift+r')
  // The top right corner of the first box, which labelme keeps no point for, moves
  await page.keyboard.press('v')
  await click(page, 75, 75)
  await expect(page.getByTestId('box-size')).toHaveText(/box 5\d × 5\d/)
  ;[a] = shapesIn(dir, 's')
  const right = Math.max(a.points[0][0], a.points[1][0]), top = Math.min(a.points[0][1], a.points[1][1])
  const left = Math.min(a.points[0][0], a.points[1][0]), bottom = Math.max(a.points[0][1], a.points[1][1])
  await drag(page, [right, top], [right + 40, top - 20])
  await saved(page)
  ;[a] = shapesIn(dir, 's')
  const xs = a.points.map((p: number[]) => p[0]).sort((m: number, n: number) => m - n)
  const ys = a.points.map((p: number[]) => p[1]).sort((m: number, n: number) => m - n)
  expect(Math.abs(xs[0] - left)).toBeLessThan(0.01)
  expect(Math.abs(ys[1] - bottom)).toBeLessThan(0.01)
  expect(Math.abs(xs[1] - (right + 40))).toBeLessThan(2)
  expect(Math.abs(ys[0] - (top - 20))).toBeLessThan(2)
  // Labels drawn on the boxes: the canvas changes where the label goes
  const shot = () => page.getByTestId('canvas').screenshot()
  await page.keyboard.press('Escape')
  const plain = await shot()
  await page.keyboard.press('ControlOrMeta+Shift+p')
  await page.getByRole('menuitem', { name: 'View' }).click()
  await expect(page.getByRole('menuitemcheckbox', { name: 'Display labels' })).toBeChecked()
  await page.keyboard.press('Escape')
  expect((await shot()).equals(plain)).toBe(false)
  // LabelImg's keys to hide and show every box, and its label panel
  const showing = async (on: boolean) => {
    await page.getByRole('menuitem', { name: 'View' }).click()
    await expect(page.getByRole('menuitemcheckbox', { name: 'Show shapes' })).toBeChecked({ checked: on })
    await page.keyboard.press('Escape')
  }
  await page.keyboard.press('ControlOrMeta+h')
  await showing(false)
  await page.keyboard.press('ControlOrMeta+a')
  await showing(true)
  await page.keyboard.press('ControlOrMeta+Shift+l')
  await expect(page.getByRole('region', { name: 'Shapes' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Labels' })).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+l')
  await expect(page.getByRole('region', { name: 'Shapes' })).toBeVisible()
  await finish(app, errors)
})

test('difficult, the label filter, single class mode, copying the previous image, opening an annotation, deleting an image', async () => {
  const dir = await project('labelimg-tools', { a: doc('a', [square('cat', 50, 50, 150, 150), square('dog', 200, 50, 300, 150)]), b: null, c: null })
  const { app, page, errors } = await launch(dir)
  const trashed = await fakeTrash(app, path.join(BASE, 'labelimg-tools-trash'))
  await open(page, 'a.png')
  await page.locator('.shape', { hasText: 'cat' }).click()
  await page.getByRole('region', { name: 'Shapes' }).getByLabel('Difficult').check()
  await saved(page)
  expect(shapesIn(dir, 'a')[0].flags).toEqual({ difficult: true })
  await expect(page.locator('.shape', { hasText: 'cat' }).locator('.tag.difficult')).toBeVisible()
  // Only one label's shapes show
  await page.getByLabel('Show shapes of').selectOption('dog')
  await expect(page.locator('.shape.off')).toHaveText(/cat/)
  await page.getByLabel('Show shapes of').selectOption('')
  await expect(page.locator('.shape.off')).toHaveCount(0)

  // b takes a's shapes
  await open(page, 'b.png')
  await page.getByRole('menuitem', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: "Copy previous image's shapes" }).click()
  // It reads a's file first, so the shapes arrive a moment after the click
  await expect(page.locator('.shape')).toHaveCount(2)
  await saved(page)
  await expect.poll(() => existsSync(path.join(dir, 'b.json')) && shapesIn(dir, 'b').map((s: any) => s.label)).toEqual(['cat', 'dog'])
  expect(shapesIn(dir, 'b')[0].flags).toEqual({ difficult: true })

  // Single class mode is on: the label picked is used. Off, each new shape asks.
  await page.getByRole('menuitem', { name: 'View' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Single class mode' }).click()
  await page.keyboard.press('r')
  await drag(page, [300, 200], [350, 250])
  await expect(page.getByRole('dialog', { name: 'Label' })).toBeVisible()
  await page.keyboard.press('Escape')

  // LabelImg's own VOC file, onto c
  await open(page, 'c.png')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as any
  }, path.join(FIXTURES, 'voc/cars.xml'))
  await page.keyboard.press('ControlOrMeta+Shift+o')
  await expect(page.locator('.shape')).toHaveCount(4)
  await saved(page)
  expect(shapesIn(dir, 'c').map((s: any) => s.label)).toEqual(['car', 'a & <b>', '고양이', 'dog'])
  expect(shapesIn(dir, 'c')[1].flags).toEqual({ difficult: true })

  // Delete image: asked first, then the image and, after it, its label file go to the trash
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as any
  })
  await page.keyboard.press('ControlOrMeta+Shift+Delete')
  await expect(page.locator('.file')).toHaveCount(2)
  await expect(page.locator('.file.on')).toContainText('b.png')
  expect(await trashed()).toEqual([path.join(dir, 'c.png'), path.join(dir, 'c.json')])
  expect(existsSync(path.join(dir, 'c.png'))).toBe(false)
  await finish(app, errors)
})

test('a tap of Space verifies, as in LabelImg, and Space+drag still pans', async () => {
  const dir = await project('verify', { q: doc('q', [square('cat', 50, 50, 150, 150)]) })
  const { app, page, errors } = await launch(dir)
  await open(page, 'q.png')
  await page.getByTestId('canvas').focus()
  await page.keyboard.press('Space')
  await expect(page.locator('.status')).toContainText('Verified')
  await expect.poll(() => read(dir, 'q').verified).toBe(true)
  // LabelMe keeps it at the top of the file, where labelme 5 and 7 leave keys they don't know
  expect(Object.keys(read(dir, 'q')).at(-1)).toBe('verified')
  await page.mouse.move(...await onImage(page, 200, 150))
  await page.keyboard.down('Space')
  await page.mouse.down()
  await page.mouse.move(...await onImage(page, 260, 190), { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up('Space')
  await page.waitForTimeout(500)
  await expect(page.locator('.status')).toContainText('Verified')
  // Held a while with no drag, Space was meant for panning, so nothing changes either
  await page.keyboard.down('Space')
  await page.waitForTimeout(800)
  await page.keyboard.up('Space')
  await page.waitForTimeout(300)
  await expect(page.locator('.status')).toContainText('Verified')
  await page.keyboard.press('Space')
  await expect(page.locator('.status')).not.toContainText('Verified')
  await expect.poll(() => read(dir, 'q').verified).toBeUndefined()
  // Verified again, the file labelme's check in CI reads
  await page.keyboard.press('Space')
  await expect.poll(() => read(dir, 'q').verified).toBe(true)
  await finish(app, errors)
})

test("LabelImg's beginner mode, its colours, and its right drag to copy or move", async () => {
  const dir = await project('labelimg-more', { m: doc('m', [square('cat', 50, 50, 150, 150)]) })
  const { app, page, errors } = await launch(dir, ['--labels', 'cat,dog'])
  await open(page, 'm.png')
  // Advanced mode off: one box, then back to editing
  await page.getByRole('menuitem', { name: 'View' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Advanced mode' }).click()
  await page.keyboard.press('r')
  await drag(page, [200, 50], [300, 120])
  await saved(page)
  await expect(page.getByRole('toolbar').getByRole('button', { name: 'Edit', exact: true })).toHaveClass(/on/)
  expect(shapesIn(dir, 'm')).toHaveLength(2)

  // A shape's own colours, kept in the file as labelme 3 and 4 kept them
  const pick = async (item: string, colour: string) => {
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await page.getByRole('menuitem', { name: `${item}…` }).click()
    const dialog = page.getByRole('dialog', { name: item })
    await dialog.getByLabel('Colour').fill(colour)
    await dialog.getByRole('button', { name: 'OK' }).click()
  }
  await page.locator('.shape').first().click()
  await pick('Shape line colour', '#ff0000')
  await pick('Shape fill colour', '#0000ff')
  await saved(page)
  expect(shapesIn(dir, 'm')[0]).toMatchObject({ line_color: [255, 0, 0, 255], fill_color: [0, 0, 255, 255] })
  // The colour a box is drawn in, from LabelImg's Ctrl+L
  await page.keyboard.press('ControlOrMeta+l')
  await page.getByRole('dialog', { name: 'Box line colour' }).getByLabel('Colour').fill('#00ffff')
  await page.getByRole('dialog', { name: 'Box line colour' }).getByRole('button', { name: 'OK' }).click()
  await page.keyboard.press('ControlOrMeta+l')
  await expect(page.getByRole('dialog', { name: 'Box line colour' }).getByLabel('Colour')).toHaveValue('#00ffff')
  await page.getByRole('dialog', { name: 'Box line colour' }).getByRole('button', { name: 'Cancel' }).click()

  // A right drag on a shape carries a copy: Copy here, then Move here
  const rightDrag = async (from: number[], to: number[]) => {
    await page.mouse.move(...await onImage(page, from[0], from[1]))
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(...await onImage(page, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2), { steps: 4 })
    await page.mouse.move(...await onImage(page, to[0], to[1]), { steps: 4 })
    await page.mouse.up({ button: 'right' })
  }
  await rightDrag([100, 100], [140, 120])
  await page.getByRole('menuitem', { name: 'Copy here' }).click()
  await saved(page)
  let shapes = shapesIn(dir, 'm')
  expect(shapes).toHaveLength(3)
  const near = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 2
  expect(near(shapes[2].points[0], [90, 70])).toBe(true)
  expect(near(shapes[0].points[0], [50, 50])).toBe(true)
  await rightDrag([180, 160], [200, 160])
  await page.getByRole('menuitem', { name: 'Move here' }).click()
  await saved(page)
  shapes = shapesIn(dir, 'm')
  expect(shapes).toHaveLength(3)
  expect(near(shapes[2].points[0], [110, 70])).toBe(true)
  // Let go anywhere else and nothing changes; a right click with no drag opens the menu
  await rightDrag([100, 100], [120, 100])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menuitem', { name: 'Copy here' })).toHaveCount(0)
  await page.mouse.click(...await onImage(page, 100, 100), { button: 'right' })
  await expect(page.locator('.context')).toContainText('Edit label…')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  expect(shapesIn(dir, 'm')).toHaveLength(3)

  // LabelImg's Reset All: what the window keeps is forgotten, and the app starts again
  expect(await page.evaluate(() => localStorage.getItem('seamtag:settings'))).toContain('"advanced":false')
  await app.evaluate(({ app: electron, dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as any
    ;(globalThis as any).restarted = false
    electron.relaunch = (() => { (globalThis as any).restarted = true }) as any
    electron.exit = (() => {}) as any
  })
  await page.getByRole('menuitem', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: 'Reset settings…' }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as any).restarted)).toBe(true)
  expect(await page.evaluate(() => localStorage.getItem('seamtag:settings'))).toBeNull()
  await finish(app, errors)
})

test('switching to a format the image already has labels in opens them, and writes over nothing', async () => {
  const dir = await project('both', { b: doc('b', [square('cat', 20, 20, 120, 90)]) })
  writeFileSync(path.join(dir, 'b.xml'), '<annotation><object><name>dog</name><bndbox><xmin>200</xmin><ymin>50</ymin><xmax>300</xmax><ymax>150</ymax></bndbox></object></annotation>')
  const before = [text(dir, 'b.json'), text(dir, 'b.xml')]
  const { app, page, errors } = await launch(dir, ['--config', '{label_format: voc}'])
  await open(page, 'b.png')
  await expect(page.locator('.shape .name')).toHaveText(['dog'])
  await page.getByLabel('Save format').selectOption('labelme')
  await expect(page.locator('.notice')).toContainText('has LabelMe JSON labels already')
  await expect(page.locator('.shape .name')).toHaveText(['cat'])
  await expect(page.getByLabel('Save format')).toHaveValue('labelme')
  await page.waitForTimeout(700)
  expect([text(dir, 'b.json'), text(dir, 'b.xml')]).toEqual(before)
  await finish(app, errors)
})

test('one CreateML file for the whole folder, with -O', async () => {
  const dir = await project('createml-one', { a: null, b: null, c: null })
  const out = path.join(BASE, 'createml-one-labels', 'labels.json')
  rmSync(path.dirname(out), { recursive: true, force: true })
  let { app, page, errors } = await launch(dir, ['-O', out, '--labels', 'cat', '--config', '{label_format: createml}'])
  for (const name of ['a.png', 'b.png']) {
    await open(page, name)
    await page.keyboard.press('r')
    await drag(page, [50, 50], [150, 120])
    await saved(page)
  }
  const list = JSON.parse(readFileSync(out, 'utf8'))
  expect(list.map((e: any) => [e.image, e.annotations.length])).toEqual([['a.png', 1], ['b.png', 1]])
  await finish(app, errors)
  ;({ app, page, errors } = await launch(dir, ['-O', out]))
  // Only the images it lists count as labelled, and each opens with its own box
  await expect(page.locator('.file .dot.done')).toHaveCount(2)
  await open(page, 'b.png')
  await expect(page.locator('.shape')).toHaveCount(1)
  await expect(page.getByLabel('Save format')).toHaveValue('createml')
  await open(page, 'c.png')
  await expect(page.locator('.shape')).toHaveCount(0)
  await finish(app, errors)
})

test("LabelImg's command line: a folder, a file of classes, a folder for labels", async () => {
  const dir = await project('labelimg-cli', { p: null })
  const out = path.join(BASE, 'labelimg-cli-out')
  rmSync(out, { recursive: true, force: true })
  const classes = path.join(BASE, 'predefined_classes.txt')
  writeFileSync(classes, 'dog\nperson\ncat\n')
  const { app, page, errors } = await launch(dir, [classes, out])
  await open(page, 'p.png')
  await expect(page.getByRole('region', { name: 'Labels' }).locator('.class .name')).toHaveText(['dog', 'person', 'cat'])
  await page.keyboard.press('r')
  await drag(page, [50, 50], [150, 150])
  await expect.poll(() => existsSync(path.join(out, 'p.json'))).toBe(true)
  expect(existsSync(path.join(dir, 'p.json'))).toBe(false)
  await finish(app, errors)
})
