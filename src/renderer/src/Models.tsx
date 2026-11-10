import type { ModelInfo } from './types'

// labelme 7's AI Models window: each model, what it takes, its size and licence; download,
// cancel or delete. The files are osam's cache, which labelme reads too.

type Props = {
  models: ModelInfo[]
  progress: { model: string; done: number; total: number } | null
  onDownload: (name: string) => void
  onCancel: (name: string) => void
  onRemove: (name: string) => void
  onLink: (url: string) => void
  onClose: () => void
}

const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`)
const takes = (m: ModelInfo) => [m.points && 'clicks', m.box && 'a box', m.text && 'words'].filter(Boolean).join(', ')

export default function Models({ models, progress, onDownload, onCancel, onRemove, onLink, onClose }: Props) {
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog models" role="dialog" aria-label="AI models" onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose() }}>
        <h3>AI models</h3>
        <p className="muted">Downloaded once into ~/.cache/osam, which labelme uses too: a model either app downloaded is here already.</p>
        <table>
          <thead><tr><th>Model</th><th>Takes</th><th>Size</th><th>Licence</th><th /></tr></thead>
          <tbody>
            {models.map((m) => {
              const busy = progress?.model === m.name || m.downloading
              return (
                <tr key={m.name} data-model={m.name}>
                  <td>{m.title}</td>
                  <td className="muted">{takes(m)}</td>
                  <td className="muted">{size(m.size)}</td>
                  <td><a href={m.license.url} onClick={(e) => { e.preventDefault(); onLink(m.license.url) }}>{m.license.name}</a></td>
                  <td className="act">
                    {busy ? (
                      <>
                        <span className="muted">{progress?.model === m.name ? `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` : '…'}</span>
                        <button className="ghost" onClick={() => onCancel(m.name)}>Cancel</button>
                      </>
                    ) : m.downloaded ? (
                      <button className="ghost" onClick={() => onRemove(m.name)}>Delete</button>
                    ) : (
                      <button className="ghost" onClick={() => onDownload(m.name)}>Download</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="actions">
          <button className="primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
