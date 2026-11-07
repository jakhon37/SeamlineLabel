// labelme's config, key for key, so a ~/.labelmerc works here as it is, plus a few keys
// for what this app adds. See docs/config.md.

export type Shortcut = string | string[] | null

const DOCK = { show: true, closable: true, movable: true, floatable: true }

export const DEFAULT_CONFIG = {
  auto_save: true,
  // labelme asks for a label after every shape. Here the class picked in the Labels list
  // (or with 1-9) labels new shapes, and the dialog only opens when none is picked.
  display_label_popup: false,
  store_data: false,
  keep_prev: false,
  keep_prev_scale: false,
  keep_prev_brightness_contrast: false,
  logger_level: 'info',
  dark_mode: true,

  flags: null as string[] | null,
  label_flags: null as Record<string, string[]> | null,
  labels: null as string[] | null,
  file_search: null as string | null,
  sort_labels: true,
  validate_label: null as 'exact' | null,

  default_shape_color: [0, 255, 0] as number[],
  shape_color: 'auto' as 'auto' | 'manual' | null,
  shift_auto_shape_color: 0,
  label_colors: null as Record<string, number[]> | null,

  shape: {
    line_color: [0, 255, 0, 128],
    fill_color: [0, 0, 0, 64],
    vertex_fill_color: [0, 255, 0, 255],
    select_line_color: [255, 255, 255, 255],
    select_fill_color: [0, 255, 0, 64],
    hvertex_fill_color: [255, 255, 255, 255],
    point_size: 8
  },

  ai: { default: 'Sam2 (balanced)' },

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
    crosshair: {
      polygon: false,
      rectangle: true,
      circle: false,
      line: false,
      point: false,
      linestrip: false,
      ai_polygon: false,
      ai_mask: false
    },
    // Seamline zooms with the wheel; 'scroll' scrolls as labelme does and zooms with Ctrl
    wheel: 'zoom' as 'zoom' | 'scroll'
  },

  // The brush and eraser, in screen pixels
  brush: { size: 28, min: 4, max: 200 },

  // Pre-labelling with a segmentation model: smaller blobs are dropped
  prelabel: { min_area: 20 },

  shortcuts: {
    close: 'Ctrl+W' as Shortcut,
    open: 'Ctrl+O' as Shortcut,
    open_dir: 'Ctrl+U' as Shortcut,
    quit: 'Ctrl+Q' as Shortcut,
    save: 'Ctrl+S' as Shortcut,
    save_as: 'Ctrl+Shift+S' as Shortcut,
    save_to: null as Shortcut,
    delete_file: 'Ctrl+Delete' as Shortcut,

    open_next: ['D', 'Ctrl+Shift+D'] as Shortcut,
    open_prev: ['A', 'Ctrl+Shift+A'] as Shortcut,

    zoom_in: ['Ctrl++', 'Ctrl+='] as Shortcut,
    zoom_out: 'Ctrl+-' as Shortcut,
    zoom_to_original: 'Ctrl+0' as Shortcut,
    fit_window: ['Ctrl+F', '0'] as Shortcut,
    fit_width: 'Ctrl+Shift+F' as Shortcut,

    create_polygon: ['Ctrl+Shift+V', 'P'] as Shortcut,
    create_rectangle: ['Ctrl+Shift+B', 'R'] as Shortcut,
    create_circle: null as Shortcut,
    create_line: null as Shortcut,
    create_point: null as Shortcut,
    create_linestrip: null as Shortcut,
    create_ai_polygon: null as Shortcut,
    create_ai_mask: null as Shortcut,
    create_brush: 'B' as Shortcut,
    create_eraser: 'E' as Shortcut,
    edit_polygon: ['Ctrl+Shift+C', 'V'] as Shortcut,
    delete_polygon: 'Delete' as Shortcut,
    duplicate_polygon: 'Ctrl+D' as Shortcut,
    copy_polygon: 'Ctrl+C' as Shortcut,
    paste_polygon: 'Ctrl+V' as Shortcut,
    undo: 'Ctrl+Z' as Shortcut,
    redo: ['Ctrl+Shift+Z', 'Ctrl+Y'] as Shortcut,
    undo_last_point: 'Ctrl+Z' as Shortcut,
    edit_label: 'Ctrl+Shift+X' as Shortcut,
    toggle_keep_prev_mode: 'Ctrl+P' as Shortcut,
    remove_selected_point: ['Meta+H', 'Backspace'] as Shortcut,
    add_multiple_points: 'Ctrl+M' as Shortcut,
    merge_polygons: 'Ctrl+Shift+M' as Shortcut,

    show_all_polygons: null as Shortcut,
    hide_all_polygons: null as Shortcut,
    toggle_all_polygons: 'F' as Shortcut,

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

function validate(key: string, value: unknown) {
  if (key === 'validate_label' && value !== null && value !== 'exact') {
    throw new Error(`Unexpected value for config key 'validate_label': ${JSON.stringify(value)}`)
  }
  if (key === 'shape_color' && value !== null && value !== 'auto' && value !== 'manual') {
    throw new Error(`Unexpected value for config key 'shape_color': ${JSON.stringify(value)}`)
  }
  if (key === 'labels' && Array.isArray(value) && new Set(value).size !== value.length) {
    throw new Error(`Duplicates are detected for config key 'labels': ${JSON.stringify(value)}`)
  }
}

/** labelme's _update_dict. Unknown keys are reported, not fatal: a newer labelme's file still opens. */
export function mergeConfig(target: Record<string, any>, source: Record<string, unknown>, unknown: string[] = [], prefix = '') {
  for (const [key, value] of Object.entries(source)) {
    validate(key, value)
    if (!(key in target)) {
      unknown.push(prefix + key)
      continue
    }
    if (isPlain(target[key]) && isPlain(value)) mergeConfig(target[key], value, unknown, `${prefix}${key}.`)
    else target[key] = value
  }
  return unknown
}

/** labelme's _migrate_config_from_file, for config files written by older versions */
export function migrateConfig(raw: Record<string, any>) {
  const brightness = raw.keep_prev_brightness
  const contrast = raw.keep_prev_contrast
  delete raw.keep_prev_brightness
  delete raw.keep_prev_contrast
  if (brightness || contrast) raw.keep_prev_brightness_contrast = true
  if (isPlain(raw.shortcuts)) delete raw.shortcuts.add_point_to_edge
  const model = raw.ai?.default
  const old = typeof model === 'string' && /^SegmentAnything \((.*)\)$/.exec(model)
  if (old) raw.ai.default = `Sam (${old[1]})`
}

export function checkConfig(config: Config) {
  if (!config.labels?.length && config.validate_label) {
    throw new Error('labels must be specified when validate_label is enabled')
  }
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
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase()
  if (key !== keys.key) return false
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
