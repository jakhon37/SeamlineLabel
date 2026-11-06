import { ElectronApplication, expect, Page, test } from '@playwright/test'
import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import path from 'path'
import { FakeGpu, fakeGpu, launch, project, startRemote } from './fake_gpu'

// Opening another folder during a remote run once lost its events, left the app stuck on
// "training", and could put its model in the wrong folder and delete the remote copy
const BASE = process.env.E2E_SWITCH_DIR || '/tmp/myseg-e2e-switch'
const SOON = { timeout: 20000 }
const STARTED = { timeout: 60000 }
const START = { type: 'start', epochs: 9, device: 'Fake GPU' }
const DONE = { type: 'done' }
const epoch = (n: number) => ({ type: 'epoch', epoch: n, epochs: 9, train_loss: 0.5, val_loss: 0.5, iou: 0.5, f1: 0.5 })

const runDir = (dir: string, run: string) => path.join(dir, '.myseg/runs', run)
const saved = (dir: string, run: string) =>
  readFileSync(path.join(runDir(dir, run), 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const fetched = (dir: string, run: string) => JSON.parse(readFileSync(path.join(runDir(dir, run), 'remote.json'), 'utf8')).fetched
const hasModel = (dir: string, run: string) => existsSync(path.join(runDir(dir, run), 'run_1/best_model.pth'))

const stop = (page: Page) => page.getByRole('button', { name: /Stop training/ })
const train = (page: Page) => page.getByRole('button', { name: /Train on 2 labelled/ })
const status = (page: Page) => page.locator('.tile', { hasText: 'Status' })
const log = (page: Page) => page.getByTestId('log')
const pulse = (page: Page) => page.locator('.pulse')
const active = (page: Page) => page.evaluate(() => window.api.activeRun())

let app: ElectronApplication | null = null
let machine: FakeGpu | null = null
let errors: string[] = []
test.afterEach(async () => {
  // The stand-ins first: closing the app would wait for them
  machine?.release()
  spawnSync('pkill', ['-f', `engine/studio.py train ${BASE}`])
  await app?.close()
  app = null
  expect(errors).toEqual([])
})

async function setup(name: string) {
  const base = path.join(BASE, name)
  const gpu = machine = fakeGpu(base)
  const a = await project(base, 'folder-a')
  const b = await project(base, 'folder-b')
  app = await launch(gpu, base, a)
  const page = await app.firstWindow()
  errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await expect(page.locator('.topbar')).toContainText('folder-a')
  return { gpu, a, b, page }
}

// A run whose first event has reached the app
async function running(page: Page, gpu: FakeGpu, dir: string) {
  await startRemote(page)
  await expect(stop(page)).toBeVisible(STARTED)
  const run = (await active(page))!
  gpu.emit(run, START)
  await expect.poll(() => saved(dir, run), SOON).toEqual([START])
  return run
}

async function pick(page: Page, dir: string) {
  await app!.evaluate(({ dialog }, d) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [d] })) as any
  }, dir)
  await page.getByRole('button', { name: 'Open folder' }).click()
}
async function openFolder(page: Page, dir: string) {
  await pick(page, dir)
  await expect(page.locator('.topbar')).toContainText(path.basename(dir))
}

// Two polls more: the second starts only once the first is fully dealt with
async function pollsPass(gpu: FakeGpu) {
  const seen = gpu.polls()
  await expect.poll(() => gpu.polls(), SOON).toBeGreaterThanOrEqual(seen + 2)
}

async function expectHome(page: Page, gpu: FakeGpu, dir: string, run: string, events: unknown[]) {
  await expect.poll(() => existsSync(gpu.projectOf(run)), SOON).toBe(false)
  await expect(train(page)).toBeVisible()
  await expect(status(page)).toContainText('Finished')
  expect(hasModel(dir, run)).toBe(true)
  expect(fetched(dir, run)).toBe(true)
  expect(saved(dir, run)).toEqual(events)
  expect(await active(page)).toBeNull()
}

test('a run trains on while another folder is open, and is picked up again on return', async () => {
  const { gpu, a, b, page } = await setup('return')
  const run = await running(page, gpu, a)
  await expect(pulse(page)).toHaveCount(1)

  // Nothing runs in the new folder and nothing watches the run from it
  await openFolder(page, b)
  expect(await active(page)).toBeNull()
  await expect(train(page)).toBeVisible()
  await expect(pulse(page)).toHaveCount(0)
  gpu.emit(run, epoch(0))
  const polls = gpu.polls()
  await page.waitForTimeout(3500)
  expect(gpu.polls()).toBe(polls)
  await expect(log(page)).not.toContainText('Connection lost')
  expect(saved(a, run)).toEqual([START])
  expect(existsSync(path.join(b, '.myseg/runs'))).toBe(false)

  // Back in its folder it catches up, with each event once
  await openFolder(page, a)
  await expect(stop(page)).toBeVisible()
  await expect(pulse(page)).toHaveCount(1)
  await expect(status(page)).toContainText('Training')
  await expect.poll(() => saved(a, run), SOON).toEqual([START, epoch(0)])

  // Opening the folder it's already in changes nothing
  await pick(page, a)
  await page.waitForTimeout(300)
  expect(await active(page)).toBe(run)
  gpu.emit(run, epoch(1))
  await expect.poll(() => saved(a, run), SOON).toEqual([START, epoch(0), epoch(1)])
  gpu.emit(run, DONE)
  gpu.end(run)
  await expectHome(page, gpu, a, run, [START, epoch(0), epoch(1), DONE])
  await expect(pulse(page)).toHaveCount(0)
})

test('a run that ends while another folder is open waits, and its model comes back to its own folder', async () => {
  const { gpu, a, b, page } = await setup('ends-away')
  // This folder has runs of its own, so a model sent here by mistake would land
  mkdirSync(path.join(b, '.myseg/runs/older'), { recursive: true })
  const run = await running(page, gpu, a)
  await openFolder(page, b)
  gpu.emit(run, epoch(0), DONE)
  gpu.end(run)
  await expect.poll(() => gpu.hasModel(run), SOON).toBe(true)
  await page.waitForTimeout(3500)

  expect(existsSync(gpu.projectOf(run))).toBe(true)
  expect(readdirSync(path.join(b, '.myseg/runs'))).toEqual(['older'])
  expect(fetched(a, run)).toBe(false)
  expect(await active(page)).toBeNull()
  await expect(train(page)).toBeVisible()

  await openFolder(page, a)
  await expectHome(page, gpu, a, run, [START, epoch(0), DONE])
  await train(page).click()
  await expect(stop(page)).toBeVisible(STARTED)
})

test('another folder can start its own run, and each model goes to its own folder', async () => {
  const { gpu, a, b, page } = await setup('both')
  const first = await running(page, gpu, a)
  await openFolder(page, b)
  await train(page).click()
  await expect(stop(page)).toBeVisible(STARTED)
  const second = (await active(page))!
  expect(second).not.toBe(first)
  gpu.emit(second, START, epoch(0))
  await expect.poll(() => saved(b, second), SOON).toEqual([START, epoch(0)])

  // The first ends while the second is on screen, and neither notices
  gpu.emit(first, DONE)
  gpu.end(first)
  await expect.poll(() => gpu.hasModel(first), SOON).toBe(true)
  await pollsPass(gpu)
  await expect(stop(page)).toBeVisible()
  await expect(status(page)).toContainText('Training')
  expect(existsSync(gpu.projectOf(first))).toBe(true)

  await openFolder(page, a)
  await expectHome(page, gpu, a, first, [START, DONE])
  expect(readdirSync(path.join(a, '.myseg/runs'))).toEqual([first])

  await openFolder(page, b)
  await expect(stop(page)).toBeVisible()
  gpu.emit(second, DONE)
  gpu.end(second)
  await expectHome(page, gpu, b, second, [START, epoch(0), DONE])
  expect(readdirSync(path.join(b, '.myseg/runs'))).toEqual([second])
})

test('a poll on its way when the folder changes is ignored', async () => {
  const { gpu, a, b, page } = await setup('in-flight')
  const run = await running(page, gpu, a)

  // Its answer comes after the folder changed and changed back, so two polls read the same events
  gpu.hold('kill -0')
  await expect.poll(() => gpu.isHeld(), SOON).toBe(true)
  gpu.emit(run, epoch(0))
  await openFolder(page, b)
  await openFolder(page, a)
  gpu.release()
  await expect.poll(() => saved(a, run), SOON).toEqual([START, epoch(0)])
  await pollsPass(gpu)
  expect(saved(a, run)).toEqual([START, epoch(0)])

  // Its answer comes while the other folder is open: nothing is taken from it
  gpu.hold('kill -0')
  await expect.poll(() => gpu.isHeld(), SOON).toBe(true)
  gpu.emit(run, epoch(1))
  await openFolder(page, b)
  gpu.release()
  await page.waitForTimeout(500)
  expect(saved(a, run)).toEqual([START, epoch(0)])
  await expect(log(page)).not.toContainText('Connection')
  await openFolder(page, a)
  await expect.poll(() => saved(a, run), SOON).toEqual([START, epoch(0), epoch(1)])
})

test('a folder opened during the model download leaves the rest for the return', async () => {
  const { gpu, a, b, page } = await setup('download')
  const run = await running(page, gpu, a)
  gpu.hold('rsync --server')
  gpu.emit(run, DONE)
  gpu.end(run)
  await expect.poll(() => gpu.isHeld(), SOON).toBe(true)
  await openFolder(page, b)
  await expect(train(page)).toBeVisible()
  gpu.release()

  // That download still lands at home, but nothing counts as finished yet
  await expect.poll(() => hasModel(a, run), SOON).toBe(true)
  await page.waitForTimeout(500)
  expect(fetched(a, run)).toBe(false)
  expect(existsSync(gpu.projectOf(run))).toBe(true)
  await expect(log(page)).not.toContainText('Remote copy removed')
  await expect(train(page)).toBeVisible()
  expect(await active(page)).toBeNull()

  await openFolder(page, a)
  await expectHome(page, gpu, a, run, [START, DONE])
})

test('a last read on its way when the folder changes is ignored', async () => {
  const { gpu, a, b, page } = await setup('last-read')
  const run = await running(page, gpu, a)
  gpu.hold('^tail -c')
  gpu.end(run)
  await expect.poll(() => gpu.isHeld(), SOON).toBe(true)
  // Written late, so the attached job and the one before it both read it
  gpu.emit(run, DONE)
  await openFolder(page, b)
  await openFolder(page, a)
  await expect.poll(() => saved(a, run), SOON).toEqual([START, DONE])
  gpu.release()
  await expectHome(page, gpu, a, run, [START, DONE])
})

test('a folder opened as the remote copy is being removed keeps its own run', async () => {
  const { gpu, a, b, page } = await setup('removing')
  const first = await running(page, gpu, a)
  gpu.hold('rm -rf')
  gpu.emit(first, DONE)
  gpu.end(first)
  await expect.poll(() => gpu.isHeld(), SOON).toBe(true)
  await openFolder(page, b)
  await train(page).click()
  await expect(stop(page)).toBeVisible(STARTED)
  const second = await active(page)
  gpu.release()

  await expect.poll(() => existsSync(gpu.projectOf(first)), SOON).toBe(false)
  await pollsPass(gpu)
  expect(fetched(a, first)).toBe(true)
  expect(await active(page)).toBe(second)
  await expect(stop(page)).toBeVisible()
  await expect(log(page)).not.toContainText('Remote copy removed')
})

test('two folders opening at once leave only the open one\'s run attached', async () => {
  const { gpu, a, b, page } = await setup('at-once')
  const run = await running(page, gpu, a)
  await openFolder(page, b)
  for (let i = 0; i < 5; i++) {
    await page.evaluate(([x, y]) => Promise.all([window.api.openProject(x), window.api.openProject(y)]), [a, b])
    const inA = (await page.evaluate(() => window.api.listRuns())).some((r) => r.name === run)
    expect(await active(page)).toBe(inA ? run : null)
    await page.evaluate((y) => window.api.openProject(y), b)
    expect(await active(page)).toBeNull()
  }
  expect(existsSync(gpu.projectOf(run))).toBe(true)
})

test('events that can\'t be saved and a model download that fails are tried again', async () => {
  const { gpu, a, page } = await setup('retry')
  const run = await running(page, gpu, a)
  const events = path.join(runDir(a, run), 'events.jsonl')
  chmodSync(events, 0o444)
  gpu.emit(run, epoch(0))
  await expect(log(page)).toContainText('Connection lost', SOON)
  chmodSync(events, 0o644)
  await expect.poll(() => saved(a, run), SOON).toEqual([START, epoch(0)])
  await expect(log(page)).toContainText('Connection back', SOON)

  gpu.fail('rsync --server')
  gpu.emit(run, DONE)
  gpu.end(run)
  await expect(log(page)).toContainText('rsync', SOON)
  expect(existsSync(gpu.projectOf(run))).toBe(true)
  expect(await active(page)).toBe(run)
  gpu.recover()
  await expectHome(page, gpu, a, run, [START, epoch(0), DONE])
})

test('a run whose files were removed from the machine ends, and says so', async () => {
  const { gpu, a, b, page } = await setup('removed')
  const run = await running(page, gpu, a)
  await openFolder(page, b)
  gpu.remove(run)
  await openFolder(page, a)
  await expect(status(page)).toContainText('Failed', SOON)
  await expect(page.locator('.error.static')).toContainText('no longer on gpu@fake')
  await expect(train(page)).toBeVisible()
  expect(await active(page)).toBeNull()
  expect(fetched(a, run)).toBe(true)

  // It stays ended, and the folder can train again
  await openFolder(page, b)
  await openFolder(page, a)
  expect(await active(page)).toBeNull()
  expect(saved(a, run).filter((e) => e.type === 'error')).toHaveLength(1)
  await train(page).click()
  await expect(stop(page)).toBeVisible(STARTED)
})

test('a run that dies before its first event ends, and says so', async () => {
  const { gpu, a, page } = await setup('died')
  await startRemote(page)
  await expect(stop(page)).toBeVisible(STARTED)
  const run = (await active(page))!
  gpu.crash(run, 'ModuleNotFoundError: No module named torch\n')
  await expect(status(page)).toContainText('Failed', SOON)
  await expect(page.locator('.error.static')).toContainText('before it reported anything')
  await expect(log(page)).toContainText('No module named torch')
  await expect(train(page)).toBeVisible()
  expect(readFileSync(path.join(runDir(a, run), 'out.log'), 'utf8')).toContain('No module named torch')
  expect(existsSync(gpu.projectOf(run))).toBe(false)
  expect(fetched(a, run)).toBe(true)
  expect(await active(page)).toBeNull()
})

test('stopping a run before its first event isn\'t a failure', async () => {
  const { gpu, a, page } = await setup('stopped-early')
  await startRemote(page)
  await expect(stop(page)).toBeVisible(STARTED)
  const run = (await active(page))!
  await stop(page).click()
  await expect.poll(() => existsSync(gpu.projectOf(run)), SOON).toBe(false)
  await expect(train(page)).toBeVisible()
  await expect(status(page)).toContainText('Stopped')
  expect(saved(a, run)).toEqual([])
})

test('a removal whose answer got lost isn\'t taken for a lost model', async () => {
  const { gpu, a, page } = await setup('lost-answer')
  const run = await running(page, gpu, a)
  gpu.fail('rm -rf')
  gpu.emit(run, DONE)
  gpu.end(run)
  await expect(log(page)).toContainText('Connection lost', SOON)
  // As if the removal worked and only its answer went missing
  gpu.remove(run)
  gpu.recover()
  await expect(train(page)).toBeVisible(SOON)
  await expect(status(page)).toContainText('Finished')
  expect(saved(a, run)).toEqual([START, DONE])
  expect(hasModel(a, run)).toBe(true)
  expect(fetched(a, run)).toBe(true)
})

test('Stop stops the run on screen, not one started from another folder', async () => {
  const { gpu, a, b, page } = await setup('stop')
  const remote = await running(page, gpu, a)
  await openFolder(page, b)
  await page.getByLabel('Run on').selectOption('local')
  await train(page).click()
  await expect(stop(page)).toBeVisible(STARTED)
  const local = await active(page)
  expect(local).not.toBe(remote)

  await openFolder(page, a)
  await expect(stop(page)).toBeVisible()
  await expect(status(page)).toContainText('Training')
  expect(await active(page)).toBe(remote)
  await stop(page).click()
  await expect.poll(() => existsSync(gpu.projectOf(remote)), SOON).toBe(false)

  // The local run goes on, and still shows as going
  await expect.poll(() => active(page), SOON).toBe(local)
  await expect(stop(page)).toBeVisible()
  await expect(pulse(page)).toHaveCount(1)
  await stop(page).click()
  await expect(train(page)).toBeVisible(SOON)
  await expect(pulse(page)).toHaveCount(0)
  expect(await active(page)).toBeNull()
})

test('a folder can\'t open while a run is starting', async () => {
  const { gpu, a, b, page } = await setup('starting')
  gpu.hold('rsync --server')
  await startRemote(page)
  await expect.poll(() => gpu.isHeld(), STARTED).toBe(true)
  await pick(page, b)
  await expect(page.locator('.error')).toContainText('starting')
  await expect(page.locator('.topbar')).toContainText('folder-a')
  gpu.release()

  // The run goes ahead with this folder's own dataset
  await expect(stop(page)).toBeVisible(STARTED)
  const run = (await active(page))!
  expect(existsSync(runDir(a, run))).toBe(true)
  expect(JSON.parse(readFileSync(path.join(gpu.projectOf(run), '.myseg/project.json'), 'utf8')).name).toBe('folder-a')
  expect(readdirSync(path.join(b, '.myseg'))).toEqual(['project.json'])
})
