import { existsSync, promises as fs } from 'fs'
import path from 'path'

// Seamline trains in the folder it labels, one run to a folder in .myseg/runs named by the time
// it started: options.json holds the run's architecture, encoder and the like, and events.jsonl
// one JSON event a line, each epoch's with its IoU. Its Export for Seamtag writes model.onnx
// there, then model.json beside it, so a run's model is ready once both are in place.

export type RunModel = {
  path: string
  run: string
  /** The run as Seamline lists it: its name, architecture and encoder, and its best IoU */
  title: string
}

/** The best IoU of the run's epochs. Whole lines only: the last may still be being written. */
export function bestIou(events: string) {
  let best: number | null = null
  for (const line of events.slice(0, events.lastIndexOf('\n') + 1).split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e?.type === 'epoch' && typeof e.iou === 'number' && Number.isFinite(e.iou)) best = Math.max(best ?? e.iou, e.iou)
    } catch {
      // Not an event: skipped
    }
  }
  return best
}

async function runTitle(dir: string) {
  const options = await fs.readFile(path.join(dir, 'options.json'), 'utf8').then(JSON.parse).catch(() => null)
  const iou = bestIou(await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8').catch(() => ''))
  const text = (v: unknown) => (typeof v === 'string' && v ? v : null)
  return [path.basename(dir), text(options?.architecture), text(options?.encoder), iou === null ? null : `IoU ${iou.toFixed(3)}`]
    .filter(Boolean).join(' · ')
}

/** The models exported from the folder's runs, newest run first, as Seamline lists them */
export async function runModels(root: string): Promise<RunModel[]> {
  const runs = path.join(root, '.myseg', 'runs')
  const names = await fs.readdir(runs).catch(() => [] as string[])
  const found: RunModel[] = []
  for (const run of names.sort().reverse()) {
    const file = path.join(runs, run, 'model.onnx')
    if (!existsSync(file) || !existsSync(path.join(runs, run, 'model.json'))) continue
    found.push({ path: file, run, title: await runTitle(path.join(runs, run)) })
  }
  return found
}

/** The folder whose run exported the model, for one Seamline exported: <folder>/.myseg/runs/<run>/model.onnx */
export function exportedFrom(file: string) {
  const runs = path.dirname(path.dirname(file))
  if (path.basename(file) !== 'model.onnx' || path.basename(runs) !== 'runs' || path.basename(path.dirname(runs)) !== '.myseg') return null
  return path.dirname(path.dirname(runs))
}

/** A model Seamline exported goes by its run, since every export is called model.onnx */
export async function exportedTitle(file: string) {
  return exportedFrom(file) === null ? null : runTitle(path.dirname(file))
}
