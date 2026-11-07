import { contextBridge, ipcRenderer as ipc, webUtils } from 'electron'

const on = (channel: string) => (fn: (payload: any) => void) => {
  const listener = (_e: unknown, payload: any) => fn(payload)
  ipc.on(channel, listener)
  return () => void ipc.off(channel, listener)
}

contextBridge.exposeInMainWorld('api', {
  start: () => ipc.invoke('app:start'),
  pickFolder: (title?: string) => ipc.invoke('dialog:folder', title),
  pickFile: (title: string, filters: unknown) => ipc.invoke('dialog:file', title, filters),
  pickSave: (title: string, defaultPath: string) => ipc.invoke('dialog:save', title, defaultPath),
  ask: (message: string, detail: string, buttons: string[]) => ipc.invoke('dialog:ask', message, detail, buttons),
  openProject: (target: string, output: string | null) => ipc.invoke('project:open', target, output),
  closeProject: (root: string) => ipc.invoke('project:close', root),
  saveProject: (root: string, project: unknown) => ipc.invoke('project:save', root, project),
  openImage: (root: string, name: string) => ipc.invoke('image:open', root, name),
  loadLabels: (root: string, name: string) => ipc.invoke('labels:load', root, name),
  saveLabels: (root: string, name: string, req: unknown) => ipc.invoke('labels:save', root, name, req),
  labelPath: (root: string, name: string) => ipc.invoke('labels:path', root, name),
  trashLabels: (root: string, name: string) => ipc.invoke('labels:trash', root, name),
  reveal: (root: string, name: string) => ipc.invoke('file:reveal', root, name),
  openConfig: () => ipc.invoke('config:open'),
  openLink: (url: string) => ipc.invoke('app:link', url),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  onSummaries: on('project:summaries'),
  onFlush: on('app:flush'),
  flushed: (ok: boolean) => ipc.send('app:flushed', ok),
  onError: on('app:error'),
  aiModels: () => ipc.invoke('ai:models'),
  aiDownload: (name: string) => ipc.invoke('ai:download', name),
  onAiDownload: on('ai:download'),
  aiSegment: (root: string, name: string, model: string, points: number[][], labels: number[], mode: string) =>
    ipc.invoke('ai:segment', root, name, model, points, labels, mode),
  prelabelPick: () => ipc.invoke('prelabel:pick'),
  prelabelInfo: (path: string) => ipc.invoke('prelabel:info', path),
  prelabelRun: (root: string, model: string, names: string[], classes: string[]) =>
    ipc.invoke('prelabel:run', root, model, names, classes),
  prelabelStop: () => ipc.invoke('prelabel:stop'),
  onPrelabel: on('prelabel:progress')
})
