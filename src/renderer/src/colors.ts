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
  return hex(LABEL_COLORMAP[(1 + index + config.shift_auto_shape_color) % LABEL_COLORMAP.length])
}

/** labelme's _get_rgb_by_label, with a Seamline project's own colour before the automatic one */
export function labelColor(label: string, index: number, config: Config, projectColor?: string) {
  if (config.shape_color === 'manual' && config.label_colors?.[label]) return hex(config.label_colors[label])
  if (projectColor) return projectColor
  if (config.shape_color === 'auto') return autoColor(index, config)
  return hex(config.default_shape_color ?? [0, 255, 0])
}

export function withAlpha(color: string, alpha: number) {
  const v = parseInt(color.slice(1), 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`
}
