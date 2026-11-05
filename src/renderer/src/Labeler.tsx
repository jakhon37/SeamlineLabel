import { Check, Eye, EyeOff, Hexagon, Maximize, MousePointer2, Plus, Redo2, Sparkles, Square, Trash2, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fileUrl, ImageItem, OpenImage, OpenProject, Project, Shape } from './types'

type Tool = 'select' | 'polygon' | 'rectangle'
type Props = {
  data: OpenProject
  setProject: (p: Project) => void
  setImages: (fn: (images: ImageItem[]) => ImageItem[]) => void
  active: boolean
  onError: (m: string) => void
}
type Drag =
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'vertex'; shape: number; vertex: number }
  | { kind: 'move'; shape: number; x: number; y: number }
  | { kind: 'rect'; start: number[]; end: number[] }

const PALETTE = ['#4f8cff', '#ff6b6b', '#3ecf8e', '#f7b731', '#b57bff', '#22c7d6', '#ff8f4d', '#ec6fb3']
const HIT = 8
const CACHE_TILES = 400

function outline(s: Shape): number[][] {
  if (s.shape_type !== 'rectangle') return s.points
  const [[a, b], [c, d]] = s.points
  return [[a, b], [c, b], [c, d], [a, d]]
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
  const { project, images } = data
  const [index, setIndex] = useState(0)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'todo' | 'done'>('all')
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

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const view = useRef({ scale: 1, x: 0, y: 0 })
  const shapesRef = useRef<Shape[]>([])
  const selectedRef = useRef<number | null>(null)
  const metaRef = useRef<OpenImage | null>(null)
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
  const opts = useRef({ showShapes, fill, classes: project.classes, tool, activeClass })
  opts.current = { showShapes, fill, classes: project.classes, tool, activeClass }
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
        ctx.fill()
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
    const d = drag.current
    if (d?.kind === 'rect') {
      const [a, b] = toScreen(d.start), [c, e] = toScreen(d.end)
      ctx.strokeStyle = current
      ctx.lineWidth = 2
      ctx.strokeRect(a, b, c - a, e - b)
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
    const name = images[index]?.name
    if (!m || !name) return
    const ai = next.filter((s) => s.flags?.ai).length
    setImages((all) => all.map((i) => (i.name === name ? { ...i, count: next.length - ai, ai } : i)))
    setSaved('saving')
    pendingSave.current = () =>
      window.api.saveLabels(name, next, [m.width, m.height]).catch((e) => onError(`Save failed: ${e.message}`))
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flush, 400)
  }

  // Load the current image; older requests are dropped if you move on quickly
  useEffect(() => {
    const name = images[index]?.name
    if (!name) return
    let stale = false
    setLoading(true)
    ;(async () => {
      await flush()
      try {
        const [m, loaded] = await Promise.all([window.api.openImage(name), window.api.loadLabels(name)])
        if (stale) return
        metaRef.current = m
        shapesRef.current = loaded
        undo.current = []
        redo.current = []
        draft.current = []
        setMeta(m)
        setShapesState(loaded)
        setSelected(null)
        fit()
      } catch (e: any) {
        if (!stale) onError(`Could not open ${name}: ${e.message}`)
      } finally {
        if (!stale) setLoading(false)
      }
    })()
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, images[index]?.name])

  useEffect(invalidate, [showShapes, fill, selected, tool, activeClass, project.classes, invalidate])
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
    if (!metaRef.current) return
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
    const list = shapesRef.current
    if (selected !== null && list[selected]) {
      const pts = list[selected].points
      const v = pts.findIndex((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < radius)
      if (v >= 0) {
        if (e.altKey && list[selected].shape_type === 'polygon' && pts.length > 3) {
          setShapes(list.map((s, i) => (i === selected ? { ...s, points: pts.filter((_, k) => k !== v) } : s)))
          return
        }
        undo.current.push(list)
        redo.current = []
        drag.current = { kind: 'vertex', shape: selected, vertex: v }
        return
      }
    }
    for (let i = list.length - 1; i >= 0; i--) {
      if (inside(p, outline(list[i]))) {
        setSelected(i)
        undo.current.push(list)
        redo.current = []
        drag.current = { kind: 'move', shape: i, x: p[0], y: p[1] }
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
    const d = drag.current
    if (!d) {
      if (draft.current.length) invalidate()
      return
    }
    if (d.kind === 'pan') {
      view.current.x += e.clientX - d.x
      view.current.y += e.clientY - d.y
      d.x = e.clientX
      d.y = e.clientY
    } else if (d.kind === 'rect') {
      d.end = clampPoint(p)
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
    if (d.kind === 'rect') {
      if (Math.abs(d.start[0] - d.end[0]) > 1 && Math.abs(d.start[1] - d.end[1]) > 1) {
        const label = project.classes[activeClass]?.name
        const next = [...shapesRef.current, { label, points: [d.start, d.end], shape_type: 'rectangle' as const, flags: {} }]
        setShapes(next)
        setSelected(next.length - 1)
      }
      invalidate()
    } else if (d.kind === 'vertex' || d.kind === 'move') {
      apply(shapesRef.current.map((s, i) => (i === d.shape && s.flags?.ai ? { ...s, flags: {} } : s)))
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
      setShapes(shapesRef.current.map((q, i) => (i === selected ? { ...q, points } : q)))
    }
  }

  const stepHistory = (from: typeof undo, to: typeof undo) => {
    const prev = from.current.pop()
    if (!prev) return
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
      setShapes(shapesRef.current.map((s, k) => (k === selected ? { ...s, label: project.classes[i].name } : s)))
    }
  }

  const visible = useMemo(
    () =>
      images
        .map((image, i) => ({ image, i }))
        .filter(({ image }) => image.name.toLowerCase().includes(query.toLowerCase()))
        .filter(({ image }) => filter === 'all' || (filter === 'done') === image.count > 0),
    [images, query, filter]
  )
  const go = useCallback(
    (delta: number) => {
      const at = visible.findIndex((v) => v.i === index)
      const next = visible[Math.max(0, Math.min(visible.length - 1, at + delta))]
      if (next) setIndex(next.i)
    },
    [visible, index]
  )

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (e.code === 'Space') { space.current = e.type === 'keydown'; e.preventDefault(); return }
      if (e.type !== 'keydown') return
      if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        e.shiftKey ? stepHistory(redo, undo) : stepHistory(undo, redo)
        return
      }
      if (e.ctrlKey) return
      const k = e.key.toLowerCase()
      if (k === 'v') setTool('select')
      else if (k === 'p') setTool('polygon')
      else if (k === 'r') setTool('rectangle')
      else if (k === 'f') setShowShapes((s) => !s)
      else if (k === 'a') go(-1)
      else if (k === 'd') go(1)
      else if (k === '0') fit()
      else if (e.key === 'Enter') finishPolygon()
      else if (e.key === 'Escape') { draft.current = []; setSelected(null); invalidate() }
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

  const prelabel = async () => {
    const runs = await window.api.listRuns()
    const run = runs.find((r) => r.events.some((e) => e.type === 'epoch'))
    if (!run) return onError('Train a model first, then it can pre-label images.')
    setBusyAi(true)
    try {
      const name = images[index].name
      const { results } = await window.api.predict(run.name, [name])
      const kept = shapesRef.current.filter((s) => !s.flags?.ai)
      setShapes([...kept, ...results[name]])
    } catch (e: any) {
      onError(`Pre-label failed: ${e.message}`)
    } finally {
      setBusyAi(false)
    }
  }
  const aiCount = shapes.filter((s) => s.flags?.ai).length
  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    shapes.forEach((s) => (out[s.label] = (out[s.label] ?? 0) + 1))
    return out
  }, [shapes])

  return (
    <div className="labeler">
      <aside className="panel left">
        <input className="search" placeholder={`Search ${images.length} images`} value={query}
          onChange={(e) => setQuery(e.target.value)} />
        <div className="seg small">
          {(['all', 'todo', 'done'] as const).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
        <div className="files">
          {visible.map(({ image, i }) => (
            <button key={image.name} className={`file ${i === index ? 'on' : ''}`} onClick={() => setIndex(i)} title={image.name}>
              <i className={image.count ? 'dot done' : image.ai ? 'dot ai' : 'dot'} />
              <span className="name">{image.name}</span>
              {image.count > 0 && <span className="muted">{image.count}</span>}
            </button>
          ))}
          {!visible.length && <p className="muted pad">No images match.</p>}
        </div>
      </aside>

      <main className="stage">
        <div className="toolbar">
          <div className="seg">
            <button className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')} title="Select and edit (V)"><MousePointer2 size={16} /></button>
            <button className={tool === 'polygon' ? 'on' : ''} onClick={() => setTool('polygon')} title="Polygon (P)"><Hexagon size={16} /></button>
            <button className={tool === 'rectangle' ? 'on' : ''} onClick={() => setTool('rectangle')} title="Rectangle (R)"><Square size={16} /></button>
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
          <div className="spacer" />
          {aiCount > 0 && (
            <button className="ghost" onClick={() => setShapes(shapesRef.current.map((s) => ({ ...s, flags: {} })))}>
              <Check size={15} /> Accept {aiCount} AI {aiCount === 1 ? 'shape' : 'shapes'}
            </button>
          )}
          <button className="ghost" onClick={prelabel} disabled={busyAi}>
            <Sparkles size={15} /> {busyAi ? 'Predicting…' : 'Pre-label'}
          </button>
        </div>
        <div className="canvas-wrap">
          <canvas ref={canvasRef} data-testid="canvas" className={`tool-${tool}`} onWheel={onWheel}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onDoubleClick={onDoubleClick} onContextMenu={(e) => e.preventDefault()} />
          {loading && <div className="loading">Preparing image…</div>}
          {!images.length && <div className="loading">This folder has no images.</div>}
        </div>
        <footer className="status">
          <span>{images[index]?.name}</span>
          {meta && <span>{meta.width} × {meta.height}</span>}
          <span>{Math.round(zoom * 1000) / 10}%</span>
          {cursor && meta && <span>{Math.round(cursor[0])}, {Math.round(cursor[1])}</span>}
          <div className="spacer" />
          <span data-testid="save-state">{saved === 'saved' ? 'Saved' : 'Saving…'}</span>
          <span className="muted">A/D image · 1–9 class · Enter close · Space pan</span>
        </footer>
      </main>

      <aside className="panel right">
        <h3>Classes</h3>
        <div className="classes">
          {project.classes.map((c, i) => (
            <button key={c.name} className={`class ${i === activeClass ? 'on' : ''}`} onClick={() => chooseClass(i)}>
              <i style={{ background: c.color }} /><span className="name">{c.name}</span>
              <span className="muted">{counts[c.name] ?? 0}</span><kbd>{i + 1}</kbd>
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
              {s.flags?.ai && <span className="tag">AI</span>}
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
