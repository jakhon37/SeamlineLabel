import { ChildProcess, execFile, spawn } from 'child_process'
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from 'electron'
import { existsSync, promises as fs } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import sharp from 'sharp'
import { summarize } from '../shared/labels'

const REPO = path.resolve(__dirname, '../../..')
const PYTHON = process.env.MYSEG_PYTHON || path.join(REPO, '.venv/bin/python')
const ENGINE = path.join(REPO, 'engine/studio.py')
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff'])
const PALETTE = ['#4f8cff', '#ff6b6b', '#3ecf8e', '#f7b731', '#b57bff', '#22c7d6', '#ff8f4d', '#ec6fb3']
const TILE = 512
const DIRECT_MAX = 4096
sharp.cache(false)

let root = ''
let win: BrowserWindow | null = null
let job: { proc: ChildProcess; run: string; offset: number; timer: NodeJS.Timeout } | null = null
type RemoteInfo = { host: string; dir: string; project: string; pid: number; fetched: boolean }
let remoteJob: { run: string; info: RemoteInfo; events: number; log: number; timer: NodeJS.Timeout; polling: boolean; lost: boolean } | null = null
let launching = false
type PrelabelJob = { proc: ChildProcess; stopped: boolean }
let prelabelJob: PrelabelJob | null = null
// Label files are read, changed and written back: one at a time, or a pre-label could undo a save
let writes: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>) {
  const result = writes.then(fn)
  writes = result.catch(() => {})
  return result
}

const SSH_OPTS = [
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${path.join(tmpdir(), 'myseg-ssh-%C')}`, '-o', 'ControlPersist=60'
]
// Room left on the remote disk for the environment, checkpoints and logs
const REMOTE_RESERVE_KB = 3 * 1024 * 1024
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

protocol.registerSchemesAsPrivileged([
  { scheme: 'myseg', privileges: { standard: true, supportFetchAPI: true, stream: true, secure: true } }
])

const meta = (...p: string[]) => path.join(root, '.myseg', ...p)
const sidecar = (name: string, base = root) => path.join(base, name.replace(/\.[^.]+$/, '') + '.json')

// A window can still be saving to the last folder as the next one opens, so each
// save names its folder. Only folders opened in this run are accepted.
const opened = new Set<string>()
function labelFile(base: string, name: string) {
  const full = path.resolve(base, name)
  if (!opened.has(base) || !full.startsWith(base + path.sep)) throw new Error('Path outside project')
  return sidecar(name, base)
}

// Image names come from the renderer: never let one leave the project folder
function inProject(name: string): string {
  const full = path.resolve(root, name)
  if (!root || !full.startsWith(root + path.sep)) throw new Error('Path outside project')
  return full
}

async function readJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

// No file means no labels yet. A file we can't read is someone's labels, so this throws
// rather than let anyone write over it.
async function readLabels(file: string): Promise<any | null> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (e: any) {
    if (e.code === 'ENOENT') return null
    throw new Error(`${path.basename(file)} can't be read (${e.code}), so it's left unchanged.`)
  }
  let doc: any = null
  try {
    doc = JSON.parse(text)
  } catch {
    // Reported below with the other bad files
  }
  const shapes = doc?.shapes ?? []
  const valid = doc && typeof doc === 'object' && !Array.isArray(doc) &&
    Array.isArray(shapes) && shapes.every((s: any) => Array.isArray(s?.points))
  if (!valid) throw new Error(`${path.basename(file)} isn't a readable label file, so it's left unchanged.`)
  return doc
}

async function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, text)
  await fs.rename(tmp, file)
}

async function openProject(dir: string) {
  // The slow reading comes first: the open folder only changes once it's done
  const base = path.resolve(dir)
  const names = (await fs.readdir(base))
    .filter((n) => IMAGE_EXTS.has(path.extname(n).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const read = await Promise.all(names.map((n) =>
    readLabels(sidecar(n, base)).then((doc) => ({ doc, broken: false }), () => ({ doc: null, broken: true }))
  ))
  const images = names.map((name, i) => ({
    name, ...summarize(read[i].doc?.shapes ?? []), broken: read[i].broken
  }))
  stopPrelabel()
  prelabelJob = null
  root = base
  opened.add(base)
  await fs.mkdir(meta(), { recursive: true })
  await resumeRemote()
  let project = await readJson(meta('project.json'))
  if (!project) {
    // Existing LabelMe folders open with their classes already in place
    const labels = new Set<string>()
    read.forEach(({ doc }) => doc?.shapes?.forEach((s: any) => s.label && labels.add(s.label)))
    const classes = labels.size ? [...labels].sort() : ['object']
    project = {
      name: path.basename(root),
      classes: classes.map((name, i) => ({ name, color: PALETTE[i % PALETTE.length] }))
    }
    await writeAtomic(meta('project.json'), JSON.stringify(project, null, 2))
  }
  return { root, project, images }
}

async function openImage(name: string) {
  const file = inProject(name)
  const stat = await fs.stat(file)
  const started = Date.now()
  const info = await sharp(file, { limitInputPixels: false }).metadata()
  // EXIF orientations 5-8 swap the sides, and the browser shows photos upright
  const swapped = (info.orientation ?? 1) >= 5
  const width = swapped ? info.height! : info.width!
  const height = swapped ? info.width! : info.height!
  const browserReadable = ['jpeg', 'png'].includes(info.format ?? '')
  if (browserReadable && Math.max(width, height) <= DIRECT_MAX) {
    return { width, height, file, pyramid: null, ms: Date.now() - started }
  }
  // Large or TIFF/BMP: build a tile pyramid once and reuse it until the file changes
  const key = `${name.replace(/[^\w.-]/g, '_')}-${stat.size}-${Math.floor(stat.mtimeMs)}`
  const dir = meta('cache', key)
  if (!existsSync(path.join(dir, 'done'))) {
    await fs.rm(dir, { recursive: true, force: true })
    await fs.mkdir(dir, { recursive: true })
    await sharp(file, { limitInputPixels: false })
      .rotate()
      .toColourspace('srgb')
      .jpeg({ quality: 92 })
      .tile({ size: TILE, overlap: 0, layout: 'dz' })
      .toFile(path.join(dir, 't'))
    await fs.writeFile(path.join(dir, 'done'), '')
  }
  const maxLevel = Math.ceil(Math.log2(Math.max(width, height)))
  return {
    width, height, file, ms: Date.now() - started,
    pyramid: { dir: path.join(dir, 't_files'), maxLevel, tile: TILE }
  }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim().split('\n').pop() || err.message))
      else resolve(stdout)
    })
  })
}
const ssh = (host: string, command: string) => run('ssh', [...SSH_OPTS, host, command])
const rsync = (...args: string[]) => run('rsync', ['-a', '-e', ['ssh', ...SSH_OPTS].join(' '), ...args])

async function checkRemote(host: string, dir: string) {
  const out = await ssh(host, `mkdir -p ${dir} && cd ${dir} && df -Pk . | tail -1 | awk '{print $4}'; ` +
    `nvidia-smi --query-gpu=name,memory.free,memory.total --format=csv,noheader 2>/dev/null | head -1; ` +
    `nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null | wc -l; ` +
    `python3 -c 'import torch;print(torch.__version__, torch.cuda.is_available())' 2>&1 | tail -1`)
  const [free, gpu, jobs, torch] = out.trim().split('\n')
  return { freeKb: Number(free), gpu: gpu ?? '', gpuJobs: Number(jobs), torch: torch ?? '' }
}

async function startRemote(options: any, target: { host: string; dir: string }) {
  const { host, dir } = target
  const log = (line: string) => send('train:log', line + '\n')
  log(`Checking ${host}…`)
  const remote = await checkRemote(host, dir)
  if (!/ True$/.test(remote.torch)) throw new Error(`No GPU PyTorch on ${host}: ${remote.torch}`)
  if (remote.gpuJobs > 0) throw new Error(`The GPU on ${host} is busy with ${remote.gpuJobs} other job(s).`)

  log('Preparing dataset…')
  await engine(['prepare', root, '--val-split', String(options.val_split), '--tile', String(options.tile)])
  const sizeKb = Number((await run('du', ['-sk', meta('dataset')])).split('\t')[0])
  if (remote.freeKb < sizeKb + REMOTE_RESERVE_KB) {
    const gb = (kb: number) => (kb / 1048576).toFixed(1)
    throw new Error(`Not enough disk on ${host}: ${gb(remote.freeKb)} GB free, need ${gb(sizeKb + REMOTE_RESERVE_KB)} GB.`)
  }

  const name = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)
  const project = `${dir}/projects/${name}`
  log('Sending code…')
  await ssh(host, `mkdir -p ${dir}/code`)
  await rsync('--delete', '--exclude=__pycache__', ...['engine', 'scripts', 'src', 'configs'].map((d) => path.join(REPO, d)), `${host}:${dir}/code/`)
  log('Setting up the environment if needed…')
  await ssh(host, `cd ${dir} && python3 code/engine/remote_setup.py venv`)
  await ssh(host, `mkdir -p ${project}/.myseg/runs/${name}`)
  log(`Uploading dataset (${(sizeKb / 1024).toFixed(0)} MB)…`)
  await rsync(meta('dataset'), meta('project.json'), `${host}:${project}/.myseg/`)

  const runDir = meta('runs', name)
  await fs.mkdir(runDir, { recursive: true })
  await fs.writeFile(path.join(runDir, 'options.json'), JSON.stringify({ ...options, target }, null, 2))
  await fs.writeFile(path.join(runDir, 'events.jsonl'), '')
  const absolute = (await ssh(host, `cd ${project} && pwd`)).trim()
  const remoteRun = `.myseg/runs/${name}`
  const pid = Number((await ssh(host,
    `cd ${dir}/code && { setsid nohup ../venv/bin/python -u engine/studio.py train ${quote(absolute)} ` +
    `--options ${quote(JSON.stringify(options))} --prepared --run ${name} ` +
    `> ${quote(absolute)}/${remoteRun}/out.log 2>&1 < /dev/null & echo $!; }`)).trim())
  const info: RemoteInfo = { host, dir, project, pid, fetched: false }
  await fs.writeFile(path.join(runDir, 'remote.json'), JSON.stringify(info))
  attachRemote(name, info)
  return name
}

function attachRemote(name: string, info: RemoteInfo, events = 0) {
  remoteJob = { run: name, info, events, log: 0, polling: false, lost: false, timer: setInterval(pollRemote, 3000) }
  pollRemote()
}

async function pollRemote() {
  const j = remoteJob
  if (!j || j.polling) return
  j.polling = true
  const { host, project, pid } = j.info
  const dirOf = `${project}/.myseg/runs/${j.run}`
  try {
    const out = await ssh(host, `cd ${dirOf} 2>/dev/null; kill -0 ${pid} 2>/dev/null && S=alive || S=dead; ` +
      `tail -c +${j.events + 1} events.jsonl 2>/dev/null; echo @@SEP; tail -c +${j.log + 1} out.log 2>/dev/null; echo @@SEP; echo $S`)
    if (j.lost) send('train:log', 'Connection back.\n')
    j.lost = false
    const [eventText, logText, state] = out.split('@@SEP\n')
    const end = eventText.lastIndexOf('\n')
    if (end >= 0) {
      const chunk = eventText.slice(0, end + 1)
      j.events += Buffer.byteLength(chunk)
      await fs.appendFile(meta('runs', j.run, 'events.jsonl'), chunk)
      send('train:events', { run: j.run, events: chunk.trim().split('\n').map((l) => JSON.parse(l)) })
    }
    if (logText) {
      j.log += Buffer.byteLength(logText)
      send('train:log', logText)
    }
    if (state.trim() === 'dead') await finishRemote(j)
  } catch (e: any) {
    // Training goes on without us; keep trying until the box answers again
    if (!j.lost) send('train:log', `Connection lost, training continues on ${host}. Retrying… (${e.message})\n`)
    j.lost = true
  } finally {
    j.polling = false
  }
}

async function finishRemote(j: NonNullable<typeof remoteJob>) {
  clearInterval(j.timer)
  const { host, project } = j.info
  const local = meta('runs', j.run)
  // One read after the process ended, so the last events aren't lost
  const rest = await ssh(host, `tail -c +${j.events + 1} ${project}/.myseg/runs/${j.run}/events.jsonl 2>/dev/null`)
  if (rest.trim()) {
    await fs.appendFile(path.join(local, 'events.jsonl'), rest)
    send('train:events', { run: j.run, events: rest.trim().split('\n').map((l) => JSON.parse(l)) })
  }
  send('train:log', 'Bringing the model back…\n')
  await rsync('--exclude=checkpoint_*', '--exclude=events.jsonl', '--exclude=options.json',
    `${host}:${project}/.myseg/runs/${j.run}/`, `${local}/`)
  await fs.writeFile(path.join(local, 'remote.json'), JSON.stringify({ ...j.info, fetched: true }))
  // The run is safe here now; its copy on the remote disk isn't needed
  await ssh(host, `rm -rf ${quote(project)}`)
  send('train:log', 'Remote copy removed.\n')
  remoteJob = null
  send('train:exit', { run: j.run, code: 0 })
}

// A run can outlive the app: pick it up again when its project opens
async function resumeRemote() {
  if (remoteJob) return
  const dir = meta('runs')
  if (!existsSync(dir)) return
  for (const name of await fs.readdir(dir)) {
    const info: RemoteInfo | null = await readJson(path.join(dir, name, 'remote.json'))
    if (info && !info.fetched) {
      const seen = await fs.stat(path.join(dir, name, 'events.jsonl')).then((s) => s.size).catch(() => 0)
      attachRemote(name, info, seen)
      return
    }
  }
}

function engine(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [ENGINE, ...args], { cwd: REPO, maxBuffer: 1 << 28 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim().split('\n').pop() || err.message))
      else resolve(JSON.parse(stdout.trim().split('\n').pop()!))
    })
  })
}

async function listRuns() {
  const dir = meta('runs')
  const names = existsSync(dir) ? (await fs.readdir(dir)).sort().reverse() : []
  return Promise.all(
    names.map(async (name) => {
      const raw = await fs.readFile(path.join(dir, name, 'events.jsonl'), 'utf8').catch(() => '')
      const events = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      return {
        name, events,
        options: await readJson(path.join(dir, name, 'options.json')),
        running: job?.run === name || remoteJob?.run === name
      }
    })
  )
}

function send(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

async function launch(options: any, target: { host: string; dir: string } | null) {
  if (job || remoteJob || launching) throw new Error('A training run is already active')
  launching = true
  try {
    return await (target ? startRemote(options, target) : startTraining(options))
  } finally {
    launching = false
  }
}

function startTraining(options: unknown) {
  const proc = spawn(PYTHON, [ENGINE, 'train', root, '--options', JSON.stringify(options)], {
    cwd: REPO, detached: true, env: { ...process.env, PYTHONUNBUFFERED: '1' }
  })
  return new Promise<string>((resolve, reject) => {
    let pending = ''
    const onLog = (chunk: Buffer) => {
      const text = chunk.toString()
      send('train:log', text)
      if (job) return
      pending += text
      const found = pending.match(/\{"run": "([^"]+)"\}/)
      if (!found) return
      const current = { proc, run: found[1], offset: 0, timer: setInterval(pollEvents, 1000) }
      job = current
      resolve(found[1])
    }
    proc.stdout!.on('data', onLog)
    proc.stderr!.on('data', onLog)
    proc.on('error', reject)
    proc.on('exit', async (code) => {
      if (!job) return reject(new Error(pending.trim().split('\n').pop() || `Engine exited with ${code}`))
      await pollEvents()
      clearInterval(job.timer)
      const run = job.run
      job = null
      send('train:exit', { run, code })
    })
  })
}

async function pollEvents() {
  if (!job) return
  const raw = await fs.readFile(meta('runs', job.run, 'events.jsonl'), 'utf8').catch(() => '')
  const fresh = raw.slice(job.offset)
  const end = fresh.lastIndexOf('\n')
  if (end < 0) return
  job.offset += end + 1
  const events = fresh.slice(0, end).split('\n').map((l) => JSON.parse(l))
  send('train:events', { run: job.run, events })
}

function stopLocal() {
  if (job?.proc.pid) process.kill(-job.proc.pid, 'SIGTERM')
}

async function stopTraining() {
  stopLocal()
  if (remoteJob) await ssh(remoteJob.info.host, `kill -TERM -${remoteJob.info.pid}`)
}

async function writeLabels(file: string, name: string, shapes: any[], size: number[]) {
  // LabelMe format, so LabelMeV2 opens the same files
  const doc = (await readLabels(file)) ?? { version: '5.5.0', flags: {} }
  Object.assign(doc, {
    shapes, imagePath: name, imageData: null, imageWidth: size[0], imageHeight: size[1]
  })
  await writeAtomic(file, JSON.stringify(doc, null, 2))
}

async function predictOne(runName: string, images: string[]) {
  const lines = (await run(PYTHON, [ENGINE, 'predict', root, '--run', runName, '--images', ...images])).trim().split('\n')
  const results: Record<string, any[]> = {}
  let device = ''
  for (const line of lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l))) {
    if (line.device) device = line.device
    if (line.error) throw new Error(line.error)
    if (line.name) results[line.name] = line.shapes
  }
  return { device, results }
}

// Saves as it goes, so stopping keeps what's done. Images someone has labelled are left alone.
function prelabelAll(runName: string, names: string[]) {
  if (prelabelJob) throw new Error('Pre-labelling is already running')
  names.forEach(inProject)
  const base = root
  const proc = spawn(PYTHON, [ENGINE, 'predict', root, '--run', runName], {
    cwd: REPO, detached: true, env: { ...process.env, PYTHONUNBUFFERED: '1' }
  })
  const current: PrelabelJob = { proc, stopped: false }
  prelabelJob = current
  const failed: string[] = []
  let done = 0, pending = '', errors = ''
  let queue = Promise.resolve()

  const onResult = async (r: { name: string; shapes?: any[]; size?: number[]; error?: string }) => {
    if (prelabelJob !== current) return
    let shapes: any[] | null = null
    if (r.error) {
      failed.push(`${r.name}: ${r.error}`)
    } else {
      shapes = await serial(async () => {
        const file = sidecar(r.name, base)
        const existing: any[] = (await readLabels(file))?.shapes ?? []
        if (existing.some((s) => !s.flags?.ai)) return null
        if (r.shapes!.length || existing.length) await writeLabels(file, r.name, r.shapes!, r.size!)
        return r.shapes!
      }).catch((e) => {
        failed.push(`${r.name}: ${e.message}`)
        return null
      })
    }
    done++
    send('prelabel:progress', { name: r.name, shapes, done, total: names.length })
  }

  return new Promise<{ done: number; total: number; stopped: boolean; failed: string[]; error?: string }>((resolve, reject) => {
    proc.stdout!.on('data', (chunk: Buffer) => {
      pending += chunk.toString()
      const lines = pending.split('\n')
      pending = lines.pop()!
      for (const line of lines) {
        if (line.startsWith('{"name"')) queue = queue.then(() => onResult(JSON.parse(line)))
      }
    })
    proc.stderr!.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-2000) })
    proc.stdin!.on('error', () => {})
    proc.on('error', (e) => {
      if (prelabelJob === current) prelabelJob = null
      reject(e)
    })
    proc.on('close', async (code, signal) => {
      await queue
      if (prelabelJob === current) prelabelJob = null
      const crashed = code !== 0 && !current.stopped
      const reason = errors.trim().split('\n').pop()
      const error = crashed ? `Engine stopped (${signal ?? code})${reason ? `: ${reason}` : ''}` : undefined
      if (crashed && !done) reject(new Error(error))
      else resolve({ done, total: names.length, stopped: current.stopped || crashed, failed, error })
    })
    proc.stdin!.end(JSON.stringify(names))
  })
}

function stopPrelabel() {
  if (!prelabelJob?.proc.pid) return
  prelabelJob.stopped = true
  try {
    process.kill(-prelabelJob.proc.pid, 'SIGTERM')
  } catch {
    // Already gone
  }
}

function registerIpc() {
  ipcMain.handle('project:pick', async () => {
    const result = await dialog.showOpenDialog(win!, {
      title: 'Open image folder', properties: ['openDirectory']
    })
    return result.canceled ? null : openProject(result.filePaths[0])
  })
  ipcMain.handle('project:open', (_e, dir: string) => openProject(dir))
  ipcMain.handle('project:save', (_e, project) =>
    writeAtomic(meta('project.json'), JSON.stringify(project, null, 2))
  )
  ipcMain.handle('image:open', (_e, name: string) => openImage(name))
  // Through the same queue as saves, so a load always sees the save sent before it
  ipcMain.handle('labels:load', (_e, base: string, name: string) => {
    const file = labelFile(base, name)
    return serial(async () => (await readLabels(file))?.shapes ?? [])
  })
  ipcMain.handle('labels:save', (_e, base: string, name: string, shapes: any[], size: number[]) => {
    const file = labelFile(base, name)
    return serial(() => writeLabels(file, name, shapes, size))
  })
  ipcMain.handle('runs:list', listRuns)
  ipcMain.handle('train:start', (_e, options, target) => launch(options, target))
  ipcMain.handle('remote:check', (_e, host: string, dir: string) => checkRemote(host, dir))
  ipcMain.handle('train:stop', stopTraining)
  ipcMain.handle('train:active', () => job?.run ?? remoteJob?.run ?? null)
  ipcMain.handle('dataset:check', (_e, val: number, tile: number) =>
    engine(['prepare', root, '--val-split', String(val), '--tile', String(tile)])
  )
  ipcMain.handle('model:predict', (_e, runName: string, images: string[]) => predictOne(runName, images))
  ipcMain.handle('prelabel:start', (_e, runName: string, names: string[]) => prelabelAll(runName, names))
  ipcMain.handle('prelabel:stop', stopPrelabel)
}

app.whenReady().then(() => {
  protocol.handle('myseg', (request) => {
    const file = path.resolve(decodeURIComponent(new URL(request.url).pathname.slice(1)))
    if (!root || !file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })
  registerIpc()
  win = new BrowserWindow({
    width: 1500, height: 940, minWidth: 1000, minHeight: 640,
    backgroundColor: '#14161a', autoHideMenuBar: true, title: 'mySeg Studio',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: false }
  })
  // Saves wait a moment after each change: let the last one reach the disk before closing
  let flushed = false
  win.on('close', (e) => {
    if (flushed || !root) return
    e.preventDefault()
    const close = () => {
      if (flushed) return
      flushed = true
      win?.close()
    }
    ipcMain.once('app:flushed', close)
    setTimeout(close, 3000)
    send('app:flush', null)
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else {
    const project = process.env.MYSEG_PROJECT
    win.loadFile(path.join(__dirname, '../renderer/index.html'), project ? { query: { project } } : {})
  }
})

// Local runs end with the app; remote ones keep going and reattach on next open
app.on('window-all-closed', () => {
  stopLocal()
  stopPrelabel()
  app.quit()
})
