import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { describe, expect, test } from 'vitest'
import { bestIou, exportedFrom, exportedTitle, runModels } from '../../src/main/runs'

// Seamline's run folders, as its engine writes them; the models are never run here, so any bytes do
const SIDECAR = JSON.stringify({ classes: ['scratch', 'dent'], mean: [0, 0, 0], std: [1, 1, 1], tile: 1024, input_size: [512, 512] })
const epoch = (n: number, iou: number) => JSON.stringify({ type: 'epoch', epoch: n, epochs: 30, train_loss: 0.4, val_loss: 0.5, iou, f1: iou }) + '\n'

function folder(runs: Record<string, Record<string, string>>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'seamtag-runs-'))
  for (const [run, files] of Object.entries(runs)) {
    mkdirSync(path.join(dir, '.myseg', 'runs', run), { recursive: true })
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, '.myseg', 'runs', run, name), text)
  }
  return dir
}

describe("a folder's exported models", () => {
  test('newest run first, each named by its run, architecture, encoder and best IoU', async () => {
    const dir = folder({
      '20261110_090000': {
        'model.onnx': 'onnx', 'model.json': SIDECAR, 'options.json': JSON.stringify({ architecture: 'Unet', encoder: 'resnet34', tile: 1024 }),
        'events.jsonl': JSON.stringify({ type: 'start', epochs: 30 }) + '\n' + epoch(1, 0.5) + epoch(2, 0.71) + epoch(3, 0.65) + JSON.stringify({ type: 'done' }) + '\n'
      },
      // Still training: the last line is only half written
      '20261112_101500': {
        'model.onnx': 'onnx', 'model.json': SIDECAR, 'options.json': JSON.stringify({ architecture: 'DeepLabV3Plus', encoder: 'efficientnet-b0' }),
        'events.jsonl': epoch(1, 0.42) + '{"type": "epoch", "epoch": 2, "iou": 0.9'
      },
      // Exported before options and events were kept
      '20261109_080000': { 'model.onnx': 'onnx', 'model.json': SIDECAR },
      // An export still being written: model.json comes last
      '20261111_000000': { 'model.onnx': 'onnx', 'options.json': '{}' },
      // Trained, never exported
      '20261113_070000': { 'options.json': JSON.stringify({ architecture: 'Unet', encoder: 'resnet34' }), 'events.jsonl': epoch(1, 0.8) }
    })
    const models = await runModels(dir)
    expect(models.map((m) => m.run)).toEqual(['20261112_101500', '20261110_090000', '20261109_080000'])
    expect(models.map((m) => m.title)).toEqual([
      '20261112_101500 · DeepLabV3Plus · efficientnet-b0 · IoU 0.420',
      '20261110_090000 · Unet · resnet34 · IoU 0.710',
      '20261109_080000'
    ])
    expect(models[0].path).toBe(path.join(dir, '.myseg', 'runs', '20261112_101500', 'model.onnx'))
  })

  test('a folder without runs has none, and options or events that can not be read leave the name', async () => {
    expect(await runModels(mkdtempSync(path.join(tmpdir(), 'seamtag-runs-')))).toEqual([])
    const dir = folder({ '20261110_090000': { 'model.onnx': 'onnx', 'model.json': SIDECAR, 'options.json': '{"architecture": ', 'events.jsonl': 'not json\n' } })
    expect((await runModels(dir)).map((m) => m.title)).toEqual(['20261110_090000'])
  })

  test("the best IoU is the epochs' highest; other events and broken lines don't count", () => {
    expect(bestIou('')).toBeNull()
    expect(bestIou(JSON.stringify({ type: 'done', iou: 0.99 }) + '\n' + epoch(1, 0.3) + 'oops\n' + epoch(2, 0.6) + '{"type": "epoch", "iou": "high"}\n')).toBe(0.6)
  })

  test("a model Seamline exported goes by its run's name; any other by none", async () => {
    const dir = folder({ '20261110_090000': { 'model.onnx': 'onnx', 'model.json': SIDECAR, 'options.json': JSON.stringify({ architecture: 'Unet', encoder: 'resnet34' }) } })
    expect(await exportedTitle(path.join(dir, '.myseg', 'runs', '20261110_090000', 'model.onnx'))).toBe('20261110_090000 · Unet · resnet34')
    expect(await exportedTitle(path.join(dir, 'model.onnx'))).toBeNull()
    expect(await exportedTitle(path.join(dir, '.myseg', 'runs', '20261110_090000', 'other.onnx'))).toBeNull()
    // And it's known which folder's run it is
    expect(exportedFrom(path.join(dir, '.myseg', 'runs', '20261110_090000', 'model.onnx'))).toBe(dir)
    expect(exportedFrom(path.join(dir, 'model.onnx'))).toBeNull()
  })
})
