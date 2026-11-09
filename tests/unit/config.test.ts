import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { describe, expect, test } from 'vitest'
import { defaultConfig, formatKeys, matches, mergeConfig, migrateConfig, parseKeys } from '../../src/shared/config'
import { loadConfig, parseArgs } from '../../src/main/config'
import { autoColor, LABEL_COLORMAP, labelColor } from '../../src/renderer/src/colors'

const key = (k: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}) =>
  ({ key: k, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta })

describe('shortcuts, written as Qt writes them', () => {
  test('modifiers and keys', () => {
    expect(parseKeys('Ctrl+Shift+V')).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: 'v' })
    expect(parseKeys('Ctrl++')).toEqual({ ctrl: true, shift: false, alt: false, meta: false, key: '+' })
    expect(parseKeys('Delete')?.key).toBe('delete')
    expect(parseKeys('')).toBeNull()
  })

  test('letters need their exact modifiers; symbols carry Shift themselves', () => {
    expect(matches(parseKeys('W')!, key('w'), false)).toBe(true)
    expect(matches(parseKeys('W')!, key('W', { shift: true }), false)).toBe(false)
    expect(matches(parseKeys('Shift+W')!, key('W', { shift: true }), false)).toBe(true)
    expect(matches(parseKeys('Ctrl++')!, key('+', { ctrl: true, shift: true }), false)).toBe(true)
    expect(matches(parseKeys('Ctrl+=')!, key('=', { ctrl: true }), false)).toBe(true)
    expect(matches(parseKeys('D')!, key('d', { ctrl: true }), false)).toBe(false)
  })

  test('on a Mac, Ctrl means Command and Meta means Control, as in Qt', () => {
    expect(matches(parseKeys('Ctrl+S')!, key('s', { meta: true }), true)).toBe(true)
    expect(matches(parseKeys('Ctrl+S')!, key('s', { ctrl: true }), true)).toBe(false)
    expect(matches(parseKeys('Meta+H')!, key('h', { ctrl: true }), true)).toBe(true)
    expect(formatKeys('Ctrl+Shift+S', true)).toBe('⇧⌘S')
    expect(formatKeys(['Ctrl+Shift+S', 'X'], false)).toBe('Ctrl+Shift+S')
  })

  const noCollisions = (shortcuts: Record<string, unknown>) => {
    const seen = new Map<string, string>()
    for (const [name, value] of Object.entries(shortcuts)) {
      for (const k of [value].flat().filter(Boolean) as string[]) {
        const id = JSON.stringify(parseKeys(k))
        // Undo and undo-last-point share Ctrl+Z on purpose: one while drawing, one otherwise
        if (seen.has(id) && !['undo', 'undo_last_point'].includes(name)) throw new Error(`${k}: ${seen.get(id)} and ${name}`)
        seen.set(id, name)
      }
    }
  }

  test('no two default shortcuts collide', () => {
    noCollisions(defaultConfig().shortcuts)
  })

  test("docs/config.md's lines for LabelImg's keys load, and no two keys collide", () => {
    const docs = readFileSync(path.join(__dirname, '../../docs/config.md'), 'utf8')
    const block = /```yaml\n(# LabelImg's keys\n[\s\S]*?)```/.exec(docs)![1]
    const { config } = loadConfig(parseArgs(['--config', block]))
    expect(config.shortcuts.create_rectangle).toEqual(['W', 'R'])
    expect(config.shortcuts.copy_previous_shapes).toBe('Ctrl+V')
    noCollisions(config.shortcuts)
  })
})

describe('config', () => {
  test("labelme's own config keys all exist here", () => {
    // From labelme/config/default_config.yaml in LabelMeV2
    const labelme = ['auto_save', 'display_label_popup', 'store_data', 'keep_prev', 'keep_prev_scale', 'keep_prev_brightness_contrast',
      'logger_level', 'flags', 'label_flags', 'labels', 'file_search', 'sort_labels', 'validate_label', 'default_shape_color',
      'shape_color', 'shift_auto_shape_color', 'label_colors', 'shape', 'ai', 'flag_dock', 'label_dock', 'shape_dock', 'file_dock',
      'show_label_text_field', 'label_completion', 'fit_to_content', 'epsilon', 'canvas', 'shortcuts', 'dark_mode',
      'default_num_points_to_add', 'zoom_increment', 'max_zoom', 'performance']
    const config = defaultConfig()
    for (const k of labelme) expect(config, k).toHaveProperty(k)
    const shortcuts = ['close', 'open', 'open_dir', 'quit', 'save', 'save_as', 'save_to', 'delete_file', 'open_next', 'open_prev',
      'zoom_in', 'zoom_out', 'zoom_to_original', 'fit_window', 'fit_width', 'create_polygon', 'create_rectangle', 'create_circle',
      'create_line', 'create_point', 'create_linestrip', 'edit_polygon', 'delete_polygon', 'duplicate_polygon', 'copy_polygon',
      'paste_polygon', 'undo', 'undo_last_point', 'edit_label', 'toggle_keep_prev_mode', 'remove_selected_point',
      'add_multiple_points', 'merge_polygons', 'show_all_polygons', 'hide_all_polygons', 'toggle_all_polygons']
    for (const k of shortcuts) expect(config.shortcuts, k).toHaveProperty(k)
  })

  test("merging validates as labelme does, and reports keys it doesn't know", () => {
    const config = defaultConfig()
    const unknown = mergeConfig(config, { auto_save: false, canvas: { num_backups: 5 }, new_key: 1 })
    expect(config.auto_save).toBe(false)
    expect(config.canvas.num_backups).toBe(5)
    expect(config.canvas.double_click).toBe('close')
    expect(unknown).toEqual(['new_key'])
    expect(() => mergeConfig(defaultConfig(), { validate_label: 'fuzzy' })).toThrow(/validate_label/)
    expect(() => mergeConfig(defaultConfig(), { labels: ['a', 'a'] })).toThrow(/Duplicates/)
  })

  test("old labelme config files are migrated as labelme migrates them", () => {
    const raw: any = { keep_prev_brightness: true, shortcuts: { add_point_to_edge: 'Ctrl+Shift+P' }, ai: { default: 'SegmentAnything (speed)' } }
    migrateConfig(raw)
    expect(raw).toEqual({ keep_prev_brightness_contrast: true, shortcuts: {}, ai: { default: 'Sam (speed)' } })
  })

  test("labelme's command line", () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sl-args-'))
    const labels = path.join(dir, 'labels.txt')
    writeFileSync(labels, 'cat\n\ndog \n')
    const args = parseArgs(['--no-sandbox', 'images', '--labels', labels, '--flags', 'night,blurry', '--nodata', '--autosave',
      '--labelflags', '{.*: [occluded]}', '--validatelabel', 'exact', '--epsilon=4', '-O', 'out', '--keep-prev', '--nosortlabels'])
    expect(args.filename).toBe('images')
    expect(args.output).toBe('out')
    expect(args.overrides).toEqual({
      labels: ['cat', 'dog'], flags: ['night', 'blurry'], store_data: false, auto_save: true,
      label_flags: { '.*': ['occluded'] }, validate_label: 'exact', epsilon: 4, keep_prev: true, sort_labels: false
    })
    expect(() => parseArgs(['--validatelabel', 'fuzzy'])).toThrow()
  })

  test("LabelImg's command line: an image folder, a file of classes, then where labels go", () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sl-labelimg-'))
    const classes = path.join(dir, 'predefined_classes.txt')
    writeFileSync(classes, 'dog\nperson\ncat\n')
    const args = parseArgs(['images', classes, 'annotations'])
    expect([args.filename, args.output, args.overrides.labels]).toEqual(['images', 'annotations', ['dog', 'person', 'cat']])
    // -O wins over the third
    expect(parseArgs(['images', classes, 'annotations', '-O', 'out']).output).toBe('out')
    expect(() => parseArgs(['images', path.join(dir, 'missing.txt')])).toThrow(/doesn't exist/)
  })

  test("label_format takes LabelImg's formats and labelme's", () => {
    expect(loadConfig(parseArgs(['--config', '{label_format: yolo}'])).config.label_format).toBe('yolo')
    expect(() => loadConfig(parseArgs(['--config', '{label_format: coco}']))).toThrow(/label_format/)
  })

  test('--config takes YAML overrides or a file, such as a ~/.labelmerc', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sl-config-'))
    const file = path.join(dir, '.labelmerc')
    writeFileSync(file, 'labels: [a, b]\nauto_save: false\nshortcuts:\n  save: Ctrl+Alt+S\n')
    const fromFile = loadConfig(parseArgs(['--config', file]))
    expect(fromFile.config.labels).toEqual(['a', 'b'])
    expect(fromFile.config.auto_save).toBe(false)
    expect(fromFile.config.shortcuts.save).toBe('Ctrl+Alt+S')
    const inline = loadConfig(parseArgs(['--config', '{store_data: true}']))
    expect(inline.config.store_data).toBe(true)
    expect(inline.file).toBeNull()
    expect(() => loadConfig(parseArgs(['--config', path.join(dir, 'missing')]))).toThrow(/does not exist/)
    expect(() => loadConfig(parseArgs(['--config', '{validate_label: exact}']))).toThrow(/labels must be specified/)
  })
})

describe('colours', () => {
  test("labelme's label colormap, and its first automatic colours", () => {
    expect(LABEL_COLORMAP.slice(0, 4)).toEqual([[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0]])
    const config = defaultConfig()
    expect(autoColor(0, config)).toBe('#800000')
    expect(autoColor(0, { ...config, shift_auto_shape_color: 2 })).toBe('#808000')
  })

  test('manual colours first, then a Seamline project colour, then automatic', () => {
    const config = { ...defaultConfig(), shape_color: 'manual' as const, label_colors: { cat: [1, 2, 3] } }
    expect(labelColor('cat', 0, config, '#ffffff')).toBe('#010203')
    expect(labelColor('dog', 0, defaultConfig(), '#4f8cff')).toBe('#4f8cff')
    expect(labelColor('dog', 1, { ...defaultConfig(), shape_color: null }, undefined)).toBe('#00ff00')
  })
})
