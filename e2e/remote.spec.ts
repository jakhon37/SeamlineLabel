import { _electron as electron, expect, test } from '@playwright/test'
import { execFileSync } from 'child_process'
import { existsSync, readdirSync, rmSync } from 'fs'
import path from 'path'

// Needs a real GPU machine: MYSEG_E2E_SSH=user@host npm run test:e2e
const HOST = process.env.MYSEG_E2E_SSH
const REMOTE = process.env.MYSEG_E2E_DIR || 'myseg-studio'
const REPO = path.resolve(__dirname, '../..')
const DIR = (process.env.E2E_DIR || '/tmp/myseg-e2e') + '-remote'
const SHOTS = process.env.E2E_SHOTS || DIR
const launch = () =>
  electron.launch({
    args: [path.resolve(__dirname, '..')],
    env: { ...process.env, MYSEG_PROJECT: DIR } as Record<string, string>
  })

test('train on a remote GPU, survive closing the app, get the model back', async () => {
  test.skip(!HOST, 'MYSEG_E2E_SSH not set')
  test.setTimeout(900000)
  rmSync(DIR, { recursive: true, force: true })
  execFileSync(path.join(REPO, '.venv/bin/python'), [path.join(__dirname, 'make_project.py'), DIR])
  let app = await launch()
  let page = await app.firstWindow()
  await page.getByRole('tab', { name: /Train/ }).click()
  await page.getByLabel('Run on').selectOption('ssh')
  await page.getByLabel('SSH host').fill(HOST!)
  await page.getByLabel('Remote folder').fill(REMOTE)
  await page.getByRole('button', { name: 'Test connection' }).click()
  await expect(page.getByTestId('remote-status')).toContainText('GB free', { timeout: 30000 })
  await page.getByLabel('Epochs').fill('60')
  await page.getByLabel('Batch').fill('4')
  await page.getByLabel('Input size').fill('128')
  await page.getByLabel('Encoder').selectOption('resnet18')
  await page.getByLabel('Learning rate').fill('0.001')
  await page.getByLabel('Start from ImageNet weights').uncheck()
  await page.getByRole('button', { name: /Train on 10 labelled/ }).click()
  await expect(page.getByRole('button', { name: /Stop training/ })).toBeVisible({ timeout: 300000 })
  await expect(page.getByTestId('device')).toContainText(/GTX|RTX|NVIDIA|Tesla/, { timeout: 120000 })
  await page.screenshot({ path: `${SHOTS}/remote-running.png` })

  // Close the app mid-run, reopen: the run is still there and reattaches
  await app.close()
  await new Promise((r) => setTimeout(r, 5000))
  app = await launch()
  page = await app.firstWindow()
  await page.getByRole('tab', { name: /Train/ }).click()
  await expect(page.getByRole('button', { name: /Stop training/ })).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.tile', { hasText: 'Status' })).toContainText('Finished', { timeout: 600000 })
  await page.getByRole('button', { name: /Train on 10 labelled/ }).waitFor({ timeout: 60000 })
  await page.screenshot({ path: `${SHOTS}/remote-done.png` })

  // Model came back and pre-labels on this machine
  const runs = path.join(DIR, '.myseg/runs')
  const run = readdirSync(runs)[0]
  const sub = readdirSync(path.join(runs, run)).find((n) => n.startsWith('run_'))!
  expect(existsSync(path.join(runs, run, sub, 'best_model.pth'))).toBe(true)
  await page.keyboard.press('Control+1')
  await page.locator('.file', { hasText: 'disc_10.png' }).click()
  await page.getByRole('button', { name: /Pre-label/ }).click()
  await expect(page.getByRole('button', { name: /Accept/ })).toBeVisible({ timeout: 120000 })

  // Stop reaches the remote process, and nothing stays on its disk
  await page.keyboard.press('Control+2')
  await page.getByLabel('Epochs').fill('500')
  await page.getByRole('button', { name: /Train on 10 labelled/ }).click()
  await expect(page.getByRole('button', { name: /Stop training/ })).toBeVisible({ timeout: 300000 })
  await page.getByRole('button', { name: /Stop training/ }).click()
  await page.getByRole('button', { name: /Train on 10 labelled/ }).waitFor({ timeout: 60000 })
  const left = execFileSync('ssh', [HOST!, `ls -A ${REMOTE}/projects; pgrep -fc 'engine/[s]tudio.py train' || true`]).toString().trim()
  expect(left).toBe('0')
  await app.close()
})
