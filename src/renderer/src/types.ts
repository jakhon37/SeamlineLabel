export type Shape = {
  label: string
  points: number[][]
  shape_type: 'polygon' | 'rectangle'
  group_id?: number | null
  description?: string
  flags?: Record<string, boolean>
}
export type LabelClass = { name: string; color: string }
export type Project = { name: string; classes: LabelClass[] }
export type ImageItem = { name: string; count: number; ai: number }
export type OpenProject = { root: string; project: Project; images: ImageItem[] }
export type OpenImage = {
  width: number; height: number; file: string; ms: number
  pyramid: { dir: string; maxLevel: number; tile: number } | null
}
export type TrainEvent = { type: string; [key: string]: any }
export type Run = { name: string; events: TrainEvent[]; options: any; running: boolean }

declare global {
  interface Window {
    api: {
      pickProject(): Promise<OpenProject | null>
      openProject(dir: string): Promise<OpenProject>
      saveProject(project: Project): Promise<void>
      openImage(name: string): Promise<OpenImage>
      loadLabels(name: string): Promise<Shape[]>
      saveLabels(name: string, shapes: Shape[], size: number[]): Promise<void>
      listRuns(): Promise<Run[]>
      startTraining(options: unknown, target: { host: string; dir: string } | null): Promise<string>
      checkRemote(host: string, dir: string): Promise<{ freeKb: number; gpu: string; gpuJobs: number; torch: string }>
      stopTraining(): Promise<void>
      activeRun(): Promise<string | null>
      checkDataset(val: number, tile: number): Promise<any>
      predict(run: string, images: string[]): Promise<{ device: string; results: Record<string, Shape[]> }>
      onLog(fn: (text: string) => void): () => void
      onEvents(fn: (p: { run: string; events: TrainEvent[] }) => void): () => void
      onExit(fn: (p: { run: string; code: number }) => void): () => void
    }
  }
}
export const fileUrl = (p: string) => 'myseg://f/' + encodeURIComponent(p)
