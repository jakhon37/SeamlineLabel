import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { existsSync, promises as fs, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { cancelDownload, download, listModels, release, removeModel } from './ai'
import { mergeMasks } from './masks'
import { assist, type AssistRequest, fromTexts, MaskOutputUnavailable, type TextRequest } from './assist'
import { type Args, loadConfig, type LoadedConfig, parseArgs, USAGE, USER_CONFIG } from './config'
import { FORMAT_EXT, FORMAT_NAMES, type LabelFormat } from '../shared/formats'
import { cacheRoot, imageData, imageDepth, imageSize, openImage, setCacheDir } from './images'
import { modelInfo, prelabel, stopPrelabel } from './prelabel'
import {
  closeProject, hasLabelsIn, imagePath, type LabelClass, labelsChanged, LabelsChanged, labelsFile, loadLabels, meta, openHere, openProject, type ProjectInfo,
  readLabelFile, refreshProject, reloadProjectFile, rootsOpen, saveLabels, saveProjectFile, type SaveRequest, setTrash, summarizeAll, trashImage, trashLabels
} from './project'
import { runModels } from './runs'

const NAME = 'Seamtag'
app.setName(NAME)
// macOS and Windows put the profile where the system says, whatever HOME is, so tests name their own
if (process.env.SEAMTAG_USER_DATA) app.setPath('userData', process.env.SEAMTAG_USER_DATA)

// In development Electron's own arguments come first: `electron . image.jpg`
const argv = process.argv.slice(app.isPackaged ? 1 : 2)
let args: Args
try {
  args = parseArgs(argv)
} catch (e: any) {
  process.stderr.write(`${e.message}\n\n${USAGE}`)
  process.exit(2)
}
if (args.help) {
  process.stdout.write(USAGE)
  process.exit(0)
}
if (args.version) {
  process.stdout.write(`${NAME} ${app.getVersion()}\n`)
  process.exit(0)
}

// One Seamtag to a profile: started again, as Seamline's Label in Seamtag starts it, it shows what
// it was given in the window that's open, rather than in a second one whose settings and saves
// would cross the first's
type Started = { filename: string | null; output: string | null }
const started: Started = { filename: args.filename ? path.resolve(args.filename) : null, output: args.output ? path.resolve(args.output) : null }
// Chromium keeps the lock's socket in the temp folder and stops the app when the socket's path is
// longer than a socket's can be: under a temp folder that deep, each start has a window of its own
const lockable = process.platform === 'win32' || path.join(tmpdir(), 'scoped_dir000000', 'SingletonSocket').length < (process.platform === 'darwin' ? 104 : 108)
if (lockable && !app.requestSingleInstanceLock(started)) {
  const others = args.config !== null || Object.keys(args.overrides).length > 0 || args.resetConfig
  const opens = started.filename && existsSync(started.filename) ? `, so ${started.filename} opens in its window` : ''
  process.stdout.write(`${NAME} is already open${opens}.${others ? ' Other options take effect when it starts.' : ''}\n`)
  process.exit(0)
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'myseg', privileges: { standard: true, supportFetchAPI: true, stream: true, secure: true, corsEnabled: true } }
])

let win: BrowserWindow | null = null
let loaded: LoadedConfig
let configError = ''
// The window has asked what to open first: what a new start gives is sent to it from then on
let asked = false

// `select`: the image a remembered folder opens on, as a Seamline project opened by a start on one of its images
type State = { recent: string[]; select?: Record<string, string>; bounds?: { width: number; height: number; x?: number; y?: number }; maximized?: boolean }
const statePath = () => path.join(app.getPath('userData'), 'state.json')
function readState(): State {
  try {
    return { recent: [], ...JSON.parse(readFileSync(statePath(), 'utf8')) }
  } catch {
    return { recent: [] }
  }
}
function writeState(state: State) {
  try {
    writeFileSync(statePath(), JSON.stringify(state, null, 2))
  } catch {
    // Not worth stopping for
  }
}
function addRecent(target: string, select: string | null) {
  const state = readState()
  state.recent = [target, ...state.recent.filter((r) => r !== target)].slice(0, 10)
  const kept = Object.entries(state.select ?? {}).filter(([r]) => r !== target && state.recent.includes(r))
  state.select = Object.fromEntries(select ? [...kept, [target, select]] : kept)
  writeState(state)
}

function send(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// `again`: opened from Open recent or as the last folder, so a folder remembered on an image opens on it
async function open(target: string, output: string | null, started?: boolean, again?: boolean) {
  const project = await openProject(target, output, !!started)
  const on = again ? readState().select?.[target] : undefined
  if (on && project.images.some((i) => i.name === on)) project.select = on
  // A Seamline project a start on one of its images opened is remembered on that image, as an image opened
  // is on itself, and stays so while it's opened again on it
  addRecent(project.remembered, project.remembered !== target || (on && project.select === on) ? project.select : null)
  win?.setTitle(`${path.basename(project.root)} - ${NAME}`)
  // Counts and broken files arrive after the list, so a big folder opens at once
  summarizeAll(project.root, (batch) => send('project:summaries', batch), loaded?.config.label_format).catch((e) =>
    send('app:error', `Some label files couldn't be read: ${e.message}`)
  )
  return project
}

function registerIpc() {
  ipcMain.handle('app:start', () => {
    asked = true
    return {
      config: loaded?.config ?? null,
      configError,
      configFile: loaded?.file ?? null,
      warnings: loaded?.warnings ?? [],
      version: app.getVersion(),
      platform: process.platform,
      filename: started.filename,
      output: started.output,
      recent: readState().recent.filter((r) => existsSync(r))
    }
  })
  ipcMain.handle('dialog:folder', async (_e, title?: string) => {
    const r = await dialog.showOpenDialog(win!, { title: title ?? 'Open folder', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:file', async (_e, title: string, filters: Electron.FileFilter[]) => {
    const r = await dialog.showOpenDialog(win!, { title, properties: ['openFile'], filters })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:save', async (_e, title: string, defaultPath: string, format: LabelFormat = 'labelme') => {
    const filters = [{ name: `${FORMAT_NAMES[format]} files`, extensions: [FORMAT_EXT[format].slice(1)] }]
    const r = await dialog.showSaveDialog(win!, { title, defaultPath, filters })
    return r.canceled ? null : r.filePath
  })
  ipcMain.handle('dialog:ask', async (_e, message: string, detail: string, buttons: string[]) => {
    const r = await dialog.showMessageBox(win!, { type: 'question', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true })
    return r.response
  })
  ipcMain.handle('project:open', (_e, target: string, output: string | null, started?: boolean, again?: boolean) => open(target, output, started, again))
  ipcMain.handle('project:close', (_e, root: string) => closeProject(root))
  ipcMain.handle('project:save', (_e, root: string, project: ProjectInfo, shown?: LabelClass[]) => saveProjectFile(root, project, shown))
  ipcMain.handle('project:reload', (_e, root: string) => reloadProjectFile(root))
  // Another app, such as Seamline, may have changed the folder while the window was in the background
  ipcMain.handle('project:refresh', (_e, root: string) => refreshProject(root))
  ipcMain.handle('project:summarize', (_e, root: string) =>
    summarizeAll(root, (batch) => send('project:summaries', batch), loaded?.config.label_format, true))
  ipcMain.handle('image:open', (_e, root: string, name: string) => openImage(root, name))
  // YOLO's boxes are shares of the image, so reading them needs its size: the window's, or the file's
  const sizeOf = (root: string, name: string, size?: [number, number]) => async () => size ?? imageSize(root, name)
  ipcMain.handle('labels:load', (_e, root: string, name: string, prefer?: LabelFormat, size?: [number, number], edit?: boolean) =>
    loadLabels(root, name, prefer, sizeOf(root, name, size), edit))
  // Labels another app changed since the window read them are left as they are, and the window reads them again
  const changedElsewhere = (e: unknown) => {
    if (e instanceof LabelsChanged) return { changed: e.name }
    throw e
  }
  // The image's data and depth are read in the save's turn, so saves of one image keep their order
  ipcMain.handle('labels:save', (_e, root: string, name: string, req: SaveRequest & { storeData?: boolean }) =>
    saveLabels(root, name, { ...req, imageData: null }, {
      imageData: req.storeData ? () => imageData(root, name) : undefined,
      depth: req.format === 'voc' ? () => imageDepth(root, name) : undefined
    }).catch(changedElsewhere))
  ipcMain.handle('labels:changed', (_e, root: string, name: string) => labelsChanged(root, name))
  ipcMain.handle('labels:has', (_e, root: string, name: string, format: LabelFormat) => hasLabelsIn(root, name, format))
  ipcMain.handle('labels:path', (_e, root: string, name: string, prefer: LabelFormat) => labelsFile(root, name, prefer))
  // labelme deletes the file. It goes to the trash here, so a slip can be undone.
  ipcMain.handle('labels:trash', (_e, root: string, name: string, prefer: LabelFormat) => trashLabels(root, name, prefer).catch(changedElsewhere))
  ipcMain.handle('labels:read', (_e, root: string, name: string, file: string, size?: [number, number]) =>
    readLabelFile(root, name, file, sizeOf(root, name, size)))
  ipcMain.handle('image:trash', (_e, root: string, name: string) => trashImage(root, name).catch(changedElsewhere))
  ipcMain.handle('file:reveal', (_e, root: string, name: string) => shell.showItemInFolder(imagePath(root, name)))
  ipcMain.handle('config:open', async () => {
    const file = loaded?.file ?? USER_CONFIG
    if (!existsSync(file)) await fs.writeFile(file, '')
    const error = await shell.openPath(file)
    if (error) throw new Error(error)
  })
  // LabelImg's Reset All: the window's settings, layout and recent files are forgotten, then it starts again
  ipcMain.handle('app:reset', async () => {
    await fs.rm(statePath(), { force: true })
    await win?.webContents.session.clearStorageData({ storages: ['localstorage'] })
    app.relaunch()
    app.exit(0)
  })
  ipcMain.handle('app:link', (_e, url: string) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url)
  })
  ipcMain.handle('ai:models', () => listModels())
  ipcMain.handle('ai:download', (_e, name: string) => download(name, (p) => send('ai:download', p)))
  ipcMain.handle('ai:cancel', (_e, name: string) => cancelDownload(name))
  ipcMain.handle('ai:remove', (_e, name: string) => removeModel(name))
  ipcMain.handle('ai:assist', (_e, req: AssistRequest) => assist(req))
  ipcMain.handle('shapes:merge-masks', (_e, shapes: { points: number[][]; mask: string }[]) => mergeMasks(shapes))
  // A model that finds boxes only, asked for masks, is the user's choice to change, not a failure
  ipcMain.handle('ai:text', (_e, req: TextRequest) => fromTexts(req).catch((e) => {
    if (e instanceof MaskOutputUnavailable) return { shapes: [], matched: [], notice: e.message }
    throw e
  }))
  // Seamline exports its runs' models into the folder's hidden .myseg/runs, so the dialog starts there and shows hidden files
  ipcMain.handle('prelabel:pick', async (_e, root?: string) => {
    const runs = root && rootsOpen().includes(root) ? meta(root, 'runs') : null
    const r = await dialog.showOpenDialog(win!, {
      title: 'Choose a segmentation model', defaultPath: runs && existsSync(runs) ? runs : undefined,
      properties: ['openFile', 'showHiddenFiles'], filters: [{ name: 'ONNX models', extensions: ['onnx'] }]
    })
    return r.canceled ? null : modelInfo(r.filePaths[0])
  })
  ipcMain.handle('prelabel:info', (_e, file: string) => modelInfo(file))
  // Models Seamline exported from the folder's training runs
  ipcMain.handle('prelabel:models', (_e, root: string) => runModels(root))
  ipcMain.handle('prelabel:run', (_e, root: string, model: string, names: string[], classes: string[], batch?: boolean) =>
    prelabel(root, model, names, classes, loaded?.config.prelabel.min_area ?? 25, (p) => send('prelabel:progress', p), !!batch))
  ipcMain.handle('prelabel:stop', () => stopPrelabel())
}

function buildMenu() {
  // The window has its own menu bar. A Mac still needs the app menu, and Edit for text fields.
  if (process.platform !== 'darwin') return Menu.setApplicationMenu(null)
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ]))
}

function createWindow() {
  const state = readState()
  win = new BrowserWindow({
    width: state.bounds?.width ?? 1500, height: state.bounds?.height ?? 940, x: state.bounds?.x, y: state.bounds?.y,
    minWidth: 960, minHeight: 600, backgroundColor: '#14161a', title: NAME, show: false,
    icon: path.join(__dirname, '../../resources/icon.png'),
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: false }
  })
  if (state.maximized) win.maximize()
  win.once('ready-to-show', () => win?.show())
  // Back from another app, such as Seamline: the window looks at the folder again
  win.on('focus', () => send('app:focus', null))
  // Saves wait a moment after each change: the window flushes them, or asks about unsaved
  // work when saving isn't automatic, before it closes
  let closing = false
  win.on('close', (e) => {
    if (closing || !win) return
    e.preventDefault()
    const finish = (ok: boolean) => {
      if (!ok || closing || !win) return
      closing = true
      const s = readState()
      s.maximized = win.isMaximized()
      if (!s.maximized) s.bounds = win.getBounds()
      writeState(s)
      win.close()
    }
    ipcMain.once('app:flushed', (_e, ok: boolean) => finish(ok))
    send('app:flush', null)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // electron-vite's dev server, in development only: an installed Seamtag that another app's
  // development run starts, as Seamline's `npm run dev` does, gets that app's address in its environment
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  setCacheDir(path.join(app.getPath('userData'), 'cache'))
  if (args.resetConfig) {
    // labelme forgets its Qt settings; here that's the layout, recent files and app settings
    await fs.rm(statePath(), { force: true })
    await fs.rm(path.join(app.getPath('userData'), 'Local Storage'), { recursive: true, force: true })
    process.stdout.write('Settings were reset.\n')
    app.exit(0)
    return
  }
  try {
    loaded = loadConfig(args)
  } catch (e: any) {
    configError = e.message
  }
  setTrash((file) => shell.trashItem(file))
  protocol.handle('myseg', async (request) => {
    const file = path.resolve(decodeURIComponent(new URL(request.url).pathname.slice(1)))
    const allowed = [...rootsOpen(), cacheRoot()].some((dir) => dir && file.startsWith(dir + path.sep))
    if (!allowed) return new Response('Forbidden', { status: 403 })
    // Shared with the page's own origin, so drawing an image leaves the canvas readable
    const response = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(response.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(response.body, { status: response.status, headers })
  })
  registerIpc()
  buildMenu()
  createWindow()
})

// Seamtag started again: this window comes forward and opens what that start was given
app.on('second-instance', (_e, _argv, _cwd, data) => {
  const again: Started = { filename: null, output: null, ...(data as Partial<Started> | undefined) }
  // The window hasn't asked what to open yet: it opens this as it starts
  if (!asked && again.filename) Object.assign(started, again)
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (!asked || !again.filename) return
  // Not there: the window keeps what it has open, unsaved work and all, and says so
  if (!existsSync(again.filename)) send('app:error', `Could not open ${again.filename}: there's no such file or folder.`)
  else send('app:open', { target: again.filename, output: again.output, here: openHere(again.filename) })
})

app.on('window-all-closed', () => {
  stopPrelabel()
  release().finally(() => app.quit())
})
