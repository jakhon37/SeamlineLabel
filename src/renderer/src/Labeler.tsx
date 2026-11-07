import {
  Check, CheckCheck, Circle, Eraser, Eye, EyeOff, Hexagon, Maximize, MousePointer2, Paintbrush, Plus, Redo2, SkipForward,
  Slash, Sparkles, Spline, Square, Trash2, Undo2, Wand2, X, Dot, ScanLine, Lock
} from 'lucide-react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { type Config, matches, type ShortcutName, shortcutList } from '../../shared/config'
import { accepted, isAi, newShape, scoreOf, type Shape, type ShapeType } from '../../shared/labelfile'
import { summarize } from '../../shared/labels'
import { labelColor, withAlpha } from './colors'
import { eraseShapes, paintShapes, strokeRegion } from './geometry'
import LabelDialog, { flagsFor, type LabelChoice, type LabelRequest } from './LabelDialog'
import {
  addPointsToEdge, bounds, canRemovePoint, CLOSED, contains, describe, edges, insertPoint, mergePolygons, moveShapes,
  nearestEdge, nearestVertex, outline, type Pt, squareFrom, toEdge
} from './shapes'
import { fileUrl, type ImageItem, type ModelInfo, type OpenImage, type OpenProject, plainError, type PrelabelModel, type ProjectInfo } from './types'

export type Mode = 'edit' | 'polygon' | 'rectangle' | 'circle' | 'line' | 'point' | 'linestrip' | 'ai_polygon' | 'ai_mask' | 'brush' | 'eraser'
export const CREATE_MODES: Mode[] = ['polygon', 'rectangle', 'circle', 'line', 'point', 'linestrip', 'ai_polygon', 'ai_mask']

export type Settings = {
  autoSave: boolean
  storeData: boolean
  keepPrev: boolean
  keepPrevScale: boolean
  keepPrevBC: boolean
  fillDrawing: boolean
  fill: number
  fit: 'window' | 'width' | 'manual'
  aiModel: string
  prelabelModel: string
  docks: { files: boolean; labels: boolean; shapes: boolean; flags: boolean }
  dark: boolean
}

export type Command = { label: string; run: () => void; enabled?: () => boolean; checked?: () => boolean; shortcut?: ShortcutName; keys?: string }
export type Commands = Record<string, Command>
export type LabelerHandle = { commands: Commands; canLeave: () => Promise<boolean> }

type Filter = 'all' | 'label' | 'review' | 'done'
type Props = {
  data: OpenProject
  config: Config
  settings: Settings
  setSettings: (fn: (s: Settings) => Settings) => void
  setProject: (p: ProjectInfo) => void
  setImages: (fn: (images: ImageItem[]) => ImageItem[]) => void
  discovered: string[]
  mac: boolean
  onError: (m: string) => void
  onOpenMenu: (x: number, y: number) => void
  onChange: () => void
}
type Drag =
  | { kind: 'pan'; x: number; y: number; press: number[]; button: number; moved: boolean }
  | { kind: 'vertex'; shape: number; vertex: number; press: number[]; active: boolean; start: Shape[] }
  | { kind: 'move'; shapes: number[]; x: number; y: number; press: number[]; active: boolean; start: Shape[] }
  | { kind: 'two'; press: number[] }
  | { kind: 'stroke'; points: number[][]; radius: number }
type Draft = { points: Pt[]; labels: number[]; preview: Shape | null }
type Hover = { shape: number; vertex: number; edge: number } | null

const HISTORY_IMAGES = 30
const CACHE_TILES = 400
const DRAG_START = 4

const FILTERS: { key: Filter; name: string; title: string; test: (i: ImageItem) => boolean }[] = [
  { key: 'all', name: 'All', title: 'Every image', test: () => true },
  { key: 'label', name: 'Label', title: 'No label file yet', test: (i) => !i.labelled && !i.broken },
  { key: 'review', name: 'Review', title: 'AI shapes to accept or reject', test: (i) => i.ai > 0 },
  { key: 'done', name: 'Done', title: 'Labelled, nothing left to review', test: (i) => i.labelled && !i.ai && !i.broken }
]
const percent = (score: number) => `${Math.round(score * 100)}%`
const MODE_NAMES: Record<Mode, string> = {
  edit: 'Edit', polygon: 'Polygon', rectangle: 'Rectangle', circle: 'Circle', line: 'Line', point: 'Point',
  linestrip: 'Line strip', ai_polygon: 'AI polygon', ai_mask: 'AI mask', brush: 'Brush', eraser: 'Eraser'
}

// Least certain first; shapes without a score come last
function reviewOrder(list: Shape[]) {
  return list
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => isAi(s) && !s.hidden)
    .sort((a, b) => (scoreOf(a.s) ?? 1) - (scoreOf(b.s) ?? 1) || a.i - b.i)
    .map(({ i }) => i)
}

// A labelme mask is a PNG of 0s and 1s: it becomes a tinted, see-through overlay
const maskCache = new Map<string, HTMLCanvasElement | null>()
function maskCanvas(mask: string, color: string, onReady: () => void) {
  const key = `${color}:${mask}`
  if (maskCache.has(key)) return maskCache.get(key)
  maskCache.set(key, null)
  const img = new Image()
  img.onload = () => {
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(0, 0, c.width, c.height)
    const v = parseInt(color.slice(1), 16)
    for (let i = 0; i < px.data.length; i += 4) {
      const on = px.data[i] > 0 || px.data[i + 1] > 0 || px.data[i + 2] > 0
      px.data[i] = (v >> 16) & 255; px.data[i + 1] = (v >> 8) & 255; px.data[i + 2] = v & 255
      px.data[i + 3] = on ? 255 : 0
    }
    ctx.putImageData(px, 0, 0)
    if (maskCache.size > 300) maskCache.delete(maskCache.keys().next().value!)
    maskCache.set(key, c)
    onReady()
  }
  img.src = `data:image/png;base64,${mask}`
  return null
}

const Labeler = forwardRef<LabelerHandle, Props>(function Labeler(props, ref) {
  const { data, config, settings, setSettings, setProject, setImages, discovered, mac, onError, onOpenMenu, onChange } = props
  const { project, images, root } = data
  const [index, setIndex] = useState(() => Math.max(0, data.select ? images.findIndex((i) => i.name === data.select) : 0))
  const [query, setQuery] = useState(config.file_search ?? '')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<'name' | 'certainty'>('name')
  const [mode, setModeState] = useState<Mode>('polygon')
  const [activeClass, setActiveClass] = useState<number | null>(0)
  const [shapes, setShapesState] = useState<Shape[]>([])
  const [selected, setSelectedState] = useState<number[]>([])
  const [imageFlags, setImageFlags] = useState<Record<string, boolean>>({})
  const [meta, setMeta] = useState<OpenImage | null>(null)
  const [readOnly, setReadOnly] = useState('')
  const [showShapes, setShowShapes] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [cursor, setCursor] = useState<number[] | null>(null)
  const [saved, setSaved] = useState<'saved' | 'saving' | 'unsaved'>('saved')
  const [loading, setLoading] = useState(false)
  const [busyAi, setBusyAi] = useState('')
  const [newClass, setNewClass] = useState('')
  const [brushSize, setBrushSize] = useState(config.brush.size)
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  const [notice, setNotice] = useState('')
  const [dialog, setDialog] = useState<(LabelRequest & { resolve: (c: LabelChoice | null) => void }) | null>(null)
  const [pointsPrompt, setPointsPrompt] = useState<{ shape: number; edge: number; count: number } | null>(null)
  const [bc, setBc] = useState({ brightness: 1, contrast: 1 })
  const [bcOpen, setBcOpen] = useState(false)
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [download, setDownload] = useState<{ name: string; done: number; total: number } | null>(null)
  const [prelabelModel, setPrelabelModel] = useState<PrelabelModel | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [, setTick] = useState(0)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const view = useRef({ scale: 1, x: 0, y: 0 })
  const shapesRef = useRef<Shape[]>([])
  const selectedRef = useRef<number[]>([])
  const flagsRef = useRef<Record<string, boolean>>({})
  const metaRef = useRef<OpenImage | null>(null)
  const readOnlyRef = useRef('')
  const loadedName = useRef('')
  const alive = useRef(true)
  const history = useRef(new Map<string, { undo: Shape[][]; redo: Shape[][] }>())
  const reviewOnLoad = useRef(false)
  const reviewBack = useRef<string | null>(null)
  const undoOnLoad = useRef(false)
  const overCanvas = useRef(false)
  const draft = useRef<Draft | null>(null)
  const drag = useRef<Drag | null>(null)
  const hover = useRef<Hover>(null)
  const mouse = useRef<number[]>([0, 0])
  const screenMouse = useRef({ x: 0, y: 0 })
  const space = useRef(false)
  const shift = useRef(false)
  const undo = useRef<Shape[][]>([])
  const redo = useRef<Shape[][]>([])
  const tiles = useRef(new Map<string, HTMLImageElement>())
  const frame = useRef(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const pending = useRef<{ name: string; shapes: Shape[]; flags: Record<string, boolean>; size: [number, number] } | null>(null)
  const dirty = useRef(false)
  const saveTarget = useRef<string | null>(null)
  const clipboard = useRef<Shape[]>([])
  const prevShapes = useRef<Shape[]>([])
  const copyOnLoad = useRef(false)
  const bcByImage = useRef(new Map<string, { brightness: number; contrast: number }>())
  const aiSeq = useRef(0)
  const lastScale = useRef<number | null>(null)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // The label list: config labels, then a Seamline project's classes, then labels found in the files
  const classes = useMemo(() => {
    const names: string[] = []
    const add = (n: string) => n && !names.includes(n) && names.push(n)
    ;(config.labels ?? []).forEach(add)
    project.classes.forEach((c) => add(c.name))
    discovered.forEach(add)
    shapes.forEach((s) => add(s.label))
    return names.map((name, i) => ({ name, color: labelColor(name, i, config, project.classes.find((c) => c.name === name)?.color) }))
  }, [config, project.classes, discovered, shapes])
  const opts = useRef({ showShapes, settings, classes, mode, activeClass, brushSize, bc })
  opts.current = { showShapes, settings, classes, mode, activeClass, brushSize, bc }

  const colorOf = useCallback((label: string) => {
    const list = opts.current.classes
    const at = list.findIndex((c) => c.name === label)
    return at >= 0 ? list[at].color : labelColor(label, list.length, config)
  }, [config])
  const currentLabel = () => (activeClass !== null ? classes[activeClass]?.name : undefined)

  const setSelected = (next: number[]) => {
    selectedRef.current = next
    setSelectedState(next)
  }
  const setMode = (m: Mode) => {
    if (readOnlyRef.current && m !== 'edit') return
    draft.current = null
    aiSeq.current++
    setModeState(m)
    invalidate()
  }

  const getTile = (url: string) => {
    const cache = tiles.current
    let img = cache.get(url)
    if (img) {
      cache.delete(url)
      cache.set(url, img)
      return img
    }
    img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => invalidate()
    img.onerror = () => {
      if (metaRef.current && !metaRef.current.pyramid && url === fileUrl(metaRef.current.file)) onError(`The window can't show ${loadedName.current}`)
    }
    img.src = url
    cache.set(url, img)
    if (cache.size > CACHE_TILES) cache.delete(cache.keys().next().value!)
    return img
  }

  const draw = useCallback(() => {
    frame.current = 0
    const canvas = canvasRef.current
    const m = metaRef.current
    if (!canvas || !canvas.clientWidth) return
    const dpr = devicePixelRatio
    const W = canvas.clientWidth, H = canvas.clientHeight
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
    }
    const ctx = canvas.getContext('2d', { alpha: false })!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--canvas').trim() || '#0d0e11'
    ctx.fillRect(0, 0, W, H)
    if (!m) return
    const { scale, x, y } = view.current
    const o = opts.current
    ctx.imageSmoothingEnabled = scale < 2
    if (o.bc.brightness !== 1 || o.bc.contrast !== 1) ctx.filter = `brightness(${o.bc.brightness}) contrast(${o.bc.contrast})`

    const put = (img: HTMLImageElement, ix: number, iy: number, iw: number, ih: number) => {
      if (!img.complete || !img.naturalWidth) return
      const x0 = Math.round(ix * scale + x), y0 = Math.round(iy * scale + y)
      ctx.drawImage(img, x0, y0, Math.round((ix + iw) * scale + x) - x0, Math.round((iy + ih) * scale + y) - y0)
    }
    if (!m.pyramid) {
      put(getTile(fileUrl(m.file)), 0, 0, m.width, m.height)
    } else {
      const { dir, maxLevel, tile } = m.pyramid
      const overview = Math.max(0, Math.ceil(Math.log2(Math.max(m.width, m.height) / tile)))
      const drawLevel = (level: number) => {
        const f = 2 ** (maxLevel - level)
        const c0 = Math.max(0, Math.floor(-x / scale / f / tile))
        const r0 = Math.max(0, Math.floor(-y / scale / f / tile))
        const c1 = Math.min(Math.ceil(m.width / f / tile) - 1, Math.floor((W - x) / scale / f / tile))
        const r1 = Math.min(Math.ceil(m.height / f / tile) - 1, Math.floor((H - y) / scale / f / tile))
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            const img = getTile(fileUrl(`${dir}/${level}/${c}_${r}.jpeg`))
            if (img.naturalWidth) put(img, c * tile * f, r * tile * f, img.naturalWidth * f, img.naturalHeight * f)
          }
        }
      }
      // The whole-image tile fills gaps until sharper tiles arrive
      const coarsest = maxLevel - overview
      const want = Math.min(maxLevel, Math.max(coarsest, maxLevel + Math.ceil(Math.log2(scale * dpr))))
      drawLevel(coarsest)
      if (want !== coarsest) drawLevel(want)
    }
    ctx.filter = 'none'

    const S = (p: Pt): [number, number] => [p[0] * scale + x, p[1] * scale + y]
    const alpha = o.settings.fill
    const pointRadius = config.shape.point_size / 2
    const path = (s: Shape) => {
      ctx.beginPath()
      if (s.shape_type === 'circle' && s.points.length >= 2) {
        const [cx, cy] = S(s.points[0])
        ctx.arc(cx, cy, Math.hypot(s.points[1][0] - s.points[0][0], s.points[1][1] - s.points[0][1]) * scale, 0, Math.PI * 2)
        return
      }
      if (s.shape_type === 'point') {
        const [px, py] = S(s.points[0])
        ctx.arc(px, py, pointRadius + 1, 0, Math.PI * 2)
        return
      }
      const pts = outline(s)
      pts.forEach((p, k) => (k ? ctx.lineTo(...S(p)) : ctx.moveTo(...S(p))))
      if (CLOSED.has(s.shape_type) || s.shape_type === 'points') ctx.closePath()
    }
    const culling = config.performance.enable_viewport_culling
    const sel = new Set(selectedRef.current)
    const hv = hover.current
    if (o.showShapes) {
      shapesRef.current.forEach((s, i) => {
        if (s.hidden) return
        if (culling) {
          const [a, b, c, d] = bounds(s)
          const pad = 10 / scale
          if (c * scale + x < -pad || a * scale + x > W + pad || d * scale + y < -pad || b * scale + y > H + pad) return
        }
        const color = colorOf(s.label)
        const isSel = sel.has(i)
        const isHover = hv?.shape === i
        if (s.shape_type === 'mask' && s.mask && s.points.length >= 2) {
          const c = maskCanvas(s.mask, color, () => invalidate())
          if (c) {
            ctx.globalAlpha = isSel ? Math.min(1, alpha + 0.25) : Math.max(alpha, 0.35)
            const [x0, y0] = S([Math.min(s.points[0][0], s.points[1][0]), Math.min(s.points[0][1], s.points[1][1])])
            ctx.imageSmoothingEnabled = false
            ctx.drawImage(c, x0, y0, c.width * scale, c.height * scale)
            ctx.imageSmoothingEnabled = scale < 2
            ctx.globalAlpha = 1
          }
        }
        path(s)
        const closed = CLOSED.has(s.shape_type) || s.shape_type === 'point'
        if (closed && s.shape_type !== 'mask') {
          ctx.globalAlpha = isSel ? Math.min(1, alpha + 0.2) : isHover ? Math.min(1, alpha + 0.08) : alpha
          ctx.fillStyle = color
          ctx.fill('evenodd')
          ctx.globalAlpha = 1
        }
        ctx.strokeStyle = isSel ? '#ffffff' : color
        ctx.lineWidth = isSel ? 2.5 : isHover ? 2 : 1.5
        ctx.setLineDash(isAi(s) ? [6, 4] : s.shape_type === 'mask' ? [3, 3] : [])
        if (s.shape_type !== 'point' || isSel) ctx.stroke()
        ctx.setLineDash([])
        if (isSel || (isHover && hv && hv.vertex >= 0)) {
          s.points.forEach((p, k) => {
            if (s.shape_type === 'mask') return
            const [px, py] = S(p)
            const lit = isHover && hv?.vertex === k
            ctx.beginPath()
            ctx.arc(px, py, lit ? 6 : 4.5, 0, Math.PI * 2)
            ctx.fillStyle = lit ? '#ffffff' : isSel ? color : '#ffffff'
            ctx.fill()
            ctx.strokeStyle = isSel ? '#ffffff' : color
            ctx.lineWidth = 2
            ctx.stroke()
          })
        }
        if (isHover && hv && hv.vertex < 0 && hv.edge >= 0 && (isSel || shift.current)) {
          const [a, b] = edges(s)[hv.edge] ?? []
          if (a !== undefined) {
            ctx.beginPath()
            ctx.moveTo(...S(s.points[a]))
            ctx.lineTo(...S(s.points[b]))
            ctx.strokeStyle = '#ffffff'
            ctx.lineWidth = 3
            ctx.stroke()
          }
        }
      })
    }

    const current = o.activeClass !== null ? o.classes[o.activeClass]?.color ?? '#ffffff' : '#ffffff'
    const chosen = selectedRef.current.length === 1 ? shapesRef.current[selectedRef.current[0]] : undefined
    const brushColor = chosen && !chosen.hidden ? colorOf(chosen.label) : current
    const d = drag.current
    const erasing = o.mode === 'eraser'
    if (d?.kind === 'stroke') {
      ctx.beginPath()
      d.points.forEach((p, k) => (k ? ctx.lineTo(...S(p)) : ctx.moveTo(...S(p))))
      if (d.points.length === 1) ctx.lineTo(...S(d.points[0]))
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = d.radius * 2 * scale
      ctx.globalAlpha = 0.55
      ctx.strokeStyle = erasing ? '#ffffff' : brushColor
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.lineCap = 'butt'
      ctx.lineJoin = 'miter'
    }
    if ((erasing || o.mode === 'brush') && overCanvas.current) {
      ctx.beginPath()
      ctx.arc(...S(mouse.current), o.brushSize / 2, 0, Math.PI * 2)
      ctx.strokeStyle = erasing ? '#ffffff' : brushColor
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // What's being drawn, and the line or box to the pointer
    const dr = draft.current
    const live = livePoint()
    if (dr && live) {
      const m2 = o.mode
      ctx.strokeStyle = current
      ctx.fillStyle = withAlpha(current, 0.25)
      ctx.lineWidth = 2
      if (m2 === 'ai_polygon' || m2 === 'ai_mask') {
        if (dr.preview) {
          path(dr.preview)
          if (dr.preview.shape_type === 'mask' && dr.preview.mask) {
            const c = maskCanvas(dr.preview.mask, current, () => invalidate())
            if (c) {
              ctx.globalAlpha = 0.45
              const [x0, y0] = S(dr.preview.points[0])
              ctx.imageSmoothingEnabled = false
              ctx.drawImage(c, x0, y0, c.width * scale, c.height * scale)
              ctx.globalAlpha = 1
            }
          } else ctx.fill('evenodd')
          ctx.setLineDash([5, 4])
          ctx.stroke()
          ctx.setLineDash([])
        }
        dr.points.forEach((p, k) => {
          ctx.beginPath()
          ctx.arc(...S(p), 5, 0, Math.PI * 2)
          ctx.fillStyle = dr.labels[k] ? '#3ecf8e' : '#ff6b6b'
          ctx.fill()
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 1.5
          ctx.stroke()
        })
      } else {
        const shape = draftShape(live)
        if (shape) {
          path(shape)
          if (CLOSED.has(shape.shape_type) && (o.settings.fillDrawing || shape.shape_type !== 'polygon')) {
            ctx.fillStyle = withAlpha(current, 0.25)
            ctx.fill('evenodd')
          }
          ctx.strokeStyle = current
          ctx.lineWidth = 2
          ctx.stroke()
        }
        dr.points.forEach((p, k) => {
          ctx.beginPath()
          ctx.arc(...S(p), k === 0 && m2 === 'polygon' ? 6 : 3.5, 0, Math.PI * 2)
          ctx.fillStyle = k === 0 ? current : '#ffffff'
          ctx.fill()
        })
      }
    }
    // labelme's crosshair, per drawing mode
    const ch = config.canvas.crosshair as Record<string, boolean>
    if (overCanvas.current && ch[o.mode] && !d) {
      const [mx, my] = S(mouse.current)
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'
      ctx.lineWidth = 1
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(0, my); ctx.lineTo(W, my); ctx.moveTo(mx, 0); ctx.lineTo(mx, H)
      ctx.stroke()
      ctx.setLineDash([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorOf, config])

  const invalidate = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw)
  }, [draw])

  /** The pointer as a point for the shape being drawn: on the image, as labelme keeps it */
  const livePoint = (): Pt | null => {
    const m = metaRef.current
    const dr = draft.current
    if (!m || !dr) return null
    const last = dr.points[dr.points.length - 1]
    return last ? toEdge(last, mouse.current, m.width, m.height) : mouse.current
  }
  const draftShape = (p: Pt): Shape | null => {
    const dr = draft.current
    if (!dr || !dr.points.length) return null
    const md = opts.current.mode
    const first = dr.points[0]
    // Drawn open until it's closed
    if (md === 'polygon' || md === 'linestrip') return newShape('', 'linestrip', [...dr.points, p])
    if (md === 'rectangle') return newShape('', 'rectangle', [first, shift.current ? squareFrom(first, p) : p])
    if (md === 'circle') return newShape('', 'circle', [first, p])
    if (md === 'line') return newShape('', 'line', [first, p])
    return null
  }

  // Zoom, fit and scroll
  const fitScale = useCallback((how: 'window' | 'width') => {
    const canvas = canvasRef.current, m = metaRef.current
    if (!canvas || !m) return 1
    const pad = 24
    const sw = (canvas.clientWidth - pad * 2) / m.width
    return how === 'width' ? sw : Math.min(sw, (canvas.clientHeight - pad * 2) / m.height)
  }, [])
  const setScale = useCallback((scale: number, at?: { x: number; y: number }) => {
    const canvas = canvasRef.current, m = metaRef.current
    if (!canvas || !m) return
    const max = config.max_zoom / 100
    const next = Math.max(0.005, Math.min(max, scale))
    const px = at?.x ?? canvas.clientWidth / 2, py = at?.y ?? canvas.clientHeight / 2
    const v = view.current
    view.current = { scale: next, x: px - ((px - v.x) / v.scale) * next, y: py - ((py - v.y) / v.scale) * next }
    lastScale.current = next
    setZoom(next)
    invalidate()
  }, [config.max_zoom, invalidate])
  const fit = useCallback((how: 'window' | 'width' = 'window') => {
    const canvas = canvasRef.current, m = metaRef.current
    if (!canvas || !m) return
    const scale = fitScale(how)
    view.current = {
      scale,
      x: (canvas.clientWidth - m.width * scale) / 2,
      y: how === 'width' ? 24 : (canvas.clientHeight - m.height * scale) / 2
    }
    setZoom(scale)
    invalidate()
  }, [fitScale, invalidate])
  const setFit = (f: Settings['fit']) => setSettings((s) => ({ ...s, fit: f }))
  const zoomBy = (factor: number, at?: { x: number; y: number }) => {
    setFit('manual')
    setScale(view.current.scale * factor, at)
  }

  // Saving: a moment after each change when saving is automatic, or when asked
  const doSave = useCallback(async (job: NonNullable<typeof pending.current>, target?: string) => {
    setSaved('saving')
    try {
      const { item } = await window.api.saveLabels(root, job.name, {
        shapes: job.shapes.map(({ hidden: _h, ...s }) => s), flags: job.flags, size: job.size,
        storeData: settingsRef.current.storeData, target
      })
      if (!target) setImages((all) => all.map((i) => (i.name === job.name ? { ...i, ...item } : i)))
      if (pending.current === null && loadedName.current === job.name) dirty.current = false
      setSaved(dirty.current ? 'unsaved' : 'saved')
      return true
    } catch (e) {
      onError(`Save failed: ${plainError(e)}`)
      setSaved('unsaved')
      return false
    }
  }, [root, setImages, onError])

  const flush = useCallback(async () => {
    clearTimeout(saveTimer.current)
    const job = pending.current
    if (!job) return true
    pending.current = null
    return doSave(job, saveTarget.current ?? undefined)
  }, [doSave])

  const queueSave = () => {
    const m = metaRef.current
    const name = loadedName.current
    if (!m || !name || readOnlyRef.current) return
    pending.current = { name, shapes: shapesRef.current, flags: flagsRef.current, size: [m.width, m.height] }
    dirty.current = true
    setSaved('unsaved')
    onChange()
    clearTimeout(saveTimer.current)
    if (settingsRef.current.autoSave) saveTimer.current = setTimeout(flush, 400)
  }

  const apply = (next: Shape[]) => {
    shapesRef.current = next
    setShapesState(next)
    invalidate()
    const name = loadedName.current
    if (!name || readOnlyRef.current) return
    setImages((all) => all.map((i) => (i.name === name ? { ...i, ...summarize(next, true) } : i)))
    queueSave()
  }
  const setShapes = (next: Shape[], record = true) => {
    if (readOnlyRef.current) return
    if (record) {
      undo.current.push(shapesRef.current)
      if (undo.current.length > config.canvas.num_backups) undo.current.shift()
      redo.current = []
    }
    apply(next)
  }
  const setFlagsValue = (next: Record<string, boolean>) => {
    if (readOnlyRef.current) return
    flagsRef.current = next
    setImageFlags(next)
    queueSave()
  }

  /** Before another image or folder opens: save, or ask when saving isn't automatic */
  const canLeave = useCallback(async () => {
    if (!dirty.current) return true
    if (settingsRef.current.autoSave) return flush()
    const name = loadedName.current
    const answer = await window.api.ask(`Save the changes to ${name}?`, "They're lost if you don't save them.", ['Save', "Don't save", 'Cancel'])
    if (answer === 0) return flush()
    if (answer === 1) {
      pending.current = null
      dirty.current = false
      setSaved('saved')
      return true
    }
    return false
  }, [flush])

  // Load the current image; older requests are dropped if you move on quickly
  useEffect(() => {
    const name = images[index]?.name
    if (!name) return
    let stale = false
    setLoading(true)
    const rememberHistory = () => {
      const last = loadedName.current
      if (!last) return
      history.current.delete(last)
      history.current.set(last, { undo: undo.current, redo: redo.current })
      if (history.current.size > HISTORY_IMAGES) history.current.delete(history.current.keys().next().value!)
      bcByImage.current.set(last, opts.current.bc)
    }
    ;(async () => {
      await flush()
      const copy = settingsRef.current.keepPrev || copyOnLoad.current
      copyOnLoad.current = false
      try {
        // Labels last: a big image can take a while, and pre-labelling may write meanwhile
        const m = await window.api.openImage(root, name)
        if (stale) return
        let doc = null
        let broken = ''
        try {
          doc = (await window.api.loadLabels(root, name)).doc
        } catch (e) {
          broken = plainError(e)
        }
        if (stale) return
        rememberHistory()
        const kept = history.current.get(name)
        const fromReview = reviewOnLoad.current
        const undoHere = undoOnLoad.current
        reviewOnLoad.current = false
        undoOnLoad.current = false
        reviewBack.current = fromReview ? loadedName.current : null
        const previous = loadedName.current ? shapesRef.current : []
        // labelme fills in the flags a label's patterns list, keeping the file's values
        let loaded = (doc?.shapes ?? []).map((s) => ({ ...s, flags: { ...flagsFor(s.label, config.label_flags), ...s.flags } }))
        const flags: Record<string, boolean> = {}
        ;(config.flags ?? []).forEach((f) => (flags[f] = false))
        Object.assign(flags, doc?.flags ?? {})
        metaRef.current = m
        loadedName.current = name
        readOnlyRef.current = broken
        setReadOnly(broken)
        saveTarget.current = null
        undo.current = kept?.undo ?? []
        redo.current = kept?.redo ?? []
        draft.current = null
        drag.current = null
        hover.current = null
        flagsRef.current = flags
        setImageFlags(flags)
        let copied = false
        if (copy && !doc && !broken && previous.length) {
          // labelme's "keep previous annotation": an image with no labels starts from the last one's
          loaded = previous.map((s) => ({ ...s, hidden: undefined }))
          copied = true
        }
        prevShapes.current = previous
        shapesRef.current = loaded
        setMeta(m)
        setShapesState(loaded)
        setSelected([])
        dirty.current = false
        pending.current = null
        setSaved('saved')
        if (!settingsRef.current.keepPrevBC) setBc(bcByImage.current.get(name) ?? { brightness: 1, contrast: 1 })
        if (settingsRef.current.keepPrevScale && lastScale.current !== null) {
          const canvas = canvasRef.current!
          const s = lastScale.current
          view.current = { scale: s, x: (canvas.clientWidth - m.width * s) / 2, y: (canvas.clientHeight - m.height * s) / 2 }
          setZoom(s)
        } else fit(settingsRef.current.fit === 'width' ? 'width' : 'window')
        if (copied) queueSave()
        if (broken) onError(`${name}: its label file can't be read, so it's shown without labels and won't be changed. ${broken}`)
        if (undoHere) stepHistory(undo, redo)
        const first = reviewOrder(shapesRef.current)[0]
        if ((fromReview || undoHere) && first !== undefined) selectForReview(first, shapesRef.current)
        invalidate()
      } catch (e) {
        if (stale) return
        onError(`Could not open ${name}: ${plainError(e)}`)
        rememberHistory()
        reviewOnLoad.current = false
        undoOnLoad.current = false
        reviewBack.current = null
        metaRef.current = null
        loadedName.current = ''
        shapesRef.current = []
        undo.current = []
        redo.current = []
        drag.current = null
        draft.current = null
        setMeta(null)
        setShapesState([])
        setSelected([])
        invalidate()
      } finally {
        if (!stale) setLoading(false)
      }
    })()
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, images[index]?.name, root])

  useEffect(invalidate, [showShapes, settings.fill, settings.fillDrawing, selected, mode, activeClass, brushSize, classes, bc, invalidate])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 5000)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    document.querySelector('.shape.on')?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  useEffect(() => {
    document.querySelector('.file.on')?.scrollIntoView({ block: 'nearest' })
  }, [index])
  useEffect(() => {
    const canvas = canvasRef.current!
    const observer = new ResizeObserver(() => {
      const f = settingsRef.current.fit
      if (f !== 'manual' && metaRef.current) fit(f)
      else invalidate()
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [invalidate, fit])
  useEffect(() => () => void flush(), [flush])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => window.api.onPrelabel(({ root: at, name, shapes: found, done, total }) => {
    if (at !== root) return
    setBatch(done >= total ? null : { done, total })
    if (!found) return
    history.current.delete(name)
    if (name === loadedName.current) {
      // Anything being edited here wins: it saves over this result
      if (pending.current || drag.current || shapesRef.current.some((s) => !isAi(s))) return
      shapesRef.current = found
      undo.current = []
      redo.current = []
      setShapesState(found)
      setSelected([])
      invalidate()
    }
    setImages((all) => all.map((i) => (i.name === name ? { ...i, ...summarize(found, true) } : i)))
  }), [invalidate, root, setImages])
  useEffect(() => window.api.onAiDownload((p) => setDownload(p.done >= p.total ? null : p)), [])
  useEffect(() => {
    window.api.aiModels().then(setModels).catch(() => setModels(null))
  }, [])
  useEffect(() => {
    if (!settings.prelabelModel) return setPrelabelModel(null)
    window.api.prelabelInfo(settings.prelabelModel).then(setPrelabelModel).catch(() => setPrelabelModel(null))
  }, [settings.prelabelModel])
  useEffect(() => {
    const broken = images.filter((i) => i.broken)
    if (!broken.length) return
    const list = broken.slice(0, 3).map((i) => i.name).join(', ') + (broken.length > 3 ? ', …' : '')
    onError(`${broken.length} ${broken.length === 1 ? 'label file' : 'label files'} can't be read and won't be changed: ${list}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images.filter((i) => i.broken).length])

  const toImage = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const { scale, x, y } = view.current
    return [(e.clientX - rect.left - x) / scale, (e.clientY - rect.top - y) / scale]
  }
  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  const clampPoint = (p: Pt) => {
    const m = metaRef.current!
    return [Math.max(0, Math.min(m.width, p[0])), Math.max(0, Math.min(m.height, p[1]))]
  }
  const onImage = (p: Pt) => {
    const m = metaRef.current!
    return p[0] >= 0 && p[1] >= 0 && p[0] <= m.width && p[1] <= m.height
  }
  const tolerance = () => config.epsilon / view.current.scale

  const onWheel = (e: React.WheelEvent) => {
    const at = toCanvas(e)
    const zoomWheel = config.canvas.wheel !== 'scroll' || e.ctrlKey || e.metaKey
    if (zoomWheel) {
      zoomBy(Math.exp(-e.deltaY * 0.0022), at)
      return
    }
    // labelme: the wheel scrolls, Shift scrolls sideways
    const v = view.current
    view.current = e.shiftKey ? { ...v, x: v.x - e.deltaY } : { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }
    invalidate()
  }

  /** labelme asks for a label when no class is picked, or always with display_label_popup */
  const askLabel = (request: LabelRequest) =>
    new Promise<LabelChoice | null>((resolve) => setDialog({ ...request, resolve }))
  const finishShape = async (type: ShapeType, points: Pt[], extra: Partial<Shape> = {}) => {
    const m = metaRef.current
    if (!m) return
    const picked = currentLabel()
    let label = picked
    let flags = picked ? flagsFor(picked, config.label_flags) : {}
    let group_id: number | null = null
    let description = ''
    if (config.display_label_popup || !picked) {
      const choice = await askLabel({ text: picked ?? '', flags: null, group_id: null, description: null, at: screenMouse.current })
      if (!choice) {
        // labelme goes back to drawing, so a slip on the last click isn't the end of the shape
        if (type === 'polygon' || type === 'linestrip') draft.current = { points, labels: [], preview: null }
        invalidate()
        return
      }
      label = choice.text
      flags = choice.flags
      group_id = choice.group_id
      description = choice.description
    }
    if (!label) return
    const shape = newShape(label, type, points, { flags, group_id, description, ...extra })
    const next = [...shapesRef.current, shape]
    setShapes(next)
    setSelected([next.length - 1])
    const at = classes.findIndex((c) => c.name === label)
    if (at >= 0) setActiveClass(at)
  }
  const finishDraft = () => {
    const dr = draft.current
    const md = opts.current.mode
    if (!dr) return
    if (md === 'ai_polygon' || md === 'ai_mask') return finishAi()
    draft.current = null
    if (md === 'polygon' && dr.points.length >= 3) finishShape('polygon', dr.points)
    else if (md === 'linestrip' && dr.points.length >= 2) finishShape('linestrip', dr.points)
    invalidate()
  }

  // AI polygon and mask: each click refines the shape, as in labelme
  const runAi = async () => {
    const dr = draft.current
    const m = metaRef.current
    const name = loadedName.current
    if (!dr || !m || !name) return
    const model = settingsRef.current.aiModel
    const info = models?.find((x) => x.name === model)
    if (info && !info.downloaded) {
      const ok = await window.api.ask(`Download ${info.title}?`, `It's ${Math.round(info.size / 1e6)} MB, downloaded once from the address labelme uses, and kept in ~/.cache/osam.`, ['Download', 'Cancel'])
      if (ok !== 0) { draft.current = null; invalidate(); return }
      try {
        setBusyAi('Downloading the model…')
        await window.api.aiDownload(model)
        setModels(await window.api.aiModels())
      } catch (e) {
        onError(`The model couldn't be downloaded: ${plainError(e)}`)
        draft.current = null
        setBusyAi('')
        invalidate()
        return
      }
    }
    const seq = ++aiSeq.current
    setBusyAi('Segmenting…')
    try {
      const result = await window.api.aiSegment(root, name, model, dr.points, dr.labels, opts.current.mode === 'ai_mask' ? 'mask' : 'polygon')
      if (seq !== aiSeq.current || draft.current !== dr || loadedName.current !== name) return
      dr.preview = result.kind === 'polygon' ? newShape('', 'polygon', result.points)
        : result.kind === 'mask' ? newShape('', 'mask', result.box, { mask: result.mask }) : null
      if (result.kind === 'none') setNotice('The model found nothing there. Try another point.')
      invalidate()
    } catch (e) {
      if (seq === aiSeq.current) onError(`AI segmentation failed: ${plainError(e)}`)
    } finally {
      if (seq === aiSeq.current) setBusyAi('')
    }
  }
  const finishAi = async () => {
    const dr = draft.current
    if (!dr) return
    // Wait for the last click's result
    while (busyAiRef.current && draft.current === dr) await new Promise((r) => setTimeout(r, 30))
    if (draft.current !== dr || !dr.preview) return
    draft.current = null
    const p = dr.preview
    await finishShape(p.shape_type, p.points, p.mask ? { mask: p.mask } : {})
    invalidate()
  }
  const busyAiRef = useRef('')
  busyAiRef.current = busyAi

  const hitShape = (p: Pt) => {
    const list = shapesRef.current
    const tol = tolerance()
    for (let i = list.length - 1; i >= 0; i--) {
      if (!list[i].hidden && contains(list[i], p, tol)) return i
    }
    return -1
  }
  const findHover = (p: Pt): Hover => {
    const list = shapesRef.current
    const tol = tolerance()
    // Vertices of the selection first, then of whatever is on top, as labelme does
    const order = [...selectedRef.current, ...list.map((_, i) => list.length - 1 - i).filter((i) => !selectedRef.current.includes(i))]
    for (const i of order) {
      const s = list[i]
      // A lock keeps a shape's geometry; an oriented rectangle's corners move together
      if (!s || s.hidden || s.locked || s.shape_type === 'mask' || s.shape_type === 'oriented_rectangle') continue
      const v = nearestVertex(s, p, tol)
      if (v >= 0) return { shape: i, vertex: v, edge: -1 }
    }
    for (const i of order) {
      const s = list[i]
      if (!s || s.hidden || s.locked) continue
      const e = nearestEdge(s, p, tol)
      if (e >= 0) return { shape: i, vertex: -1, edge: e }
    }
    const inside = hitShape(p)
    return inside >= 0 ? { shape: inside, vertex: -1, edge: -1 } : null
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const m = metaRef.current
    if (!m || loadedName.current !== images[index]?.name) return
    canvasRef.current!.setPointerCapture(e.pointerId)
    canvasRef.current!.focus()
    const p = toImage(e)
    const press = [e.clientX, e.clientY]
    if (e.button === 1 || e.button === 2 || space.current) {
      drag.current = { kind: 'pan', x: e.clientX, y: e.clientY, press, button: e.button, moved: false }
      return
    }
    if (e.button !== 0) return
    const md = mode
    const ro = !!readOnlyRef.current
    if (!ro && (md === 'polygon' || md === 'linestrip')) {
      const dr = draft.current
      if (dr) {
        const q = livePoint()!
        const first = dr.points[0]
        const closeTo = config.epsilon / view.current.scale
        if (md === 'polygon' && dr.points.length >= 3 && Math.hypot(q[0] - first[0], q[1] - first[1]) < closeTo) return finishDraft()
        dr.points.push(q)
        if (md === 'linestrip' && (e.ctrlKey || e.metaKey)) return finishDraft()
        invalidate()
      } else if (onImage(p)) {
        draft.current = { points: [p], labels: [], preview: null }
        invalidate()
      }
      return
    }
    if (!ro && (md === 'rectangle' || md === 'circle' || md === 'line')) {
      const dr = draft.current
      if (dr) {
        const q = livePoint()!
        draft.current = null
        const second = md === 'rectangle' && e.shiftKey ? squareFrom(dr.points[0], q) : q
        if (Math.hypot(second[0] - dr.points[0][0], second[1] - dr.points[0][1]) > 0.5) finishShape(md, [dr.points[0], second])
        invalidate()
      } else if (onImage(p)) {
        draft.current = { points: [p], labels: [], preview: null }
        drag.current = { kind: 'two', press }
        invalidate()
      }
      return
    }
    if (!ro && md === 'point') {
      if (onImage(p)) finishShape('point', [p])
      return
    }
    if (!ro && (md === 'ai_polygon' || md === 'ai_mask')) {
      if (!onImage(p)) return
      const dr = draft.current ?? (draft.current = { points: [], labels: [], preview: null })
      dr.points.push(p)
      dr.labels.push(e.shiftKey ? 0 : 1)
      invalidate()
      runAi().then(() => {
        if (e.ctrlKey || e.metaKey) finishAi()
      })
      return
    }
    if (!ro && (md === 'brush' || md === 'eraser')) {
      drag.current = { kind: 'stroke', points: [p], radius: brushSize / 2 / view.current.scale }
      invalidate()
      return
    }
    // Edit
    const list = shapesRef.current
    const h = findHover(p)
    const multi = e.ctrlKey || e.metaKey
    if (h && !ro) {
      const s = list[h.shape]
      if (h.vertex >= 0 && e.altKey) {
        // Alt+click, or labelme's Alt+Shift+click, takes a point away
        if (canRemovePoint(s)) setShapes(list.map((q, i) => (i === h.shape ? { ...accepted(q), points: q.points.filter((_, k) => k !== h.vertex) } : q)))
        hover.current = null
        return
      }
      if (h.vertex < 0 && h.edge >= 0 && e.altKey) {
        // labelme's Alt+click on an edge adds a point there, and it can be dragged at once
        const point = clampPoint(p)
        const start = list
        const next = list.map((q, i) => (i === h.shape ? insertPoint(q, h.edge, point) : q))
        // Recorded for undo when the button comes up, like any other drag
        shapesRef.current = next
        setShapesState(next)
        setSelected([h.shape])
        drag.current = { kind: 'vertex', shape: h.shape, vertex: edges(s)[h.edge][0] + 1, press, active: true, start }
        invalidate()
        return
      }
      if (h.vertex >= 0) {
        if (!selectedRef.current.includes(h.shape)) setSelected([h.shape])
        drag.current = { kind: 'vertex', shape: h.shape, vertex: h.vertex, press, active: false, start: list }
        return
      }
    }
    const hit = hitShape(p)
    if (hit >= 0) {
      const sel = selectedRef.current
      if (multi) {
        setSelected(sel.includes(hit) ? sel.filter((i) => i !== hit) : [...sel, hit])
        return
      }
      const moving = (sel.includes(hit) ? sel : [hit]).filter((i) => !list[i].locked)
      if (!sel.includes(hit)) setSelected([hit])
      if (!ro && moving.length) drag.current = { kind: 'move', shapes: moving, x: p[0], y: p[1], press, active: false, start: list }
      return
    }
    if (!multi) setSelected([])
    drag.current = { kind: 'pan', x: e.clientX, y: e.clientY, press, button: 0, moved: false }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toImage(e)
    mouse.current = p
    screenMouse.current = { x: e.clientX, y: e.clientY }
    shift.current = e.shiftKey
    setCursor(p)
    overCanvas.current = true
    const d = drag.current
    if (!d) {
      if (mode === 'edit' && metaRef.current) {
        const h = findHover(p)
        const before = hover.current
        if (h?.shape !== before?.shape || h?.vertex !== before?.vertex || h?.edge !== before?.edge) {
          hover.current = h
          const c = canvasRef.current!
          c.style.cursor = h?.vertex !== undefined && h.vertex >= 0 ? 'move' : h?.edge !== undefined && h.edge >= 0 && e.altKey ? 'copy' : h ? 'pointer' : ''
          invalidate()
        }
      }
      if (draft.current || mode === 'brush' || mode === 'eraser' || (config.canvas.crosshair as Record<string, boolean>)[mode]) invalidate()
      return
    }
    if ((d.kind === 'vertex' || d.kind === 'move' || d.kind === 'pan') && !('active' in d ? d.active : d.moved)) {
      // A slip of the hand during a click isn't a drag
      if (Math.hypot(e.clientX - d.press[0], e.clientY - d.press[1]) < DRAG_START) return
      if (d.kind === 'pan') d.moved = true
      else d.active = true
    }
    const m = metaRef.current
    if (d.kind === 'pan') {
      view.current.x += e.clientX - d.x
      view.current.y += e.clientY - d.y
      d.x = e.clientX
      d.y = e.clientY
      if (settingsRef.current.fit !== 'manual') setFit('manual')
    } else if (d.kind === 'stroke') {
      const last = d.points[d.points.length - 1]
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= d.radius * 0.4) d.points.push(p)
    } else if (d.kind === 'vertex' && m) {
      const s = d.start[d.shape]
      let q = clampPoint(p)
      // Shift keeps a rectangle square while a corner moves, as in labelme
      if (s.shape_type === 'rectangle' && e.shiftKey && s.points.length === 2) q = squareFrom(s.points[1 - d.vertex], q)
      shapesRef.current = shapesRef.current.map((x, i) =>
        i === d.shape ? { ...x, points: x.points.map((pt, k) => (k === d.vertex ? q : pt)) } : x
      )
    } else if (d.kind === 'move' && m) {
      const dx = p[0] - d.x, dy = p[1] - d.y
      const before = shapesRef.current
      const next = moveShapes(before, d.shapes, dx, dy, m.width, m.height)
      if (next !== before) {
        // Only the part of the move that fits is applied, so the grip point follows that
        const moved = next[d.shapes[0]].points[0][0] - before[d.shapes[0]].points[0][0]
        const movedY = next[d.shapes[0]].points[0][1] - before[d.shapes[0]].points[0][1]
        d.x += moved
        d.y += movedY
        shapesRef.current = next
      }
    }
    invalidate()
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.kind === 'stroke') {
      commitStroke(d.points, d.radius)
      invalidate()
    } else if (d.kind === 'two') {
      // A drag draws the shape in one go; a click waits for the second click, as labelme does
      const dr = draft.current
      if (dr && Math.hypot(e.clientX - d.press[0], e.clientY - d.press[1]) >= DRAG_START) {
        const q = livePoint()!
        const second = mode === 'rectangle' && e.shiftKey ? squareFrom(dr.points[0], q) : q
        draft.current = null
        if (Math.hypot(second[0] - dr.points[0][0], second[1] - dr.points[0][1]) > 0.5) finishShape(mode as ShapeType, [dr.points[0], second])
      }
      invalidate()
    } else if (d.kind === 'vertex' || d.kind === 'move') {
      // A click only selects: looking at an AI shape must not accept it
      if (!d.active) {
        shapesRef.current = d.start
        return
      }
      const moved = new Set(d.kind === 'vertex' ? [d.shape] : d.shapes)
      undo.current.push(d.start)
      if (undo.current.length > config.canvas.num_backups) undo.current.shift()
      redo.current = []
      apply(shapesRef.current.map((s, i) => (moved.has(i) && isAi(s) ? accepted(s) : s)))
    } else if (d.kind === 'pan' && d.button === 2 && !d.moved) {
      onOpenMenu(e.clientX, e.clientY)
    }
  }

  const commitStroke = (points: number[][], radius: number) => {
    const m = metaRef.current!
    const list = shapesRef.current
    try {
      const region = strokeRegion(points, radius, 0.5 / view.current.scale, [m.width, m.height])
      if (!region.length) return
      const only = selectedRef.current.length === 1 ? selectedRef.current[0] : null
      if (mode === 'eraser') {
        const result = eraseShapes(list, region, only)
        if (result.shapes !== list) {
          setShapes(result.shapes)
          setSelected(result.selected === null ? [] : [result.selected])
        }
        return
      }
      // Painting with a shape selected continues that shape's class
      const label = (only !== null && list[only]?.label) || currentLabel()
      if (!label) return setNotice('Pick a class in the Labels list to paint with.')
      const at = classes.findIndex((c) => c.name === label)
      if (at >= 0) setActiveClass(at)
      setSelected([])
      setShapes(paintShapes(list, region, label))
    } catch (err) {
      onError(`That stroke couldn't be applied, so the shapes are unchanged: ${plainError(err)}`)
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (readOnlyRef.current) return
    if (mode === 'polygon' || mode === 'linestrip') {
      const dr = draft.current
      if (!dr || config.canvas.double_click !== 'close') return
      // The second click of the double-click added a point already
      dr.points = dr.points.slice(0, -1)
      finishDraft()
      return
    }
    if (mode === 'ai_polygon' || mode === 'ai_mask') {
      if (config.canvas.double_click === 'close') finishAi()
      return
    }
    if (mode !== 'edit') return
    const p = toImage(e)
    const h = findHover(p)
    if (h && h.vertex < 0 && h.edge >= 0) {
      setShapes(shapesRef.current.map((q, i) => (i === h.shape ? insertPoint(q, h.edge, clampPoint(p)) : q)))
      setSelected([h.shape])
      return
    }
    const hit = hitShape(p)
    if (hit >= 0) {
      setSelected([hit])
      editLabel([hit])
    }
  }

  const stepHistory = (from: typeof undo, to: typeof undo) => {
    if (readOnlyRef.current) return
    const prev = from.current.pop()
    if (!prev) {
      // Right after a review jump, the last thing done was on the image before
      const back = from === undo && reviewBack.current ? images.findIndex((i) => i.name === reviewBack.current) : -1
      if (back >= 0) {
        undoOnLoad.current = true
        setIndex(back)
      }
      return
    }
    to.current.push(shapesRef.current)
    setSelected([])
    apply(prev)
  }
  const removeSelected = () => {
    const sel = new Set(selectedRef.current.filter((i) => !shapesRef.current[i]?.locked))
    if (sel.size < selectedRef.current.length) setNotice('Locked shapes stay: unlock them first.')
    if (!sel.size) return
    setShapes(shapesRef.current.filter((_, i) => !sel.has(i)))
    setSelected([])
  }
  const relabel = (which: number[], label: string) => {
    if (!which.length) return
    setShapes(shapesRef.current.map((s, k) => (which.includes(k) ? { ...accepted(s), label, flags: { ...flagsFor(label, config.label_flags, s.flags), ...accepted(s).flags } } : s)))
  }
  const chooseClass = (i: number) => {
    setActiveClass(i)
    if (selectedRef.current.length) relabel(selectedRef.current, classes[i].name)
  }

  /** labelme's Edit Label: fields that differ across the selection can't be changed */
  const editLabel = async (which = selectedRef.current) => {
    if (!which.length || readOnlyRef.current) return
    const list = which.map((i) => shapesRef.current[i])
    const [first] = list
    const same = <K extends keyof Shape>(k: K) => list.every((s) => JSON.stringify(s[k]) === JSON.stringify(first[k]))
    const locked = { text: !same('label'), flags: !same('flags'), group_id: !same('group_id'), description: !same('description') }
    const choice = await askLabel({
      text: locked.text ? '' : first.label,
      flags: locked.flags ? null : accepted(first).flags,
      group_id: locked.group_id ? null : first.group_id,
      description: locked.description ? null : first.description,
      locked, title: 'Edit label', at: screenMouse.current
    })
    if (!choice) return
    setShapes(shapesRef.current.map((s, i) => {
      if (!which.includes(i)) return s
      const a = accepted(s)
      return {
        ...a,
        label: locked.text ? a.label : choice.text,
        flags: locked.flags ? a.flags : choice.flags,
        group_id: locked.group_id ? a.group_id : choice.group_id,
        description: locked.description ? a.description : choice.description
      }
    }))
  }

  const visible = useMemo(() => {
    const test = FILTERS.find((f) => f.key === filter)!.test
    let match: (name: string) => boolean
    try {
      // labelme's file search is a regular expression; one that isn't valid filters as plain text
      const re = new RegExp(query, 'i')
      match = (n) => re.test(n)
    } catch {
      match = (n) => n.toLowerCase().includes(query.toLowerCase())
    }
    const list = images.map((image, i) => ({ image, i })).filter(({ image }) => (!query || match(image.name)) && test(image))
    if (sort === 'certainty') {
      const rank = (i: ImageItem) => (i.ai ? i.score ?? 1 : 2)
      list.sort((a, b) => rank(a.image) - rank(b.image) || a.i - b.i)
    }
    return list
  }, [images, query, filter, sort])

  const goTo = useCallback(async (i: number, copy = false) => {
    if (i === index || i < 0 || i >= images.length) return
    if (!(await canLeave())) return
    copyOnLoad.current = copy
    setIndex(i)
  }, [index, images.length, canLeave])
  const go = (delta: number, copy = false) => {
    const at = visible.findIndex((v) => v.i === index)
    const next = visible[Math.max(0, Math.min(visible.length - 1, (at < 0 ? 0 : at) + delta))]
    if (next) goTo(next.i, copy)
  }

  // Bring a shape into view: closer in if it's off screen or too small to judge
  const focusShape = (s: Shape) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const [x0, y0, x1, y1] = bounds(s)
    const W = canvas.clientWidth, H = canvas.clientHeight
    const { scale, x, y } = view.current
    const seen = x0 * scale + x >= 0 && y0 * scale + y >= 0 && x1 * scale + x <= W && y1 * scale + y <= H
    const large = Math.max(x1 - x0, y1 - y0) * scale >= 80
    if (seen && large) return
    const fits = (x1 - x0) * scale <= W && (y1 - y0) * scale <= H
    const next = large && fits ? scale : Math.min(8, W / ((x1 - x0 || 1) * 3), H / ((y1 - y0 || 1) * 3))
    view.current = { scale: next, x: W / 2 - ((x0 + x1) / 2) * next, y: H / 2 - ((y0 + y1) / 2) * next }
    setFit('manual')
    setZoom(next)
    invalidate()
  }
  const selectForReview = (i: number, list: Shape[]) => {
    setSelected([i])
    setMode('edit')
    focusShape(list[i])
  }
  const nextReviewImage = () => {
    const at = visible.findIndex((v) => v.i === index)
    const order = [...visible.slice(at + 1), ...visible.slice(0, Math.max(at, 0))]
    const next = order.find((v) => v.i !== index && v.image.ai > 0)
    setSelected([])
    if (!next) return setNotice('Nothing left to review in this list.')
    reviewOnLoad.current = true
    goTo(next.i)
  }
  const reviewNext = (list: Shape[]) => {
    const first = reviewOrder(list)[0]
    if (first !== undefined) selectForReview(first, list)
    else nextReviewImage()
  }
  // Only once this image's shapes are in: keys can arrive faster than images load
  const reviewReady = () => !drag.current && loadedName.current === images[index]?.name && !readOnlyRef.current
  const one = () => (selectedRef.current.length === 1 ? selectedRef.current[0] : null)
  const acceptSelected = () => {
    if (!reviewReady()) return
    const list = shapesRef.current
    const s = one()
    if (s === null || !isAi(list[s])) return reviewNext(list)
    const next = list.map((x, i) => (i === s ? accepted(x) : x))
    setShapes(next)
    reviewNext(next)
  }
  const rejectSelected = () => {
    if (!reviewReady()) return
    const list = shapesRef.current
    const s = one()
    if (s === null || !isAi(list[s])) return reviewNext(list)
    const next = list.filter((_, i) => i !== s)
    setShapes(next)
    reviewNext(next)
  }
  const skipShape = () => {
    if (!reviewReady()) return
    const list = shapesRef.current
    const order = reviewOrder(list)
    if (!order.length) return nextReviewImage()
    selectForReview(order[(order.indexOf(one() ?? -1) + 1) % order.length], list)
  }
  const acceptAll = () => {
    if (!reviewReady()) return
    if (shapesRef.current.some(isAi)) setShapes(shapesRef.current.map((s) => (isAi(s) ? accepted(s) : s)))
    nextReviewImage()
  }

  const copySelected = () => {
    const sel = selectedRef.current
    if (!sel.length) return
    clipboard.current = sel.map((i) => ({ ...shapesRef.current[i], hidden: undefined }))
    setTick((t) => t + 1)
  }
  const paste = () => {
    if (!clipboard.current.length || readOnlyRef.current || !metaRef.current) return
    // Pasted onto a smaller image, shapes are kept inside it
    const fitIn = clipboard.current.map((s) => ({ ...s, points: s.points.map(clampPoint) }))
    const next = [...shapesRef.current, ...fitIn]
    setShapes(next)
    setSelected(fitIn.map((_, k) => next.length - fitIn.length + k))
  }
  const duplicate = () => {
    copySelected()
    paste()
  }
  const merge = () => {
    const result = mergePolygons(shapesRef.current, selectedRef.current.filter((i) => !shapesRef.current[i]?.locked))
    if (!result) return setNotice('Select two or more polygons or boxes to merge.')
    setShapes(result.shapes)
    setSelected(result.selected)
  }
  const removeHoveredPoint = () => {
    const h = hover.current
    const list = shapesRef.current
    if (!h || h.vertex < 0 || !canRemovePoint(list[h.shape])) return false
    setShapes(list.map((q, i) => (i === h.shape ? { ...accepted(q), points: q.points.filter((_, k) => k !== h.vertex) } : q)))
    hover.current = null
    return true
  }
  const addMultiplePoints = () => {
    const h = hover.current
    if (!h || h.edge < 0) return setNotice('Point at a polygon edge first, then Ctrl+M.')
    setPointsPrompt({ shape: h.shape, edge: h.edge, count: config.default_num_points_to_add })
  }
  const nudge = (dx: number, dy: number) => {
    const m = metaRef.current
    const which = selectedRef.current.filter((i) => !shapesRef.current[i]?.locked)
    if (!m || !which.length) return
    const next = moveShapes(shapesRef.current, which, dx, dy, m.width, m.height)
    if (next !== shapesRef.current) setShapes(next)
  }
  const undoLastPoint = () => {
    const dr = draft.current
    if (!dr) return false
    dr.points.pop()
    dr.labels.pop()
    if (!dr.points.length) draft.current = null
    else if (mode === 'ai_polygon' || mode === 'ai_mask') runAi()
    invalidate()
    return true
  }
  const deleteLabelFile = async () => {
    const name = loadedName.current
    if (!name) return
    const file = await window.api.labelPath(root, name)
    const answer = await window.api.ask(`Delete the label file of ${name}?`, `${file} goes to the trash.`, ['Delete', 'Cancel'])
    if (answer !== 0) return
    clearTimeout(saveTimer.current)
    pending.current = null
    dirty.current = false
    try {
      await window.api.trashLabels(root, name)
      history.current.delete(name)
      setImages((all) => all.map((i) => (i.name === name ? { ...i, ...summarize([], false), broken: undefined } : i)))
      shapesRef.current = []
      setShapesState([])
      setSelected([])
      readOnlyRef.current = ''
      setReadOnly('')
      undo.current = []
      redo.current = []
      invalidate()
    } catch (e) {
      onError(`It couldn't be deleted: ${plainError(e)}`)
    }
  }
  const saveAs = async () => {
    const name = loadedName.current
    if (!name || !metaRef.current) return
    const target = await window.api.pickSave('Save labels as', await window.api.labelPath(root, name))
    if (!target) return
    saveTarget.current = target
    pending.current = { name, shapes: shapesRef.current, flags: flagsRef.current, size: [metaRef.current.width, metaRef.current.height] }
    await flush()
  }
  const saveNow = async () => {
    const name = loadedName.current
    if (!name || !metaRef.current || readOnlyRef.current) return
    pending.current = { name, shapes: shapesRef.current, flags: flagsRef.current, size: [metaRef.current.width, metaRef.current.height] }
    await flush()
  }

  // Pre-labelling with a segmentation model, as in Seamline
  const toPrelabel = images.filter((i) => !i.broken && !i.count && !(i.labelled && !i.ai))
  const pickModel = async () => {
    try {
      const model = await window.api.prelabelPick()
      if (model) setSettings((s) => ({ ...s, prelabelModel: model.path }))
      return model
    } catch (e) {
      onError(plainError(e))
      return null
    }
  }
  const modelClasses = (model: PrelabelModel) => (model.classes.length ? model.classes : classes.map((c) => c.name))
  const prelabelOne = async () => {
    const model = prelabelModel ?? (await pickModel())
    if (!model) return
    const name = loadedName.current
    if (!name || readOnlyRef.current) return
    setBusyAi('Predicting…')
    try {
      await flush()
      const result = await window.api.prelabelRun(root, model.path, [name], modelClasses(model))
      if (result.error) onError(`Pre-label failed: ${result.error}`)
      else if (result.failed.length) onError(`Pre-label failed: ${result.failed[0]}`)
    } catch (e) {
      onError(`Pre-label failed: ${plainError(e)}`)
    } finally {
      setBusyAi('')
      setBatch(null)
    }
  }
  const prelabelAll = async () => {
    const model = prelabelModel ?? (await pickModel())
    if (!model) return
    await flush()
    setBatch({ done: 0, total: toPrelabel.length })
    try {
      const result = await window.api.prelabelRun(root, model.path, toPrelabel.map((i) => i.name), modelClasses(model))
      setNotice(`${result.stopped ? 'Stopped after' : 'Pre-labelled'} ${result.done} of ${result.total} images.`)
      if (result.error) onError(`Pre-labelling stopped early: ${result.error}`)
      else if (result.failed.length) onError(`${result.failed.length} ${result.failed.length === 1 ? 'image' : 'images'} failed. First: ${result.failed[0]}`)
    } catch (e) {
      onError(`Pre-label failed: ${plainError(e)}`)
    } finally {
      setBatch(null)
    }
  }

  const addClass = () => {
    const name = newClass.trim()
    if (!name || classes.some((c) => c.name === name)) return
    if (config.validate_label === 'exact' && !config.labels?.includes(name)) return onError(`“${name}” isn't in the label list, and only listed labels are allowed.`)
    const color = labelColor(name, classes.length, config)
    setProject({ ...project, classes: [...classes.map((c) => ({ name: c.name, color: c.color })), { name, color }] })
    setActiveClass(classes.length)
    setNewClass('')
  }
  const recolor = (name: string, color: string) => {
    setProject({ ...project, classes: classes.map((c) => ({ name: c.name, color: c.name === name ? color : c.color })) })
  }

  const has = () => !!metaRef.current && !readOnlyRef.current
  const sel = () => selectedRef.current.length > 0
  const commands: Commands = {
    open_next: { label: 'Next image', run: () => go(1), shortcut: 'open_next', enabled: () => images.length > 1 },
    open_prev: { label: 'Previous image', run: () => go(-1), shortcut: 'open_prev', enabled: () => images.length > 1 },
    save: { label: 'Save', run: saveNow, shortcut: 'save', enabled: has },
    save_as: { label: 'Save as…', run: saveAs, shortcut: 'save_as', enabled: has },
    delete_file: { label: 'Delete label file', run: deleteLabelFile, shortcut: 'delete_file', enabled: () => !!images[index]?.labelled },
    auto_save: { label: 'Save automatically', run: () => setSettings((s) => ({ ...s, autoSave: !s.autoSave })), checked: () => settings.autoSave },
    store_data: { label: 'Save with image data', run: () => setSettings((s) => ({ ...s, storeData: !s.storeData })), checked: () => settings.storeData },
    reveal: { label: 'Show in folder', run: () => loadedName.current && window.api.reveal(root, loadedName.current), enabled: () => !!loadedName.current },

    create_polygon: { label: 'Create polygons', run: () => setMode('polygon'), shortcut: 'create_polygon', checked: () => mode === 'polygon', enabled: has },
    create_rectangle: { label: 'Create rectangle', run: () => setMode('rectangle'), shortcut: 'create_rectangle', checked: () => mode === 'rectangle', enabled: has },
    create_circle: { label: 'Create circle', run: () => setMode('circle'), shortcut: 'create_circle', checked: () => mode === 'circle', enabled: has },
    create_line: { label: 'Create line', run: () => setMode('line'), shortcut: 'create_line', checked: () => mode === 'line', enabled: has },
    create_point: { label: 'Create point', run: () => setMode('point'), shortcut: 'create_point', checked: () => mode === 'point', enabled: has },
    create_linestrip: { label: 'Create line strip', run: () => setMode('linestrip'), shortcut: 'create_linestrip', checked: () => mode === 'linestrip', enabled: has },
    create_ai_polygon: { label: 'Create AI polygon', run: () => setMode('ai_polygon'), shortcut: 'create_ai_polygon', checked: () => mode === 'ai_polygon', enabled: () => has() && !!models },
    create_ai_mask: { label: 'Create AI mask', run: () => setMode('ai_mask'), shortcut: 'create_ai_mask', checked: () => mode === 'ai_mask', enabled: () => has() && !!models },
    create_brush: { label: 'Brush', run: () => setMode('brush'), shortcut: 'create_brush', checked: () => mode === 'brush', enabled: has },
    create_eraser: { label: 'Eraser', run: () => setMode('eraser'), shortcut: 'create_eraser', checked: () => mode === 'eraser', enabled: has },
    edit_polygon: { label: 'Edit polygons', run: () => setMode('edit'), shortcut: 'edit_polygon', checked: () => mode === 'edit' },
    edit_label: { label: 'Edit label…', run: () => editLabel(), shortcut: 'edit_label', enabled: () => has() && sel() },
    duplicate_polygon: { label: 'Duplicate', run: duplicate, shortcut: 'duplicate_polygon', enabled: () => has() && sel() },
    copy_polygon: { label: 'Copy', run: copySelected, shortcut: 'copy_polygon', enabled: sel },
    paste_polygon: { label: 'Paste', run: paste, shortcut: 'paste_polygon', enabled: () => has() && clipboard.current.length > 0 },
    delete_polygon: { label: 'Delete', run: removeSelected, shortcut: 'delete_polygon', enabled: () => has() && sel() },
    merge_polygons: { label: 'Merge polygons', run: merge, shortcut: 'merge_polygons', enabled: () => has() && selectedRef.current.length >= 2 },
    undo: { label: 'Undo', run: () => (undoLastPoint() || stepHistory(undo, redo)), shortcut: 'undo', enabled: () => has() && (undo.current.length > 0 || !!draft.current || !!reviewBack.current) },
    redo: { label: 'Redo', run: () => stepHistory(redo, undo), shortcut: 'redo', enabled: () => has() && redo.current.length > 0 },
    remove_selected_point: { label: 'Remove point', run: removeHoveredPoint, shortcut: 'remove_selected_point', enabled: has },
    add_multiple_points: { label: 'Add points to edge…', run: addMultiplePoints, shortcut: 'add_multiple_points', enabled: has },
    toggle_lock: {
      label: 'Lock shapes', run: () => {
        const which = selectedRef.current
        const lock = !which.every((i) => shapesRef.current[i]?.locked)
        setShapes(shapesRef.current.map((x, i) => (which.includes(i) ? { ...x, locked: lock || undefined } : x)))
      },
      enabled: () => has() && sel(), checked: () => sel() && selectedRef.current.every((i) => shapesRef.current[i]?.locked)
    },
    toggle_keep_prev_mode: { label: 'Keep previous annotation', run: () => setSettings((s) => ({ ...s, keepPrev: !s.keepPrev })), shortcut: 'toggle_keep_prev_mode', checked: () => settings.keepPrev },

    fill_drawing: { label: 'Fill polygon while drawing', run: () => setSettings((s) => ({ ...s, fillDrawing: !s.fillDrawing })), checked: () => settings.fillDrawing },
    hide_all_polygons: { label: 'Hide shapes', run: () => setShowShapes(false), shortcut: 'hide_all_polygons' },
    show_all_polygons: { label: 'Show shapes', run: () => setShowShapes(true), shortcut: 'show_all_polygons' },
    toggle_all_polygons: { label: 'Show shapes', run: () => setShowShapes((v) => !v), shortcut: 'toggle_all_polygons', checked: () => showShapes },
    zoom_in: { label: 'Zoom in', run: () => zoomBy(config.zoom_increment), shortcut: 'zoom_in', enabled: () => !!metaRef.current },
    zoom_out: { label: 'Zoom out', run: () => zoomBy(1 / config.zoom_increment), shortcut: 'zoom_out', enabled: () => !!metaRef.current },
    zoom_to_original: { label: 'Original size', run: () => { setFit('manual'); setScale(1) }, shortcut: 'zoom_to_original', enabled: () => !!metaRef.current },
    fit_window: { label: 'Fit window', run: () => { setFit('window'); fit('window') }, shortcut: 'fit_window', checked: () => settings.fit === 'window' },
    fit_width: { label: 'Fit width', run: () => { setFit('width'); fit('width') }, shortcut: 'fit_width', checked: () => settings.fit === 'width' },
    keep_prev_scale: { label: 'Keep previous scale', run: () => setSettings((s) => ({ ...s, keepPrevScale: !s.keepPrevScale })), checked: () => settings.keepPrevScale },
    brightness_contrast: { label: 'Brightness and contrast…', run: () => setBcOpen(true), enabled: () => !!metaRef.current },
    keep_prev_brightness_contrast: { label: 'Keep previous brightness and contrast', run: () => setSettings((s) => ({ ...s, keepPrevBC: !s.keepPrevBC })), checked: () => settings.keepPrevBC },

    review_accept: { label: 'Accept AI shape', run: acceptSelected, shortcut: 'review_accept' },
    review_reject: { label: 'Reject AI shape', run: rejectSelected, shortcut: 'review_reject' },
    review_skip: { label: 'Skip AI shape', run: skipShape, shortcut: 'review_skip' },
    review_accept_all: { label: 'Accept all here, then next', run: acceptAll, shortcut: 'review_accept_all' },
    order_certainty: { label: 'Least certain first', run: () => setSort((s) => (s === 'certainty' ? 'name' : 'certainty')), checked: () => sort === 'certainty' },
    prelabel_pick: { label: 'Choose a model…', run: pickModel },
    prelabel_one: { label: 'Pre-label this image', run: prelabelOne, enabled: () => has() && !batch && !busyAi },
    prelabel_all: { label: `Pre-label ${toPrelabel.length} images`, run: prelabelAll, enabled: () => !batch && toPrelabel.length > 0 },
    brush_smaller: { label: 'Smaller brush', run: () => setBrushSize((s) => Math.max(config.brush.min, s - 4)), shortcut: 'brush_smaller' },
    brush_larger: { label: 'Larger brush', run: () => setBrushSize((s) => Math.min(config.brush.max, s + 4)), shortcut: 'brush_larger' }
  }
  for (const m of models ?? []) {
    commands[`ai_model:${m.name}`] = { label: m.title, run: () => setSettings((s) => ({ ...s, aiModel: m.name })), checked: () => settings.aiModel === m.name }
  }
  const commandsRef = useRef(commands)
  commandsRef.current = commands
  useImperativeHandle(ref, () => ({
    get commands() { return commandsRef.current },
    canLeave
  }), [canLeave])

  // Keys: the configurable shortcuts, then the fixed ones (classes, Escape, arrows)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (dialog || pointsPrompt || bcOpen) return
      if (target.closest?.('.menubar, .menu')) return
      if (target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range' && (target as HTMLInputElement).type !== 'checkbox')) return
      if (e.code === 'Space') { space.current = e.type === 'keydown'; e.preventDefault(); return }
      if (e.key === 'Shift') { shift.current = e.type === 'keydown'; invalidate() }
      if (e.type !== 'keydown') return
      // Nothing may change the image, tool or shapes under a drag in progress
      if (drag.current && e.key !== 'Escape') return
      const all = commandsRef.current
      // Ctrl+Z takes back the last point while drawing, as in labelme
      if (draft.current && shortcutList(config.shortcuts.undo_last_point).some((k) => matches(k, e, mac))) {
        e.preventDefault()
        undoLastPoint()
        return
      }
      if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        if (undoLastPoint() || removeHoveredPoint()) return
        removeSelected()
        return
      }
      // Ctrl+Shift with next or previous copies this image's shapes over, as in labelme
      const copy = (e.ctrlKey || e.metaKey) && e.shiftKey
      for (const [id, cmd] of Object.entries(all)) {
        if (!cmd.shortcut || id === 'remove_selected_point' && e.key === 'Backspace') continue
        if (shortcutList(config.shortcuts[cmd.shortcut]).some((k) => matches(k, e, mac))) {
          e.preventDefault()
          if (e.repeat && (id.startsWith('review') || id.startsWith('create') || id === 'save')) return
          if (cmd.enabled && !cmd.enabled()) return
          if (id === 'open_next') return go(1, copy)
          if (id === 'open_prev') return go(-1, copy)
          cmd.run()
          return
        }
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key
      if (k === 'Enter') {
        e.preventDefault()
        finishDraft()
      } else if (k === 'Escape') {
        draft.current = null
        aiSeq.current++
        setBusyAi('')
        if (drag.current?.kind === 'stroke' || drag.current?.kind === 'two') drag.current = null
        setSelected([])
        invalidate()
      } else if (k.startsWith('Arrow') && selectedRef.current.length && !readOnlyRef.current) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        nudge(k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0, k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0)
      } else if (/^[1-9]$/.test(k) && classes[+k - 1]) {
        chooseClass(+k - 1)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey) }
  })

  const aiCount = shapes.filter(isAi).length
  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    shapes.forEach((s) => (out[s.label] = (out[s.label] ?? 0) + 1))
    return out
  }, [shapes])
  const totals = useMemo(() => {
    const out: Record<string, number> = {}
    images.forEach((i) => Object.entries(i.classes).forEach(([k, v]) => (out[k] = (out[k] ?? 0) + v)))
    return out
  }, [images])
  const largest = Math.max(1, ...Object.values(totals))
  const tally = (test: (i: ImageItem) => boolean) => images.filter(test).length
  const doneShare = images.length ? tally(FILTERS[3].test) / images.length : 0
  const reviewShare = images.length ? tally(FILTERS[2].test) / images.length : 0
  const current = selected.length === 1 && shapes[selected[0]] && isAi(shapes[selected[0]]) ? shapes[selected[0]] : null
  const flagKeys = Object.keys(imageFlags)
  const tool = (m: Mode, icon: React.ReactNode, title: string, cmd: string) => (
    <button className={mode === m ? 'on' : ''} onClick={() => setMode(m)} disabled={!!readOnly && m !== 'edit'}
      title={`${title}${commands[cmd]?.shortcut ? ` (${(shortcutList(config.shortcuts[commands[cmd].shortcut!])[0]?.key ?? '').toUpperCase()})` : ''}`} aria-label={title}>{icon}</button>
  )
  const modeHint: Record<Mode, string> = {
    edit: 'Click to select, Ctrl+click for more · drag to move · Alt+click an edge adds a point, a point removes it',
    polygon: 'Click to add points · click the first point, Enter or double-click to close',
    rectangle: 'Drag, or click two corners · Shift for a square',
    circle: 'Click the centre, then a point on the edge',
    line: 'Click both ends',
    point: 'Click to place a point',
    linestrip: 'Click to add points · Ctrl+click, Enter or double-click to finish',
    ai_polygon: 'Click the object · Shift+click marks background · Enter or Ctrl+click to finish',
    ai_mask: 'Click the object · Shift+click marks background · Enter or Ctrl+click to finish',
    brush: 'Paint the selected class · [ and ] change the size',
    eraser: 'Erase from the selected shape, or anything it touches'
  }

  return (
    <div className="labeler" onDragOver={(e) => e.preventDefault()}>
      {settings.docks.files && (
        <aside className="panel left" aria-label="Files">
          <input className="search" placeholder={`Search ${images.length} images`} value={query} aria-label="Search files"
            onChange={(e) => setQuery(e.target.value)} />
          <div className="progress" data-testid="progress">
            <i className="done" style={{ width: `${doneShare * 100}%` }} />
            <i className="review" style={{ width: `${reviewShare * 100}%` }} />
          </div>
          <div className="seg small filters">
            {FILTERS.map((f) => (
              <button key={f.key} className={filter === f.key ? 'on' : ''} onClick={() => setFilter(f.key)} title={f.title}>
                <b>{tally(f.test)}</b>{f.name}
              </button>
            ))}
          </div>
          <label className="sort">Order
            <select value={sort} onChange={(e) => { setSort(e.target.value as typeof sort); e.target.blur() }}>
              <option value="name">Name</option>
              <option value="certainty">Least certain first</option>
            </select>
          </label>
          <div className="files" role="listbox" aria-label="Images">
            {visible.map(({ image, i }) => (
              <button key={image.name} role="option" aria-selected={i === index} className={`file ${i === index ? 'on' : ''}`} onClick={() => goTo(i)} title={image.broken ? `${image.name}: ${image.broken}` : image.name}>
                <i className={image.broken ? 'dot broken' : image.ai ? 'dot ai' : image.labelled ? 'dot done' : 'dot'}
                  title={image.broken ? "Its label file can't be read" : image.ai ? 'AI shapes to review' : image.labelled ? 'Labelled' : 'Not labelled yet'} />
                <span className="name">{image.name}</span>
                {image.ai > 0 && image.score !== null && <span className="certainty">{percent(image.score)}</span>}
                {image.labelled && !image.ai && <span className="muted">{image.count}</span>}
              </button>
            ))}
            {!visible.length && <p className="muted pad">No images match.</p>}
          </div>
          {batch ? (
            <button className="ghost batch" onClick={() => window.api.prelabelStop()}>
              <i style={{ width: `${(batch.done / Math.max(1, batch.total)) * 100}%` }} />
              <X size={15} /> Stop · {batch.done} / {batch.total}
            </button>
          ) : (
            <button className="ghost batch" onClick={prelabelAll} disabled={!toPrelabel.length || !!busyAi}
              title={prelabelModel ? `Run ${prelabelModel.name} on every image with no label file or only AI shapes` : 'Choose a segmentation model (.onnx), then pre-label'}>
              <Sparkles size={15} /> Pre-label {toPrelabel.length} {toPrelabel.length === 1 ? 'image' : 'images'}
            </button>
          )}
        </aside>
      )}

      <main className="stage">
        <div className="toolbar" role="toolbar" aria-label="Tools">
          <div className="seg">
            {tool('edit', <MousePointer2 size={16} />, 'Edit', 'edit_polygon')}
            {tool('polygon', <Hexagon size={16} />, 'Polygon', 'create_polygon')}
            {tool('rectangle', <Square size={16} />, 'Rectangle', 'create_rectangle')}
            {tool('circle', <Circle size={16} />, 'Circle', 'create_circle')}
            {tool('line', <Slash size={16} />, 'Line', 'create_line')}
            {tool('linestrip', <Spline size={16} />, 'Line strip', 'create_linestrip')}
            {tool('point', <Dot size={16} />, 'Point', 'create_point')}
          </div>
          <div className="seg">
            {tool('brush', <Paintbrush size={16} />, 'Brush: paint a class, joining shapes it touches', 'create_brush')}
            {tool('eraser', <Eraser size={16} />, 'Eraser: cut from the selected shape, or anything it touches', 'create_eraser')}
          </div>
          {models && (
            <div className="seg">
              {tool('ai_polygon', <Wand2 size={16} />, 'AI polygon', 'create_ai_polygon')}
              {tool('ai_mask', <ScanLine size={16} />, 'AI mask', 'create_ai_mask')}
            </div>
          )}
          {(mode === 'ai_polygon' || mode === 'ai_mask') && models && (
            <label className="slider">Model
              <select value={settings.aiModel} onChange={(e) => { setSettings((s) => ({ ...s, aiModel: e.target.value })); e.target.blur() }}>
                {models.map((m) => <option key={m.name} value={m.name}>{m.title}{m.downloaded ? '' : ' (download)'}</option>)}
              </select>
            </label>
          )}
          <button className="icon" onClick={() => commands.undo.run()} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 size={16} /></button>
          <button className="icon" onClick={() => commands.redo.run()} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Redo2 size={16} /></button>
          <button className="icon" onClick={() => commands.fit_window.run()} title="Fit window (0)" aria-label="Fit window"><Maximize size={16} /></button>
          <button className="icon" onClick={() => setShowShapes(!showShapes)} title="Show or hide shapes (F)" aria-label="Show or hide shapes">
            {showShapes ? <Eye size={16} /> : <EyeOff size={16} />}
          </button>
          <label className="slider">Fill
            <input type="range" min={0} max={0.8} step={0.05} value={settings.fill} aria-label="Fill"
              onChange={(e) => setSettings((s) => ({ ...s, fill: +e.target.value }))} />
          </label>
          {(mode === 'brush' || mode === 'eraser') && (
            <label className="slider" title="[ and ] change it">Size
              <input type="range" min={config.brush.min} max={config.brush.max} step={4} value={brushSize} aria-label="Brush size" onChange={(e) => setBrushSize(+e.target.value)} />
            </label>
          )}
          <div className="spacer" />
          <span className="zoom" title="Zoom">{Math.round(zoom * 1000) / 10}%</span>
          <button className="ghost" onClick={prelabelOne} disabled={!!busyAi || !!batch || !!readOnly}
            title={prelabelModel ? `Pre-label with ${prelabelModel.name}` : 'Choose a segmentation model (.onnx), then pre-label this image'}>
            <Sparkles size={15} /> {busyAi === 'Predicting…' ? 'Predicting…' : 'Pre-label'}
          </button>
        </div>
        <div className="canvas-wrap">
          <canvas ref={canvasRef} data-testid="canvas" className={`tool-${mode}`} tabIndex={0} onWheel={onWheel}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onPointerLeave={() => { overCanvas.current = false; invalidate() }}
            onDoubleClick={onDoubleClick} onContextMenu={(e) => e.preventDefault()} />
          {loading && <div className="loading">Preparing image…</div>}
          {(notice || busyAi || download) && (
            <div className="loading notice">
              {download ? `Downloading ${download.name}: ${Math.round((download.done / Math.max(1, download.total)) * 100)}%` : busyAi || notice}
            </div>
          )}
          {readOnly && <div className="readonly" role="alert">This image's label file can't be read, so it's shown without labels and won't be changed.</div>}
          {aiCount > 0 && (
            <div className="review-bar" data-testid="review-bar" onMouseDown={(e) => e.preventDefault()}>
              <span>
                <b>{aiCount}</b> AI {aiCount === 1 ? 'shape' : 'shapes'}
                {current && scoreOf(current) !== undefined && <> · this one <b className="certainty">{percent(scoreOf(current)!)}</b></>}
              </span>
              <button className="ghost" onClick={acceptSelected}><Check size={15} /> {current ? 'Accept' : 'Review'} <kbd>W</kbd></button>
              <button className="ghost" onClick={rejectSelected} disabled={!current}><X size={15} /> Reject <kbd>S</kbd></button>
              <button className="ghost" onClick={skipShape} disabled={aiCount < 2 && !!current}><SkipForward size={15} /> Skip <kbd>Tab</kbd></button>
              <button className="ghost" onClick={acceptAll}><CheckCheck size={15} /> Accept all <kbd>⇧W</kbd></button>
            </div>
          )}
          {!images.length && <div className="loading">This folder has no images.</div>}
        </div>
        <footer className="status">
          <span>{images[index]?.name}</span>
          {meta && <span>{meta.width} × {meta.height}</span>}
          {cursor && meta && <span>{Math.round(cursor[0])}, {Math.round(cursor[1])}</span>}
          <span className="muted">{MODE_NAMES[mode]}</span>
          <div className="spacer" />
          <span data-testid="save-state">{readOnly ? 'Read only' : saved === 'saved' ? 'Saved' : saved === 'saving' ? 'Saving…' : settings.autoSave ? 'Saving…' : 'Not saved'}</span>
          <span className="muted hint">{modeHint[mode]}</span>
        </footer>
      </main>

      {(settings.docks.labels || settings.docks.flags || settings.docks.shapes) && (
        <aside className="panel right">
          {settings.docks.labels && (
            <section aria-label="Labels">
              <h3>Labels <span title="Shapes on this image · accepted shapes in the whole folder">here · all</span></h3>
              <div className="classes">
                {classes.map((c, i) => (
                  <div key={c.name} className={`class ${i === activeClass ? 'on' : ''}`} role="button" tabIndex={0}
                    onClick={() => (i === activeClass && !selected.length ? setActiveClass(null) : chooseClass(i))}
                    title={i === activeClass ? 'New shapes get this label. Click again to be asked each time.' : 'Label new shapes with this'}>
                    <label className="swatch" style={{ background: c.color }} onClick={(e) => e.stopPropagation()} title="Change colour">
                      <input type="color" value={c.color} onChange={(e) => recolor(c.name, e.target.value)} aria-label={`Colour of ${c.name}`} />
                    </label>
                    <span className="name">{c.name}</span>
                    <span className="muted">{counts[c.name] ?? 0} · {totals[c.name] ?? 0}</span>{i < 9 && <kbd>{i + 1}</kbd>}
                    <em style={{ width: `${((totals[c.name] ?? 0) / largest) * 100}%`, background: c.color }} />
                  </div>
                ))}
                {!classes.length && <p className="muted pad">No labels yet. Add one, or draw a shape and name it.</p>}
              </div>
              <div className="add">
                <input placeholder="New label" value={newClass} aria-label="New label" onChange={(e) => setNewClass(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addClass()} />
                <button className="icon" onClick={addClass} title="Add label" aria-label="Add label"><Plus size={16} /></button>
              </div>
            </section>
          )}
          {settings.docks.flags && flagKeys.length > 0 && (
            <section aria-label="Flags">
              <h3>Flags <span className="muted">this image</span></h3>
              <div className="flag-list">
                {flagKeys.map((k) => (
                  <label key={k} className="check">
                    <input type="checkbox" checked={imageFlags[k]} disabled={!!readOnly} onChange={(e) => setFlagsValue({ ...flagsRef.current, [k]: e.target.checked })} /> {k}
                  </label>
                ))}
              </div>
            </section>
          )}
          {settings.docks.shapes && (
            <section className="grow" aria-label="Shapes">
              <h3>Shapes <span className="muted">{shapes.length}</span></h3>
              <div className="shapes" role="listbox" aria-multiselectable>
                {shapes.map((s, i) => (
                  <div key={i} role="option" aria-selected={selected.includes(i)} draggable={!readOnly}
                    className={`shape ${selected.includes(i) ? 'on' : ''} ${dragOver === i ? 'drop' : ''} ${s.hidden ? 'off' : ''}`}
                    onClick={(e) => {
                      if (e.ctrlKey || e.metaKey) setSelected(selected.includes(i) ? selected.filter((k) => k !== i) : [...selected, i])
                      else if (e.shiftKey && selected.length) {
                        const a = Math.min(selected[selected.length - 1], i), b = Math.max(selected[selected.length - 1], i)
                        setSelected(Array.from({ length: b - a + 1 }, (_, k) => a + k))
                      } else setSelected([i])
                      if (mode !== 'edit') setMode('edit')
                    }}
                    onDoubleClick={() => { setSelected([i]); editLabel([i]) }}
                    onDragStart={(e) => e.dataTransfer.setData('text/x-shape', String(i))}
                    onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-shape')) { e.preventDefault(); setDragOver(i) } }}
                    onDragLeave={() => setDragOver(null)}
                    onDrop={(e) => {
                      setDragOver(null)
                      const from = Number(e.dataTransfer.getData('text/x-shape'))
                      if (Number.isNaN(from) || from === i) return
                      // Order matters: later shapes are drawn, and trained, on top
                      const next = [...shapesRef.current]
                      const [moved] = next.splice(from, 1)
                      next.splice(i, 0, moved)
                      setShapes(next)
                      setSelected([i])
                    }}>
                    <input type="checkbox" checked={!s.hidden} aria-label={`Show ${s.label}`} onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const next = shapesRef.current.map((q, k) => (k === i ? { ...q, hidden: !e.target.checked || undefined } : q))
                        shapesRef.current = next
                        setShapesState(next)
                        invalidate()
                      }} />
                    <i style={{ background: colorOf(s.label) }} />
                    <span className="name">{s.label}{s.group_id !== null ? ` (${s.group_id})` : ''}</span>
                    {s.locked && <Lock size={12} className="muted" aria-label="Locked" />}
                    {isAi(s) && <span className="tag">AI{scoreOf(s) !== undefined ? ` ${percent(scoreOf(s)!)}` : ''}</span>}
                    <span className="muted">{describe(s)}</span>
                  </div>
                ))}
                {!shapes.length && <p className="muted pad">Nothing yet. Click on the image to start a polygon.</p>}
              </div>
              {selected.length > 0 && !readOnly && (
                <button className="ghost danger" onClick={removeSelected}><Trash2 size={15} /> Delete {selected.length > 1 ? `${selected.length} shapes` : 'shape'}</button>
              )}
            </section>
          )}
        </aside>
      )}

      {dialog && (
        <LabelDialog request={dialog} config={config} labels={classes.map((c) => c.name)}
          onDone={(choice) => {
            const { resolve } = dialog
            if (choice && config.validate_label === 'exact' && !dialog.locked?.text && !(config.labels ?? []).includes(choice.text)) {
              onError(`Invalid label “${choice.text}”: only labels from the list are allowed.`)
              choice = null
            }
            setDialog(null)
            resolve(choice)
            canvasRef.current?.focus()
          }} />
      )}
      {pointsPrompt && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && setPointsPrompt(null)}>
          <form className="dialog small" onSubmit={(e) => {
            e.preventDefault()
            const n = Math.max(1, Math.min(100, Math.round(pointsPrompt.count)))
            const s = shapesRef.current[pointsPrompt.shape]
            if (s) setShapes(shapesRef.current.map((q, i) => (i === pointsPrompt.shape ? addPointsToEdge(q, pointsPrompt.edge, n) : q)))
            setPointsPrompt(null)
          }}>
            <label>Points to add along this edge
              <input type="number" min={1} max={100} autoFocus value={pointsPrompt.count} onChange={(e) => setPointsPrompt({ ...pointsPrompt, count: +e.target.value })}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setPointsPrompt(null) }} />
            </label>
            <div className="actions">
              <button type="button" className="ghost" onClick={() => setPointsPrompt(null)}>Cancel</button>
              <button className="primary">Add</button>
            </div>
          </form>
        </div>
      )}
      {bcOpen && (
        <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && setBcOpen(false)}>
          <div className="dialog small" role="dialog" aria-label="Brightness and contrast" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setBcOpen(false) }}>
            {(['brightness', 'contrast'] as const).map((k) => (
              <label key={k} className="slider wide">{k[0].toUpperCase() + k.slice(1)}
                <input type="range" min={0} max={3} step={0.02} value={bc[k]} aria-label={k} onChange={(e) => setBc({ ...bc, [k]: +e.target.value })} />
                <span className="muted">{Math.round(bc[k] * 100)}%</span>
              </label>
            ))}
            <div className="actions">
              <button className="ghost" onClick={() => setBc({ brightness: 1, contrast: 1 })}>Reset</button>
              <button className="primary" onClick={() => setBcOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

export default Labeler
