import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { existsSync, promises as fs, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { download, listModels, release, segment } from './ai'
import { type Args, loadConfig, type LoadedConfig, parseArgs, USAGE, USER_CONFIG } from './config'
import { FORMAT_EXT, FORMAT_NAMES, type LabelFormat } from '../shared/formats'
import { cacheRoot, imageData, imageDepth, imageSize, openImage, setCacheDir } from './images'
import { modelInfo, prelabel, stopPrelabel } from './prelabel'
import {
  closeProject, hasLabelsIn, imagePath, labelsFile, loadLabels, openProject, type ProjectInfo, readLabelFile, rootsOpen, saveLabels,
  saveProjectFile, type SaveRequest, setTrash, summarizeAll, trashImage, trashLabels
} from './project'

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

protocol.registerSchemesAsPrivileged([
  { scheme: 'myseg', privileges: { standard: true, supportFetchAPI: true, stream: true, secure: true, corsEnabled: true } }
])

let win: BrowserWindow | null = null
let loaded: LoadedConfig
let configError = ''

type State = { recent: string[]; bounds?: { width: number; height: number; x?: number; y?: number }; maximized?: boolean }
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
function addRecent(target: string) {
  const state = readState()
  state.recent = [target, ...state.recent.filter((r) => r !== target)].slice(0, 10)
  writeState(state)
}

function send(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

async function open(target: string, output: string | null) {
  const project = await openProject(target, output)
  addRecent(target)
  win?.setTitle(`${path.basename(project.root)} - ${NAME}`)
  // Counts and broken files arrive after the list, so a big folder opens at once
  summarizeAll(project.root, (batch) => send('project:summaries', batch), loaded?.config.label_format).catch((e) =>
    send('app:error', `Some label files couldn't be read: ${e.message}`)
  )
  return project
}

function registerIpc() {
  ipcMain.handle('app:start', () => ({
    config: loaded?.config ?? null,
    configError,
    configFile: loaded?.file ?? null,
    warnings: loaded?.warnings ?? [],
    version: app.getVersion(),
    platform: process.platform,
    filename: args.filename ? path.resolve(args.filename) : null,
    output: args.output ? path.resolve(args.output) : null,
    recent: readState().recent.filter((r) => existsSync(r))
  }))
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
  ipcMain.handle('project:open', (_e, target: string, output: string | null) => open(target, output))
  ipcMain.handle('project:close', (_e, root: string) => closeProject(root))
  ipcMain.handle('project:save', (_e, root: string, project: ProjectInfo) => saveProjectFile(root, project))
  ipcMain.handle('image:open', (_e, root: string, name: string) => openImage(root, name))
  // YOLO's boxes are shares of the image, so reading them needs its size: the window's, or the file's
  const sizeOf = (root: string, name: string, size?: [number, number]) => async () => size ?? imageSize(root, name)
  ipcMain.handle('labels:load', (_e, root: string, name: string, prefer?: LabelFormat, size?: [number, number]) =>
    loadLabels(root, name, prefer, sizeOf(root, name, size)))
  // The image's data and depth are read in the save's turn, so saves of one image keep their order
  ipcMain.handle('labels:save', (_e, root: string, name: string, req: SaveRequest & { storeData?: boolean }) =>
    saveLabels(root, name, { ...req, imageData: null }, {
      imageData: req.storeData ? () => imageData(root, name) : undefined,
      depth: req.format === 'voc' ? () => imageDepth(root, name) : undefined
    }))
  ipcMain.handle('labels:has', (_e, root: string, name: string, format: LabelFormat) => hasLabelsIn(root, name, format))
  ipcMain.handle('labels:path', (_e, root: string, name: string, prefer: LabelFormat) => labelsFile(root, name, prefer))
  // labelme deletes the file. It goes to the trash here, so a slip can be undone.
  ipcMain.handle('labels:trash', (_e, root: string, name: string, prefer: LabelFormat) => trashLabels(root, name, prefer))
  ipcMain.handle('labels:read', (_e, root: string, name: string, file: string, size?: [number, number]) =>
    readLabelFile(root, name, file, sizeOf(root, name, size)))
  ipcMain.handle('image:trash', (_e, root: string, name: string) => trashImage(root, name))
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
  ipcMain.handle('ai:segment', (_e, root: string, name: string, model: string, points: number[][], labels: number[], mode: 'polygon' | 'mask') =>
    segment(root, name, model, points, labels, mode))
  ipcMain.handle('prelabel:pick', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Choose a segmentation model', properties: ['openFile'], filters: [{ name: 'ONNX models', extensions: ['onnx'] }] })
    return r.canceled ? null : modelInfo(r.filePaths[0])
  })
  ipcMain.handle('prelabel:info', (_e, file: string) => modelInfo(file))
  ipcMain.handle('prelabel:run', (_e, root: string, model: string, names: string[], classes: string[]) =>
    prelabel(root, model, names, classes, loaded?.config.prelabel.min_area ?? 20, (p) => send('prelabel:progress', p)))
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
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
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

app.on('window-all-closed', () => {
  stopPrelabel()
  release().finally(() => app.quit())
})
