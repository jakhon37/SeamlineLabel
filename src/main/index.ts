import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { existsSync, promises as fs, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { type Args, loadConfig, type LoadedConfig, parseArgs, USAGE, USER_CONFIG } from './config'
import { cacheRoot, imageData, openImage, setCacheDir } from './images'
import {
  closeProject, imagePath, labelPath, loadLabels, openProject, type ProjectInfo, rootsOpen, saveLabels,
  saveProjectFile, type SaveRequest, summarizeAll
} from './project'

const NAME = 'Seamline Label'
app.setName(NAME)

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
  summarizeAll(project.root, (batch) => send('project:summaries', batch)).catch((e) =>
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
  ipcMain.handle('dialog:save', async (_e, title: string, defaultPath: string) => {
    const r = await dialog.showSaveDialog(win!, { title, defaultPath, filters: [{ name: 'Label files', extensions: ['json'] }] })
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
  ipcMain.handle('labels:load', (_e, root: string, name: string) => loadLabels(root, name))
  ipcMain.handle('labels:save', async (_e, root: string, name: string, req: SaveRequest & { storeData?: boolean }) => {
    const data = req.storeData ? await imageData(root, name) : null
    return saveLabels(root, name, { ...req, imageData: data })
  })
  ipcMain.handle('labels:path', (_e, root: string, name: string) => labelPath(root, name))
  // labelme deletes the file. It goes to the trash here, so a slip can be undone.
  ipcMain.handle('labels:trash', async (_e, root: string, name: string) => {
    const file = labelPath(root, name)
    if (existsSync(file)) await shell.trashItem(file)
    return file
  })
  ipcMain.handle('file:reveal', (_e, root: string, name: string) => shell.showItemInFolder(imagePath(root, name)))
  ipcMain.handle('config:open', async () => {
    const file = loaded?.file ?? USER_CONFIG
    if (!existsSync(file)) await fs.writeFile(file, '')
    const error = await shell.openPath(file)
    if (error) throw new Error(error)
  })
  ipcMain.handle('app:link', (_e, url: string) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url)
  })
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

app.on('window-all-closed', () => app.quit())
