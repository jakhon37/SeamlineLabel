# mySeg Studio

Label images and train segmentation models in one desktop app. Press `Ctrl+1` for Label and `Ctrl+2` for Train; each keeps its place when you switch.

## Run

Needs Node 20+ and the repo's Python requirements in `.venv` at the repo root. Set `MYSEG_PYTHON` to use another interpreter.

```bash
npm install
npm run build
npm start
```

Open any folder of images. Labels are saved beside each image as LabelMe JSON, so LabelMe and LabelMeV2 can open the same folder. A label file that can't be read is marked red and never written over. Project settings, the tile cache, the prepared dataset and runs go in `.myseg/` inside that folder.

## Keys

| Key | Action |
|---|---|
| `V` / `P` / `R` | Select and edit / polygon / rectangle |
| `B` / `E`, `[` `]` | Brush / eraser, brush size |
| `W` / `S` / `Tab` | Accept / reject / skip the AI shape, then go to the next |
| `Shift+W` | Accept every AI shape here and go to the next image to review |
| Click first point, `Enter` or double-click | Close polygon |
| `1`-`9` | Choose class, or change the selected shape's class |
| `A` / `D` | Previous / next image |
| Wheel, `Space`+drag or right-drag, `0` | Zoom, pan, fit |
| `F` | Show or hide shapes |
| Double-click an edge / `Alt`+click a point | Add / remove a point |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |

## How it fits together

- `src/main`: file access, image tile pyramids (libvips through sharp), and starting the Python engine
- `src/renderer`: the React UI, with `Labeler.tsx` and `Trainer.tsx` side by side
- `../engine/studio.py`: LabelMe JSON to masks, training through `scripts/train.py`, and pre-labelling

Pre-labelled shapes stay dashed and are left out of training until you accept or edit them.

## Review pre-labels

**Pre-label N images** runs the newest model on every image with no accepted shapes, saving as it goes. Press `W` to step through the shapes. **Least certain first** orders images by their least certain shape, and each image's shapes are reviewed in the same order. A shape's score is the model's mean confidence inside it. It's good for ranking but isn't a probability, and an object the model missed has no shape, so no score. `Ctrl+Z` right after moving on goes back to the last image and takes the decision back.

## Brush and eraser

The brush paints the selected shape's class, or the current class if nothing is selected. Shapes of that class it touches merge into one and keep their layer, which also joins shapes split at a tile edge. Where another class sits on a higher layer, it stays on top: erase it to paint there. The eraser cuts from the selected shape, or from everything it touches if nothing is selected, and can split a shape in two.

LabelMe polygons can't have holes, so a hole is saved as one outline with a zero-width cut. The cut shows as a thin line on screen, but it doesn't change the training mask.

## Train on a GPU machine

On the Train page, set **Run on** to **GPU machine over SSH**, then enter `user@host` and a remote folder. You need key-based SSH, rsync on both ends, and a GPU PyTorch for the machine's `python3`.

The app prepares the dataset here, checks there is 3 GB to spare, and uploads it. Training runs detached, so it survives closing the app or a lost connection; the app reattaches when the project opens. When the run ends, the best model comes back and the run's files are removed from the machine.

`engine/remote_setup.py` builds an isolated environment in the remote folder, linking the machine's PyTorch rather than copying it.

## Test

```bash
npm run test:e2e
```

Set `MYSEG_E2E_SSH=user@host` to include the remote GPU test.
