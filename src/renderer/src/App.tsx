import { FolderOpen } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type Config, formatKeys, matches, shortcutList } from '../../shared/config'
import Labeler, { type Commands, type LabelerHandle, type Settings } from './Labeler'
import Logo from './Logo'
import MenuBar, { ContextMenu, type MenuSpec } from './Menu'
import { type ImageItem, type OpenProject, plainError, type ProjectInfo, type Start } from './types'

const DOCS = 'https://github.com/jakhon37/Seamtag#readme'
const KEPT = 'seamtag:settings'

// Settings made in the window that outlast it. Saving and the like start from the config each time, as in labelme.
type Kept = Pick<Settings, 'fill' | 'fit' | 'aiModel' | 'prelabelModel' | 'docks' | 'dark'>
function readKept(): Partial<Kept> {
  try {
    return JSON.parse(localStorage.getItem(KEPT) ?? '{}')
  } catch {
    return {}
  }
}

const AI_TITLES: Record<string, string> = {
  'EfficientSam (speed)': 'efficientsam:10m', 'EfficientSam (accuracy)': 'efficientsam:latest',
  'Sam (speed)': 'sam:100m', 'Sam (balanced)': 'sam:300m', 'Sam (accuracy)': 'sam:latest',
  'Sam2 (speed)': 'sam2:small', 'Sam2 (balanced)': 'sam2:latest', 'Sam2 (accuracy)': 'sam2:large'
}

function initialSettings(config: Config): Settings {
  const kept = readKept()
  return {
    autoSave: config.auto_save,
    storeData: config.store_data,
    keepPrev: config.keep_prev,
    keepPrevScale: config.keep_prev_scale,
    keepPrevBC: config.keep_prev_brightness_contrast,
    fillDrawing: config.canvas.fill_drawing,
    fill: kept.fill ?? 0.3,
    fit: kept.fit ?? 'window',
    aiModel: kept.aiModel ?? AI_TITLES[config.ai.default] ?? 'sam2:latest',
    prelabelModel: kept.prelabelModel ?? '',
    docks: {
      files: config.file_dock.show, labels: config.label_dock.show, shapes: config.shape_dock.show, flags: config.flag_dock.show,
      ...kept.docks
    },
    dark: kept.dark ?? config.dark_mode
  }
}

const MENUS: MenuSpec = [
  { label: 'File', items: ['open', 'open_dir', { label: 'Open recent', items: [], prefix: 'recent:' }, '-', 'open_next', 'open_prev', '-', 'save', 'save_as', 'auto_save', 'store_data', 'save_to', '-', 'delete_file', 'reveal', 'close', '-', 'preferences', 'quit'] },
  { label: 'Edit', items: ['create_polygon', 'create_rectangle', 'create_circle', 'create_line', 'create_point', 'create_linestrip', 'create_ai_polygon', 'create_ai_mask', 'create_brush', 'create_eraser', 'edit_polygon', '-', 'edit_label', 'duplicate_polygon', 'copy_polygon', 'paste_polygon', 'delete_polygon', 'merge_polygons', '-', 'undo', 'redo', 'remove_selected_point', 'add_multiple_points', 'toggle_lock', '-', 'toggle_keep_prev_mode'] },
  { label: 'View', items: ['dock_flags', 'dock_labels', 'dock_shapes', 'dock_files', '-', 'fill_drawing', 'toggle_all_polygons', '-', 'zoom_in', 'zoom_out', 'zoom_to_original', 'fit_window', 'fit_width', 'keep_prev_scale', '-', 'brightness_contrast', 'keep_prev_brightness_contrast', '-', 'dark_mode'] },
  { label: 'AI', items: [{ label: 'Model for AI polygon and mask', items: [], prefix: 'ai_model:' }, '-', 'prelabel_pick', 'prelabel_one', 'prelabel_all', '-', 'review_accept', 'review_reject', 'review_skip', 'review_accept_all', 'order_certainty'] },
  { label: 'Help', items: ['shortcuts', 'docs', 'about'] }
]
const CONTEXT = ['edit_label', 'duplicate_polygon', 'copy_polygon', 'paste_polygon', 'delete_polygon', 'merge_polygons', '-', 'undo', 'redo', '-', 'add_multiple_points', 'remove_selected_point', '-', 'edit_polygon', 'create_polygon', 'create_rectangle']

export default function App() {
  const [start, setStart] = useState<Start | null>(null)
  const [data, setData] = useState<OpenProject | null>(null)
  const [discovered, setDiscovered] = useState<string[]>([])
  const [settings, setSettingsState] = useState<Settings | null>(null)
  const [error, setError] = useState('')
  const [context, setContext] = useState<{ x: number; y: number } | null>(null)
  const [about, setAbout] = useState(false)
  const [help, setHelp] = useState(false)
  const [, setTick] = useState(0)
  const labeler = useRef<LabelerHandle>(null)
  const config = start?.config ?? null
  const mac = start?.platform === 'darwin'

  const showError = useCallback((message: string) => setError(plainError(message)), [])
  const setSettings = useCallback((fn: (s: Settings) => Settings) => setSettingsState((s) => (s ? fn(s) : s)), [])

  useEffect(() => {
    if (!settings) return
    const { fill, fit, aiModel, prelabelModel, docks, dark } = settings
    try {
      localStorage.setItem(KEPT, JSON.stringify({ fill, fit, aiModel, prelabelModel, docks, dark }))
    } catch {
      // Not kept, then
    }
    document.documentElement.dataset.theme = settings.dark ? 'dark' : 'light'
  }, [settings])

  const open = useCallback(async (target: string, output: string | null = data?.outputDir ?? null) => {
    if (labeler.current && !(await labeler.current.canLeave())) return
    try {
      const next = await window.api.openProject(target, output)
      if (data && data.root !== next.root) window.api.closeProject(data.root)
      setDiscovered([])
      setData(next)
      localStorage.setItem('lastProject', target)
    } catch (e) {
      showError(`Could not open ${target}: ${plainError(e)}`)
    }
  }, [data, showError])

  useEffect(() => {
    window.api.start().then((s) => {
      setStart(s)
      if (!s.config) return
      setSettingsState(initialSettings(s.config))
      s.warnings.forEach((w) => showError(w))
      const first = s.filename ?? localStorage.getItem('lastProject')
      if (first) {
        window.api.openProject(first, s.output).then((p) => { setData(p) }).catch((e) => {
          if (s.filename) showError(`Could not open ${s.filename}: ${plainError(e)}`)
        })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => window.api.onError(showError), [showError])
  useEffect(() => window.api.onSummaries(({ root, items, labels }) => {
    setData((d) => {
      if (!d || d.root !== root) return d
      const byName = new Map(items.map((i) => [i.name, i]))
      return { ...d, images: d.images.map((i) => byName.get(i.name) ?? i) }
    })
    if (labels.length) setDiscovered((list) => {
      const fresh = labels.filter((l) => !list.includes(l)).sort((a, b) => a.localeCompare(b))
      return fresh.length ? [...list, ...fresh] : list
    })
  }), [])
  // Closing the window: unsaved work is saved, or asked about, first
  useEffect(() => window.api.onFlush(async () => {
    const ok = labeler.current ? await labeler.current.canLeave() : true
    window.api.flushed(ok)
  }), [])

  const setProject = useCallback((project: ProjectInfo) => {
    setData((d) => d && { ...d, project, hasProjectFile: true })
    if (data) window.api.saveProject(data.root, project).catch((e) => showError(`The label list couldn't be saved: ${plainError(e)}`))
  }, [data, showError])
  const setImages = useCallback((fn: (images: ImageItem[]) => ImageItem[]) => setData((d) => d && { ...d, images: fn(d.images) }), [])

  const pickOpen = async () => {
    const file = await window.api.pickFile('Open image or label file', [
      { name: 'Images and label files', extensions: ['jpg', 'jpeg', 'jfif', 'png', 'bmp', 'gif', 'tif', 'tiff', 'webp', 'avif', 'json'] }
    ])
    if (file) open(file)
  }
  const pickDir = async () => {
    const dir = await window.api.pickFolder('Open image folder')
    if (dir) open(dir)
  }
  const changeOutput = async () => {
    if (!data) return
    const dir = await window.api.pickFolder('Save label files in')
    if (!dir) return
    const current = data.images.find((i) => i.name === data.select)?.name
    if (labeler.current && !(await labeler.current.canLeave())) return
    try {
      const next = await window.api.openProject(data.root, dir)
      setData({ ...next, select: current ?? next.select })
    } catch (e) {
      showError(plainError(e))
    }
  }
  const closeFolder = async () => {
    if (labeler.current && !(await labeler.current.canLeave())) return
    if (data) window.api.closeProject(data.root)
    localStorage.removeItem('lastProject')
    setData(null)
  }
  const dock = (k: keyof Settings['docks'], label: string) => ({
    label, run: () => setSettings((s) => ({ ...s, docks: { ...s.docks, [k]: !s.docks[k] } })), checked: () => !!settings?.docks[k]
  })

  const commands = (): Commands => {
    const own: Commands = {
      open: { label: 'Open…', run: pickOpen, shortcut: 'open' },
      open_dir: { label: 'Open folder…', run: pickDir, shortcut: 'open_dir' },
      save_to: { label: 'Change output folder…', run: changeOutput, shortcut: 'save_to', enabled: () => !!data },
      close: { label: 'Close folder', run: closeFolder, shortcut: 'close', enabled: () => !!data },
      preferences: { label: 'Open config file', run: () => window.api.openConfig().catch((e) => showError(plainError(e))) },
      quit: { label: 'Quit', run: () => window.close(), shortcut: 'quit' },
      dock_flags: dock('flags', 'Flags'),
      dock_labels: dock('labels', 'Labels'),
      dock_shapes: dock('shapes', 'Shapes'),
      dock_files: dock('files', 'Files'),
      dark_mode: { label: 'Dark mode', run: () => setSettings((s) => ({ ...s, dark: !s.dark })), checked: () => !!settings?.dark },
      shortcuts: { label: 'Keyboard shortcuts', run: () => setHelp(true) },
      docs: { label: 'Documentation', run: () => window.api.openLink(DOCS) },
      about: { label: `About Seamtag`, run: () => setAbout(true) }
    }
    ;(start?.recent ?? []).forEach((r, i) => (own[`recent:${i}`] = { label: r, run: () => open(r) }))
    return { ...(labeler.current?.commands ?? {}), ...own }
  }
  // App-wide shortcuts, for when no folder is open: the labeller handles the rest
  useEffect(() => {
    if (!config) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      for (const id of ['open', 'open_dir', 'close', 'quit', 'save_to'] as const) {
        const name = commands()[id]?.shortcut
        if (name && shortcutList(config.shortcuts[name]).some((k) => matches(k, e, mac))) {
          e.preventDefault()
          commands()[id].run()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Drop a folder, an image or a label file anywhere to open it
  const onDrop = (e: React.DragEvent) => {
    const file = e.dataTransfer.files[0]
    if (!file) return
    e.preventDefault()
    const p = window.api.pathForFile(file)
    if (p) open(p)
  }

  if (!start) return <div className="app" />
  if (!config || !settings) {
    return (
      <div className="app">
        <div className="empty">
          <Logo size={72} />
          <h1>The config file has a problem</h1>
          <p className="error static">{start.configError}</p>
          <p>{start.configFile ?? '~/.seamtagrc'}</p>
          <button className="primary" onClick={() => window.api.openConfig()}>Open config file</button>
        </div>
      </div>
    )
  }
  const done = data?.images.filter((i) => i.labelled && !i.ai).length ?? 0
  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="topbar">
        <div className="brand"><Logo size={22} /> Seamtag</div>
        <MenuBar menus={MENUS} commands={commands} config={config} mac={mac} />
        <div className="spacer" />
        {data && (
          <span className="muted" title={data.outputDir ? `Label files go to ${data.outputDir}` : undefined}>
            {data.project.name} · {done}/{data.images.length} labelled{data.outputDir ? ' · output folder set' : ''}
          </span>
        )}
        <button className="ghost" onClick={pickDir} title={`Open folder (${formatKeys(config.shortcuts.open_dir, mac)})`}>
          <FolderOpen size={15} /> Open folder
        </button>
      </header>
      {error && <div className="error" role="alert" onClick={() => setError('')}>{error}</div>}
      {!data ? (
        <div className="empty">
          <Logo size={72} />
          <h1>Open a folder of images</h1>
          <p>Labels are saved beside each image as LabelMe JSON, so folders labelled in labelme, LabelMeV2 or Seamline open as they are.</p>
          <div className="row">
            <button className="primary" onClick={pickDir}><FolderOpen size={16} /> Open folder</button>
            <button className="ghost" onClick={pickOpen}>Open a file</button>
          </div>
          {start.recent.length > 0 && (
            <div className="recent">
              <h3>Recent</h3>
              {start.recent.slice(0, 5).map((r) => <button key={r} className="file" onClick={() => open(r)} title={r}><span className="name">{r}</span></button>)}
            </div>
          )}
        </div>
      ) : (
        <div className="page">
          <Labeler key={`${data.root}\n${data.outputDir ?? ''}`} ref={labeler} data={data} config={config} settings={settings} setSettings={setSettings}
            setProject={setProject} setImages={setImages} discovered={discovered} mac={mac} onError={showError}
            onOpenMenu={(x, y) => setContext({ x, y })} onChange={() => setTick((t) => t + 1)} />
        </div>
      )}
      {context && <ContextMenu at={context} items={CONTEXT} commands={commands()} config={config} mac={mac} onDone={() => setContext(null)} />}
      {about && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && setAbout(false)}>
          <div className="dialog about" role="dialog" aria-label="About">
            <Logo size={56} />
            <h1>Seamtag {start.version}</h1>
            <p>Image annotation in LabelMe format, with brush, eraser, AI segmentation and review of model proposals.</p>
            <p className="muted">Continues LabelMeV2, an enhanced fork of labelme by Kentaro Wada, on Seamline's desktop app. GPL-3.0. AI models are downloaded from the addresses osam and labelme use, under their own licences.</p>
            <div className="actions"><button className="primary" onClick={() => setAbout(false)}>Close</button></div>
          </div>
        </div>
      )}
      {help && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && setHelp(false)}>
          <div className="dialog shortcuts" role="dialog" aria-label="Keyboard shortcuts">
            <h3>Keyboard shortcuts <span className="muted">change them under shortcuts: in the config file</span></h3>
            <div className="kv">
              {Object.entries(commands()).filter(([, c]) => c.shortcut && config.shortcuts[c.shortcut]).map(([id, c]) => (
                <div key={id}><span>{c.label}</span><b>{shortcutList(config.shortcuts[c.shortcut!]).map((_, k) => formatKeys([config.shortcuts[c.shortcut!]].flat()[k], mac)).join('  ')}</b></div>
              ))}
              <div><span>Pick a label</span><b>1-9</b></div>
              <div><span>Move the selection</span><b>Arrows, Shift for 10 px</b></div>
              <div><span>Pan</span><b>Space+drag, middle or right drag</b></div>
              <div><span>Add or remove a point</span><b>Alt+click an edge or a point</b></div>
            </div>
            <div className="actions"><button className="primary" onClick={() => setHelp(false)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  )
}
