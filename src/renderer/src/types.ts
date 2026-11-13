import type { AiOutput, Config } from '../../shared/config'
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
  /** What Open recent and the last folder keep: what was opened, or the Seamline project a start on an image in its subfolder opened */
  remembered: string
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
  /** Saved automatically: with nothing to keep, an image with no label file gets none */
  auto?: boolean
}
export type Loaded = {
  file: string; format: LabelFormat | null; verified: boolean; doc: LabelDoc | null
  /** Opened to edit: another app changed the labels since Seamtag last read or wrote them */
  changed?: boolean
}
/** Nothing was written: another app changed the image's labels since the window read them */
export type Changed = { changed: string }
export type ModelInfo = {
  name: string; title: string; textTitle?: string; size: number; downloaded: boolean; downloading: boolean
  license: { name: string; url: string }
  /** What it takes: clicks, a box, words */
  points: boolean; box: boolean; text: boolean
}
/** A shape the AI proposes; a mask shape's pixels as labelme's base64 PNG */
export type ProposedShape = { label?: string; shape_type: AiOutput; points: number[][]; mask?: string; description?: string; group_id?: number | null }
export type DrawnShape = { shape_type: string; points: number[][]; label?: string; mask?: string | null }
export type AssistRequest = {
  root: string; name: string; model: string; points: number[][]; labels: number[]; output: AiOutput; detail: number
  drawn: DrawnShape[] | null; groups: number[]; outside: boolean
}
export type TextRequest = Omit<AssistRequest, 'points' | 'labels' | 'drawn'> & { texts: string[]; drawn: DrawnShape[]; iou: number; score: number }
/** New shapes, and the indexes of drawn shapes the AI found again; `notice` when nothing could be made */
export type Proposal = { shapes: ProposedShape[]; matched: number[]; notice?: string }
/** `project`: the folder whose Seamline run exported it, or null */
export type PrelabelModel = { path: string; name: string; project: string | null; classes: string[]; inputSize: number[]; tile: number }
/** A model Seamline exported from one of the folder's training runs */
export type RunModel = { path: string; run: string; title: string }

declare global {
  interface Window {
    api: {
      start(): Promise<Start>
      pickFolder(title?: string): Promise<string | null>
      pickFile(title: string, filters: { name: string; extensions: string[] }[]): Promise<string | null>
      pickSave(title: string, defaultPath: string, format?: LabelFormat): Promise<string | null>
      ask(message: string, detail: string, buttons: string[]): Promise<number>
      /** A question or file dialog is open, or about to open */
      asking(): boolean
      /** `again`: opened from Open recent or as the last folder, so a folder remembered on an image opens on it */
      openProject(target: string, output: string | null, started?: boolean, again?: boolean): Promise<OpenProject>
      closeProject(root: string): Promise<void>
      saveProject(root: string, project: ProjectInfo, shown?: LabelClass[]): Promise<ProjectInfo>
      reloadProject(root: string): Promise<ProjectInfo | null>
      refreshProject(root: string): Promise<{ names: string[]; added: ImageItem[] }>
      summarize(root: string): Promise<void>
      openImage(root: string, name: string): Promise<OpenImage>
      loadLabels(root: string, name: string, prefer?: LabelFormat, size?: [number, number], edit?: boolean): Promise<Loaded>
      /** `format` is null when the image has no label file now: saved automatically, it had nothing to keep */
      saveLabels(root: string, name: string, req: SaveRequest): Promise<{ file: string; item: ImageItem; format: LabelFormat | null; replaced?: string; kept?: string } | Changed>
      labelsChanged(root: string, name: string): Promise<boolean>
      labelPath(root: string, name: string, prefer: LabelFormat): Promise<string>
      trashLabels(root: string, name: string, prefer: LabelFormat): Promise<string | null | Changed>
      readLabelFile(root: string, name: string, file: string, size?: [number, number]): Promise<Loaded & { doc: LabelDoc; format: LabelFormat }>
      trashImage(root: string, name: string): Promise<{ image: string; kept?: string } | Changed>
      hasLabelsIn(root: string, name: string, format: LabelFormat): Promise<boolean>
      resetSettings(): Promise<void>
      reveal(root: string, name: string): Promise<void>
      openConfig(): Promise<void>
      openLink(url: string): Promise<void>
      pathForFile(file: File): string
      onSummaries(fn: (p: { root: string; items: ImageItem[]; labels: string[] }) => void): () => void
      onFocus(fn: () => void): () => void
      /** Seamtag started again with this: `here` when it's a folder open here, or one of its images */
      onOpen(fn: (p: { target: string; output: string | null; here: { root: string; name: string | null } | null }) => void): () => void
      onFlush(fn: () => void): () => void
      flushed(ok: boolean): void
      onError(fn: (message: string) => void): () => void
      aiModels(): Promise<ModelInfo[]>
      aiDownload(name: string): Promise<void>
      onAiDownload(fn: (p: { name: string; model: string; done: number; total: number }) => void): () => void
      aiCancel(name: string): Promise<void>
      aiRemove(name: string): Promise<void>
      aiAssist(req: AssistRequest): Promise<Proposal>
      aiText(req: TextRequest): Promise<Proposal>
      mergeMasks(shapes: { points: number[][]; mask: string }[]): Promise<{ points: number[][]; mask: string }>
      prelabelPick(root?: string): Promise<PrelabelModel | null>
      prelabelInfo(path: string): Promise<PrelabelModel>
      prelabelModels(root: string): Promise<RunModel[]>
      /** `nothing`: the images the model found nothing on, which keep their labels as they were */
      prelabelRun(root: string, model: string, names: string[], classes: string[], batch?: boolean): Promise<{ done: number; total: number; stopped: boolean; failed: string[]; nothing: string[]; error?: string }>
      prelabelStop(): Promise<void>
      onPrelabel(fn: (p: { root: string; name: string; shapes: Shape[] | null; done: number; total: number; changed: boolean }) => void): () => void
    }
  }
}

export const fileUrl = (p: string) => 'myseg://f/' + encodeURIComponent(p)
export const plainError = (e: unknown) =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
