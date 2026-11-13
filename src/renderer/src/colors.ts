import type { Config } from '../../shared/config'
import type { LabelClass } from './types'

// labelme's colours: imgviz.label_colormap(), the PASCAL VOC map, picked by a label's place
// in the label list. Seamline projects can set their own in .myseg/project.json.
export const LABEL_COLORMAP: number[][] = Array.from({ length: 256 }, (_, i) => {
  let r = 0, g = 0, b = 0, c = i
  for (let j = 7; j >= 0; j--) {
    r |= (c & 1) << j
    g |= ((c >> 1) & 1) << j
    b |= ((c >> 2) & 1) << j
    c >>= 3
  }
  return [r, g, b]
})

const hex = (rgb: number[]) => '#' + rgb.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')

export function autoColor(index: number, config: Config) {
  // Index 0 is black: labelme skips it
  return hex(LABEL_COLORMAP[(1 + index + config.shape_color.auto.shift) % LABEL_COLORMAP.length])
}

/** labelme's resolve_shape_color, with a Seamline project's own colour before the automatic one */
export function labelColor(label: string, index: number, config: Config, projectColor?: string) {
  const { mode, uniform, by_label } = config.shape_color
  if (mode === 'by_label' && by_label.colors?.[label]) return hex(by_label.colors[label])
  if (projectColor) return projectColor
  if (mode === 'auto') return autoColor(index, config)
  return hex(mode === 'uniform' ? uniform.color : by_label.fallback)
}

/**
 * The label list, each label with its colour: config labels, then a Seamline project's classes, then
 * labels found in the files or on screen. `kept` is the list as it was when a label was last added
 * or recoloured here: those labels stay where they were, where a growing class list would move the
 * others along, and their colours with them.
 */
export function labelList(config: Config, classes: LabelClass[], found: string[], kept: string[] | null = null) {
  const names: string[] = []
  const add = (n: string) => n && !names.includes(n) && names.push(n)
  ;(config.labels ?? []).forEach(add)
  classes.forEach((c) => add(c.name))
  found.forEach(add)
  const order = kept ? [...kept.filter((n) => names.includes(n)), ...names.filter((n) => !kept.includes(n))] : names
  return order.map((name, i) => ({ name, color: labelColor(name, i, config, classes.find((c) => c.name === name)?.color) }))
}

// The class list is Seamline's list of what to train, one model output each: a change made here
// carries that one label, never the list's others from the config or the files
/** A label added: the classes, then it */
export const withClass = (classes: LabelClass[], name: string, color: string): LabelClass[] => [...classes, { name, color }]
/** A label's colour changed: a class takes it, any other label joins the classes with it */
export const recolored = (classes: LabelClass[], name: string, color: string): LabelClass[] =>
  classes.some((c) => c.name === name) ? classes.map((c) => (c.name === name ? { ...c, color } : c)) : withClass(classes, name, color)

export function withAlpha(color: string, alpha: number) {
  const v = parseInt(color.slice(1), 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`
}
