# Config

Seamtag reads `~/.seamtagrc`, a YAML file it creates on first run. Put in it only what you want to change. It takes labelme 7's keys, so the lines of a `~/.labelmerc` work as they are, and migrates labelme 5's as labelme 7 does (`store_data` becomes `with_image_data`, `shape_color: manual` and `label_colors` become `shape_color.by_label`, `edit_polygon` becomes `edit_shape`, and so on); `seamtag --config ~/.labelmerc` reads that file instead, and `--config '{auto_save: false}'` passes overrides inline. Keys this version doesn't know are reported and skipped, so a newer labelme's file still opens. The defaults are in [`src/shared/config.ts`](../src/shared/config.ts).

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
| `auto_save` | `true` | Save a moment after each change. An image with no label file gets none while it has no shapes and no flags, so a shape drawn and undone leaves nothing behind; Save writes the empty file. When off, leaving an image asks. |
| `display_label_popup` | `false` | Ask for a label after every shape, as labelme does. When off, the label picked in the Labels list (or with 1-9) is used, and the dialog opens only when none is picked. |
| `with_image_data` | `false` | Put the image in the label file as base64 (`imageData`). labelme 5 called it `store_data`. |
| `keep_prev` | `false` | An image with no labels starts with the previous image's shapes. |
| `keep_prev_scale` | `false` | Keep the zoom when moving between images. |
| `keep_prev_brightness_contrast` | `false` | Keep brightness and contrast when moving between images. |
| `flags` | `null` | Flags for each image, shown in the Flags list. |
| `labels` | `null` | Labels offered first, in this order. |
| `label_flags` | `null` | Flags for shapes, by a pattern matched against the start of the label. |
| `file_search` | `null` | Text the file list starts filtered by. It's a regular expression, as in labelme. |
| `sort_labels` | `true` | Sort labels in the label dialog. |
| `validate_label` | `null` | `exact`: only labels from `labels` are allowed. |
| `shape_color.mode` | `auto` | `auto`: labelme's colours by place in the label list. `uniform`: `shape_color.uniform.color` for all. `by_label`: from `shape_color.by_label.colors`, `{label: [r, g, b]}`, else `shape_color.by_label.fallback`. A Seamline project's own colours come before `auto` and `uniform`. |
| `shape_color.auto.shift` | `0` | Start the automatic colours further along. |
| `shape.point_size` | `8` | Size of point shapes. |
| `shape.show_labels` | `false` | Draw each shape's label on it at first, as View → Display labels does. |
| `mask_polygonization.detail` | `60` | From 0 to 100: how closely polygons from AI masks follow them, and how small a part of a mask still gets its own polygon. |
| `ai.default` | `Sam2 (balanced)` | The model for AI points and AI box, by labelme's name for it. labelme's `Sam (…)` models can't run in this app, so they get SAM2 (balanced). |
| `ai.text_model` | `yoloworld:latest` | The model for the text prompt. labelme also takes `sam3:latest`; SAM 3 can't run in this app, so YOLO-World is used. |
| `ai.suppress_existing_shape_matches` | `false` | AI points and AI box leave out objects already drawn, and select those shapes instead. |
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
| `canvas.allow_out_of_bounds_points` | `false` | Points may be placed past the image's edge. |
| `canvas.crosshair.<tool>` | rectangle and AI box | Show a crosshair while drawing with that tool: `polygon`, `rectangle`, `oriented_rectangle`, `circle`, `line`, `point`, `linestrip`, `ai_points_to_shape`, `ai_box_to_shape`. |
| `dark_mode` | `true` | |

`fit_to_content`, `language`, `color_theme` and the rest of `performance` are accepted and have no effect here: the window lays itself out, is in English with its own Dark mode switch, and large images always go through tile pyramids. A `logger_level` key is dropped on load, as labelme 7 drops it.

## Seamtag's own keys

| Key | Default | |
|---|---|---|
| `canvas.wheel` | `zoom` | The wheel zooms. `scroll`: it scrolls, as in labelme, and zooms with Ctrl. |
| `brush.size`, `brush.min`, `brush.max` | `28`, `4`, `200` | The brush and eraser, in screen pixels. |
| `prelabel.min_area` | `25` | Proposed shapes smaller than this, in pixels, are dropped. The area runs through the centres of the shape's outer pixels, as Seamline measures it. |
| `label_format` | `labelme` | The format new label files are saved in: `labelme`, or LabelImg's `voc` (Pascal VOC), `yolo` or `createml`. An image that has a label file keeps that file's format, as in LabelImg. |

## Shortcuts

Written as Qt writes them, a key or a list of keys, `null` for none. As in Qt, `Ctrl` means Command on a Mac.

| Key | Default |
|---|---|
| `open`, `open_dir`, `close`, `quit` | `Ctrl+O`, `Ctrl+U`, `Ctrl+W`, `Ctrl+Q` |
| `save`, `save_as`, `save_to`, `delete_file` | `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+R`, `Ctrl+Delete` |
| `open_next`, `open_prev` | `[D, Ctrl+Shift+D]`, `[A, Ctrl+Shift+A]` |
| `zoom_in`, `zoom_out`, `zoom_to_original` | `[Ctrl++, Ctrl+=]`, `Ctrl+-`, `Ctrl+0` |
| `fit_window`, `fit_selection` | `[Ctrl+F, 0]`, `Ctrl+Shift+F` |
| `create_polygon`, `create_rectangle`, `create_oriented_rectangle` | `[Ctrl+Shift+V, P]`, `[Ctrl+Shift+B, R]`, none |
| `create_circle`, `create_line`, `create_point`, `create_linestrip` | none |
| `create_ai_points_to_shape`, `create_ai_box_to_shape` | none |
| `create_brush`, `create_eraser` | `B`, `E` |
| `edit_shape`, `edit_label`, `lock_shape` | `[Ctrl+Shift+C, V, Ctrl+J]`, `[Ctrl+Shift+X, Ctrl+E]`, `Ctrl+Shift+L` |
| `delete_shape`, `duplicate_shape`, `copy_shape`, `paste_shape` | `Delete`, `Ctrl+D`, `Ctrl+C`, `Ctrl+V` |
| `undo`, `redo`, `undo_last_point` | `Ctrl+Z`, `[Ctrl+Shift+Z, Ctrl+Y]`, `Ctrl+Z` |
| `remove_selected_point`, `add_multiple_points`, `merge_shapes` | `[Meta+H, Backspace]`, `Ctrl+M`, `Ctrl+Shift+M` |
| `toggle_keep_prev_mode` | none, as in labelme 7 |
| `show_all_shapes`, `hide_all_shapes`, `toggle_all_shapes` | `Ctrl+A`, `Ctrl+H`, `F` |
| `select_shape_up`, `select_shape_down`, `select_shape_left`, `select_shape_right` | `Ctrl+Up`, `Ctrl+Down`, `Ctrl+Left`, `Ctrl+Right` |
| `review_accept`, `review_accept_all`, `review_reject`, `review_skip` | `W`, `Shift+W`, `S`, `Tab` |
| `brush_smaller`, `brush_larger` | `[`, `]` |

LabelImg's commands:

| Key | Default |
|---|---|
| `verify_image`, `toggle_difficult` | `Space`, none. Space is a tap: held while dragging, it pans. |
| `open_annotation`, `copy_previous_shapes`, `delete_image` | `Ctrl+Shift+O`, none, `Ctrl+Shift+Delete` |
| `change_format` | none. Each press moves to the next format, as LabelImg's format button does. |
| `draw_squares`, `display_labels` | `Ctrl+Shift+R`, `Ctrl+Shift+P` |
| `toggle_label_panel`, `fit_width` | none: their keys, `Ctrl+Shift+L` and `Ctrl+Shift+F`, are labelme 7's Lock Shapes and Fit to Selection |
| `single_class_mode`, `advanced_mode` | none |
| `box_line_color`, `shape_line_color`, `shape_fill_color` | `Ctrl+L`, none, none |

`1` to `9` pick a label, arrow keys move the selection (Shift for 10 pixels), `Space` finishes a polygon, line strip or AI points shape being drawn, and `Escape` cancels what's being drawn. On a Mac, macOS keeps ⌘H and ⌘A for itself, so there `F` shows and hides shapes.

## LabelImg's keys

Where LabelImg and labelme give a key different jobs, Seamtag keeps labelme's: `W` accepts an AI proposal, `Ctrl+V` pastes, `Ctrl+Y` redoes, `Ctrl+Shift+D` and `Ctrl+Shift+A` copy the shapes over to the next or previous image, `Ctrl+=` zooms in, `Ctrl+Shift+L` locks shapes and `Ctrl+Shift+F` fits the view to the selection. These lines in `~/.seamtagrc` give those keys LabelImg's jobs and move the others aside:

```yaml
# LabelImg's keys
shortcuts:
  create_rectangle: [W, R]
  review_accept: Y
  review_accept_all: Shift+Y
  copy_previous_shapes: Ctrl+V
  paste_shape: Ctrl+Alt+V
  change_format: Ctrl+Y
  redo: Ctrl+Shift+Z
  delete_image: Ctrl+Shift+D
  open_next: D
  advanced_mode: Ctrl+Shift+A
  open_prev: A
  zoom_in: Ctrl++
  zoom_to_original: [Ctrl+0, Ctrl+=]
  toggle_label_panel: Ctrl+Shift+L
  lock_shape: Ctrl+Alt+L
  fit_width: Ctrl+Shift+F
  fit_selection: Ctrl+Alt+F
```

LabelImg's `Ctrl+Shift+S` for Single Class Mode stays Save As, as LabelImg's own Save As has it too.

## Files in LabelImg's formats

| Format | Each image's file | |
|---|---|---|
| Pascal VOC | `name.xml` | Boxes with their labels and the difficult flag; the image's verified mark. |
| YOLO | `name.txt`, and `classes.txt` beside it | Each box as a class number and its centre and size, as shares of the image. `classes.txt` names the classes in order: new labels are added at its end, so the numbers in files already saved stay right. A `.txt` file counts as YOLO's only beside a `classes.txt`. |
| CreateML | `name.json` | A list of images, each with its boxes and verified mark, named by file name. `-O labels.json` keeps every image in one list, named by its path in the folder, so images of the same name in different folders stay apart. |

The files are written as LabelImg writes them, CreateML with the verified mark of LabelImg's master branch, which 1.8.6 leaves out. Boxes saved in Pascal VOC and YOLO are whole pixels, starting from 1. In an output folder, label files keep the folders their images are in. Files labelme or LabelImg left straight in it, by image file name, open too, except where images in different folders share that name. Group IDs, descriptions, flags other than difficult, and image flags have no place in these files. A file that can't be read in its format is shown read-only and never written over.
