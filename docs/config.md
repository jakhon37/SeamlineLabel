# Config

Seamtag reads `~/.seamtagrc`, a YAML file it creates on first run. Put in it only what you want to change. It takes labelme's keys, so the lines of a `~/.labelmerc` work as they are; `seamtag --config ~/.labelmerc` reads that file instead, and `--config '{auto_save: false}'` passes overrides inline. Keys this version doesn't know are reported and skipped, so a newer labelme's file still opens. The defaults are in [`src/shared/config.ts`](../src/shared/config.ts).

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

## Seamtag's own keys

| Key | Default | |
|---|---|---|
| `canvas.wheel` | `zoom` | The wheel zooms. `scroll`: it scrolls, as in labelme, and zooms with Ctrl. |
| `brush.size`, `brush.min`, `brush.max` | `28`, `4`, `200` | The brush and eraser, in screen pixels. |
| `prelabel.min_area` | `20` | Proposed shapes smaller than this, in pixels, are dropped. |
| `label_format` | `labelme` | The format new label files are saved in: `labelme`, or LabelImg's `voc` (Pascal VOC), `yolo` or `createml`. An image that has a label file keeps that file's format, as in LabelImg. |

## Shortcuts

Written as Qt writes them, a key or a list of keys, `null` for none. As in Qt, `Ctrl` means Command on a Mac.

| Key | Default |
|---|---|
| `open`, `open_dir`, `close`, `quit` | `Ctrl+O`, `Ctrl+U`, `Ctrl+W`, `Ctrl+Q` |
| `save`, `save_as`, `save_to`, `delete_file` | `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+R`, `Ctrl+Delete` |
| `open_next`, `open_prev` | `[D, Ctrl+Shift+D]`, `[A, Ctrl+Shift+A]` |
| `zoom_in`, `zoom_out`, `zoom_to_original` | `[Ctrl++, Ctrl+=]`, `Ctrl+-`, `Ctrl+0` |
| `fit_window`, `fit_width` | `[Ctrl+F, 0]`, `Ctrl+Shift+F` |
| `create_polygon`, `create_rectangle` | `[Ctrl+Shift+V, P]`, `[Ctrl+Shift+B, R]` |
| `create_circle`, `create_line`, `create_point`, `create_linestrip` | none |
| `create_ai_polygon`, `create_ai_mask` | none |
| `create_brush`, `create_eraser` | `B`, `E` |
| `edit_polygon`, `edit_label` | `[Ctrl+Shift+C, V, Ctrl+J]`, `[Ctrl+Shift+X, Ctrl+E]` |
| `delete_polygon`, `duplicate_polygon`, `copy_polygon`, `paste_polygon` | `Delete`, `Ctrl+D`, `Ctrl+C`, `Ctrl+V` |
| `undo`, `redo`, `undo_last_point` | `Ctrl+Z`, `[Ctrl+Shift+Z, Ctrl+Y]`, `Ctrl+Z` |
| `remove_selected_point`, `add_multiple_points`, `merge_polygons` | `[Meta+H, Backspace]`, `Ctrl+M`, `Ctrl+Shift+M` |
| `toggle_keep_prev_mode` | `Ctrl+P` |
| `show_all_polygons`, `hide_all_polygons`, `toggle_all_polygons` | `Ctrl+A`, `Ctrl+H`, `F` |
| `review_accept`, `review_accept_all`, `review_reject`, `review_skip` | `W`, `Shift+W`, `S`, `Tab` |
| `brush_smaller`, `brush_larger` | `[`, `]` |

LabelImg's commands:

| Key | Default |
|---|---|
| `verify_image`, `toggle_difficult` | `Space`, none. Space is a tap: held while dragging, it pans. |
| `open_annotation`, `copy_previous_shapes`, `delete_image` | `Ctrl+Shift+O`, none, `Ctrl+Shift+Delete` |
| `change_format` | none. Each press moves to the next format, as LabelImg's format button does. |
| `draw_squares`, `display_labels`, `toggle_label_panel` | `Ctrl+Shift+R`, `Ctrl+Shift+P`, `Ctrl+Shift+L` |
| `single_class_mode`, `advanced_mode` | none |
| `box_line_color`, `shape_line_color`, `shape_fill_color` | `Ctrl+L`, none, none |

`1` to `9` pick a label, arrow keys move the selection (Shift for 10 pixels), and `Escape` cancels what's being drawn. On a Mac, macOS keeps ⌘H and ⌘A for itself, so there `F` shows and hides shapes.

## LabelImg's keys

Where LabelImg and labelme give a key different jobs, Seamtag keeps labelme's: `W` accepts an AI proposal, `Ctrl+V` pastes, `Ctrl+Y` redoes, `Ctrl+Shift+D` and `Ctrl+Shift+A` copy the shapes over to the next or previous image, and `Ctrl+=` zooms in. These lines in `~/.seamtagrc` give those keys LabelImg's jobs and move the others aside:

```yaml
# LabelImg's keys
shortcuts:
  create_rectangle: [W, R]
  review_accept: Y
  review_accept_all: Shift+Y
  copy_previous_shapes: Ctrl+V
  paste_polygon: Ctrl+Alt+V
  change_format: Ctrl+Y
  redo: Ctrl+Shift+Z
  delete_image: Ctrl+Shift+D
  open_next: D
  advanced_mode: Ctrl+Shift+A
  open_prev: A
  zoom_in: Ctrl++
  zoom_to_original: [Ctrl+0, Ctrl+=]
```

LabelImg's `Ctrl+Shift+S` for Single Class Mode stays Save As, as LabelImg's own Save As has it too.

## Files in LabelImg's formats

| Format | Each image's file | |
|---|---|---|
| Pascal VOC | `name.xml` | Boxes with their labels and the difficult flag; the image's verified mark. |
| YOLO | `name.txt`, and `classes.txt` beside it | Each box as a class number and its centre and size, as shares of the image. `classes.txt` names the classes in order: new labels are added at its end, so the numbers in files already saved stay right. A `.txt` file counts as YOLO's only beside a `classes.txt`. |
| CreateML | `name.json` | A list of images, each with its boxes and verified mark, named by file name. `-O labels.json` keeps every image in one list, named by its path in the folder, so images of the same name in different folders stay apart. |

The files are written as LabelImg writes them, CreateML with the verified mark of LabelImg's master branch, which 1.8.6 leaves out. Boxes saved in Pascal VOC and YOLO are whole pixels, starting from 1. In an output folder, label files keep the folders their images are in. Files labelme or LabelImg left straight in it, by image file name, open too, except where images in different folders share that name. Group IDs, descriptions, flags other than difficult, and image flags have no place in these files. A file that can't be read in its format is shown read-only and never written over.
