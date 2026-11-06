import { _electron as electron, Page } from '@playwright/test'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import path from 'path'
import sharp from 'sharp'

const REPO = path.resolve(__dirname, '../..')

// Stands in for the GPU machine, so remote runs can be tested anywhere. `ssh` runs each
// command in a folder of its own, real rsync works through it, and the "training" only
// waits: a test writes the run's events itself and says when the run ends.
const COMMANDS: Record<string, string> = {
  ssh: `#!/bin/sh
while :; do
  case "$1" in
    -o|-l) shift 2 ;;
    *) break ;;
  esac
done
shift
cd "$FAKE_GPU" || exit 255
cmd="$*"
printf '%s\\n' "$cmd" >> commands
matches() { [ -e "$1" ] && printf '%s' "$cmd" | grep -q -e "$(cat "$1")"; }
if matches hold; then
  touch held
  i=0
  while [ -e hold ] && [ $i -lt 1200 ]; do
    sleep 0.05
    i=$((i + 1))
  done
fi
if matches fail; then
  echo 'ssh: connect to host fake port 22: Connection refused' >&2
  exit 255
fi
exec sh -c "$cmd"
`,
  python3: `#!/bin/sh
[ "$1" = -c ] && echo '2.5.1 True'
exit 0
`,
  'nvidia-smi': `#!/bin/sh
case "$1" in --query-gpu*) echo 'Fake GPU, 8000 MiB, 8000 MiB' ;; esac
`,
  df: `#!/bin/sh
echo 'fake 0 0 99999999 0% /'
`,
  // The real engine, except that training on this computer just waits to be stopped
  'local-python': `#!/bin/sh
if [ "$2" = train ]; then
  name=$(date +%Y%m%d_%H%M%S)
  run="$3/.myseg/runs/$name"
  mkdir -p "$run"
  echo '{"architecture": "Unet", "encoder": "resnet18"}' > "$run/options.json"
  : > "$run/events.jsonl"
  echo "{\\"run\\": \\"$name\\"}"
  exec sleep 300
fi
exec "$REAL_PYTHON" "$@"
`
}

// Called as: python -u engine/studio.py train PROJECT --options JSON --prepared --run NAME
const TRAINER = `#!/bin/sh
run="$4/.myseg/runs/$9"
i=0
until [ -e "$4/end" ] || [ -e "$4/crash" ] || [ $i -ge 1800 ]; do
  sleep 0.1
  i=$((i + 1))
done
[ -e "$4/crash" ] && exit 1
mkdir -p "$run/run_1"
echo model > "$run/run_1/best_model.pth"
`

export function fakeGpu(base: string) {
  const home = path.join(base, 'gpu')
  const bin = path.join(base, 'bin')
  rmSync(base, { recursive: true, force: true })
  mkdirSync(bin, { recursive: true })
  mkdirSync(path.join(home, 'myseg-studio/venv/bin'), { recursive: true })
  const script = (file: string, text: string) => {
    writeFileSync(file, text)
    chmodSync(file, 0o755)
  }
  for (const [name, text] of Object.entries(COMMANDS)) script(path.join(bin, name), text)
  script(path.join(home, 'myseg-studio/venv/bin/python'), TRAINER)

  const projectOf = (run: string) => path.join(home, 'myseg-studio/projects', run)
  return {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_GPU: home,
      MYSEG_PYTHON: path.join(bin, 'local-python'),
      REAL_PYTHON: path.join(REPO, '.venv/bin/python')
    },
    projectOf,
    emit: (run: string, ...events: unknown[]) => appendFileSync(
      path.join(projectOf(run), '.myseg/runs', run, 'events.jsonl'),
      events.map((e) => JSON.stringify(e) + '\n').join('')
    ),
    end: (run: string) => writeFileSync(path.join(projectOf(run), 'end'), ''),
    // Dies with this output and no events, as an engine does that can't import its packages
    crash: (run: string, output: string) => {
      appendFileSync(path.join(projectOf(run), '.myseg/runs', run, 'out.log'), output)
      writeFileSync(path.join(projectOf(run), 'crash'), '')
    },
    remove: (run: string) => rmSync(projectOf(run), { recursive: true, force: true }),
    hasModel: (run: string) => existsSync(path.join(projectOf(run), '.myseg/runs', run, 'run_1/best_model.pth')),
    // Commands matching the pattern wait until release, or fail until recover
    hold: (pattern: string) => writeFileSync(path.join(home, 'hold'), pattern),
    isHeld: () => existsSync(path.join(home, 'held')),
    release: () => {
      rmSync(path.join(home, 'hold'), { force: true })
      rmSync(path.join(home, 'held'), { force: true })
    },
    fail: (pattern: string) => writeFileSync(path.join(home, 'fail'), pattern),
    recover: () => rmSync(path.join(home, 'fail')),
    polls: () => existsSync(path.join(home, 'commands'))
      ? readFileSync(path.join(home, 'commands'), 'utf8').split('\n').filter((l) => l.includes('kill -0')).length
      : 0
  }
}
export type FakeGpu = ReturnType<typeof fakeGpu>

// A folder with two labelled images
export async function project(base: string, name: string) {
  const dir = path.join(base, name)
  mkdirSync(path.join(dir, '.myseg'), { recursive: true })
  writeFileSync(path.join(dir, '.myseg/project.json'), JSON.stringify({ name, classes: [{ name: 'cat', color: '#4f8cff' }] }))
  for (const image of ['one', 'two']) {
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#445566' } }).png().toFile(path.join(dir, `${image}.png`))
    writeFileSync(path.join(dir, `${image}.json`), JSON.stringify({
      version: '5.5.0', flags: {}, imagePath: `${image}.png`, imageData: null, imageWidth: 64, imageHeight: 64,
      shapes: [{ label: 'cat', shape_type: 'polygon', flags: {}, points: [[8, 8], [40, 8], [40, 40], [8, 40]] }]
    }))
  }
  return dir
}

// A profile of its own, so the fake host doesn't end up in the real app's settings
export const launch = (gpu: FakeGpu, base: string, dir: string) =>
  electron.launch({
    args: [path.resolve(__dirname, '..'), `--user-data-dir=${path.join(base, 'profile')}`],
    env: { ...process.env, ...gpu.env, MYSEG_PROJECT: dir } as Record<string, string>
  })

export async function startRemote(page: Page) {
  await page.getByRole('tab', { name: /Train/ }).click()
  await page.getByLabel('Run on').selectOption('ssh')
  await page.getByLabel('SSH host').fill('gpu@fake')
  await page.getByLabel('Remote folder').fill('myseg-studio')
  await page.getByRole('button', { name: /Train on 2 labelled/ }).click()
}
