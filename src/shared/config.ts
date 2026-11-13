// labelme 7's config, key for key, so a ~/.labelmerc works here as it is, plus a few keys
// for what this app adds. Files written for labelme 5 are migrated as labelme 7 migrates
// them. See docs/config.md.
import { LABEL_FORMATS, type LabelFormat } from './formats'

export type Shortcut = string | string[] | null

const DOCK = { show: true, closable: true, movable: true, floatable: true }

export type ShapeColorMode = 'auto' | 'uniform' | 'by_label'
export type AiOutput = 'polygon' | 'mask' | 'rectangle' | 'circle' | 'oriented_rectangle'
export const AI_OUTPUTS: AiOutput[] = ['polygon', 'mask', 'rectangle', 'circle', 'oriented_rectangle']
export const AI_TEXT_MODELS = ['sam3:latest', 'yoloworld:latest']

export const DEFAULT_CONFIG = {
  auto_save: true,
  // labelme asks for a label after every shape. Here the class picked in the Labels list
  // (or with 1-9) labels new shapes, and the dialog only opens when none is picked.
  display_label_popup: false,
  with_image_data: false,
  keep_prev: false,
  keep_prev_scale: false,
  keep_prev_brightness_contrast: false,
  // labelme 7's language and theme: read, but this window is English and has its own theme
  language: null as string | null,
  color_theme: 'system' as 'system' | 'light' | 'dark',
  dark_mode: true,

  flags: null as string[] | null,
  label_flags: null as Record<string, string[]> | null,
  labels: null as string[] | null,
  file_search: null as string | null,
  sort_labels: true,
  validate_label: null as 'exact' | null,

  shape_color: {
    mode: 'auto' as ShapeColorMode,
    auto: { shift: 0 },
    uniform: { color: [0, 255, 0] as number[] },
    by_label: { colors: null as Record<string, number[]> | null, fallback: [0, 255, 0] as number[] }
  },

  shape: {
    line_color: [0, 255, 0, 128],
    fill_color: [0, 0, 0, 64],
    vertex_fill_color: [0, 255, 0, 255],
    select_line_color: [255, 255, 255, 255],
    select_fill_color: [0, 255, 0, 64],
    hvertex_fill_color: [255, 255, 255, 255],
    point_size: 8,
    show_labels: false
  },

  // How closely AI polygons follow a mask, from 0 to 100
  mask_polygonization: { detail: 60 },

  ai: {
    default: 'Sam2 (balanced)',
    text_model: 'yoloworld:latest',
    // Drop AI shapes that cover a shape already drawn, and point out that shape instead
    suppress_existing_shape_matches: false
  },

  flag_dock: { ...DOCK },
  label_dock: { ...DOCK },
  shape_dock: { ...DOCK },
  file_dock: { ...DOCK },

  show_label_text_field: true,
  label_completion: 'startswith' as 'startswith' | 'contains',
  fit_to_content: { column: true, row: false },

  epsilon: 10.0,
  default_num_points_to_add: 5,
  zoom_increment: 1.45,
  max_zoom: 5000,

  performance: {
    auto_downsample_large_images: false,
    downsample_threshold: 8000,
    downsample_factor: 2,
    enable_viewport_culling: true,
    max_image_cache_size: 3
  },

  canvas: {
    fill_drawing: false,
    double_click: 'close' as 'close' | null,
    num_backups: 200,
    allow_out_of_bounds_points: false,
    crosshair: {
      polygon: false,
      rectangle: true,
      oriented_rectangle: false,
      circle: false,
      line: false,
      point: false,
      linestrip: false,
      ai_points_to_shape: false,
      ai_box_to_shape: true
    },
    // Seamline zooms with the wheel; 'scroll' scrolls as labelme does and zooms with Ctrl
    wheel: 'zoom' as 'zoom' | 'scroll'
  },

  // The brush and eraser, in screen pixels
  brush: { size: 28, min: 4, max: 200 },

  // Pre-labelling with a segmentation model: smaller blobs are dropped, as in Seamline
  prelabel: { min_area: 25 },

  // Where new labels are saved: LabelMe JSON, or LabelImg's Pascal VOC, YOLO or CreateML.
  // An image that has a label file keeps that file's format, as in LabelImg.
  label_format: 'labelme' as LabelFormat,

  shortcuts: {
    close: 'Ctrl+W' as Shortcut,
    open: 'Ctrl+O' as Shortcut,
    open_dir: 'Ctrl+U' as Shortcut,
    quit: 'Ctrl+Q' as Shortcut,
    save: 'Ctrl+S' as Shortcut,
    save_as: 'Ctrl+Shift+S' as Shortcut,
    save_to: 'Ctrl+R' as Shortcut,
    delete_file: 'Ctrl+Delete' as Shortcut,

    open_next: ['D', 'Ctrl+Shift+D'] as Shortcut,
    open_prev: ['A', 'Ctrl+Shift+A'] as Shortcut,

    zoom_in: ['Ctrl++', 'Ctrl+='] as Shortcut,
    zoom_out: 'Ctrl+-' as Shortcut,
    zoom_to_original: 'Ctrl+0' as Shortcut,
    fit_window: ['Ctrl+F', '0'] as Shortcut,
    fit_selection: 'Ctrl+Shift+F' as Shortcut,

    create_polygon: ['Ctrl+Shift+V', 'P'] as Shortcut,
    create_rectangle: ['Ctrl+Shift+B', 'R'] as Shortcut,
    create_oriented_rectangle: null as Shortcut,
    create_circle: null as Shortcut,
    create_line: null as Shortcut,
    create_point: null as Shortcut,
    create_linestrip: null as Shortcut,
    create_ai_points_to_shape: null as Shortcut,
    create_ai_box_to_shape: null as Shortcut,
    create_brush: 'B' as Shortcut,
    create_eraser: 'E' as Shortcut,
    edit_shape: ['Ctrl+Shift+C', 'V', 'Ctrl+J'] as Shortcut,
    delete_shape: 'Delete' as Shortcut,
    duplicate_shape: 'Ctrl+D' as Shortcut,
    copy_shape: 'Ctrl+C' as Shortcut,
    paste_shape: 'Ctrl+V' as Shortcut,
    undo: 'Ctrl+Z' as Shortcut,
    redo: ['Ctrl+Shift+Z', 'Ctrl+Y'] as Shortcut,
    undo_last_point: 'Ctrl+Z' as Shortcut,
    edit_label: ['Ctrl+Shift+X', 'Ctrl+E'] as Shortcut,
    lock_shape: 'Ctrl+Shift+L' as Shortcut,
    toggle_keep_prev_mode: null as Shortcut,
    remove_selected_point: ['Meta+H', 'Backspace'] as Shortcut,
    add_multiple_points: 'Ctrl+M' as Shortcut,
    merge_shapes: 'Ctrl+Shift+M' as Shortcut,

    show_all_shapes: 'Ctrl+A' as Shortcut,
    hide_all_shapes: 'Ctrl+H' as Shortcut,
    toggle_all_shapes: 'F' as Shortcut,
    select_shape_up: 'Ctrl+Up' as Shortcut,
    select_shape_down: 'Ctrl+Down' as Shortcut,
    select_shape_left: 'Ctrl+Left' as Shortcut,
    select_shape_right: 'Ctrl+Right' as Shortcut,

    // LabelImg's
    open_annotation: 'Ctrl+Shift+O' as Shortcut,
    copy_previous_shapes: null as Shortcut,
    change_format: null as Shortcut,
    // A tap of Space: Space held down and dragged pans
    verify_image: 'Space' as Shortcut,
    delete_image: 'Ctrl+Shift+Delete' as Shortcut,
    draw_squares: 'Ctrl+Shift+R' as Shortcut,
    display_labels: 'Ctrl+Shift+P' as Shortcut,
    single_class_mode: null as Shortcut,
    toggle_difficult: null as Shortcut,
    // Ctrl+Shift+L and Ctrl+Shift+F are labelme 7's: Lock Shapes and Fit to Selection
    toggle_label_panel: null as Shortcut,
    fit_width: null as Shortcut,
    advanced_mode: null as Shortcut,
    box_line_color: 'Ctrl+L' as Shortcut,
    shape_line_color: null as Shortcut,
    shape_fill_color: null as Shortcut,

    review_accept: 'W' as Shortcut,
    review_accept_all: 'Shift+W' as Shortcut,
    review_reject: 'S' as Shortcut,
    review_skip: 'Tab' as Shortcut,
    brush_smaller: '[' as Shortcut,
    brush_larger: ']' as Shortcut
  }
}

export type Config = typeof DEFAULT_CONFIG
export type ShortcutName = keyof Config['shortcuts']

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
export const defaultConfig = (): Config => clone(DEFAULT_CONFIG)

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isRgb = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)

function checkRgb(path: string, value: unknown) {
  if (!isRgb(value)) throw new Error(`${path} must be a list of three integers from 0 to 255`)
}

/** labelme's validate_shape_color */
export function validateShapeColor(value: unknown) {
  if (!isPlain(value)) throw new Error('shape_color must be a mapping')
  if ('mode' in value && !['auto', 'uniform', 'by_label'].includes(value.mode as string)) {
    throw new Error("shape_color.mode must be one of 'auto', 'uniform', or 'by_label'")
  }
  const section = (name: string) => {
    const v = value[name] ?? {}
    if (!isPlain(v)) throw new Error(`shape_color.${name} must be a mapping`)
    return v
  }
  if ('auto' in value && 'shift' in section('auto') && !Number.isInteger(section('auto').shift)) {
    throw new Error('shape_color.auto.shift must be an integer')
  }
  if ('uniform' in value && 'color' in section('uniform')) checkRgb('shape_color.uniform.color', section('uniform').color)
  if (!('by_label' in value)) return
  const byLabel = section('by_label')
  if ('fallback' in byLabel) checkRgb('shape_color.by_label.fallback', byLabel.fallback)
  if (byLabel.colors === null || byLabel.colors === undefined) return
  if (!isPlain(byLabel.colors)) throw new Error('shape_color.by_label.colors must be a mapping')
  for (const [label, color] of Object.entries(byLabel.colors)) {
    if (!label) throw new Error('shape_color.by_label.colors keys must be non-empty strings')
    checkRgb(`shape_color.by_label.colors.${label}`, color)
  }
}

function validate(path: string[], value: unknown) {
  const key = path[path.length - 1]
  const at = path.join('.')
  if (at === 'label_flags' && value !== null) {
    if (!isPlain(value) || Object.values(value).some((names) => !Array.isArray(names) || names.some((n) => typeof n !== 'string'))) {
      throw new Error('label_flags must map string patterns to lists of strings')
    }
  }
  if (at === 'mask_polygonization.detail' && !(Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100)) {
    throw new Error(`mask_polygonization.detail must be an integer between 0 and 100, but got ${JSON.stringify(value)}`)
  }
  if (at === 'ai.text_model' && value !== null && !AI_TEXT_MODELS.includes(value as string)) {
    throw new Error(`Unexpected AI Text Prompt model: ${JSON.stringify(value)}`)
  }
  if (key === 'validate_label' && value !== null && value !== 'exact') {
    throw new Error(`Unexpected value for config key 'validate_label': ${JSON.stringify(value)}`)
  }
  if (at === 'label_format' && !LABEL_FORMATS.includes(value as LabelFormat)) {
    throw new Error(`Unexpected value for config key 'label_format': ${JSON.stringify(value)} (labelme, voc, yolo or createml)`)
  }
  if (key === 'labels' && value !== null) {
    if (!Array.isArray(value)) throw new Error(`Config key 'labels' must be a list, but got ${JSON.stringify(value)}`)
    if (new Set(value).size !== value.length) throw new Error(`Duplicates are detected for config key 'labels': ${JSON.stringify(value)}`)
  }
}

/** labelme's _update_dict. Unknown keys are reported, not fatal: a newer labelme's file still opens. */
export function mergeConfig(target: Record<string, any>, source: Record<string, unknown>, unknown: string[] = [], path: string[] = []) {
  for (const [key, value] of Object.entries(source)) {
    const at = [...path, key]
    validate(at, value)
    if (!(key in target)) {
      unknown.push(at.join('.'))
      continue
    }
    if (!isPlain(target[key])) {
      target[key] = value
      continue
    }
    // An empty section (a bare `shortcuts:`) keeps its defaults; anything else but a mapping is a mistake
    if (value === null || value === undefined) continue
    if (!isPlain(value)) throw new Error(`Config section '${key}' must be a mapping, but got ${JSON.stringify(value)}`)
    mergeConfig(target[key], value, unknown, at)
  }
  return unknown
}

/** labelme's migrate_shape_color: labelme 5's colour keys into labelme 7's shape_color */
export function migrateShapeColor(raw: Record<string, any>) {
  const legacy = ['default_shape_color', 'shift_auto_shape_color', 'label_colors'].some((k) => k in raw)
  if (isPlain(raw.shape_color)) {
    if (legacy) throw new Error('New shape_color config cannot be combined with legacy color keys')
    return
  }
  const hasMode = 'shape_color' in raw
  if (!hasMode && !legacy) return
  const mode = raw.shape_color ?? null
  if (mode !== null && mode !== 'auto' && mode !== 'manual') {
    throw new Error(`Unexpected value for config key 'shape_color': ${JSON.stringify(mode)}`)
  }
  const shapeColor: Record<string, any> = {}
  if (hasMode) shapeColor.mode = mode === 'auto' ? 'auto' : mode === 'manual' ? 'by_label' : 'uniform'
  if ('shift_auto_shape_color' in raw) shapeColor.auto = { shift: raw.shift_auto_shape_color }
  if ('default_shape_color' in raw) {
    const color = raw.default_shape_color ?? [0, 255, 0]
    shapeColor.uniform = { color }
    shapeColor.by_label = { fallback: color }
  }
  if ('label_colors' in raw) shapeColor.by_label = { ...shapeColor.by_label, colors: raw.label_colors }
  for (const k of ['shape_color', 'default_shape_color', 'shift_auto_shape_color', 'label_colors']) delete raw[k]
  raw.shape_color = shapeColor
}

const RENAMED_SHORTCUTS: Record<string, string> = {
  // labelme 7 calls polygons shapes
  edit_polygon: 'edit_shape',
  delete_polygon: 'delete_shape',
  duplicate_polygon: 'duplicate_shape',
  copy_polygon: 'copy_shape',
  paste_polygon: 'paste_shape',
  show_all_polygons: 'show_all_shapes',
  hide_all_polygons: 'hide_all_shapes',
  toggle_all_polygons: 'toggle_all_shapes',
  // Seamtag's own, from before labelme 7's AI tools
  create_ai_polygon: 'create_ai_points_to_shape',
  create_ai_mask: 'create_ai_points_to_shape',
  merge_polygons: 'merge_shapes'
}

/** labelme's migrate_config, for config files written by older versions */
export function migrateConfig(raw: Record<string, any>) {
  migrateShapeColor(raw)
  delete raw.instance_label_auto_increment
  const brightness = raw.keep_prev_brightness
  const contrast = raw.keep_prev_contrast
  delete raw.keep_prev_brightness
  delete raw.keep_prev_contrast
  if ((brightness || contrast) && !('keep_prev_brightness_contrast' in raw)) raw.keep_prev_brightness_contrast = true
  if ('store_data' in raw) {
    if (!('with_image_data' in raw)) raw.with_image_data = raw.store_data
    delete raw.store_data
  }
  // The log level comes from the command line only
  delete raw.logger_level
  const shortcuts = isPlain(raw.shortcuts) ? raw.shortcuts : {}
  for (const key of ['add_point', 'add_point_to_edge', 'edit_line_color', 'edit_fill_color']) delete shortcuts[key]
  // labelme 7 dropped Fit Width and gave its key to Fit to Selection. LabelImg has Fit Width,
  // so it stays here: only labelme 5's default for it goes, unless Fit to Selection moved.
  if (shortcuts.fit_width === 'Ctrl+Shift+F' && !('fit_selection' in shortcuts)) delete shortcuts.fit_width
  for (const [from, to] of Object.entries(RENAMED_SHORTCUTS)) {
    if (!(from in shortcuts)) continue
    if (!(to in shortcuts)) shortcuts[to] = shortcuts[from]
    delete shortcuts[from]
  }
  const model = raw.ai?.default
  const old = typeof model === 'string' && /^SegmentAnything \((.*)\)$/.exec(model)
  if (old) raw.ai.default = `Sam (${old[1]})`
  const crosshair = isPlain(raw.canvas) && isPlain(raw.canvas.crosshair) ? raw.canvas.crosshair : {}
  const aiPolygon = crosshair.ai_polygon
  const aiMask = crosshair.ai_mask
  delete crosshair.ai_polygon
  delete crosshair.ai_mask
  if ((aiPolygon !== undefined || aiMask !== undefined) && !('ai_points_to_shape' in crosshair)) {
    crosshair.ai_points_to_shape = !!aiPolygon || !!aiMask
  }
}

export function checkConfig(config: Config) {
  if (!config.labels?.length && config.validate_label) {
    throw new Error('labels must be specified when validate_label is enabled')
  }
  validateShapeColor(config.shape_color)
}

// Shortcuts are written as Qt writes them ("Ctrl+Shift+V", "Ctrl++"). As in Qt, Ctrl means
// Command on a Mac, and Meta means Control there.
export type Keys = { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean; key: string }

const KEY_NAMES: Record<string, string> = {
  del: 'delete', esc: 'escape', return: 'enter', ins: 'insert', pgup: 'pageup', pgdown: 'pagedown',
  space: ' ', plus: '+', minus: '-', left: 'arrowleft', right: 'arrowright', up: 'arrowup', down: 'arrowdown'
}

export function parseKeys(text: string): Keys | null {
  const s = text.trim()
  if (!s) return null
  // The last part is the key: "Ctrl++" ends in "+"
  const parts = s.endsWith('++') ? [...s.slice(0, -2).split('+'), '+'] : s.split('+')
  const keys: Keys = { ctrl: false, shift: false, alt: false, meta: false, key: '' }
  parts.forEach((raw, i) => {
    const p = raw.trim().toLowerCase()
    if (i < parts.length - 1) {
      if (p === 'ctrl' || p === 'control') keys.ctrl = true
      else if (p === 'shift') keys.shift = true
      else if (p === 'alt') keys.alt = true
      else if (p === 'meta' || p === 'cmd') keys.meta = true
    } else {
      keys.key = KEY_NAMES[p] ?? p
    }
  })
  return keys.key ? keys : null
}

export function shortcutList(value: Shortcut): Keys[] {
  const list = value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]
  return list.map(parseKeys).filter((k): k is Keys => k !== null)
}

type KeyEventLike = { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }

export function matches(keys: Keys, e: KeyEventLike, mac: boolean): boolean {
  const ctrl = mac ? e.metaKey : e.ctrlKey
  const meta = mac ? e.ctrlKey : e.metaKey
  if (keys.ctrl !== ctrl || keys.alt !== e.altKey || keys.meta !== meta) return false
  if (e.key.toLowerCase() !== keys.key) return false
  // Symbols already carry Shift in the key itself ("+" is Shift+=), letters and named keys don't
  const symbol = keys.key.length === 1 && !/[a-z0-9]/.test(keys.key)
  return symbol || keys.shift === e.shiftKey
}

export function formatKeys(value: Shortcut, mac: boolean): string {
  const first = shortcutList(value)[0]
  if (!first) return ''
  const name = first.key === ' ' ? 'Space' : first.key.length === 1 ? first.key.toUpperCase() : first.key[0].toUpperCase() + first.key.slice(1)
  if (mac) return `${first.meta ? '⌃' : ''}${first.alt ? '⌥' : ''}${first.shift ? '⇧' : ''}${first.ctrl ? '⌘' : ''}${name}`
  return [first.ctrl && 'Ctrl', first.meta && 'Meta', first.alt && 'Alt', first.shift && 'Shift', name].filter(Boolean).join('+')
}
