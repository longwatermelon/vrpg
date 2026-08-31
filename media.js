import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// extract the last frame of a clip into a jpg with ffmpeg
export async function extractLastFrame(videoPath, outPath) {
  // decode the final second and keep overwriting one image, the last frame survives
  await run('ffmpeg', ['-y', '-sseof', '-1', '-i', videoPath, '-update', '1', '-q:v', '2', outPath])
}

// first existing font file for choice overlays, serif to match the game ui
function findFont() {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf',
    '/usr/share/fonts/truetype/noto/NotoSerif-Regular.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ]
  for (const f of candidates) if (fs.existsSync(f)) return f
  throw new Error('no font available for choice overlays')
}

// width and height of a video file via ffprobe
async function probeSize(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])
  const [w, h] = String(stdout).trim().split(',').map(n => parseInt(n))
  if (!w || !h) throw new Error('could not probe clip dimensions')
  return [w, h]
}

// concatenate clips into one mp4 with each turn's choice ui overlaid at its clip's start:
// the options show as played, the picked one highlights green while the rest fade,
// holds ~2s, then fades out too; specs align with clips, null renders a clip bare
export async function concatClipsWithChoices(clips, specs, outPath) {
  const [W, H] = await probeSize(clips[0])
  const font = findFont()
  const script = outPath + '.filter'
  const tmp = outPath + '.tmp.mp4'
  const texts = [] // textfiles backing the labels, sidesteps drawtext escaping entirely
  // layout scaled to the video size, mirroring the game's choice buttons
  const bw = Math.round(W * 0.72), bx = Math.round((W - bw) / 2) // button width, centered
  const bh = Math.round(H * 0.096), gap = Math.round(H * 0.021) // button height, stack gap
  const bottom = Math.round(H * 0.083), fz = Math.round(H * 0.042) // bottom margin, font size
  const ms = Math.max(6, Math.round(H * 0.017)) // marker square size
  const lh = Math.round(fz * 1.35) // line height for wrapped labels
  const maxChars = Math.floor((bw - fz * 3) / (fz * 0.55)) // rough per-line cap for the box width

  // word-wrap a label to at most two lines like the browser buttons, ellipsize the rest
  function wrapLabel(label) {
    const lines = ['']
    for (const w of label.trim().split(/\s+/)) {
      const cur = lines[lines.length - 1]
      if (!cur) lines[lines.length - 1] = w
      else if (cur.length + 1 + w.length <= maxChars) lines[lines.length - 1] = cur + ' ' + w
      else lines.push(w)
    }
    const out = lines.slice(0, 2).map(l => l.length > maxChars ? l.slice(0, maxChars - 1) + '…' : l) // overlong single words
    if (lines.length > 2) out[1] = out[1].slice(0, maxChars - 1) + '…' // dropped lines leave a trailing ellipsis
    return out
  }

  // filters drawing one choice button (wrapped lines, height h) at y, green styles the picked one
  function button({ lines, h }, y, green) {
    const file = `${outPath}.label-${texts.length}.txt`
    fs.writeFileSync(file, lines.join('\n'))
    texts.push(file)
    const [fill, border, marker, ink] = green
      ? ['0x102a14@0.85', '0x66bb6a@0.9', '0x66bb6a@0.95', '0xd7f5d7']
      : ['0x0e0d0b@0.78', '0xece8df@0.25', '0xd9a441@0.85', '0xece8df']
    const textH = lines.length * fz + (lines.length - 1) * (lh - fz) // drawn text block height
    return [
      `drawbox=x=${bx}:y=${y}:w=${bw}:h=${h}:color=${fill}:t=fill:replace=1`,
      `drawbox=x=${bx}:y=${y}:w=${bw}:h=${h}:color=${border}:t=${green ? 2 : 1}:replace=1`,
      `drawbox=x=${bx + fz}:y=${y + Math.round((h - ms) / 2)}:w=${ms}:h=${ms}:color=${marker}:t=fill:replace=1`,
      `drawtext=fontfile=${font}:textfile=${file}:expansion=none:fontcolor=${ink}:fontsize=${fz}:line_spacing=${lh - fz}:x=${bx + fz * 2}:y=${y + Math.round((h - textH) / 2)}`,
    ].join(',')
  }

  try {
    const parts = []
    clips.forEach((_, i) => {
      const spec = specs[i]
      if (!spec) return parts.push(`[${i}:v]scale=${W}:${H},setsar=1,format=yuv420p[v${i}]`)
      const btns = spec.labels.map(l => { const lines = wrapLabel(l); return { lines, h: bh + (lines.length - 1) * lh } })
      const total = btns.reduce((a, b) => a + b.h + gap, -gap)
      let y = H - bottom - total // stack rises from the bottom like the ui
      const ys = btns.map(b => { const cur = y; y += b.h + gap; return cur })
      // layer 1: every option in normal style, fades out as the pick highlights
      const all = btns.map((b, j) => button(b, ys[j], false)).join(',')
      parts.push(`color=c=black@0:s=${W}x${H}:r=24:d=1.6,format=rgba,${all},fade=t=out:st=1:d=0.4:alpha=1[a${i}]`)
      // layer 2: the picked option in green, crossfades in at 1s, holds 2s, fades out
      parts.push(`color=c=black@0:s=${W}x${H}:r=24:d=3.7,format=rgba,${button(btns[spec.picked], ys[spec.picked], true)},fade=t=in:st=1:d=0.4:alpha=1,fade=t=out:st=3:d=0.5:alpha=1[g${i}]`)
      parts.push(`[${i}:v]scale=${W}:${H},setsar=1[b${i}]`)
      parts.push(`[b${i}][a${i}]overlay=eof_action=pass[p${i}]`)
      parts.push(`[p${i}][g${i}]overlay=eof_action=pass,format=yuv420p[v${i}]`)
    })
    parts.push(clips.map((_, i) => `[v${i}][${i}:a]`).join('') + `concat=n=${clips.length}:v=1:a=1[v][a]`)
    fs.writeFileSync(script, parts.join(';\n'))
    await run('ffmpeg', ['-y', ...clips.flatMap(f => ['-i', f]), '-filter_complex_script', script,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac',
      '-movflags', '+faststart', tmp], { maxBuffer: 16 * 1024 * 1024 })
    fs.renameSync(tmp, outPath) // only expose a fully written render
  } finally {
    for (const f of [script, tmp, ...texts]) fs.rmSync(f, { force: true })
  }
}

// concatenate clips into one mp4, re-encoding for uniform timestamps across clips
export async function concatClips(clips, outPath) {
  const list = outPath + '.txt'
  const tmp = outPath + '.tmp.mp4'
  fs.writeFileSync(list, clips.map(f => `file '${f.replaceAll("'", "'\\''")}'`).join('\n'))
  try {
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac',
      '-movflags', '+faststart', tmp])
    fs.renameSync(tmp, outPath) // only expose a fully written render
  } finally {
    fs.rmSync(list, { force: true })
    fs.rmSync(tmp, { force: true })
  }
}
