import { Brain, FolderOpen, PenTool } from 'lucide-react'
import { useEffect, useState } from 'react'
import Labeler from './Labeler'
import Logo from './Logo'
import Trainer from './Trainer'
import type { ImageItem, OpenProject, Project } from './types'

type Mode = 'label' | 'train'

export default function App() {
  const [data, setData] = useState<OpenProject | null>(null)
  const [mode, setMode] = useState<Mode>('label')
  const [error, setError] = useState('')
  const [training, setTraining] = useState(false)
  const showError = (message: string) =>
    setError(message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, ''))

  const open = async (loader: () => Promise<OpenProject | null>) => {
    try {
      const next = await loader()
      if (next) {
        setData(next)
        localStorage.setItem('lastProject', next.root)
      }
    } catch (e: any) {
      showError(e.message)
    }
  }

  useEffect(() => {
    const initial = new URLSearchParams(location.search).get('project')
    const last = initial ?? localStorage.getItem('lastProject')
    if (last) window.api.openProject(last).then(setData).catch(() => {})
    const key = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return
      if (e.key === '1') setMode('label')
      if (e.key === '2') setMode('train')
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const setProject = (project: Project) => {
    setData((d) => d && { ...d, project })
    window.api.saveProject(project)
  }
  const setImages = (fn: (images: ImageItem[]) => ImageItem[]) =>
    setData((d) => d && { ...d, images: fn(d.images) })

  const done = data?.images.filter((i) => i.count > 0).length ?? 0
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><Logo size={22} /> Seamline</div>
        {data && (
          <div className="switch" role="tablist">
            <button role="tab" aria-selected={mode === 'label'} className={mode === 'label' ? 'on' : ''}
              onClick={() => setMode('label')} title="Ctrl+1">
              <PenTool size={15} /> Label
            </button>
            <button role="tab" aria-selected={mode === 'train'} className={mode === 'train' ? 'on' : ''}
              onClick={() => setMode('train')} title="Ctrl+2">
              <Brain size={15} /> Train {training && <i className="pulse" />}
            </button>
          </div>
        )}
        <div className="spacer" />
        {data && <span className="muted">{data.project.name} · {done}/{data.images.length} labelled</span>}
        <button className="ghost" onClick={() => open(window.api.pickProject)}>
          <FolderOpen size={15} /> Open folder
        </button>
      </header>
      {error && <div className="error" onClick={() => setError('')}>{error}</div>}
      {!data ? (
        <div className="empty">
          <Logo size={72} />
          <h1>Open a folder of images</h1>
          <p>Labels are saved beside each image as LabelMe JSON, so folders you labelled in LabelMe open as they are.</p>
          <button className="primary" onClick={() => open(window.api.pickProject)}>
            <FolderOpen size={16} /> Open folder
          </button>
        </div>
      ) : (
        <>
          {/* Both stay mounted, so switching keeps your place and view */}
          <div className="page" hidden={mode !== 'label'}>
            <Labeler key={data.root} data={data} setProject={setProject} setImages={setImages}
              active={mode === 'label'} onError={showError} />
          </div>
          <div className="page" hidden={mode !== 'train'}>
            <Trainer key={data.root} data={data} active={mode === 'train'} onError={showError}
              onTraining={setTraining} />
          </div>
        </>
      )}
    </div>
  )
}
