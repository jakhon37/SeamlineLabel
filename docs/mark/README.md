# Seamtag's mark

Seamtag is the labelling half of Seamline, so its mark is [Seamline's](../brand) with the other side changed. The seam still parts the photos from what they're joined to, but that side is cloth in the app's blue instead of a network training. A line of stitches runs beside the seam, and a white label comes out from under its edge: the tag in the name. Two of Seamline's handles stay on the seam.

## Files

| File | Use |
|---|---|
| `seamtag-mark.svg` | The mark: from 64 px in the app, from 48 px in the installers' icons |
| `seamtag-mark-small.svg` | The mark below that: the two sides and the shadow, with no detail, label or handles, and a firmer rim |
| `../../resources/icon.png` | Window icon: the mark at 944 of 1024 px |
| `../../resources/icon.icns`, `icon.ico`, `icons/` | The installers' icons for macOS, Windows and Linux, with the small mark at 32 px and under, and at 16 and 32 points on a Mac |

`make.py` draws both SVGs from Seamline's mark and copies them into `src/renderer/src/assets`; `icons.cjs` makes the icons from them:

```bash
python3 docs/mark/make.py && node docs/mark/icons.cjs
```

## Colours

Seamline's paper (`#f3f5f9`), handle ink and rim, and its blue (`#4f8cff`) for the cloth, shaded from `#5c97ff` to `#3f7ae8`. The photo tiles are Seamline's, in greys at about a third of their strength.
