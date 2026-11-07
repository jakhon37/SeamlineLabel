import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import yaml from 'js-yaml'
import { checkConfig, type Config, defaultConfig, mergeConfig, migrateConfig } from '../shared/config'

// Its own file, not ~/.labelmerc: labelme stops on keys it doesn't know, and this app adds some.
// `--config ~/.labelmerc` reads a labelme config as it is.
export const USER_CONFIG = path.join(homedir(), '.seamline-labelrc')

const HEADER = `# Seamline Label config file.
# Only add settings you want to override. It takes labelme's keys, so a ~/.labelmerc
# can be copied in as it is. For all options and defaults, see:
#   https://github.com/jakhon37/SeamlineLabel/blob/main/docs/config.md
#
# Example:
# auto_save: true
# store_data: false
# labels: [cat, dog]
`

export function ensureUserConfig() {
  if (existsSync(USER_CONFIG)) return
  try {
    writeFileSync(USER_CONFIG, HEADER)
  } catch {
    // A read-only home still runs, with the defaults
  }
}

export type Args = {
  filename: string | null
  output: string | null
  config: string | null
  overrides: Record<string, unknown>
  resetConfig: boolean
  version: boolean
  help: boolean
}

export const USAGE = `Usage: seamline-label [options] [image, label file or folder]

  -h, --help            show this help
  -V, --version         show the version
  --reset-config        forget window layout, recent files and settings made in the app
  --output, -O, -o DIR  folder for label files (a path ending in .json saves one file there)
  --config FILE|YAML    config file, or YAML overrides (default: ~/.seamline-labelrc)
  --nodata              don't store image data in label files
  --autosave            save automatically
  --nosortlabels        keep labels in the order given
  --flags LIST|FILE     comma separated image flags, or a file with one per line
  --labelflags YAML|FILE  flags for labels matching a pattern, e.g. "{.*: [occluded]}"
  --labels LIST|FILE    comma separated labels, or a file with one per line
  --validatelabel exact only allow labels from --labels
  --keep-prev           copy the previous image's shapes to an image with none
  --epsilon PIXELS      how close counts as on a vertex
  --logger-level LEVEL  debug, info, warning, error or fatal
`

function listOrFile(value: string): string[] {
  if (existsSync(value)) {
    return readFileSync(value, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  }
  return value.split(',').filter(Boolean)
}

/** labelme's command line. Flags Electron or Chromium add are passed over. */
export function parseArgs(argv: string[]): Args {
  const args: Args = { filename: null, output: null, config: null, overrides: {}, resetConfig: false, version: false, help: false }
  const takes = (i: number) => {
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`)
    return argv[i + 1]
  }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    const [flag, inline] = raw.startsWith('--') && raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, null]
    const value = () => (inline !== null ? inline : takes(i++))
    switch (flag) {
      case '-h': case '--help': args.help = true; break
      case '-V': case '--version': args.version = true; break
      case '--reset-config': args.resetConfig = true; break
      case '--output': case '-O': case '-o': args.output = value(); break
      case '--config': args.config = value(); break
      case '--nodata': args.overrides.store_data = false; break
      case '--autosave': args.overrides.auto_save = true; break
      case '--nosortlabels': args.overrides.sort_labels = false; break
      case '--flags': args.overrides.flags = listOrFile(value()); break
      case '--labels': args.overrides.labels = listOrFile(value()); break
      case '--labelflags': {
        const v = value()
        args.overrides.label_flags = yaml.load(existsSync(v) ? readFileSync(v, 'utf8') : v)
        break
      }
      case '--validatelabel': {
        const v = value()
        if (v !== 'exact') throw new Error(`--validatelabel must be exact, not ${v}`)
        args.overrides.validate_label = v
        break
      }
      case '--keep-prev': args.overrides.keep_prev = true; break
      case '--epsilon': {
        const v = Number(value())
        if (!Number.isFinite(v)) throw new Error('--epsilon must be a number')
        args.overrides.epsilon = v
        break
      }
      case '--logger-level': args.overrides.logger_level = value().toLowerCase(); break
      default:
        if (!raw.startsWith('-') && args.filename === null) args.filename = raw
    }
  }
  return args
}

export type LoadedConfig = { config: Config; file: string | null; warnings: string[] }

export function loadConfig(args: Args): LoadedConfig {
  const config = defaultConfig()
  const warnings: string[] = []
  let file: string | null = USER_CONFIG
  let overrides: Record<string, unknown> = {}
  // As in labelme, --config is either YAML overrides or a file to read instead of the default
  if (args.config !== null) {
    const asYaml = (() => {
      try {
        return yaml.load(args.config!)
      } catch {
        return null
      }
    })()
    if (asYaml && typeof asYaml === 'object' && !Array.isArray(asYaml)) {
      overrides = asYaml as Record<string, unknown>
      file = null
    } else {
      file = path.resolve(args.config)
      if (!existsSync(file)) throw new Error(`Config file does not exist: ${file}`)
    }
  } else {
    ensureUserConfig()
  }
  if (file && existsSync(file)) {
    const loaded = yaml.load(readFileSync(file, 'utf8'))
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
      migrateConfig(loaded as Record<string, any>)
      const unknown = mergeConfig(config, loaded as Record<string, unknown>)
      if (unknown.length) warnings.push(`${path.basename(file)} has keys this version doesn't use: ${unknown.join(', ')}`)
    }
  }
  const unknown = mergeConfig(config, { ...overrides, ...args.overrides })
  if (unknown.length) warnings.push(`Unknown config keys were ignored: ${unknown.join(', ')}`)
  checkConfig(config)
  return { config, file, warnings }
}
