import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'

const REPO = path.resolve(__dirname, '../..')
const DIR = process.env.E2E_DIR || '/tmp/myseg-e2e'
const SHOTS = process.env.E2E_SHOTS || DIR

test('label, switch, train, pre-label', async () => {
  rmSync(DIR, { recursive: true, force: true })
  execFileSync(path.join(REPO, '.venv/bin/python'), [path.join(__dirname, 'make_project.py'), DIR])
  const app = await electron.launch({
    args: [path.resolve(__dirname, '..')],
    env: { ...process.env, MYSEG_PROJECT: DIR } as Record<string, string>
  })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewportSize({ width: 1500, height: 940 }).catch(() => {})

  // Existing LabelMe labels and classes are picked up
  await expect(page.getByText('10/13 labelled')).toBeVisible()
  await expect(page.locator('.class .name')).toHaveText(['disc'])

  // Large TIFF: time the first open (tile build) and the second (cache)
  const openMs = () =>
    page.evaluate(async () => {
      const t = performance.now()
      await window.api.openImage('zz_large.tif')
      return Math.round(performance.now() - t)
    })
  const first = await openMs()
  const second = await openMs()
  console.log(`large TIFF open: first ${first} ms, cached ${second} ms`)
  await page.locator('.file', { hasText: 'zz_large.tif' }).click()
  await expect(page.locator('.status')).toContainText('6050 × 12300')
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${SHOTS}/large-fit.png` })

  // Zoom in: sharper tiles have to load
  const canvas = page.getByTestId('canvas')
  const box = (await canvas.boundingBox())!
  // Aim at the disc's edge so both noise (detail) and the disc are in view
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.34)
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -300)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${SHOTS}/large-zoom.png` })

  // Draw a polygon on the large image; it autosaves as LabelMe JSON
  await page.keyboard.press('0')
  const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const
  await page.mouse.click(...at(0.45, 0.4))
  await page.mouse.click(...at(0.55, 0.4))
  await page.mouse.click(...at(0.55, 0.6))
  await page.mouse.click(...at(0.45, 0.6))
  await page.keyboard.press('Enter')
  await expect(page.locator('.shape')).toHaveCount(1)
  await expect(page.getByTestId('save-state')).toHaveText('Saved')
  const doc = JSON.parse(readFileSync(path.join(DIR, 'zz_large.json'), 'utf8'))
  expect(doc.shapes[0].points.length).toBe(4)
  expect(doc.imageWidth).toBe(6050)
  await page.screenshot({ path: `${SHOTS}/label.png` })

  // Undo removes it, redo restores it
  await page.keyboard.press('Control+z')
  await expect(page.locator('.shape')).toHaveCount(0)
  await page.keyboard.press('Control+Shift+z')
  await expect(page.locator('.shape')).toHaveCount(1)

  // Remove it again so the training set stays small for the test
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('save-state')).toHaveText('Saved')

  // Switch to Train with the shortcut and run real training on CPU
  await page.keyboard.press('Control+2')
  await page.getByLabel('Epochs').fill('3')
  await page.getByLabel('Batch').fill('4')
  await page.getByLabel('Input size').fill('128')
  await page.getByLabel('Encoder').selectOption('resnet18')
  await page.getByLabel('Start from ImageNet weights').uncheck()
  await page.getByRole('button', { name: /Train on 10 labelled/ }).click()
  await expect(page.locator('.tile', { hasText: 'Status' })).toContainText('Training', { timeout: 60000 })
  await expect(page.locator('.tile', { hasText: 'Epoch' })).toContainText('3 / 3', { timeout: 240000 })
  await expect(page.locator('.tile', { hasText: 'Status' })).toContainText('Finished', { timeout: 60000 })
  await page.screenshot({ path: `${SHOTS}/train.png` })

  // Switching back keeps the place; pre-label an unlabelled image
  await page.keyboard.press('Control+1')
  await expect(page.locator('.file.on')).toContainText('zz_large.tif')
  await page.locator('.file', { hasText: 'disc_10.png' }).click()
  await expect(page.locator('.status')).toContainText('320 × 240')
  await page.getByRole('button', { name: 'Pre-label', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Pre-label', exact: true })).toBeEnabled({ timeout: 120000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${SHOTS}/prelabel.png` })

  // Pre-label the rest with progress: results are saved, scored and not training data yet
  const startBatch = async () => {
    await page.getByRole('button', { name: 'Pre-label 3 images' }).click()
    await expect(page.getByRole('button', { name: /Stop ·/ })).toBeVisible()
  }
  const batchEnded = () =>
    expect(page.getByRole('button', { name: 'Pre-label 3 images' })).toBeVisible({ timeout: 240000 })
  await startBatch()
  await batchEnded()
  await expect(page.getByText('Pre-labelled 3 of 3 images.')).toBeVisible()
  const predicted = ['disc_10', 'disc_11', 'zz_large'].flatMap((n) =>
    JSON.parse(readFileSync(path.join(DIR, `${n}.json`), 'utf8')).shapes
  )
  console.log(`batch pre-label: ${predicted.length} shapes`)
  expect(predicted.length).toBeGreaterThan(0)
  for (const s of predicted) {
    expect(s.flags.ai).toBe(true)
    expect(s.score).toBeGreaterThan(0)
    expect(s.score).toBeLessThanOrEqual(1)
  }
  await expect(page.getByText('10/13 labelled')).toBeVisible()

  // A file that can't be read fails alone
  const good = readFileSync(path.join(DIR, 'disc_11.png'))
  writeFileSync(path.join(DIR, 'disc_11.png'), 'not an image')
  await startBatch()
  await batchEnded()
  await expect(page.locator('.error')).toContainText('1 image failed. First: disc_11.png')
  await page.locator('.error').click()
  writeFileSync(path.join(DIR, 'disc_11.png'), good)

  // An engine that dies is reported, not counted as finished
  await startBatch()
  await page.waitForTimeout(1000)
  execFileSync('pkill', ['-KILL', '-f', `engine/studio.py predict ${DIR}`])
  await batchEnded()
  await expect(page.locator('.error')).toContainText(/stopped/i)
  await page.locator('.error').click()

  // A label file that goes bad while pre-labelling is left as it is
  const broken = '{"shapes": ['
  writeFileSync(path.join(DIR, 'disc_10.json'), broken)
  await startBatch()
  await batchEnded()
  await expect(page.locator('.error')).toContainText('disc_10.png')
  expect(readFileSync(path.join(DIR, 'disc_10.json'), 'utf8')).toBe(broken)
  await page.locator('.error').click()
  rmSync(path.join(DIR, 'disc_10.json'))

  // Stop ends it straight away
  await page.getByRole('button', { name: 'Pre-label 3 images' }).click()
  await page.getByRole('button', { name: /Stop ·/ }).click()
  await expect(page.getByText(/Stopped after \d of 3 images/)).toBeVisible({ timeout: 30000 })
  expect(existsSync(path.join(DIR, '.myseg/runs'))).toBe(true)

  // Stop ends a run straight away and it reads as stopped, not finished
  await page.keyboard.press('Control+2')
  await page.getByLabel('Epochs').fill('500')
  await page.getByRole('button', { name: /Train on 10 labelled/ }).click()
  await expect(page.getByRole('button', { name: /Stop training/ })).toBeVisible({ timeout: 60000 })
  await page.getByRole('button', { name: /Stop training/ }).click()
  await expect(page.getByRole('button', { name: /Train on 10 labelled/ })).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.tile', { hasText: 'Status' })).toContainText('Stopped')
  await page.locator('.icon[title="Check dataset"]').click()
  await expect(page.locator('.kv')).toContainText('Train / val samples')
  await page.screenshot({ path: `${SHOTS}/train-stopped.png` })
  expect(errors).toEqual([])
  await app.close()
})
