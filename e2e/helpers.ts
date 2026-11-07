import { _electron as electron, type ElectronApplication, expect, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import sharp from 'sharp'

export const W = 400, H = 300
export const BASE = process.env.E2E_DIR || path.join(tmpdir(), 'seamline-label-e2e')

export const square = (label: string, x0: number, y0: number, x1: number, y1: number, score?: number) => ({
  label, shape_type: 'polygon', group_id: null, description: '',
  points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
  flags: score === undefined ? {} : { ai: true },
  ...(score === undefined ? {} : { score })
})
export const doc = (name: string, shapes: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({
  version: '5.5.0', flags: {}, shapes, imagePath: `${name}.png`, imageData: null, imageWidth: W, imageHeight: H, ...extra
})

/** A folder of grey images, with label files where given */
export async function project(folder: string, files: Record<string, string | null>, classes?: { name: string; color: string }[]) {
  const dir = path.join(BASE, folder)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  if (classes) {
    mkdirSync(path.join(dir, '.myseg'), { recursive: true })
    writeFileSync(path.join(dir, '.myseg/project.json'), JSON.stringify({ name: folder, classes }))
  }
  for (const [name, text] of Object.entries(files)) {
    await sharp({ create: { width: W, height: H, channels: 3, background: '#445566' } }).png().toFile(path.join(dir, `${name}.png`))
    if (text !== null) writeFileSync(path.join(dir, `${name}.json`), text)
  }
  return dir
}

/**
 * The app on a folder or file, with its own home folder and profile, so a test never reads or
 * writes the settings, config or recent files of the person running it.
 */
export async function launch(target: string | null, extra: string[] = [], home?: string) {
  const own = home ?? mkdtempSync(path.join(tmpdir(), 'seamline-label-home-'))
  // A home with the folders Windows expects in one
  const roaming = path.join(own, 'AppData', 'Roaming'), local = path.join(own, 'AppData', 'Local')
  mkdirSync(roaming, { recursive: true })
  mkdirSync(local, { recursive: true })
  const headless = process.platform === 'linux' && !process.env.E2E_SHOW ? ['--ozone-platform=headless'] : []
  const app = await electron.launch({
    args: [path.resolve(__dirname, '..'), ...headless, ...(target ? [target] : []), ...extra],
    env: {
      ...process.env, HOME: own, USERPROFILE: own, APPDATA: roaming, LOCALAPPDATA: local, XDG_CONFIG_HOME: path.join(own, '.config'),
      SEAMLINE_LABEL_USER_DATA: path.join(own, 'profile')
    } as Record<string, string>
  })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.setViewportSize({ width: 1500, height: 940 }).catch(() => {})
  if (target) await expect(page.locator('.file').first()).toBeVisible()
  await page.waitForTimeout(300)
  return { app, page, errors, home: own }
}

export async function onImage(page: Page, x: number, y: number, w = W, h = H) {
  const box = (await page.getByTestId('canvas').boundingBox())!
  const scale = Math.min((box.width - 48) / w, (box.height - 48) / h)
  return [box.x + (box.width - w * scale) / 2 + x * scale, box.y + (box.height - h * scale) / 2 + y * scale] as const
}
export const click = async (page: Page, x: number, y: number, options: Parameters<Page['mouse']['click']>[2] = {}) =>
  page.mouse.click(...(await onImage(page, x, y)), options)
export async function drag(page: Page, from: number[], to: number[]) {
  await page.mouse.move(...(await onImage(page, from[0], from[1])))
  await page.mouse.down()
  await page.mouse.move(...(await onImage(page, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2)), { steps: 8 })
  await page.mouse.move(...(await onImage(page, to[0], to[1])), { steps: 8 })
  await page.mouse.up()
}
export async function open(page: Page, name: string) {
  await page.locator('.file', { hasText: name }).first().click()
  await expect(page.locator('.file.on')).toContainText(name)
  await expect(page.locator('.loading', { hasText: 'Preparing' })).toHaveCount(0, { timeout: 90000 })
  await page.waitForTimeout(150)
}
export const saved = (page: Page) => expect(page.getByTestId('save-state')).toHaveText('Saved')
export const read = (dir: string, name: string) => JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8'))
export const shapesIn = (dir: string, name: string) => read(dir, name).shapes

function inRing(p: number[], ring: number[][]) {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}
/** The label a training mask would give this pixel: later shapes win, polygons fill even-odd */
export function labelAt(shapes: any[], x: number, y: number) {
  let label = ''
  for (const s of shapes) {
    if (s.flags?.ai) continue
    const pts = s.shape_type === 'rectangle' ? [[s.points[0][0], s.points[0][1]], [s.points[1][0], s.points[0][1]], [s.points[1][0], s.points[1][1]], [s.points[0][0], s.points[1][1]]] : s.points
    if (inRing([x, y], pts)) label = s.label
  }
  return label
}

export async function finish(app: ElectronApplication, errors: string[] = []) {
  await app.close()
  expect(errors).toEqual([])
}
