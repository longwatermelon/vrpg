import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// true if p resolves inside base, follows symlinks so ../ tricks can't escape
function isInside(p, base) {
  try {
    return fs.realpathSync(p).startsWith(fs.realpathSync(base) + path.sep)
  } catch {
    return false
  }
}

// extract the last frame of a clip into a jpg with ffmpeg
export async function extractLastFrame(videoPath, outPath) {
  // decode the final second and keep overwriting one image, the last frame survives
  await run('ffmpeg', ['-y', '-sseof', '-1', '-i', videoPath, '-update', '1', '-q:v', '2', outPath])
}

// generate the opening frame with the image-gen cli, move it to outBase, return its path
export async function generateInitialImage(context, outBase) {
  const dir = path.dirname(outBase)
  const prompt = `Generate a 16:9 widescreen image: the opening frame of a first-person POV rpg game with this starting context: ${context}`
  // cwd is the session dir so any files the cli drops stay contained
  const pending = run('image-gen', [prompt], { cwd: dir, timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 })
  pending.child.stdin.end() // codex silently fails if stdin is left as an open pipe
  const { stdout } = await pending
  // image-gen reports the saved path in freeform text, grab the last path that exists
  // only trust paths inside the session dir or the codex output store, stdout is agent output
  const codexStore = path.join(os.homedir(), '.codex', 'generated_images')
  const matches = stdout.match(/[~/][^\s"'`)\]]+\.(?:png|jpe?g|webp)/gi) || []
  const existing = matches
    .map(p => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p))
    .filter(p => isInside(p, dir) || isInside(p, codexStore))
  let src = existing.at(-1)
  if (!src) { // fall back to the newest image dropped in the session dir
    src = fs.readdirSync(dir)
      .filter(f => /\.(png|jpe?g|webp)$/i.test(f))
      .map(f => path.join(dir, f))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs)
      .at(-1)
  }
  if (!src) throw new Error(`image-gen did not report a saved image, output was: ${stdout.slice(-500)}`)
  const outPath = outBase + path.extname(src).toLowerCase()
  if (src !== outPath) {
    fs.copyFileSync(src, outPath)
    try { fs.rmSync(src, { force: true }) } catch {} // best-effort cleanup, the copy already succeeded
  }
  return outPath
}
