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
  const fixture = (name: string) => path.join(__dirname, '../fixtures', name, 'default_config.yaml')

  test("labelme 7.9.1's whole default config loads, every key known", () => {
    const { config, warnings } = loadConfig(parseArgs(['--config', fixture('labelme7')]))
    expect(warnings).toEqual([])
    // labelme's own defaults where Seamtag's differ
    expect(config.display_label_popup).toBe(true)
    expect(config.canvas.fill_drawing).toBe(true)
    expect(config.shortcuts.create_polygon).toBe('Ctrl+N')
    expect(config.shortcuts.lock_shape).toBe('Ctrl+Shift+L')
    expect(config.shortcuts.fit_selection).toBe('Ctrl+Shift+F')
    expect(config.shape_color.mode).toBe('auto')
  })

  test("labelme 5.8.1's whole default config, as labelme 5 copied it to ~/.labelmerc, migrates as labelme 7 migrates it", () => {
    const { config, warnings } = loadConfig(parseArgs(['--config', fixture('labelme5')]))
    expect(warnings).toEqual([])
    expect(config.with_image_data).toBe(true)
    expect(config.shape_color).toEqual({ mode: 'auto', auto: { shift: 0 }, uniform: { color: [0, 255, 0] }, by_label: { colors: null, fallback: [0, 255, 0] } })
    expect(config.shortcuts.edit_shape).toBe('Ctrl+J')
    expect(config.shortcuts.toggle_all_shapes).toBe('T')
    expect(config.canvas.crosshair.ai_points_to_shape).toBe(false)
    // labelme 5's Ctrl+Shift+F for Fit Width is Fit to Selection's now
    expect(config.shortcuts.fit_width).toBeNull()
    expect(config.shortcuts.fit_selection).toBe('Ctrl+Shift+F')
  })

  test("merging validates as labelme does, and reports keys it doesn't know", () => {
    const config = defaultConfig()
    const unknown = mergeConfig(config, { auto_save: false, canvas: { num_backups: 5 }, shortcuts: null, new_key: 1, ai: { other: 1 } })
    expect(config.auto_save).toBe(false)
    expect(config.canvas.num_backups).toBe(5)
    expect(config.canvas.double_click).toBe('close')
    expect(config.shortcuts.save).toBe('Ctrl+S')
    expect(unknown).toEqual(['new_key', 'ai.other'])
    expect(() => mergeConfig(defaultConfig(), { validate_label: 'fuzzy' })).toThrow(/validate_label/)
    expect(() => mergeConfig(defaultConfig(), { labels: ['a', 'a'] })).toThrow(/Duplicates/)
    expect(() => mergeConfig(defaultConfig(), { labels: 'a' })).toThrow(/must be a list/)
    expect(() => mergeConfig(defaultConfig(), { shortcuts: 'oops' })).toThrow(/must be a mapping/)
    expect(() => mergeConfig(defaultConfig(), { mask_polygonization: { detail: 101 } })).toThrow(/between 0 and 100/)
    expect(() => mergeConfig(defaultConfig(), { ai: { text_model: 'sam2:latest' } })).toThrow(/AI Text Prompt model/)
    expect(() => mergeConfig(defaultConfig(), { label_flags: { '.*': 'occluded' } })).toThrow(/label_flags/)
  })

  test("old labelme config files are migrated as labelme migrates them", () => {
    const raw: any = {
      keep_prev_brightness: true, store_data: false, logger_level: 'debug', instance_label_auto_increment: true,
      shortcuts: { add_point_to_edge: 'Ctrl+Shift+P', edit_polygon: 'Ctrl+J', delete_polygon: 'X', delete_shape: 'Delete', create_ai_mask: 'M' },
      ai: { default: 'SegmentAnything (speed)' }, canvas: { crosshair: { ai_polygon: false, ai_mask: true } }
    }
    migrateConfig(raw)
    expect(raw).toEqual({
      keep_prev_brightness_contrast: true, with_image_data: false,
      shortcuts: { edit_shape: 'Ctrl+J', delete_shape: 'Delete', create_ai_points_to_shape: 'M' },
      ai: { default: 'Sam (speed)' }, canvas: { crosshair: { ai_points_to_shape: true } }
    })
  })

  test("labelme 5's colour keys become labelme 7's shape_color, and the two can't be mixed", () => {
    const manual: any = { shape_color: 'manual', label_colors: { cat: [1, 2, 3] }, default_shape_color: [9, 9, 9] }
    migrateConfig(manual)
    expect(manual.shape_color).toEqual({ mode: 'by_label', uniform: { color: [9, 9, 9] }, by_label: { fallback: [9, 9, 9], colors: { cat: [1, 2, 3] } } })
    const none: any = { shape_color: null }
    migrateConfig(none)
    expect(none.shape_color).toEqual({ mode: 'uniform' })
    expect(() => migrateConfig({ shape_color: { mode: 'auto' }, label_colors: {} })).toThrow(/cannot be combined/)
    expect(() => migrateConfig({ shape_color: 'rainbow' })).toThrow(/shape_color/)
    expect(() => loadConfig(parseArgs(['--config', '{shape_color: {mode: rainbow}}']))).toThrow(/shape_color.mode/)
    expect(() => loadConfig(parseArgs(['--config', '{shape_color: {by_label: {colors: {cat: [1, 2]}}}}']))).toThrow(/cat must be/)
    expect(loadConfig(parseArgs(['--config', '{shape_color: manual, label_colors: {cat: [1, 2, 3]}}'])).config.shape_color.mode).toBe('by_label')
  })

  test("labelme 7's command line, and labelme 5's spellings", () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sl-args-'))
    const labels = path.join(dir, 'labels.txt')
    writeFileSync(labels, 'cat\n\ndog \n')
    const args = parseArgs(['--no-sandbox', 'images', '--labels', labels, '--flags', 'night,blurry', '--with-image-data', '--no-auto-save',
      '--label-flags', '{.*: [occluded]}', '--validate-label', 'exact', '--epsilon=4', '-O', 'out', '--keep-prev', '--no-sort-labels', '--logger-level', 'debug'])
    expect(args.filename).toBe('images')
    expect(args.output).toBe('out')
    expect(args.overrides).toEqual({
      labels: ['cat', 'dog'], flags: ['night', 'blurry'], with_image_data: true, auto_save: false,
      label_flags: { '.*': ['occluded'] }, validate_label: 'exact', epsilon: 4, keep_prev: true, sort_labels: false
    })
    const old = parseArgs(['--nodata', '--autosave', '--labelflags', '{.*: [occluded]}', '--validatelabel', 'exact', '--nosortlabels'])
    expect(old.overrides).toEqual({ with_image_data: false, auto_save: true, label_flags: { '.*': ['occluded'] }, validate_label: 'exact', sort_labels: false })
    expect(() => parseArgs(['--validatelabel', 'fuzzy'])).toThrow()
    expect(() => parseArgs(['--validate-label', 'fuzzy'])).toThrow()
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
    expect(inline.config.with_image_data).toBe(true)
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
    config.shape_color.auto.shift = 2
    expect(autoColor(0, config)).toBe('#808000')
  })

  test('colours by label first, then a Seamline project colour, then automatic, uniform or the fallback', () => {
    const withMode = (mode: 'auto' | 'uniform' | 'by_label') => {
      const config = defaultConfig()
      config.shape_color = { ...config.shape_color, mode, uniform: { color: [1, 1, 1] }, by_label: { colors: { cat: [1, 2, 3] }, fallback: [4, 5, 6] } }
      return config
    }
    expect(labelColor('cat', 0, withMode('by_label'), '#ffffff')).toBe('#010203')
    expect(labelColor('dog', 0, withMode('by_label'), undefined)).toBe('#040506')
    expect(labelColor('dog', 0, defaultConfig(), '#4f8cff')).toBe('#4f8cff')
    expect(labelColor('dog', 1, withMode('uniform'), undefined)).toBe('#010101')
    expect(labelColor('cat', 0, withMode('auto'), undefined)).toBe('#800000')
  })
})
