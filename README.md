# mySeg Studio

Label images and train segmentation models in one desktop app. Press `Ctrl+1` for Label and `Ctrl+2` for Train; each keeps its place when you switch.

## Run

Needs Node 20+ and the repo's Python requirements in `.venv` at the repo root. Set `MYSEG_PYTHON` to use another interpreter.

```bash
npm install
npm run build
npm start
```

Open any folder of images. Labels are saved beside each image as LabelMe JSON, so LabelMe and LabelMeV2 can open the same folder. Project settings, the tile cache, the prepared dataset and runs go in `.myseg/` inside that folder.

## Keys

| Key | Action |
|---|---|
| `V` / `P` / `R` | Select and edit / polygon / rectangle |
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

## Train on a GPU machine

On the Train page, set **Run on** to **GPU machine over SSH**, then enter `user@host` and a remote folder. You need key-based SSH, rsync on both ends, and a GPU PyTorch for the machine's `python3`.

The app prepares the dataset here, checks there is 3 GB to spare, and uploads it. Training runs detached, so it survives closing the app or a lost connection; the app reattaches when the project opens. When the run ends, the best model comes back and the run's files are removed from the machine.

`engine/remote_setup.py` builds an isolated environment in the remote folder, linking the machine's PyTorch rather than copying it.

## Test

```bash
npm run test:e2e
```

Set `MYSEG_E2E_SSH=user@host` to include the remote GPU test.
