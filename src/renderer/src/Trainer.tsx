import { Play, RefreshCw, Square } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { OpenProject, Run, TrainEvent } from './types'

const ARCHS = ['Unet', 'UnetPlusPlus', 'DeepLabV3', 'DeepLabV3Plus', 'FPN', 'PSPNet', 'PAN', 'Linknet', 'MAnet']
const ENCODERS = ['resnet18', 'resnet34', 'resnet50', 'efficientnet-b0', 'efficientnet-b4', 'mobilenet_v2', 'densenet121']
const LOSSES = ['combined', 'focal', 'dice', 'cross_entropy']

type Props = { data: OpenProject; active: boolean; onError: (m: string) => void; onTraining: (on: boolean) => void }
type Series = { name: string; color: string; values: number[] }

function Chart({ title, series, max }: { title: string; series: Series[]; max?: number }) {
  const W = 600, H = 200, L = 40, B = 20, T = 8
  const all = series.flatMap((s) => s.values)
  const top = max ?? Math.max(...all, 1e-6) * 1.1
  const count = Math.max(...series.map((s) => s.values.length))
  const n = Math.max(count, 2)
  const px = (i: number) => L + (i / (n - 1)) * (W - L - 8)
  const py = (v: number) => T + (1 - Math.min(v, top) / top) * (H - T - B)
  return (
    <section className="card chart">
      <header>
        <h3>{title}</h3>
        <div className="legend">
          {series.map((s) => (
            <span key={s.name}><i style={{ background: s.color }} />{s.name}{' '}
              <b>{s.values.length ? s.values[s.values.length - 1].toFixed(3) : '–'}</b></span>
          ))}
        </div>
      </header>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - 8} y1={py(top * f)} y2={py(top * f)} className="grid" />
            {count > 0 && <text x={L - 6} y={py(top * f) + 4} textAnchor="end">{(top * f).toFixed(2)}</text>}
          </g>
        ))}
        {count > 0
          ? <text x={W - 8} y={H - 4} textAnchor="end">epoch {count}</text>
          : <text x={(L + W - 8) / 2} y={py(top * 0.5) - 8} textAnchor="middle">No epochs yet</text>}
        {series.map((s) => (
          <g key={s.name}>
            <polyline fill="none" stroke={s.color} strokeWidth={2}
              points={s.values.map((v, i) => `${px(i)},${py(v)}`).join(' ')} />
            {s.values.length === 1 && <circle cx={px(0)} cy={py(s.values[0])} r={3.5} fill={s.color} />}
          </g>
        ))}
      </svg>
    </section>
  )
}

// Progress bars redraw with \r and would bury the useful lines
const cleanLog = (text: string) =>
  text.split(/[\r\n]+/).filter((l) => l.trim() && !/\d+%\|/.test(l)).map((l) => l + '\n').join('')

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>
}

export default function Trainer({ data, active, onError, onTraining }: Props) {
  const [options, setOptions] = useState({
    architecture: 'Unet', encoder: 'resnet34', encoder_weights: 'imagenet', loss: 'combined',
    epochs: 30, batch_size: 8, image_size: 512, learning_rate: 0.0001, val_split: 0.2, tile: 1024, num_workers: 4
  })
  const [runs, setRuns] = useState<Run[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [log, setLog] = useState('')
  const [saved, setSaved] = useState('')
  // The run whose output is in `log`: any other run shows what it saved
  const streamed = useRef<string | null>(null)
  const [check, setCheck] = useState<any>(null)
  const [checking, setChecking] = useState(false)
  const stored = (key: string, fallback: string) => {
    try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
  }
  const [where, setWhere] = useState(stored('trainWhere', 'local'))
  const [host, setHost] = useState(stored('trainHost', ''))
  const [dir, setDir] = useState(stored('trainDir', 'myseg-studio'))
  const [remote, setRemote] = useState<string>('')
  const logRef = useRef<HTMLPreElement>(null)

  const set = (key: string, value: unknown) => setOptions((o) => ({ ...o, [key]: value }))
  const reload = async () => {
    const list = await window.api.listRuns()
    setRuns(list)
    setCurrent((c) => c ?? list[0]?.name ?? null)
  }
  // Asked rather than assumed: each folder mounts a new Trainer, and another run can outlast the one that ended
  const syncRunning = () => window.api.activeRun().then((r) => {
    if (r) streamed.current = r
    setRunning(r)
    onTraining(!!r)
  })

  useEffect(() => {
    reload()
    syncRunning()
    const offLog = window.api.onLog((t) => setLog((l) => (l + cleanLog(t)).slice(-20000)))
    const offEvents = window.api.onEvents(({ run, events }) =>
      setRuns((all) => all.map((r) => (r.name === run ? { ...r, events } : r)))
    )
    const offExit = window.api.onExit(() => { syncRunning(); reload() })
    return () => { offLog(); offEvents(); offExit() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { if (active) reload() /* eslint-disable-next-line */ }, [active])
  useEffect(() => {
    setSaved('')
    if (!current || current === streamed.current) return
    let live = true
    window.api.runLog(current).then((text) => { if (live) setSaved(cleanLog(text).slice(-20000)) }).catch(() => {})
    return () => { live = false }
  }, [current, running])
  // A hidden panel can't scroll, so opening the tab counts as new text
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight)
  }, [log, saved, active])

  const runCheck = async () => {
    setChecking(true)
    try {
      setCheck(await window.api.checkDataset(options.val_split, options.tile))
    } catch (e: any) {
      onError(`Dataset check failed: ${e.message}`)
    } finally {
      setChecking(false)
    }
  }
  const testRemote = async () => {
    setRemote('Connecting…')
    try {
      const r = await window.api.checkRemote(host, dir)
      const [name, free, total] = r.gpu.split(', ').map((part) => part.trim())
      const memory = total ? ` · ${(parseInt(free) / 1024).toFixed(1)} of ${(parseInt(total) / 1024).toFixed(1)} GB memory free` : ''
      setRemote(`${name || 'No GPU found'}${memory} · ${r.gpuJobs} GPU jobs · ${(r.freeKb / 1048576).toFixed(1)} GB free on disk`)
    } catch (e: any) {
      setRemote(`Failed: ${e.message}`)
    }
  }
  const start = async () => {
    setStarting(true)
    setLog('')
    try {
      localStorage.setItem('trainWhere', where)
      localStorage.setItem('trainHost', host)
      localStorage.setItem('trainDir', dir)
      const run = await window.api.startTraining(options, where === 'ssh' ? { host, dir } : null)
      streamed.current = run
      setRunning(run)
      onTraining(true)
      setCurrent(run)
      await reload()
    } catch (e: any) {
      onError(`Could not start training: ${e.message}`)
    } finally {
      setStarting(false)
    }
  }

  const selected = runs.find((r) => r.name === current)
  const events: TrainEvent[] = selected?.events ?? []
  const epochs = useMemo(() => events.filter((e) => e.type === 'epoch'), [events])
  const failure = events.find((e) => e.type === 'error')
  const prepared = events.find((e) => e.type === 'prepared')
  const last = epochs[epochs.length - 1]
  const best = epochs.length ? epochs.reduce((a, b) => (b.iou > a.iou ? b : a)) : null
  const labelled = data.images.filter((i) => i.count > 0).length
  const isRunning = !!running && running === current

  return (
    <div className="trainer">
      <aside className="panel left wide">
        <h3>New training run</h3>
        <Field label="Architecture">
          <select value={options.architecture} onChange={(e) => set('architecture', e.target.value)}>
            {ARCHS.map((a) => <option key={a}>{a}</option>)}
          </select>
        </Field>
        <Field label="Encoder">
          <select value={options.encoder} onChange={(e) => set('encoder', e.target.value)}>
            {ENCODERS.map((a) => <option key={a}>{a}</option>)}
          </select>
        </Field>
        <Field label="Loss">
          <select value={options.loss} onChange={(e) => set('loss', e.target.value)}>
            {LOSSES.map((a) => <option key={a}>{a}</option>)}
          </select>
        </Field>
        <div className="row">
          <Field label="Epochs"><input type="number" min={1} value={options.epochs} onChange={(e) => set('epochs', +e.target.value)} /></Field>
          <Field label="Batch"><input type="number" min={1} value={options.batch_size} onChange={(e) => set('batch_size', +e.target.value)} /></Field>
        </div>
        <div className="row">
          <Field label="Input size"><input type="number" step={32} min={32} value={options.image_size} onChange={(e) => set('image_size', +e.target.value)} /></Field>
          <Field label="Learning rate"><input type="number" step={0.0001} min={0} value={options.learning_rate} onChange={(e) => set('learning_rate', +e.target.value)} /></Field>
        </div>
        <div className="row">
          <Field label="Validation share"><input type="number" step={0.05} min={0.05} max={0.5} value={options.val_split} onChange={(e) => set('val_split', +e.target.value)} /></Field>
          <Field label="Tile size"><input type="number" step={256} min={256} value={options.tile} onChange={(e) => set('tile', +e.target.value)} /></Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={options.encoder_weights === 'imagenet'}
            onChange={(e) => set('encoder_weights', e.target.checked ? 'imagenet' : null)} />
          Start from ImageNet weights
        </label>
        <Field label="Run on">
          <select value={where} onChange={(e) => setWhere(e.target.value)}>
            <option value="local">This computer</option>
            <option value="ssh">GPU machine over SSH</option>
          </select>
        </Field>
        {where === 'ssh' && (
          <>
            <Field label="SSH host"><input placeholder="user@host" value={host} onChange={(e) => setHost(e.target.value)} /></Field>
            <Field label="Remote folder"><input value={dir} onChange={(e) => setDir(e.target.value)} /></Field>
            <button className="ghost" onClick={testRemote} disabled={!host}>Test connection</button>
            {remote && <p className="muted" data-testid="remote-status">{remote}</p>}
          </>
        )}
        {running ? (
          <button className="primary danger" onClick={() => window.api.stopTraining()}><Square size={15} /> Stop training</button>
        ) : (
          <button className="primary" onClick={start} disabled={starting || labelled < 2 || (where === 'ssh' && !host)}>
            <Play size={15} /> {starting ? 'Preparing dataset…' : `Train on ${labelled} labelled images`}
          </button>
        )}
        {labelled < 2 && <p className="muted">Label at least two images first.</p>}

        <h3 className="gap">Dataset check
          <button className="icon" onClick={runCheck} disabled={checking} title="Check dataset"><RefreshCw size={14} /></button>
        </h3>
        {checking && <p className="muted">Checking…</p>}
        {check && (
          <div className="kv">
            <div><span>Labelled images</span><b>{check.labelled}</b></div>
            <div><span>Not labelled yet</span><b>{check.unlabelled}</b></div>
            <div><span>Train / val samples</span><b>{check.train} / {check.val}</b></div>
            {Object.entries(check.class_pixels as Record<string, number>).map(([k, v]) => (
              <div key={k}><span>{k} pixels</span><b>{v.toLocaleString()}</b></div>
            ))}
            {check.unknown_labels.length > 0 && (
              <p className="warn">Ignored, not in class list: {check.unknown_labels.join(', ')}</p>
            )}
          </div>
        )}
      </aside>

      <main className="results">
        <div className="tiles">
          <div className="tile"><span>Status</span>
            <b>{failure ? 'Failed' : isRunning ? 'Training' : events.some((e) => e.type === 'done') ? 'Finished' : selected ? 'Stopped' : '–'}</b></div>
          <div className="tile"><span>Epoch</span><b>{last ? `${last.epoch + 1} / ${last.epochs}` : '–'}</b></div>
          <div className="tile"><span>Best IoU</span><b>{best ? best.iou.toFixed(3) : '–'}</b></div>
          <div className="tile"><span>Device</span><b className="fit" data-testid="device">{events.find((e) => e.type === 'start')?.device ?? '–'}</b></div>
          <div className="tile"><span>Samples</span><b>{prepared ? `${prepared.train} / ${prepared.val}` : '–'}</b></div>
        </div>
        {failure && <div className="error static">{failure.message}</div>}
        <div className="charts">
          <Chart title="Loss" series={[
            { name: 'train', color: '#4f8cff', values: epochs.map((e) => e.train_loss) },
            { name: 'validation', color: '#ff8f4d', values: epochs.map((e) => e.val_loss) }
          ]} />
          <Chart title="Validation quality" max={1} series={[
            { name: 'IoU', color: '#3ecf8e', values: epochs.map((e) => e.iou) },
            { name: 'F1', color: '#b57bff', values: epochs.map((e) => e.f1) }
          ]} />
        </div>
        <section className="card logs">
          <header><h3>Log</h3></header>
          <pre ref={logRef} data-testid="log">{saved || log || 'Output appears here once a run starts.'}</pre>
        </section>
      </main>

      <aside className="panel right">
        <h3>Runs</h3>
        <div className="shapes">
          {runs.map((r) => {
            const done = r.events.filter((e) => e.type === 'epoch')
            const top = done.length ? Math.max(...done.map((e) => e.iou)) : null
            return (
              <button key={r.name} className={`run ${r.name === current ? 'on' : ''}`} onClick={() => setCurrent(r.name)}>
                <span className="name">{r.options?.architecture} · {r.options?.encoder}</span>
                <span className="muted">{r.name.replace('_', ' ')}{r.options?.target ? ` · ${r.options.target.host}` : ''}</span>
                <span className="muted">{r.name === running ? 'running' : top !== null ? `IoU ${top.toFixed(3)}` : 'no result'}</span>
              </button>
            )
          })}
          {!runs.length && <p className="muted pad">Runs you start appear here.</p>}
        </div>
      </aside>
    </div>
  )
}
