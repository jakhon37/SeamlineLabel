import { Check, CheckCheck, Eraser, Eye, EyeOff, Hexagon, Maximize, MousePointer2, Paintbrush, Plus, Redo2, SkipForward, Sparkles, Square, Trash2, Undo2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { summarize } from '../../shared/labels'
import { accepted, eraseShapes, outline, paintShapes, strokeRegion } from './geometry'
import { fileUrl, ImageItem, OpenImage, OpenProject, Project, Shape } from './types'

type Tool = 'select' | 'polygon' | 'rectangle' | 'brush' | 'eraser'
type Filter = 'all' | 'label' | 'review' | 'done'
type Props = {
  data: OpenProject
  setProject: (p: Project) => void
  setImages: (fn: (images: ImageItem[]) => ImageItem[]) => void
  active: boolean
  onError: (m: string) => void
}
type Drag =
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'vertex'; shape: number; vertex: number; press: number[]; active: boolean }
  | { kind: 'move'; shape: number; x: number; y: number; press: number[]; active: boolean }
  | { kind: 'rect'; start: number[]; end: number[] }
  | { kind: 'stroke'; points: number[][]; radius: number }

const PALETTE = ['#4f8cff', '#ff6b6b', '#3ecf8e', '#f7b731', '#b57bff', '#22c7d6', '#ff8f4d', '#ec6fb3']
const HIT = 8
const CACHE_TILES = 400
const DRAG_START = 4
const HISTORY_IMAGES = 30

const FILTERS: { key: Filter; name: string; test: (i: ImageItem) => boolean }[] = [
  { key: 'all', name: 'All', test: () => true },
  { key: 'label', name: 'Label', test: (i) => !i.count && !i.ai && !i.broken },
  { key: 'review', name: 'Review', test: (i) => i.ai > 0 },
  { key: 'done', name: 'Done', test: (i) => i.count > 0 && !i.ai }
]
const percent = (score: number) => `${Math.round(score * 100)}%`

// Least certain first; shapes without a score come last
function reviewOrder(list: Shape[]) {
  return list
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.flags?.ai)
    .sort((a, b) => (a.s.score ?? 1) - (b.s.score ?? 1) || a.i - b.i)
    .map(({ i }) => i)
}

function inside(p: number[], poly: number[][]) {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

function segmentDistance(p: number[], a: number[], b: number[]) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

export default function Labeler({ data, setProject, setImages, active, onError }: Props) {
  const { project, images, root } = data
  const [index, setIndex] = useState(0)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<'name' | 'certainty'>('name')
  const [tool, setTool] = useState<Tool>('polygon')
  const [activeClass, setActiveClass] = useState(0)
  const [shapes, setShapesState] = useState<Shape[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [meta, setMeta] = useState<OpenImage | null>(null)
  const [showShapes, setShowShapes] = useState(true)
  const [fill, setFill] = useState(0.3)
  const [zoom, setZoom] = useState(1)
  const [cursor, setCursor] = useState<number[] | null>(null)
  const [saved, setSaved] = useState<'saved' | 'saving'>('saved')
  const [loading, setLoading] = useState(false)
  const [busyAi, setBusyAi] = useState(false)
  const [newClass, setNewClass] = useState('')
  const [brushSize, setBrushSize] = useState(28)
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  const [notice, setNotice] = useState('')

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const view = useRef({ scale: 1, x: 0, y: 0 })
  const shapesRef = useRef<Shape[]>([])
  const selectedRef = useRef<number | null>(null)
  const metaRef = useRef<OpenImage | null>(null)
  const loadedName = useRef('')
  const alive = useRef(true)
  const history = useRef(new Map<string, { undo: Shape[][]; redo: Shape[][] }>())
  const reviewOnLoad = useRef(false)
  const reviewBack = useRef<string | null>(null)
  const undoOnLoad = useRef(false)
  const overCanvas = useRef(false)
  const draft = useRef<number[][]>([])
  const drag = useRef<Drag | null>(null)
  const mouse = useRef<number[]>([0, 0])
  const space = useRef(false)
  const undo = useRef<Shape[][]>([])
  const redo = useRef<Shape[][]>([])
  const tiles = useRef(new Map<string, HTMLImageElement>())
  const frame = useRef(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const pendingSave = useRef<(() => Promise<void>) | null>(null)
  const opts = useRef({ showShapes, fill, classes: project.classes, tool, activeClass, brushSize })
  opts.current = { showShapes, fill, classes: project.classes, tool, activeClass, brushSize }
  selectedRef.current = selected

  const colorOf = useCallback(
    (label: string) => opts.current.classes.find((c) => c.name === label)?.color ?? '#999',
    []
  )

  const getTile = (url: string) => {
    const cache = tiles.current
    let img = cache.get(url)
    if (img) {
      cache.delete(url)
      cache.set(url, img) // keep most recently used last
      return img
    }
    img = new Image()
    img.onload = () => invalidate()
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
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr
      canvas.height = H * dpr
    }
    const ctx = canvas.getContext('2d', { alpha: false })!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#0d0e11'
    ctx.fillRect(0, 0, W, H)
    if (!m) return
    const { scale, x, y } = view.current
    ctx.imageSmoothingEnabled = scale < 2

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
            if (img.naturalWidth) {
              put(img, c * tile * f, r * tile * f, img.naturalWidth * f, img.naturalHeight * f)
            }
          }
        }
      }
      // The whole-image tile fills gaps until sharper tiles arrive
      const coarsest = maxLevel - overview
      const want = Math.min(maxLevel, Math.max(coarsest, maxLevel + Math.ceil(Math.log2(scale * dpr))))
      drawLevel(coarsest)
      if (want !== coarsest) drawLevel(want)
    }

    const toScreen = (p: number[]): [number, number] => [p[0] * scale + x, p[1] * scale + y]
    const { showShapes, fill: alpha } = opts.current
    if (showShapes) {
      shapesRef.current.forEach((s, i) => {
        const pts = outline(s)
        const color = colorOf(s.label)
        const isSel = i === selectedRef.current
        ctx.beginPath()
        pts.forEach((p, k) => (k ? ctx.lineTo(...toScreen(p)) : ctx.moveTo(...toScreen(p))))
        ctx.closePath()
        ctx.globalAlpha = isSel ? Math.min(1, alpha + 0.15) : alpha
        ctx.fillStyle = color
        ctx.fill('evenodd')
        ctx.globalAlpha = 1
        ctx.strokeStyle = color
        ctx.lineWidth = isSel ? 2.5 : 1.5
        ctx.setLineDash(s.flags?.ai ? [6, 4] : [])
        ctx.stroke()
        ctx.setLineDash([])
        if (isSel) {
          for (const p of pts) {
            const [px, py] = toScreen(p)
            ctx.beginPath()
            ctx.arc(px, py, 4.5, 0, 7)
            ctx.fillStyle = '#fff'
            ctx.fill()
            ctx.strokeStyle = color
            ctx.lineWidth = 2
            ctx.stroke()
          }
        }
      })
    }
    const current = opts.current.classes[opts.current.activeClass]?.color ?? '#fff'
    // The brush continues a selected shape's class, so it previews in that colour
    const chosen = selectedRef.current === null ? undefined : shapesRef.current[selectedRef.current]
    const brushColor = chosen ? colorOf(chosen.label) : current
    const d = drag.current
    if (d?.kind === 'rect') {
      const [a, b] = toScreen(d.start), [c, e] = toScreen(d.end)
      ctx.strokeStyle = current
      ctx.lineWidth = 2
      ctx.strokeRect(a, b, c - a, e - b)
    }
    const erasing = opts.current.tool === 'eraser'
    if (d?.kind === 'stroke') {
      ctx.beginPath()
      d.points.forEach((p, k) => (k ? ctx.lineTo(...toScreen(p)) : ctx.moveTo(...toScreen(p))))
      if (d.points.length === 1) ctx.lineTo(...toScreen(d.points[0]))
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.lineWidth = d.radius * 2 * scale
      ctx.globalAlpha = 0.55
      ctx.strokeStyle = erasing ? '#fff' : brushColor
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.lineCap = 'butt'
      ctx.lineJoin = 'miter'
    }
    if ((erasing || opts.current.tool === 'brush') && overCanvas.current) {
      ctx.beginPath()
      ctx.arc(...toScreen(mouse.current), opts.current.brushSize / 2, 0, 7)
      ctx.strokeStyle = erasing ? '#fff' : brushColor
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
    if (draft.current.length) {
      ctx.beginPath()
      draft.current.forEach((p, k) => (k ? ctx.lineTo(...toScreen(p)) : ctx.moveTo(...toScreen(p))))
      ctx.lineTo(...toScreen(mouse.current))
      ctx.strokeStyle = current
      ctx.lineWidth = 2
      ctx.stroke()
      draft.current.forEach((p, k) => {
        ctx.beginPath()
        ctx.arc(...toScreen(p), k === 0 ? 6 : 3.5, 0, 7)
        ctx.fillStyle = k === 0 ? current : '#fff'
        ctx.fill()
      })
    }
  }, [colorOf])

  const invalidate = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw)
  }, [draw])

  const fit = useCallback(() => {
    const canvas = canvasRef.current, m = metaRef.current
    if (!canvas || !m) return
    const pad = 24
    const scale = Math.min((canvas.clientWidth - pad * 2) / m.width, (canvas.clientHeight - pad * 2) / m.height)
    view.current = {
      scale,
      x: (canvas.clientWidth - m.width * scale) / 2,
      y: (canvas.clientHeight - m.height * scale) / 2
    }
    setZoom(scale)
    invalidate()
  }, [invalidate])

  const flush = useCallback(async () => {
    clearTimeout(saveTimer.current)
    const job = pendingSave.current
    pendingSave.current = null
    if (job) await job()
    setSaved('saved')
  }, [])

  const setShapes = (next: Shape[], record = true) => {
    if (record) {
      undo.current.push(shapesRef.current)
      if (undo.current.length > 200) undo.current.shift()
      redo.current = []
    }
    apply(next)
  }

  const apply = (next: Shape[]) => {
    shapesRef.current = next
    setShapesState(next)
    invalidate()
    const m = metaRef.current
    // Not the selected image: while the next one loads, these shapes still belong to the last
    const name = loadedName.current
    if (!m || !name) return
    setImages((all) => all.map((i) => (i.name === name ? { ...i, ...summarize(next) } : i)))
    setSaved('saving')
    pendingSave.current = () =>
      window.api.saveLabels(root, name, next, [m.width, m.height]).catch((e) => onError(`Save failed: ${e.message}`))
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flush, 400)
  }

  // Load the current image; older requests are dropped if you move on quickly
  useEffect(() => {
    const name = images[index]?.name
    if (!name) return
    let stale = false
    setLoading(true)
    // Undo stays with each image, so going back can still take back a decision
    const rememberHistory = () => {
      const last = loadedName.current
      if (!last) return
      history.current.delete(last)
      history.current.set(last, { undo: undo.current, redo: redo.current })
      if (history.current.size > HISTORY_IMAGES) history.current.delete(history.current.keys().next().value!)
    }
    ;(async () => {
      await flush()
      try {
        // Labels last: a big image can take a while, and pre-labelling may write meanwhile
        const m = await window.api.openImage(name)
        if (stale) return
        const loaded = await window.api.loadLabels(root, name)
        if (stale) return
        rememberHistory()
        const kept = history.current.get(name)
        const fromReview = reviewOnLoad.current
        const undoHere = undoOnLoad.current
        reviewOnLoad.current = false
        undoOnLoad.current = false
        reviewBack.current = fromReview ? loadedName.current : null
        metaRef.current = m
        loadedName.current = name
        shapesRef.current = loaded
        undo.current = kept?.undo ?? []
        redo.current = kept?.redo ?? []
        draft.current = []
        drag.current = null
        setMeta(m)
        setShapesState(loaded)
        setSelected(null)
        fit()
        if (undoHere) stepHistory(undo, redo)
        const first = reviewOrder(shapesRef.current)[0]
        if ((fromReview || undoHere) && first !== undefined) selectForReview(first, shapesRef.current)
      } catch (e: any) {
        if (stale) return
        onError(`Could not open ${name}: ${e.message}`)
        // Nothing on screen, so nothing can be edited or saved under this image's name
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
        setMeta(null)
        setShapesState([])
        setSelected(null)
        invalidate()
      } finally {
        if (!stale) setLoading(false)
      }
    })()
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, images[index]?.name])

  useEffect(invalidate, [showShapes, fill, selected, tool, activeClass, brushSize, project.classes, invalidate])
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
  useEffect(() =>
    window.api.onPrelabel(({ name, shapes: found, done, total }) => {
      setBatch({ done, total })
      if (!found) return
      history.current.delete(name)
      if (name === loadedName.current) {
        // Anything being edited here wins: it saves over this result
        if (pendingSave.current || drag.current || shapesRef.current.some((s) => !s.flags?.ai)) return
        shapesRef.current = found
        undo.current = []
        redo.current = []
        setShapesState(found)
        setSelected(null)
        invalidate()
      }
      setImages((all) => all.map((i) => (i.name === name ? { ...i, ...summarize(found) } : i)))
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [invalidate]
  )
  useEffect(() => {
    const canvas = canvasRef.current!
    const observer = new ResizeObserver(() => invalidate())
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [invalidate])
  useEffect(() => {
    if (active) { fit(); canvasRef.current && invalidate() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  useEffect(() => () => void flush(), [flush])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => window.api.onFlush(() => void flush().finally(() => window.api.flushed())), [flush])
  useEffect(() => {
    const broken = images.filter((i) => i.broken).map((i) => i.name)
    if (!broken.length) return
    const list = broken.slice(0, 3).join(', ') + (broken.length > 3 ? ', …' : '')
    onError(`${broken.length} ${broken.length === 1 ? 'label file' : 'label files'} can't be read and won't be changed: ${list}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toImage = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const { scale, x, y } = view.current
    return [(e.clientX - rect.left - x) / scale, (e.clientY - rect.top - y) / scale]
  }
  const clampPoint = (p: number[]) => {
    const m = metaRef.current!
    return [Math.max(0, Math.min(m.width, p[0])), Math.max(0, Math.min(m.height, p[1]))]
  }

  const onWheel = (e: React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const v = view.current
    const next = Math.max(0.005, Math.min(50, v.scale * Math.exp(-e.deltaY * 0.0022)))
    const px = e.clientX - rect.left, py = e.clientY - rect.top
    view.current = {
      scale: next,
      x: px - ((px - v.x) / v.scale) * next,
      y: py - ((py - v.y) / v.scale) * next
    }
    setZoom(next)
    invalidate()
  }

  const finishPolygon = () => {
    if (draft.current.length >= 3) {
      const label = project.classes[activeClass]?.name
      const next = [...shapesRef.current, { label, points: draft.current, shape_type: 'polygon' as const, flags: {} }]
      setShapes(next)
      setSelected(next.length - 1)
    }
    draft.current = []
    invalidate()
  }

  const onPointerDown = (e: React.PointerEvent) => {
    // While the next image loads, what's on screen is about to go
    if (!metaRef.current || loadedName.current !== images[index]?.name) return
    canvasRef.current!.setPointerCapture(e.pointerId)
    const p = toImage(e)
    const radius = HIT / view.current.scale
    if (e.button === 1 || e.button === 2 || space.current) {
      drag.current = { kind: 'pan', x: e.clientX, y: e.clientY }
      return
    }
    if (tool === 'polygon') {
      const first = draft.current[0]
      if (first && draft.current.length >= 3 && Math.hypot(p[0] - first[0], p[1] - first[1]) < radius * 1.5) {
        finishPolygon()
      } else {
        draft.current = [...draft.current, clampPoint(p)]
        invalidate()
      }
      return
    }
    if (tool === 'rectangle') {
      const start = clampPoint(p)
      drag.current = { kind: 'rect', start, end: start }
      return
    }
    if (tool === 'brush' || tool === 'eraser') {
      drag.current = { kind: 'stroke', points: [p], radius: brushSize / 2 / view.current.scale }
      invalidate()
      return
    }
    const list = shapesRef.current
    if (selected !== null && list[selected]) {
      const pts = list[selected].points
      const v = pts.findIndex((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < radius)
      if (v >= 0) {
        if (e.altKey && list[selected].shape_type === 'polygon' && pts.length > 3) {
          setShapes(list.map((s, i) => (i === selected ? { ...accepted(s), points: pts.filter((_, k) => k !== v) } : s)))
          return
        }
        undo.current.push(list)
        redo.current = []
        drag.current = { kind: 'vertex', shape: selected, vertex: v, press: [e.clientX, e.clientY], active: false }
        return
      }
    }
    for (let i = list.length - 1; i >= 0; i--) {
      if (inside(p, outline(list[i]))) {
        setSelected(i)
        undo.current.push(list)
        redo.current = []
        drag.current = { kind: 'move', shape: i, x: p[0], y: p[1], press: [e.clientX, e.clientY], active: false }
        return
      }
    }
    setSelected(null)
    drag.current = { kind: 'pan', x: e.clientX, y: e.clientY }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const p = toImage(e)
    mouse.current = p
    setCursor(p)
    overCanvas.current = true
    const d = drag.current
    if (!d) {
      if (draft.current.length || tool === 'brush' || tool === 'eraser') invalidate()
      return
    }
    if ((d.kind === 'vertex' || d.kind === 'move') && !d.active) {
      // A slip of the hand during a click isn't a drag
      if (Math.hypot(e.clientX - d.press[0], e.clientY - d.press[1]) < DRAG_START) return
      d.active = true
    }
    if (d.kind === 'pan') {
      view.current.x += e.clientX - d.x
      view.current.y += e.clientY - d.y
      d.x = e.clientX
      d.y = e.clientY
    } else if (d.kind === 'rect') {
      d.end = clampPoint(p)
    } else if (d.kind === 'stroke') {
      const last = d.points[d.points.length - 1]
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= d.radius * 0.4) d.points.push(p)
    } else if (d.kind === 'vertex') {
      shapesRef.current = shapesRef.current.map((s, i) =>
        i === d.shape ? { ...s, points: s.points.map((q, k) => (k === d.vertex ? clampPoint(p) : q)) } : s
      )
    } else {
      const dx = p[0] - d.x, dy = p[1] - d.y
      d.x = p[0]
      d.y = p[1]
      shapesRef.current = shapesRef.current.map((s, i) =>
        i === d.shape ? { ...s, points: s.points.map((q) => [q[0] + dx, q[1] + dy]) } : s
      )
    }
    invalidate()
  }

  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.kind === 'stroke') {
      commitStroke(d.points, d.radius)
      invalidate()
    } else if (d.kind === 'rect') {
      if (Math.abs(d.start[0] - d.end[0]) > 1 && Math.abs(d.start[1] - d.end[1]) > 1) {
        const label = project.classes[activeClass]?.name
        const next = [...shapesRef.current, { label, points: [d.start, d.end], shape_type: 'rectangle' as const, flags: {} }]
        setShapes(next)
        setSelected(next.length - 1)
      }
      invalidate()
    } else if (d.kind === 'vertex' || d.kind === 'move') {
      // A click only selects: looking at an AI shape must not accept it
      if (shapesRef.current === undo.current[undo.current.length - 1]) {
        undo.current.pop()
        return
      }
      apply(shapesRef.current.map((s, i) => (i === d.shape && s.flags?.ai ? accepted(s) : s)))
    }
  }

  const commitStroke = (points: number[][], radius: number) => {
    const m = metaRef.current!
    const list = shapesRef.current
    try {
      const region = strokeRegion(points, radius, 0.5 / view.current.scale, [m.width, m.height])
      if (!region.length) return
      if (tool === 'eraser') {
        const result = eraseShapes(list, region, selected)
        if (result.shapes !== list) {
          setShapes(result.shapes)
          setSelected(result.selected)
        }
        return
      }
      // Painting with a shape selected continues that shape's class
      const label = (selected !== null && list[selected]?.label) || project.classes[activeClass]?.name
      if (!label) return
      const at = project.classes.findIndex((c) => c.name === label)
      if (at >= 0) setActiveClass(at)
      setSelected(null)
      setShapes(paintShapes(list, region, label))
    } catch (e: any) {
      onError(`That stroke couldn't be applied, so the shapes are unchanged: ${e.message}`)
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (tool === 'polygon') {
      // The second click of the double-click added a point already
      draft.current = draft.current.slice(0, -1)
      finishPolygon()
      return
    }
    if (selected === null) return
    const s = shapesRef.current[selected]
    if (s?.shape_type !== 'polygon') return
    const p = toImage(e)
    let best = -1, bestDist = HIT / view.current.scale
    s.points.forEach((a, i) => {
      const dist = segmentDistance(p, a, s.points[(i + 1) % s.points.length])
      if (dist < bestDist) { best = i; bestDist = dist }
    })
    if (best >= 0) {
      const points = [...s.points]
      points.splice(best + 1, 0, clampPoint(p))
      setShapes(shapesRef.current.map((q, i) => (i === selected ? { ...accepted(q), points } : q)))
    }
  }

  const stepHistory = (from: typeof undo, to: typeof undo) => {
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
    setSelected(null)
    apply(prev)
  }
  const removeSelected = () => {
    if (selected === null) return
    setShapes(shapesRef.current.filter((_, i) => i !== selected))
    setSelected(null)
  }
  const chooseClass = (i: number) => {
    setActiveClass(i)
    if (selected !== null) {
      setShapes(shapesRef.current.map((s, k) => (k === selected ? { ...accepted(s), label: project.classes[i].name } : s)))
    }
  }

  const visible = useMemo(() => {
    const test = FILTERS.find((f) => f.key === filter)!.test
    const list = images
      .map((image, i) => ({ image, i }))
      .filter(({ image }) => image.name.toLowerCase().includes(query.toLowerCase()))
      .filter(({ image }) => test(image))
    if (sort === 'certainty') {
      const rank = (i: ImageItem) => (i.ai ? i.score ?? 1 : 2)
      list.sort((a, b) => rank(a.image) - rank(b.image) || a.i - b.i)
    }
    return list
  }, [images, query, filter, sort])
  const go = useCallback(
    (delta: number) => {
      const at = visible.findIndex((v) => v.i === index)
      const next = visible[Math.max(0, Math.min(visible.length - 1, at + delta))]
      if (next) setIndex(next.i)
    },
    [visible, index]
  )

  // Bring a shape into view: closer in if it's off screen or too small to judge
  const focusShape = (s: Shape) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const pts = outline(s)
    const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]))
    const y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]))
    const W = canvas.clientWidth, H = canvas.clientHeight
    const { scale, x, y } = view.current
    const seen = x0 * scale + x >= 0 && y0 * scale + y >= 0 && x1 * scale + x <= W && y1 * scale + y <= H
    const large = Math.max(x1 - x0, y1 - y0) * scale >= 80
    if (seen && large) return
    const fits = (x1 - x0) * scale <= W && (y1 - y0) * scale <= H
    const next = large && fits ? scale : Math.min(8, W / ((x1 - x0 || 1) * 3), H / ((y1 - y0 || 1) * 3))
    view.current = { scale: next, x: W / 2 - ((x0 + x1) / 2) * next, y: H / 2 - ((y0 + y1) / 2) * next }
    setZoom(next)
    invalidate()
  }
  const selectForReview = (i: number, list: Shape[]) => {
    setSelected(i)
    setTool('select')
    focusShape(list[i])
  }
  const nextReviewImage = () => {
    const at = visible.findIndex((v) => v.i === index)
    const order = [...visible.slice(at + 1), ...visible.slice(0, Math.max(at, 0))]
    const next = order.find((v) => v.i !== index && v.image.ai > 0)
    setSelected(null)
    if (!next) return setNotice('Nothing left to review in this list.')
    reviewOnLoad.current = true
    setIndex(next.i)
  }
  const reviewNext = (list: Shape[]) => {
    const first = reviewOrder(list)[0]
    if (first !== undefined) selectForReview(first, list)
    else nextReviewImage()
  }
  // Only once this image's shapes are in: keys can arrive faster than images load
  const reviewReady = () => !drag.current && loadedName.current === images[index]?.name
  const acceptSelected = () => {
    if (!reviewReady()) return
    const list = shapesRef.current
    if (selected === null || !list[selected]?.flags?.ai) return reviewNext(list)
    const next = list.map((s, i) => (i === selected ? accepted(s) : s))
    setShapes(next)
    reviewNext(next)
  }
  const rejectSelected = () => {
    if (!reviewReady()) return
    const list = shapesRef.current
    if (selected === null || !list[selected]?.flags?.ai) return reviewNext(list)
    const next = list.filter((_, i) => i !== selected)
    setShapes(next)
    reviewNext(next)
  }
  const skipShape = () => {
    if (!reviewReady()) return
    const list = shapesRef.current
    const order = reviewOrder(list)
    if (!order.length) return nextReviewImage()
    selectForReview(order[(order.indexOf(selected ?? -1) + 1) % order.length], list)
  }
  const acceptAll = () => {
    if (!reviewReady()) return
    if (shapesRef.current.some((s) => s.flags?.ai)) {
      setShapes(shapesRef.current.map((s) => (s.flags?.ai ? accepted(s) : s)))
    }
    nextReviewImage()
  }

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLInputElement
      if (target.tagName === 'SELECT' || (target.tagName === 'INPUT' && target.type !== 'range')) return
      if (e.code === 'Space') { space.current = e.type === 'keydown'; e.preventDefault(); return }
      if (e.type !== 'keydown') return
      // Nothing may change the image, tool or shapes under a drag in progress
      if (drag.current && e.key !== 'Escape') return
      if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        e.shiftKey ? stepHistory(redo, undo) : stepHistory(undo, redo)
        return
      }
      if (e.ctrlKey) return
      const k = e.key.toLowerCase()
      if (k === 'v') setTool('select')
      else if (k === 'p') setTool('polygon')
      else if (k === 'r') setTool('rectangle')
      else if (k === 'b') setTool('brush')
      else if (k === 'e') setTool('eraser')
      else if (e.key === '[') setBrushSize((s) => Math.max(4, s - 4))
      else if (e.key === ']') setBrushSize((s) => Math.min(200, s + 4))
      else if (e.key === 'Tab') { e.preventDefault(); skipShape() }
      else if (k === 'w' && !e.repeat) e.shiftKey ? acceptAll() : acceptSelected()
      else if (k === 's' && !e.repeat) rejectSelected()
      else if (k === 'f') setShowShapes((s) => !s)
      else if (k === 'a') go(-1)
      else if (k === 'd') go(1)
      else if (k === '0') fit()
      else if (e.key === 'Enter') finishPolygon()
      else if (e.key === 'Escape') {
        draft.current = []
        if (drag.current?.kind === 'stroke') drag.current = null
        setSelected(null)
        invalidate()
      }
      else if (e.key === 'Backspace' && draft.current.length) { draft.current = draft.current.slice(0, -1); invalidate() }
      else if (e.key === 'Delete' || e.key === 'Backspace') removeSelected()
      else if (/^[1-9]$/.test(k) && project.classes[+k - 1]) chooseClass(+k - 1)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey) }
  })

  const addClass = () => {
    const name = newClass.trim()
    if (!name || project.classes.some((c) => c.name === name)) return
    const color = PALETTE[project.classes.length % PALETTE.length]
    setProject({ ...project, classes: [...project.classes, { name, color }] })
    setActiveClass(project.classes.length)
    setNewClass('')
  }

  const latestRun = async () => {
    const runs = await window.api.listRuns()
    const run = runs.find((r) => r.events.some((e) => e.type === 'epoch'))
    if (!run) onError('Train a model first, then it can pre-label images.')
    return run
  }
  const prelabel = async () => {
    const run = await latestRun()
    if (!run) return
    setBusyAi(true)
    try {
      const name = images[index].name
      const { results } = await window.api.predict(run.name, [name])
      if (!alive.current) return
      if (loadedName.current !== name || drag.current) {
        return setNotice(`You were working on something else, so the result for ${name} was dropped.`)
      }
      const kept = shapesRef.current.filter((s) => !s.flags?.ai)
      setSelected(null)
      setShapes([...kept, ...results[name]])
    } catch (e: any) {
      onError(`Pre-label failed: ${e.message}`)
    } finally {
      setBusyAi(false)
    }
  }
  // Images with accepted shapes keep them: pre-labelling only touches the rest
  const toPrelabel = images.filter((i) => !i.count && !i.broken)
  const prelabelAll = async () => {
    const run = await latestRun()
    if (!run) return
    await flush()
    setBatch({ done: 0, total: toPrelabel.length })
    try {
      const result = await window.api.prelabelAll(run.name, toPrelabel.map((i) => i.name))
      setNotice(`${result.stopped ? 'Stopped after' : 'Pre-labelled'} ${result.done} of ${result.total} images.`)
      if (result.error) {
        onError(`Pre-labelling stopped early: ${result.error}`)
      } else if (result.failed.length) {
        onError(`${result.failed.length} ${result.failed.length === 1 ? 'image' : 'images'} failed. First: ${result.failed[0]}`)
      }
    } catch (e: any) {
      onError(`Pre-label failed: ${e.message}`)
    } finally {
      setBatch(null)
    }
  }
  const aiCount = shapes.filter((s) => s.flags?.ai).length
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
  const current = selected !== null && shapes[selected]?.flags?.ai ? shapes[selected] : null

  return (
    <div className="labeler">
      <aside className="panel left">
        <input className="search" placeholder={`Search ${images.length} images`} value={query}
          onChange={(e) => setQuery(e.target.value)} />
        <div className="progress" data-testid="progress">
          <i className="done" style={{ width: `${doneShare * 100}%` }} />
          <i className="review" style={{ width: `${reviewShare * 100}%` }} />
        </div>
        <div className="seg small filters">
          {FILTERS.map((f) => (
            <button key={f.key} className={filter === f.key ? 'on' : ''} onClick={() => setFilter(f.key)}>
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
        <div className="files">
          {visible.map(({ image, i }) => (
            <button key={image.name} className={`file ${i === index ? 'on' : ''}`} onClick={() => setIndex(i)} title={image.name}>
              <i className={image.broken ? 'dot broken' : image.count ? 'dot done' : image.ai ? 'dot ai' : 'dot'}
                title={image.broken ? "Its label file can't be read" : undefined} />
              <span className="name">{image.name}</span>
              {image.ai > 0 && image.score !== null && <span className="certainty">{percent(image.score)}</span>}
              {image.count > 0 && <span className="muted">{image.count}</span>}
            </button>
          ))}
          {!visible.length && <p className="muted pad">No images match.</p>}
        </div>
        {batch ? (
          <button className="ghost batch" onClick={() => window.api.stopPrelabel()}>
            <i style={{ width: `${(batch.done / Math.max(1, batch.total)) * 100}%` }} />
            <X size={15} /> Stop · {batch.done} / {batch.total}
          </button>
        ) : (
          <button className="ghost batch" onClick={prelabelAll} disabled={!toPrelabel.length || busyAi}
            title="Run the newest model on every image with no accepted shapes">
            <Sparkles size={15} /> Pre-label {toPrelabel.length} {toPrelabel.length === 1 ? 'image' : 'images'}
          </button>
        )}
      </aside>

      <main className="stage">
        <div className="toolbar">
          <div className="seg">
            <button className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')} title="Select and edit (V)"><MousePointer2 size={16} /></button>
            <button className={tool === 'polygon' ? 'on' : ''} onClick={() => setTool('polygon')} title="Polygon (P)"><Hexagon size={16} /></button>
            <button className={tool === 'rectangle' ? 'on' : ''} onClick={() => setTool('rectangle')} title="Rectangle (R)"><Square size={16} /></button>
            <button className={tool === 'brush' ? 'on' : ''} onClick={() => setTool('brush')} title="Brush: paint a class, joining shapes it touches (B)"><Paintbrush size={16} /></button>
            <button className={tool === 'eraser' ? 'on' : ''} onClick={() => setTool('eraser')} title="Eraser: cut from the selected shape, or anything it touches (E)"><Eraser size={16} /></button>
          </div>
          <button className="icon" onClick={() => stepHistory(undo, redo)} title="Undo (Ctrl+Z)"><Undo2 size={16} /></button>
          <button className="icon" onClick={() => stepHistory(redo, undo)} title="Redo (Ctrl+Shift+Z)"><Redo2 size={16} /></button>
          <button className="icon" onClick={fit} title="Fit image (0)"><Maximize size={16} /></button>
          <button className="icon" onClick={() => setShowShapes(!showShapes)} title="Show or hide shapes (F)">
            {showShapes ? <Eye size={16} /> : <EyeOff size={16} />}
          </button>
          <label className="slider">Fill
            <input type="range" min={0} max={0.8} step={0.05} value={fill} onChange={(e) => setFill(+e.target.value)} />
          </label>
          {(tool === 'brush' || tool === 'eraser') && (
            <label className="slider" title="[ and ] change it">Size
              <input type="range" min={4} max={200} step={4} value={brushSize} onChange={(e) => setBrushSize(+e.target.value)} />
            </label>
          )}
          <div className="spacer" />
          <button className="ghost" onClick={prelabel} disabled={busyAi || !!batch}>
            <Sparkles size={15} /> {busyAi ? 'Predicting…' : 'Pre-label'}
          </button>
        </div>
        <div className="canvas-wrap">
          <canvas ref={canvasRef} data-testid="canvas" className={`tool-${tool}`} onWheel={onWheel}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onPointerLeave={() => { overCanvas.current = false; invalidate() }}
            onDoubleClick={onDoubleClick} onContextMenu={(e) => e.preventDefault()} />
          {loading && <div className="loading">Preparing image…</div>}
          {notice && <div className="loading notice">{notice}</div>}
          {aiCount > 0 && (
            <div className="review-bar" data-testid="review-bar" onMouseDown={(e) => e.preventDefault()}>
              <span>
                <b>{aiCount}</b> AI {aiCount === 1 ? 'shape' : 'shapes'}
                {current?.score !== undefined && <> · this one <b className="certainty">{current ? percent(current.score!) : ''}</b></>}
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
          <span>{Math.round(zoom * 1000) / 10}%</span>
          {cursor && meta && <span>{Math.round(cursor[0])}, {Math.round(cursor[1])}</span>}
          <div className="spacer" />
          <span data-testid="save-state">{saved === 'saved' ? 'Saved' : 'Saving…'}</span>
          <span className="muted">A/D image · 1–9 class · B brush · E eraser · Space pan</span>
        </footer>
      </main>

      <aside className="panel right">
        <h3>Classes <span title="Shapes on this image · accepted shapes in the whole project">here · all</span></h3>
        <div className="classes">
          {project.classes.map((c, i) => (
            <button key={c.name} className={`class ${i === activeClass ? 'on' : ''}`} onClick={() => chooseClass(i)}>
              <i style={{ background: c.color }} /><span className="name">{c.name}</span>
              <span className="muted">{counts[c.name] ?? 0} · {totals[c.name] ?? 0}</span><kbd>{i + 1}</kbd>
              <em style={{ width: `${((totals[c.name] ?? 0) / largest) * 100}%`, background: c.color }} />
            </button>
          ))}
        </div>
        <div className="add">
          <input placeholder="New class" value={newClass} onChange={(e) => setNewClass(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addClass()} />
          <button className="icon" onClick={addClass} title="Add class"><Plus size={16} /></button>
        </div>
        <h3>Shapes on this image <span className="muted">{shapes.length}</span></h3>
        <div className="shapes">
          {shapes.map((s, i) => (
            <button key={i} className={`shape ${i === selected ? 'on' : ''}`} onClick={() => { setSelected(i); setTool('select') }}>
              <i style={{ background: colorOf(s.label) }} />
              <span className="name">{s.label}</span>
              {s.flags?.ai && <span className="tag">AI{s.score !== undefined ? ` ${percent(s.score)}` : ''}</span>}
              <span className="muted">{s.shape_type === 'polygon' ? `${s.points.length} pts` : 'box'}</span>
            </button>
          ))}
          {!shapes.length && <p className="muted pad">Nothing yet. Click on the image to start a polygon.</p>}
        </div>
        {selected !== null && (
          <button className="ghost danger" onClick={removeSelected}><Trash2 size={15} /> Delete shape</button>
        )}
      </aside>
    </div>
  )
}
