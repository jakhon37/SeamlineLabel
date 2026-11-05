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
  loadLabels: (name: string) => ipc.invoke('labels:load', name),
  saveLabels: (name: string, shapes: unknown, size: number[]) =>
    ipc.invoke('labels:save', name, shapes, size),
  listRuns: () => ipc.invoke('runs:list'),
  startTraining: (options: unknown, target: unknown) => ipc.invoke('train:start', options, target),
  checkRemote: (host: string, dir: string) => ipc.invoke('remote:check', host, dir),
  stopTraining: () => ipc.invoke('train:stop'),
  activeRun: () => ipc.invoke('train:active'),
  checkDataset: (val: number, tile: number) => ipc.invoke('dataset:check', val, tile),
  predict: (run: string, images: string[]) => ipc.invoke('model:predict', run, images),
  onLog: on('train:log'),
  onEvents: on('train:events'),
  onExit: on('train:exit')
})
