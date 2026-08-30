import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// extract the last frame of a clip into a jpg with ffmpeg
export async function extractLastFrame(videoPath, outPath) {
  // decode the final second and keep overwriting one image, the last frame survives
  await run('ffmpeg', ['-y', '-sseof', '-1', '-i', videoPath, '-update', '1', '-q:v', '2', outPath])
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
