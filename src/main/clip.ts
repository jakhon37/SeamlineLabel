// CLIP's tokenizer, as osam carries it (OpenAI's simple_tokenizer.py, MIT, without ftfy): text
// prompts become the token numbers SAM 3's and YOLO-World's text encoders take. The merges are
// resources/clip/bpe_simple_vocab_16e6.txt.gz, cut to the ones CLIP uses.

/** Each byte's stand-in character, by byte, and the characters in CLIP's vocabulary order */
function bytesToUnicode(): { table: string[]; order: string[] } {
  const bs: number[] = []
  for (let b = '!'.charCodeAt(0); b <= '~'.charCodeAt(0); b++) bs.push(b)
  for (let b = 0xa1; b <= 0xac; b++) bs.push(b)
  for (let b = 0xae; b <= 0xff; b++) bs.push(b)
  const cs = [...bs]
  let n = 0
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b)
      cs.push(256 + n++)
    }
  }
  const table: string[] = []
  bs.forEach((b, i) => { table[b] = String.fromCharCode(cs[i]) })
  return { table, order: cs.map((c) => String.fromCharCode(c)) }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

// Python's html.unescape for the entities a prompt might hold
function unescape(text: string) {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (all, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all
    }
    return ENTITIES[name] ?? all
  })
}

const PATTERN = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}\p{N}_]+|\p{N}+|[^\s\p{L}\p{N}_]+/giu

export class Tokenizer {
  private byteEncoder: string[]
  private encoder = new Map<string, number>()
  private ranks = new Map<string, number>()
  private cache = new Map<string, string>([['<|startoftext|>', '<|startoftext|>'], ['<|endoftext|>', '<|endoftext|>']])

  /** `merges` is the vocabulary file's text: a header line, then one merge per line */
  constructor(merges: string) {
    const { table, order } = bytesToUnicode()
    this.byteEncoder = table
    const lines = merges.split('\n').slice(1, 49152 - 256 - 2 + 1)
    const vocab = [...order]
    vocab.push(...order.map((v) => v + '</w>'))
    lines.forEach((line, i) => {
      const [a, b] = line.split(' ')
      vocab.push(a + b)
      this.ranks.set(`${a} ${b}`, i)
    })
    vocab.push('<|startoftext|>', '<|endoftext|>')
    vocab.forEach((v, i) => this.encoder.set(v, i))
  }

  private bpe(token: string): string {
    const hit = this.cache.get(token)
    if (hit !== undefined) return hit
    let word = [...token.slice(0, -1)].concat(token.slice(-1) + '</w>')
    if (word.length < 2) return token + '</w>'
    for (;;) {
      let best: [string, string] | null = null
      let bestRank = Infinity
      for (let i = 0; i < word.length - 1; i++) {
        const rank = this.ranks.get(`${word[i]} ${word[i + 1]}`)
        if (rank !== undefined && rank < bestRank) { bestRank = rank; best = [word[i], word[i + 1]] }
      }
      if (!best) break
      const [first, second] = best
      const merged: string[] = []
      let i = 0
      while (i < word.length) {
        const j = word.indexOf(first, i)
        if (j < 0) {
          merged.push(...word.slice(i))
          break
        }
        merged.push(...word.slice(i, j))
        i = j
        if (word[i] === first && i < word.length - 1 && word[i + 1] === second) {
          merged.push(first + second)
          i += 2
        } else {
          merged.push(word[i])
          i += 1
        }
      }
      word = merged
      if (word.length === 1) break
    }
    const out = word.join(' ')
    this.cache.set(token, out)
    return out
  }

  encode(text: string): number[] {
    const clean = unescape(unescape(text)).trim().replace(/\s+/gu, ' ').trim().toLowerCase()
    const ids: number[] = []
    for (const [token] of clean.matchAll(PATTERN)) {
      const chars = [...Buffer.from(token, 'utf8')].map((b) => this.byteEncoder[b]).join('')
      for (const piece of this.bpe(chars).split(' ')) ids.push(this.encoder.get(piece)!)
    }
    return ids
  }

  /** clip.tokenize: each text between the start and end tokens, zero-padded to the context length */
  tokenize(texts: string[], contextLength = 77): BigInt64Array {
    const sot = this.encoder.get('<|startoftext|>')!, eot = this.encoder.get('<|endoftext|>')!
    const out = new BigInt64Array(texts.length * contextLength)
    texts.forEach((text, i) => {
      const tokens = [sot, ...this.encode(text), eot]
      if (tokens.length > contextLength) throw new Error(`"${text}" is too long: a text prompt takes ${contextLength - 2} tokens at most`)
      tokens.forEach((t, k) => { out[i * contextLength + k] = BigInt(t) })
    })
    return out
  }
}
