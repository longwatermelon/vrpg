import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// extract the last frame of a clip into a jpg with ffmpeg
export async function extractLastFrame(videoPath, outPath) {
  // decode the final second and keep overwriting one image, the last frame survives
  await run('ffmpeg', ['-y', '-sseof', '-1', '-i', videoPath, '-update', '1', '-q:v', '2', outPath])
}
