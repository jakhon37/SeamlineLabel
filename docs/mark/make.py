"""Draws seamtag-mark.svg and seamtag-mark-small.svg from Seamline's mark in docs/brand: its seam, photo tiles,
handles, shadows and rim, with the cloth side in place of the network.
Run: python3 docs/mark/make.py, then node docs/mark/icons.cjs for the app's icons"""
import math
import os
import re
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
SEAMLINE = os.path.join(HERE, '..', 'brand', 'seamline-mark.svg')
NS = 'http://www.w3.org/2000/svg'
ET.register_namespace('', NS)

PAPER, HANDLE_INK, RIM = '#f3f5f9', '#14161a', '#8a93a3'
SEAM = 'M322 -24C230 18 148 72 148 150C148 216 200 236 256 256C312 276 364 296 364 362C364 440 282 494 190 536'

# Seamline's photo tiles, by position. They cover only its light side, so the rest of the grid reuses them
root = ET.parse(SEAMLINE).getroot()
light = next(g for g in root.iter(f'{{{NS}}}g') if g.get('clip-path') == 'url(#ls)')
TILES = {}
for t in next(c for c in light if c.get('opacity') == '0.34'):
    x, y = map(float, re.match(r'translate\(([-\d.]+) ([-\d.]+)\)', t.get('transform')).groups())
    TILES[(x, y)] = t
POOL = list(TILES.values())


def tiles():
    out, k = [], 0
    for i, y in enumerate((32, 144, 256, 368, 480)):
        x = -80 if i % 2 == 0 else -24
        while x <= 600:
            t = TILES.get((float(x), float(y)))
            t = POOL[(k * 7 + 3) % len(POOL)] if t is None else t
            k += 1
            inner = ''.join(ET.tostring(c, encoding='unicode') for c in t).replace(f' xmlns="{NS}"', '')
            inner = re.sub(r'ts_\d+', f't{k}', inner)
            out.append(f'<g transform="translate({x} {y}) translate(-50 -50)">{inner}</g>')
            x += 112
    return f'<g opacity="0.34" filter="url(#m)">{"".join(out)}</g>'


def rounded(points, r):
    """A closed path through points, each corner rounded by r"""
    d = []
    for i, (x, y) in enumerate(points):
        (px, py), (nx, ny) = points[i - 1], points[(i + 1) % len(points)]
        a, b = math.hypot(px - x, py - y), math.hypot(nx - x, ny - y)
        d.append(f'{"M" if i == 0 else "L"}{x + (px - x) * r / a:.1f} {y + (py - y) * r / a:.1f}'
                 f'Q{x:.1f} {y:.1f} {x + (nx - x) * r / b:.1f} {y + (ny - y) * r / b:.1f}')
    return ''.join(d) + 'Z'


def mark(small):
    # The label sits at the seam's middle, square to it, and goes in under the paper's edge
    phi = math.atan2(40, 112)
    c, s = math.cos(phi), math.sin(phi)
    label = rounded([(256 + x * c - y * s, 256 + x * s + y * c) for x, y in ((-62, 40), (-62, -172), (62, -172), (62, 40))], 12)
    handles = ''.join(f'<circle cx="{x}" cy="{y}" r="19" fill="#fff" stroke="{HANDLE_INK}" stroke-width="8"/>' for x, y in ((148, 150), (364, 362)))
    cloth_side = '' if small else (
        # a line of stitches beside the seam, and the label with the paper's shade on it where it goes under
        '<g clip-path="url(#r)"><rect width="512" height="512" fill="#fff" fill-opacity=".9" mask="url(#st)"/></g>'
        f'<g filter="url(#sh)"><path d="{label}" fill="#fff"/></g>'
        f'<g clip-path="url(#lb)"><path d="{SEAM}" fill="none" stroke="#0b2a6b" stroke-opacity=".22" stroke-width="20" transform="translate(6 -3)" filter="url(#bs)"/></g>')
    return f'''<svg viewBox="0 0 512 512" xmlns="{NS}"><title>Seamtag</title><defs>
<clipPath id="c"><rect width="512" height="512" rx="116"/></clipPath>
<clipPath id="l"><path d="{SEAM}L-40 536L-40 -24Z"/></clipPath>
<clipPath id="r"><path d="{SEAM}L552 536L552 -24Z"/></clipPath>
<clipPath id="lb"><path d="{label}"/></clipPath>
<filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter>
<filter id="bs" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6"/></filter>
<filter id="sh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="6" stdDeviation="7" flood-opacity=".3"/></filter>
<filter id="m" x="0" y="0" width="1" height="1"><feColorMatrix type="saturate" values="0"/></filter>
<linearGradient id="duos" x1="0" y1="0" x2=".3" y2="1"><stop offset="0" stop-color="#1d2a44" stop-opacity=".34"/><stop offset="1" stop-color="#1d2a44" stop-opacity=".08"/></linearGradient>
<linearGradient id="cloth" x1=".3" y1="0" x2=".8" y2="1"><stop offset="0" stop-color="#5c97ff"/><stop offset="1" stop-color="#3f7ae8"/></linearGradient>
<mask id="st" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><path d="{SEAM}" fill="none" stroke="#fff" stroke-width="44" stroke-dasharray="20 14"/><path d="{SEAM}" fill="none" stroke="#000" stroke-width="30"/></mask>
</defs><g clip-path="url(#c)">
<rect width="512" height="512" fill="url(#cloth)"/>{cloth_side}
<g clip-path="url(#l)"><rect width="512" height="512" fill="{PAPER}"/>{'' if small else tiles()}
<path d="{SEAM}" fill="none" stroke="#0b2a6b" stroke-opacity="{'.16' if small else '.2'}" stroke-width="{28 if small else 36}" transform="translate(-5 4)" filter="url(#{'bs' if small else 'b'})"/></g>
{'' if small else handles}<rect width="512" height="512" rx="116" fill="none" stroke="{RIM}" stroke-opacity="{'0.5' if small else '.28'}" stroke-width="{28 if small else 5}"/>
</g></svg>
'''


# Here, and in the renderer's assets for the app's header and About box
for name, small in (('seamtag-mark.svg', False), ('seamtag-mark-small.svg', True)):
    for folder in (HERE, os.path.join(HERE, '..', '..', 'src', 'renderer', 'src', 'assets')):
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, name), 'w') as f:
            f.write(mark(small))
