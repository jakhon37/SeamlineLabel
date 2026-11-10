import type { Config } from '../../shared/config'

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

export function withAlpha(color: string, alpha: number) {
  const v = parseInt(color.slice(1), 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`
}
