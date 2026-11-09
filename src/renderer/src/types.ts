import type { Config } from '../../shared/config'
import type { LabelFormat } from '../../shared/formats'
import type { LabelDoc, Shape } from '../../shared/labelfile'
import type { Summary } from '../../shared/labels'

export type { Config, LabelDoc, LabelFormat, Shape }

export type LabelClass = { name: string; color: string }
export type ProjectInfo = { name: string; classes: LabelClass[] }
export type ImageItem = Summary & { name: string; broken?: string; embedded?: boolean; verified?: boolean }
export type OpenProject = {
  root: string
  outputDir: string | null
  project: ProjectInfo
  hasProjectFile: boolean
  images: ImageItem[]
  select: string | null
}
export type OpenImage = {
  width: number; height: number; file: string; ms: number
  pyramid: { dir: string; maxLevel: number; tile: number } | null
}
export type Start = {
  config: Config | null
  configError: string
  configFile: string | null
  warnings: string[]
  version: string
  platform: string
  filename: string | null
  output: string | null
  recent: string[]
}
export type SaveRequest = {
  shapes: Shape[]
  flags: Record<string, boolean>
  size: [number, number]
  storeData: boolean
  target?: string
  format?: LabelFormat
  verified?: boolean
  classes?: string[]
  from?: LabelFormat
}
export type Loaded = { file: string; format: LabelFormat | null; verified: boolean; doc: LabelDoc | null }
export type ModelInfo = { name: string; title: string; size: number; downloaded: boolean }
export type SegmentResult =
  | { kind: 'polygon'; points: number[][] }
  | { kind: 'mask'; box: number[][]; mask: string }
  | { kind: 'none' }
export type PrelabelModel = { path: string; name: string; classes: string[]; inputSize: number[]; tile: number }

declare global {
  interface Window {
    api: {
      start(): Promise<Start>
      pickFolder(title?: string): Promise<string | null>
      pickFile(title: string, filters: { name: string; extensions: string[] }[]): Promise<string | null>
      pickSave(title: string, defaultPath: string, format?: LabelFormat): Promise<string | null>
      ask(message: string, detail: string, buttons: string[]): Promise<number>
      openProject(target: string, output: string | null): Promise<OpenProject>
      closeProject(root: string): Promise<void>
      saveProject(root: string, project: ProjectInfo): Promise<void>
      openImage(root: string, name: string): Promise<OpenImage>
      loadLabels(root: string, name: string, prefer?: LabelFormat, size?: [number, number]): Promise<Loaded>
      saveLabels(root: string, name: string, req: SaveRequest): Promise<{ file: string; item: ImageItem; format: LabelFormat; replaced?: string; kept?: string }>
      labelPath(root: string, name: string, prefer: LabelFormat): Promise<string>
      trashLabels(root: string, name: string, prefer: LabelFormat): Promise<string | null>
      readLabelFile(root: string, name: string, file: string, size?: [number, number]): Promise<Loaded & { doc: LabelDoc; format: LabelFormat }>
      trashImage(root: string, name: string): Promise<{ image: string; kept?: string }>
      hasLabelsIn(root: string, name: string, format: LabelFormat): Promise<boolean>
      resetSettings(): Promise<void>
      reveal(root: string, name: string): Promise<void>
      openConfig(): Promise<void>
      openLink(url: string): Promise<void>
      pathForFile(file: File): string
      onSummaries(fn: (p: { root: string; items: ImageItem[]; labels: string[] }) => void): () => void
      onFlush(fn: () => void): () => void
      flushed(ok: boolean): void
      onError(fn: (message: string) => void): () => void
      aiModels(): Promise<ModelInfo[]>
      aiDownload(name: string): Promise<void>
      onAiDownload(fn: (p: { name: string; done: number; total: number }) => void): () => void
      aiSegment(root: string, name: string, model: string, points: number[][], labels: number[], mode: 'polygon' | 'mask'): Promise<SegmentResult>
      prelabelPick(): Promise<PrelabelModel | null>
      prelabelInfo(path: string): Promise<PrelabelModel>
      prelabelRun(root: string, model: string, names: string[], classes: string[]): Promise<{ done: number; total: number; stopped: boolean; failed: string[]; error?: string }>
      prelabelStop(): Promise<void>
      onPrelabel(fn: (p: { root: string; name: string; shapes: Shape[] | null; done: number; total: number }) => void): () => void
    }
  }
}

export const fileUrl = (p: string) => 'myseg://f/' + encodeURIComponent(p)
export const plainError = (e: unknown) =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
