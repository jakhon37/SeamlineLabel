// Makes the app's icons from seamtag-mark.svg and seamtag-mark-small.svg: node docs/mark/icons.cjs
// resources/icon.png is the window icon; the installers take icon.icns (macOS), icon.ico (Windows) and icons/
// (Linux). Where an icon is drawn at 32 px or less, or at 16 or 32 points on a Mac, it gets the small mark,
// as the app's own header does: the full mark's detail would turn to noise there.
const path = require('path'), fs = require('fs')
const sharp = require('sharp')

const HERE = __dirname, RESOURCES = path.join(HERE, '../../resources')
const FULL = path.join(HERE, 'seamtag-mark.svg'), SMALL = path.join(HERE, 'seamtag-mark-small.svg')

// As Seamline's icon: the mark at 944 of 1024 px, with a margin all round, then scaled to size
async function icon(svg, size) {
  const mark = await sharp(svg, { density: 72 * 944 / 512 }).resize(944, 944).png().toBuffer()
  const big = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: mark, left: 40, top: 40 }]).png().toBuffer()
  return sharp(big).resize(size, size, { kernel: 'lanczos3' })
}
const png = async (size, small = size <= 32) => (await icon(small ? SMALL : FULL, size)).png().toBuffer()

// An .icns: each image is a 4-letter type, its length and a PNG
async function icns() {
  const slots = [['icp4', 16, true], ['ic11', 32, true], ['icp5', 32, true], ['ic12', 64, true],
    ['ic07', 128], ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024]]
  const parts = []
  for (const [type, size, small = false] of slots) {
    const data = await png(size, small)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(data.length + 8, 4)
    parts.push(head, data)
  }
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4)
  return Buffer.concat([head, ...parts])
}

// An .ico: PNG at 256 px, and the classic bitmap below that, which every Windows and NSIS read
async function ico() {
  const images = []
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    if (size === 256) { images.push({ size, data: await png(size) }); continue }
    const { data: rgba } = await (await icon(size <= 32 ? SMALL : FULL, size)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const header = Buffer.alloc(40)
    header.writeUInt32LE(40, 0)
    header.writeInt32LE(size, 4)
    header.writeInt32LE(size * 2, 8) // the colour rows and the mask's
    header.writeUInt16LE(1, 12)
    header.writeUInt16LE(32, 14)
    const pixels = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { // bottom row first, as BGRA
      const from = ((size - 1 - y) * size + x) * 4, to = (y * size + x) * 4
      pixels[to] = rgba[from + 2]; pixels[to + 1] = rgba[from + 1]; pixels[to + 2] = rgba[from]; pixels[to + 3] = rgba[from + 3]
    }
    const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size) // all zero: the alpha channel decides
    images.push({ size, data: Buffer.concat([header, pixels, mask]) })
  }
  const dir = Buffer.alloc(6 + 16 * images.length)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(images.length, 4)
  let offset = dir.length
  images.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i
    dir.writeUInt8(size % 256, at)
    dir.writeUInt8(size % 256, at + 1)
    dir.writeUInt16LE(1, at + 4)
    dir.writeUInt16LE(32, at + 6)
    dir.writeUInt32LE(data.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += data.length
  })
  return Buffer.concat([dir, ...images.map((i) => i.data)])
}

;(async () => {
  fs.writeFileSync(path.join(RESOURCES, 'icon.png'), await png(1024))
  fs.mkdirSync(path.join(RESOURCES, 'icons'), { recursive: true })
  for (const size of [16, 22, 24, 32, 48, 64, 128, 256, 512]) fs.writeFileSync(path.join(RESOURCES, 'icons', `${size}x${size}.png`), await png(size))
  fs.writeFileSync(path.join(RESOURCES, 'icon.icns'), await icns())
  fs.writeFileSync(path.join(RESOURCES, 'icon.ico'), await ico())
})().catch((e) => { console.error(e); process.exit(1) })
