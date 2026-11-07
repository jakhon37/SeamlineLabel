import { contextBridge, ipcRenderer as ipc } from 'electron'

const on = (channel: string) => (fn: (payload: any) => void) => {
  const listener = (_e: unknown, payload: any) => fn(payload)
  ipc.on(channel, listener)
  return () => void ipc.off(channel, listener)
}

contextBridge.exposeInMainWorld('api', {
  pickProject: () => ipc.invoke('project:pick'),
  openProject: (dir: string) => ipc.invoke('project:open', dir),
  saveProject: (project: unknown) => ipc.invoke('project:save', project),
  openImage: (name: string) => ipc.invoke('image:open', name),
  loadLabels: (root: string, name: string) => ipc.invoke('labels:load', root, name),
  saveLabels: (root: string, name: string, shapes: unknown, size: number[]) =>
    ipc.invoke('labels:save', root, name, shapes, size),
  listRuns: () => ipc.invoke('runs:list'),
  runLog: (name: string) => ipc.invoke('runs:log', name),
  startTraining: (options: unknown, target: unknown) => ipc.invoke('train:start', options, target),
  checkRemote: (host: string, dir: string) => ipc.invoke('remote:check', host, dir),
  stopTraining: () => ipc.invoke('train:stop'),
  activeRun: () => ipc.invoke('train:active'),
  checkDataset: (val: number, tile: number) => ipc.invoke('dataset:check', val, tile),
  predict: (run: string, images: string[]) => ipc.invoke('model:predict', run, images),
  prelabelAll: (run: string, names: string[]) => ipc.invoke('prelabel:start', run, names),
  stopPrelabel: () => ipc.invoke('prelabel:stop'),
  onPrelabel: on('prelabel:progress'),
  onFlush: on('app:flush'),
  flushed: () => ipc.send('app:flushed'),
  onLog: on('train:log'),
  onEvents: on('train:events'),
  onExit: on('train:exit')
})
