import { Check, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { type Config, formatKeys } from '../../shared/config'
import type { Command, Commands } from './Labeler'

// labelme's menus, in its order, plus the AI menu. An item is a command id, '-' for a
// separator, or a submenu.
export type Item = string | '-' | { label: string; items: Item[] }
export type MenuSpec = { label: string; items: Item[] }[]

type Props = {
  menus: MenuSpec
  commands: () => Commands
  config: Config
  mac: boolean
}

export function MenuList({ items, commands, config, mac, onDone }: { items: Item[]; commands: Commands; config: Config; mac: boolean; onDone: () => void }) {
  const [sub, setSub] = useState<number | null>(null)
  const visible = items.filter((it) => typeof it !== 'string' || it === '-' || commands[it])
  return (
    <div className="menu" role="menu">
      {visible.map((it, i) => {
        if (it === '-') return i > 0 && i < visible.length - 1 && visible[i - 1] !== '-' ? <div key={i} className="sep" role="separator" /> : null
        if (typeof it !== 'string') {
          const enabled = it.items.some((x) => typeof x === 'string' && x !== '-' && commands[x])
          return (
            <div key={i} className={`item sub ${sub === i ? 'open' : ''}`} role="menuitem" aria-haspopup aria-disabled={!enabled}
              onMouseEnter={() => setSub(i)} onMouseLeave={() => setSub(null)}>
              <span className="mark" /><span className="label">{it.label}</span><ChevronRight size={14} />
              {sub === i && enabled && <MenuList items={it.items} commands={commands} config={config} mac={mac} onDone={onDone} />}
            </div>
          )
        }
        const cmd: Command = commands[it]
        const enabled = cmd.enabled ? cmd.enabled() : true
        const checked = cmd.checked?.()
        const keys = cmd.keys ?? (cmd.shortcut ? formatKeys(config.shortcuts[cmd.shortcut], mac) : '')
        return (
          <button key={i} className="item" role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={checked}
            disabled={!enabled} onClick={() => { onDone(); cmd.run() }}>
            <span className="mark">{checked && <Check size={14} />}</span>
            <span className="label">{cmd.label}</span>
            {keys && <span className="keys">{keys}</span>}
          </button>
        )
      })}
    </div>
  )
}

export default function MenuBar({ menus, commands, config, mac }: Props) {
  const [open, setOpen] = useState<number | null>(null)
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open === null) return
    const close = (e: MouseEvent) => { if (!bar.current?.contains(e.target as Node)) setOpen(null) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null) }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key) }
  }, [open])
  return (
    <div className="menubar" ref={bar} role="menubar">
      {menus.map((m, i) => (
        <div key={m.label} className="top">
          <button className={open === i ? 'on' : ''} role="menuitem" aria-haspopup aria-expanded={open === i}
            onMouseDown={(e) => { e.preventDefault(); setOpen(open === i ? null : i) }}
            onMouseEnter={() => open !== null && setOpen(i)}>{m.label}</button>
          {open === i && <MenuList items={m.items} commands={commands()} config={config} mac={mac} onDone={() => setOpen(null)} />}
        </div>
      ))}
    </div>
  )
}

export function ContextMenu({ at, items, commands, config, mac, onDone }: { at: { x: number; y: number }; items: Item[]; commands: Commands; config: Config; mac: boolean; onDone: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)
  useEffect(() => {
    const el = box.current
    if (el) setPos({ x: Math.min(at.x, window.innerWidth - el.offsetWidth - 8), y: Math.min(at.y, window.innerHeight - el.offsetHeight - 8) })
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onDone() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onDone() }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key) }
  }, [at, onDone])
  return (
    <div ref={box} className="context" style={{ left: pos.x, top: pos.y }}>
      <MenuList items={items} commands={commands} config={config} mac={mac} onDone={onDone} />
    </div>
  )
}
