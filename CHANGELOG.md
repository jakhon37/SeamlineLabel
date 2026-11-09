# Changelog

All notable changes to Seamtag, and before it LabelMeV2, are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - Seamtag

The labeller of [Seamline](https://github.com/jakhon37/Seamline), on its own, in place of the Qt app.

### Added
- All of labelme's shape types and editing, in an Electron app: the label dialog with completion, flags per label pattern, group ID, description and validation; image flags; the shape list with visibility and order; copy and paste across images; merge; adding points along an edge; keep previous annotation; brightness and contrast; output folders; image data in label files; label files opened on their own; images in subfolders.
- labelme's command line and config keys. Settings live in `~/.seamtagrc`; `--config ~/.labelmerc` reads a labelme config as it is.
- AI polygon and AI mask with labelme's eight SAM models, through onnxruntime, sharing osam's model cache. On the test photo the masks equal osam's, pixel for pixel.
- Pre-labelling with any ONNX segmentation model, with scores, and review of the proposals: `W` accept, `S` reject, `Tab` skip, least certain first.
- Brush and eraser, from Seamline.
- labelme 7's oriented rectangles and locked shapes.
- Installers for Windows, macOS (Apple silicon and Intel) and Linux (AppImage, .deb).

### Changed
- Label files are written as labelme writes them, byte for byte, and saved through a temporary file. A file that can't be read is shown read-only and never written over.
- Deleting a label file moves it to the trash.
- Large images open from tile pyramids instead of being downsampled.

### Removed
- The Qt app and its Python package. labelme's export scripts in `examples/` still work on these files with `pip install labelme`.

## [2.x] - LabelMeV2, the Qt app

### Added
- **Performance Optimizations** for large images and many polygons:
  - **Smart Image Loading**: Use QImageReader for 3-5x faster loading (10s → 2-3s)
  - **LRU Image Cache**: Instant navigation to recently viewed images (100x faster)
  - **Viewport Culling**: Only render visible polygons (5-10x faster with 100+ polygons)
  - **Adaptive Image Downsampling**: Auto-downsample large images (4x less memory, 2-5x faster)
  - Configurable performance settings in config
  - Smooth performance even with 16000×8000 images and 500+ polygons
- **Enhanced Zoom Capabilities**: Increased maximum zoom from 1000% to 5000% (50x magnification) for tiny defect annotation
  - Configurable `max_zoom` setting (default: 5000%)
  - Configurable `zoom_increment` for smoother control (default: 1.1)
  - Better support for microscopic defect inspection
- **Multiple Point Addition Feature (`Ctrl+M`)**: Add multiple evenly-spaced points along polygon edges for refined annotation
- **Polygon Merge Feature (`Ctrl+Shift+M`)**: Merge multiple polygons with intelligent handling of connected/disconnected regions
- **Dark Mode**: Eye-friendly dark theme inspired by VS Code (toggle via View menu)
- **Improved Default Settings**: Better defaults for production use
  - `auto_save` now `true` by default (never lose work)
  - `store_data` now `false` by default (smaller JSON files)
  - `keep_prev_brightness_contrast` now `true` (consistent visuals)
  - `canvas.fill_drawing` now `false` (see through shapes while drawing)
  - `canvas.num_backups` increased to 20 (more undo history)
- **Better Keyboard Shortcuts**: More intuitive shortcuts that don't conflict
  - `Ctrl+Shift+C` for Create Polygon (was `Ctrl+N`)
  - `Ctrl+Shift+X` for Create Rectangle (was `Ctrl+R`)
  - `Ctrl+Shift+V` for Edit Polygon (was `Ctrl+J`)
- Pre-commit hooks for automated code quality checks
- `.editorconfig` for consistent coding style across editors
- `.gitattributes` for consistent line endings
- Comprehensive test suite with 38 tests (100% passing)
- Production-level code quality (all linting checks pass)

### Changed
- Refactored polygon editing logic for better maintainability
- Improved error messages and user feedback
- Updated tests to reflect new default settings
- Consolidated documentation structure

### Fixed
- Test suite now fully working with all dependencies properly configured
- All code style and linting issues resolved
- Line length issues in message dialogs fixed

## [0.0.1] - 2024-02-25

### Added
- Initial fork from [wkentaro/labelme](https://github.com/wkentaro/labelme)
- Basic dark mode implementation
- File reorganization

---

## Contributing

For details on our release process and development workflow, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Upstream

Seamtag descends from [labelme](https://github.com/wkentaro/labelme) by Kentaro Wada, through LabelMeV2.
See labelme's repository for its history before the fork.
