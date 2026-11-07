# Config

Seamline Label reads `~/.seamline-labelrc`, a YAML file it creates on first run. Put in it only what you want to change. It takes labelme's keys, so the lines of a `~/.labelmerc` work as they are; `seamline-label --config ~/.labelmerc` reads that file instead, and `--config '{auto_save: false}'` passes overrides inline. Keys this version doesn't know are reported and skipped, so a newer labelme's file still opens. The defaults are in [`src/shared/config.ts`](../src/shared/config.ts).

```yaml
labels: [cat, dog]
label_flags:
  cat: [occluded, truncated]
flags: [night, blurry]
auto_save: false
shortcuts:
  save: Ctrl+Alt+S
```

## labelme's keys

| Key | Default | |
|---|---|---|
| `auto_save` | `true` | Save a moment after each change. When off, leaving an image asks. |
| `display_label_popup` | `false` | Ask for a label after every shape, as labelme does. When off, the label picked in the Labels list (or with 1-9) is used, and the dialog opens only when none is picked. |
| `store_data` | `false` | Put the image in the label file as base64 (`imageData`). |
| `keep_prev` | `false` | An image with no labels starts with the previous image's shapes. |
| `keep_prev_scale` | `false` | Keep the zoom when moving between images. |
| `keep_prev_brightness_contrast` | `false` | Keep brightness and contrast when moving between images. |
| `flags` | `null` | Flags for each image, shown in the Flags list. |
| `labels` | `null` | Labels offered first, in this order. |
| `label_flags` | `null` | Flags for shapes, by a pattern matched against the start of the label. |
| `file_search` | `null` | Text the file list starts filtered by. It's a regular expression, as in labelme. |
| `sort_labels` | `true` | Sort labels in the label dialog. |
| `validate_label` | `null` | `exact`: only labels from `labels` are allowed. |
| `shape_color` | `auto` | `auto`: labelme's colours by place in the label list. `manual`: from `label_colors`. `null`: `default_shape_color`. A Seamline project's own colours come before `auto`. |
| `shift_auto_shape_color` | `0` | Start the automatic colours further along. |
| `label_colors` | `null` | `{label: [r, g, b]}` for `manual`. |
| `default_shape_color` | `[0, 255, 0]` | |
| `shape.point_size` | `8` | Size of point shapes. |
| `ai.default` | `Sam2 (balanced)` | The model for AI polygon and AI mask, by labelme's name for it. |
| `flag_dock.show`, `label_dock.show`, `shape_dock.show`, `file_dock.show` | `true` | Which side lists show at first. |
| `show_label_text_field` | `true` | Show the text box in the label dialog. |
| `label_completion` | `startswith` | Or `contains`. |
| `epsilon` | `10` | How close, in screen pixels, counts as on a point or an edge. |
| `default_num_points_to_add` | `5` | What `Ctrl+M` offers. |
| `zoom_increment` | `1.45` | Each zoom step. |
| `max_zoom` | `5000` | In percent. |
| `performance.enable_viewport_culling` | `true` | Skip drawing shapes outside the view. |
| `canvas.fill_drawing` | `false` | Fill a polygon while it's drawn. |
| `canvas.double_click` | `close` | `close`: a double-click finishes a polygon. `null`: it doesn't. |
| `canvas.num_backups` | `200` | Undo steps kept for each image. |
| `canvas.crosshair.<mode>` | rectangle only | Show a crosshair while drawing with that tool. |
| `dark_mode` | `true` | |

`fit_to_content`, `logger_level` and the rest of `performance` are accepted and have no effect here: the window lays itself out, and large images always go through tile pyramids.

## Seamline Label's own keys

| Key | Default | |
|---|---|---|
| `canvas.wheel` | `zoom` | The wheel zooms. `scroll`: it scrolls, as in labelme, and zooms with Ctrl. |
| `brush.size`, `brush.min`, `brush.max` | `28`, `4`, `200` | The brush and eraser, in screen pixels. |
| `prelabel.min_area` | `20` | Proposed shapes smaller than this, in pixels, are dropped. |

## Shortcuts

Written as Qt writes them, a key or a list of keys, `null` for none. As in Qt, `Ctrl` means Command on a Mac.

| Key | Default |
|---|---|
| `open`, `open_dir`, `close`, `quit` | `Ctrl+O`, `Ctrl+U`, `Ctrl+W`, `Ctrl+Q` |
| `save`, `save_as`, `save_to`, `delete_file` | `Ctrl+S`, `Ctrl+Shift+S`, none, `Ctrl+Delete` |
| `open_next`, `open_prev` | `[D, Ctrl+Shift+D]`, `[A, Ctrl+Shift+A]` |
| `zoom_in`, `zoom_out`, `zoom_to_original` | `[Ctrl++, Ctrl+=]`, `Ctrl+-`, `Ctrl+0` |
| `fit_window`, `fit_width` | `[Ctrl+F, 0]`, `Ctrl+Shift+F` |
| `create_polygon`, `create_rectangle` | `[Ctrl+Shift+V, P]`, `[Ctrl+Shift+B, R]` |
| `create_circle`, `create_line`, `create_point`, `create_linestrip` | none |
| `create_ai_polygon`, `create_ai_mask` | none |
| `create_brush`, `create_eraser` | `B`, `E` |
| `edit_polygon`, `edit_label` | `[Ctrl+Shift+C, V]`, `Ctrl+Shift+X` |
| `delete_polygon`, `duplicate_polygon`, `copy_polygon`, `paste_polygon` | `Delete`, `Ctrl+D`, `Ctrl+C`, `Ctrl+V` |
| `undo`, `redo`, `undo_last_point` | `Ctrl+Z`, `[Ctrl+Shift+Z, Ctrl+Y]`, `Ctrl+Z` |
| `remove_selected_point`, `add_multiple_points`, `merge_polygons` | `[Meta+H, Backspace]`, `Ctrl+M`, `Ctrl+Shift+M` |
| `toggle_keep_prev_mode` | `Ctrl+P` |
| `show_all_polygons`, `hide_all_polygons`, `toggle_all_polygons` | none, none, `F` |
| `review_accept`, `review_accept_all`, `review_reject`, `review_skip` | `W`, `Shift+W`, `S`, `Tab` |
| `brush_smaller`, `brush_larger` | `[`, `]` |

`1` to `9` pick a label, arrow keys move the selection (Shift for 10 pixels), and `Escape` cancels what's being drawn.
