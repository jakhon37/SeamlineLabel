import { useEffect, useMemo, useRef, useState } from 'react'
import type { Config } from '../../shared/config'

export type LabelChoice = { text: string; flags: Record<string, boolean>; group_id: number | null; description: string }

export type LabelRequest = {
  text: string
  flags: Record<string, boolean> | null
  group_id: number | null
  description: string | null
  /** Editing several shapes: fields they don't share can't be changed */
  locked?: { text?: boolean; flags?: boolean; group_id?: boolean; description?: boolean }
  at?: { x: number; y: number }
  title?: string
}

/** labelme's label_flags: every pattern that matches the start of the label adds its flags */
export function flagsFor(label: string, labelFlags: Config['label_flags'], current: Record<string, boolean> = {}) {
  const out: Record<string, boolean> = {}
  for (const [pattern, keys] of Object.entries(labelFlags ?? {})) {
    let re: RegExp
    try {
      re = new RegExp(`^(?:${pattern})`)
    } catch {
      continue
    }
    if (re.test(label)) for (const k of keys) out[k] = current[k] ?? false
  }
  return out
}

type Props = {
  request: LabelRequest
  labels: string[]
  config: Config
  onDone: (choice: LabelChoice | null) => void
}

export default function LabelDialog({ request, labels, config, onDone }: Props) {
  const locked = request.locked ?? {}
  const [text, setText] = useState(request.text)
  const [flags, setFlags] = useState<Record<string, boolean>>(() => ({
    ...flagsFor(request.text, config.label_flags, request.flags ?? {}),
    ...(request.flags ?? {})
  }))
  const [group, setGroup] = useState(request.group_id === null ? '' : String(request.group_id))
  const [description, setDescription] = useState(request.description ?? '')
  const [active, setActive] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const sorted = useMemo(() => (config.sort_labels ? [...labels].sort((a, b) => a.localeCompare(b)) : labels), [labels, config.sort_labels])
  const shown = useMemo(() => {
    const t = text.trim().toLowerCase()
    if (!t || locked.text) return sorted
    return sorted.filter((l) => (config.label_completion === 'contains' ? l.toLowerCase().includes(t) : l.toLowerCase().startsWith(t)))
  }, [sorted, text, config.label_completion, locked.text])

  // As in labelme, typing a label swaps in that label's flags, keeping the ticks of any it shares
  const typed = useRef(false)
  useEffect(() => {
    if (!typed.current) {
      typed.current = true
      return
    }
    if (!locked.flags) setFlags((f) => flagsFor(text.trim(), config.label_flags, f))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
    // Next to the pointer, as labelme opens it, but inside the window
    const el = box.current
    if (!el) return
    const w = el.offsetWidth, h = el.offsetHeight
    const x = request.at?.x ?? window.innerWidth / 2 - w / 2
    const y = request.at?.y ?? window.innerHeight / 3
    setPos({ left: Math.max(8, Math.min(window.innerWidth - w - 8, x + 12)), top: Math.max(8, Math.min(window.innerHeight - h - 8, y + 12)) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const label = text.trim()
  const invalid = !locked.text && config.validate_label === 'exact' && label && !labels.includes(label)
  const groupValue = group.trim() === '' ? null : Number(group)
  const groupBad = groupValue !== null && !Number.isInteger(groupValue)
  const canAccept = (locked.text || !!label) && !invalid && !groupBad

  const accept = (value = label) => {
    if (!locked.text && !value) return
    if (!canAccept && value === label) return
    if (config.validate_label === 'exact' && !locked.text && !labels.includes(value)) return
    onDone({ text: value, flags, group_id: groupValue, description })
  }

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(-1, a - 1)) }
    else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault()
      if (active >= 0 && shown[active]) accept(shown[active])
      else accept()
    }
  }
  useEffect(() => {
    if (active >= 0) box.current?.querySelector('.choice.on')?.scrollIntoView({ block: 'nearest' })
  }, [active])
  // Escape cancels wherever the focus is, even before the dialog has taken it
  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onDone(null)
    }
    window.addEventListener('keydown', onEscape, true)
    return () => window.removeEventListener('keydown', onEscape, true)
  }, [onDone])

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onDone(null)}>
      <div ref={box} className="dialog label-dialog" role="dialog" aria-label={request.title ?? 'Label'} onKeyDown={onKey}
        style={pos ? { position: 'fixed', ...pos } : { visibility: 'hidden' }}>
        {config.show_label_text_field && (
          <input ref={input} className="search" placeholder="Enter object label" value={locked.text ? '' : text}
            disabled={locked.text} aria-label="Label" onChange={(e) => { setText(e.target.value); setActive(-1) }} />
        )}
        <div className="row">
          <input className="group" placeholder="Group ID" value={locked.group_id ? '' : group} disabled={locked.group_id}
            aria-label="Group ID" inputMode="numeric" onChange={(e) => setGroup(e.target.value.replace(/[^\d-]/g, ''))} />
        </div>
        <div className="choices" role="listbox" aria-label="Labels">
          {shown.map((l, i) => (
            <button key={l} role="option" aria-selected={i === active || l === label}
              className={`choice ${i === active ? 'on' : ''} ${l === label ? 'current' : ''}`} disabled={locked.text}
              onClick={() => { setText(l); setActive(i); input.current?.focus() }} onDoubleClick={() => accept(l)}>
              {l}
            </button>
          ))}
          {!shown.length && <p className="muted pad">{labels.length ? 'No label starts like that: Enter adds it.' : 'Type a label, then Enter.'}</p>}
        </div>
        {!locked.flags && Object.keys(flags).length > 0 && (
          <div className="flags">
            {Object.entries(flags).map(([k, v]) => (
              <label key={k} className="check"><input type="checkbox" checked={v} onChange={(e) => setFlags({ ...flags, [k]: e.target.checked })} /> {k}</label>
            ))}
          </div>
        )}
        <textarea className="description" placeholder="Description" rows={2} value={locked.description ? '' : description}
          disabled={locked.description} aria-label="Description" onChange={(e) => setDescription(e.target.value)} />
        {invalid && <p className="bad">“{label}” isn't in the label list, and only listed labels are allowed.</p>}
        {groupBad && <p className="bad">Group ID must be a whole number.</p>}
        <div className="actions">
          <button className="ghost" onClick={() => onDone(null)}>Cancel</button>
          <button className="primary" onClick={() => accept()} disabled={!canAccept}>OK</button>
        </div>
      </div>
    </div>
  )
}
