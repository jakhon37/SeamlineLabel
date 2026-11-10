<p align="center">
  <img src="docs/mark/seamtag-mark.svg" alt="" width="104">
</p>

<h1 align="center">Seamtag</h1>

<p align="center"><b>Label images in LabelMe, Pascal VOC, YOLO or CreateML format, with labelme 7's and LabelImg's tools, a brush and eraser, AI that finds objects from a click, a box or words, and review of a model's proposals. For Windows, macOS and Linux.</b></p>

<p align="center">
  <a href="https://github.com/jakhon37/Seamtag/actions/workflows/ci.yml"><img src="https://github.com/jakhon37/Seamtag/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0"></a>
</p>

![Seamtag editing a polygon on one of labelme's example photos](docs/media/label.webp)

Seamtag is the labelling half of [Seamline](https://github.com/jakhon37/Seamline), on its own. It reads and writes the same JSON files as [labelme](https://github.com/wkentaro/labelme), takes labelme 7's command line and config keys (labelme 5's still work), and offers its tools, so a folder labelled in either opens in the other. It does the same for [LabelImg](https://github.com/HumanSignal/labelImg): its Pascal VOC, YOLO and CreateML files, its command line and its tools. Everything runs on your computer: images, labels and AI models never leave it.

## What it does

**labelme's tools.** Polygons, rectangles, rotated boxes, circles, lines, line strips and points, drawn by labelme's rules: click the first point to close, Shift for a square, lines stop at the image edge unless `canvas.allow_out_of_bounds_points` lets them past. A rotated box takes two clicks along one side and a third for its width; dragging a corner keeps it square, and the handles on its sides turn it. Edit labels with labelme's dialog (completion, flags per label pattern, group ID, description, and `--validate-label exact`), tick image flags, hide or reorder shapes, copy and paste them between images, lock them, merge polygons or masks of one label, add and remove points (Alt+click, Add point to edge on the right-click menu, or `Ctrl+M` for several along an edge), keep the previous image's shapes, and adjust brightness and contrast. `Ctrl`+arrow selects the next shape that way, and Fit to selection keeps the selected shapes in view.

**LabelImg's formats.** Save labels as Pascal VOC (`name.xml`), YOLO (`name.txt`, with the class names in `classes.txt`) or CreateML (`name.json`) instead of LabelMe JSON: the files are LabelImg's to the byte. Pick the format in the top bar or under File → Save format. As in LabelImg, an image keeps the format of the label file it has, and new label files take the format last used. Switching saves the image in the new format and moves its old file to the trash, so each image has one label file; if the image already has labels in the new format, those open instead, and nothing is converted. These formats hold boxes, so other shapes become the box around them, and AI polygon and AI mask draw boxes. Pre-labelling keeps its proposals in LabelMe JSON, so it works in that format.

**LabelImg's tools.** Tap `Space` to mark an image verified: the background turns green, the file list shows it, and Pascal VOC and CreateML files keep it. Mark boxes difficult, as Pascal VOC records it. Boxes are drawn square with Shift or Ctrl held, or always with Draw squares; any of the four corners can be dragged, and the status bar gives the size of the box being drawn or pointed at. Show labels on the boxes, copy the previous image's boxes, read an annotation file onto the image, show one label's boxes at a time, delete an image to the trash, and right-drag a box to copy or move it. Single class mode labels each new box with the label picked in the Labels list, LabelImg's default label; turned off, each box asks. Advanced mode keeps a tool on; turned off, it's LabelImg's beginner mode, one box and then back to editing. Boxes can have their own line and fill colours.

**AI points, AI box and the text prompt.** Click an object, or drag a box around it, and the model outlines it; Shift+click marks background. What it finds becomes the shape picked beside the tool: polygons (one for each part of the object, grouped), a mask, a rectangle, a circle or a rotated box, as in labelme 7. Repeats of one object are dropped, and with `ai.suppress_existing_shape_matches` so are objects already drawn. The text prompt takes words, such as `dog,cat`, and boxes everything they name with YOLO-World, each box labelled with its word and score. The models are labelme's (EfficientSAM in two sizes, SAM2 in three, and YOLO-World), downloaded once from the addresses labelme uses and kept in the same cache, so a model labelme fetched is already here; AI → AI models lists them, with their sizes and licences, and downloads or deletes them. labelme's SAM and SAM 3 aren't among them: their image encoders need blocks of memory larger than Electron allows.

![SAM2 outlining a bus from two clicks](docs/media/ai.webp)

![YOLO-World boxing the people and the bottle in a photo from the words person,bottle](docs/media/text.webp)

**Pre-label with your own model.** Point it at a segmentation model exported to ONNX, for example from Seamline, and it proposes shapes for every unlabelled image, each with a score. Proposals stay dashed until you accept them: `W` accepts, `S` rejects, `Tab` skips, and the list can put the least certain images first.

**Brush and eraser.** Paint a class, and shapes of that class you touch join it. Erase from one shape or everything under the stroke, splitting shapes or cutting holes.

**Big images.** Large and TIFF images open from a tile pyramid that libvips builds once, so only the tiles in view load: a 6050 × 12300 TIFF opens again in under a second, and zoom goes to 5000%.

**Labels that are hard to lose.** Saves go through one queue to a temporary file and then into place. A label file that can't be read is shown read-only and never written over, and closing the window saves first, or asks when saving isn't automatic.

![labelme's label dialog, with flags for the person label, a group ID and a description](docs/media/dialog.webp)

## Install

Download the installer for your system from [Releases](https://github.com/jakhon37/Seamtag/releases).

| System | File | Notes |
|---|---|---|
| Windows 10 and 11 | `Seamtag-…-win-x64.exe` | Not code-signed yet: on the SmartScreen warning, choose More info, then Run anyway. |
| macOS on Apple silicon | `Seamtag-…-mac-arm64.dmg` | Not notarised yet: right-click the app and choose Open the first time, or run `xattr -cr "/Applications/Seamtag.app"`. |
| macOS on Intel | `Seamtag-…-mac-x64.dmg` | As above. |
| Linux | `Seamtag-…-linux-amd64.deb` | `sudo apt install ./Seamtag-*.deb` adds a `seamtag` command, and on Ubuntu 24.04 and later the AppArmor profile Chromium's sandbox needs. |
| Linux, any distribution | `Seamtag-…-linux-x86_64.AppImage` | `chmod +x` it and run it. On Ubuntu the .deb is simpler: an AppImage can't add that profile, so from 24.04 it needs `--no-sandbox`, and it needs `sudo apt install libfuse2t64` (`libfuse2` on 22.04). |

To build it yourself you need Node 22:

```bash
git clone https://github.com/jakhon37/Seamtag.git
cd Seamtag
npm ci
npm run dev
```

`npm run dist` builds the installer for the system you're on, into `release/`.

## Use

Open a folder of images: labels are saved beside each image as `name.json`, in labelme's format, or in the format picked in the top bar. Images in subfolders are listed too. The command line is labelme's:

```bash
seamtag images/ --labels labels.txt --flags night,blurry --label-flags '{person: [occluded]}' -O labels/
```

LabelImg's works too: a folder of images, a file of classes, and a folder for the labels.

```bash
seamtag images/ predefined_classes.txt annotations/
```

| Option | |
|---|---|
| `--labels LIST\|FILE` | Labels to offer, comma separated or one per line in a file |
| `--flags LIST\|FILE` | Flags for each image |
| `--label-flags YAML\|FILE` | Flags for shapes whose label matches a pattern |
| `--validate-label exact` | Only allow listed labels |
| `-O`, `--output DIR\|FILE.json` | Save label files somewhere else |
| `--with-image-data`, `--no-auto-save`, `--keep-prev`, `--no-sort-labels`, `--epsilon N` | As in labelme 7; labelme 5's `--nodata`, `--autosave`, `--nosortlabels`, `--labelflags` and `--validatelabel` work too |
| `--config FILE\|YAML` | A config file, such as your `~/.labelmerc`, or YAML overrides; `--config '{label_format: yolo}'` saves new labels as YOLO |

Settings live in `~/.seamtagrc`, which takes labelme's keys, so a `~/.labelmerc` can be copied in as it is. File → Open config file opens it. [docs/config.md](docs/config.md) lists every key, including the shortcuts.

### Keys

| Key | Action |
|---|---|
| `P` `R` `V` | Polygon, rectangle, edit (labelme's `Ctrl+Shift+V`, `Ctrl+Shift+B` and `Ctrl+Shift+C` work too, and LabelImg's `Ctrl+J`) |
| `B` `E`, `[` `]` | Brush, eraser, smaller and larger |
| `1`-`9` | Pick a label, or relabel the selected shapes |
| `A` `D` | Previous and next image; with `Ctrl+Shift`, copy this image's shapes over |
| `W` `S` `Tab`, `Shift+W` | Accept, reject or skip an AI proposal; accept all here and move on |
| `Enter`, `Space`, double-click | Finish a polygon, line strip or AI points shape |
| `Alt`+click | Add a point on an edge, or remove one |
| `Ctrl+M`, `Ctrl+Shift+M` | Add several points along an edge; merge selected polygons, or masks of one label |
| `Ctrl+Z`, `Ctrl+Shift+Z` | Undo (a point while drawing), redo |
| `Space` | When nothing is being drawn, a tap marks the image verified, or not; held while dragging, it pans |
| Shift or `Ctrl` while drawing a box, `Ctrl+Shift+R` | A square box; Draw squares on or off |
| `Ctrl+Shift+L`, `Ctrl+Shift+F`, `Ctrl`+arrow | Lock or unlock shapes; fit the view to the selection; select the next shape that way |
| `Ctrl+Shift+P`, `Ctrl+H`, `Ctrl+A` | Labels on shapes; hide and show every shape |
| `Ctrl+E`, `Ctrl+L` | Edit the label; the colour boxes are drawn in |
| `Ctrl+R`, `Ctrl+Shift+O`, `Ctrl+Shift+Delete` | Change the output folder; read an annotation file onto this image; delete the image |
| Right drag on a shape | Copy or move it |
| Wheel, `Space`+drag, `0` | Zoom, pan, fit |

Help → Keyboard shortcuts lists them all. Where LabelImg gives a key another job than labelme does (`W`, `Ctrl+V`, `Ctrl+Y`, `Ctrl+Shift+D`, `Ctrl+Shift+A`, `Ctrl+Shift+L`, `Ctrl+Shift+F`), Seamtag keeps labelme's; [docs/config.md](docs/config.md#labelimgs-keys) has the lines that switch to LabelImg's. On a Mac, `Ctrl` is Command.

### Pre-labelling models

Any ONNX model that takes an image as `[1, 3, H, W]` and returns scores per class as `[1, C, H, W]`, with background as class 0, works. A JSON file beside it with the same name says how to use it; every key is optional:

```json
{ "classes": ["scratch", "dent"], "mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225], "tile": 1024 }
```

Without `classes`, the label list names the classes, in order. Images bigger than `tile` go through tile by tile, and each shape's score is the model's mean confidence inside it, useful for ranking rather than as a probability.

## Working with labelme and LabelImg

The point is that files go both ways, so it's tested from both sides:

- Saving a file that labelme 5 wrote gives back the same bytes, including Python's float format and key order.
- Every `.json` in labelme's examples and test data opens.
- In CI, labelme 7.9.1 and 5.8.1 load the files this app writes with each drawing tool and turn every shape into pixels with `shapes_to_label`, as labelme's export scripts do. CI has no SAM models; run locally with one, AI mask shapes pass the same check.
- On the test photo, AI masks are the same as osam's, pixel for pixel, for EfficientSAM and SAM2, and YOLO-World finds the same boxes with the same scores as labelme 7.9.1. That needed Pillow's bilinear resize ported exactly, which a test checks against Pillow 13.
- Unit tests compare what AI results become with what labelme 7.9.1's own code makes of the same test masks: polygons at each detail, circles, rotated boxes, the removal of repeats and of objects already drawn, osam's non-maximum suppression, and CLIP's tokens for text prompts.
- labelme 7.9.1's whole default config loads with every key known, and labelme 5.8.1's migrates as labelme 7 migrates it.
- Pascal VOC, YOLO and CreateML files are written as LabelImg writes them, byte for byte: down to Python's rounding of halves, its number format, and LabelImg's rule that saved boxes are whole pixels starting from 1. Unit tests compare them with files LabelImg 1.8.6 and its master branch wrote, and read those files back as LabelImg reads them.
- In CI, LabelImg 1.8.6 and its master branch read every Pascal VOC, YOLO and CreateML file the app writes, and write the same bytes for the same boxes. The one difference is CreateML's verified mark, which master writes and 1.8.6 leaves out.

labelme's export scripts in [examples/](examples) (to VOC or COCO) work on these files with `pip install labelme`.

## How it's built

An Electron app in TypeScript. The main process reads and writes files, builds tile pyramids with libvips (through sharp), and runs ONNX models with onnxruntime, so no Python is needed. The window is React, drawing on a canvas; the LabelMe format lives in one shared module, [`src/shared/labelfile.ts`](src/shared/labelfile.ts), and LabelImg's three in [`src/shared/formats.ts`](src/shared/formats.ts), ported from its Python. labelme 7's AI pipeline (masks to shapes, the removal of repeats, non-maximum suppression, CLIP's tokenizer) is ported in [`src/main`](src/main) beside the models. Unit tests (Vitest) cover the formats, config, geometry, the AI pipeline and the resize; end-to-end tests (Playwright) drive the real app on Windows, macOS and Linux, each launch with a home folder and profile of its own. Installers are built by electron-builder on each system.

## History

This repository continues [LabelMeV2](https://github.com/jakhon37/LabelMeV2), a fork of labelme that made big images load faster and added 5000% zoom, points along an edge, polygon merge and dark mode: those are its first 29 commits. The labeller of Seamline's desktop app joined with its own history in [`6204364`](https://github.com/jakhon37/Seamtag/commit/6204364), so its files keep their commits, and replaced the Qt app in [`c2cc715`](https://github.com/jakhon37/Seamtag/commit/c2cc715). Version 3.0 is the first on the new stack; [CHANGELOG.md](CHANGELOG.md) has the rest.

## License

GPL-3.0, as labelme. The Pascal VOC, YOLO and CreateML code is ported from LabelImg, under its MIT licence, whose notice is kept in [`src/shared/formats.ts`](src/shared/formats.ts). CLIP's tokenizer vocabulary, in [`resources/clip`](resources/clip), is OpenAI's, under the MIT licence beside it. The AI models are downloaded from their authors' releases under their own licences: SAM2 and EfficientSAM are Apache-2.0, YOLO-World is GPL-3.0.

Thanks to Kentaro Wada for [labelme](https://github.com/wkentaro/labelme) and [osam](https://github.com/wkentaro/osam), and to Tzutalin and LabelImg's contributors for [LabelImg](https://github.com/HumanSignal/labelImg).
