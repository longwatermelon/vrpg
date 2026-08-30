import fs from 'node:fs'
import path from 'node:path'

const VIDEO_ENDPOINT = 'https://queue.fal.run/minimax/h3-max/image-to-video'
const IMAGE_ENDPOINT = 'https://queue.fal.run/fal-ai/bytedance/seedream/v4.5/text-to-image'
const POLL_MS = 750
const TIMEOUT_MS = 10 * 60 * 1000

const headers = { Authorization: `Key ${process.env.FAL_API_KEY}`, 'Content-Type': 'application/json' }
const shortTimeout = () => AbortSignal.timeout(60 * 1000) // per-request cap so a stalled call can't hang the game

// submit an image-to-video job to fal, returns the queue handle urls
export async function submitJob(prompt, imageDataUri) {
  const submit = await fetch(VIDEO_ENDPOINT, {
    method: 'POST',
    headers,
    signal: shortTimeout(),
    body: JSON.stringify({
      prompt,
      image_url: imageDataUri,
      duration: 5,
      resolution: '480P',
      prompt_expansion_mode: 'disabled',
    }),
  })
  if (!submit.ok) throw new Error(`fal submit failed: ${submit.status} ${await submit.text()}`)
  return await submit.json()
}

// poll a submitted fal job until it completes, then fetch and return the result json
// errors marked terminal mean the job itself failed and must be resubmitted
async function pollResult({ status_url, response_url, cancel_url }) {
  const deadline = Date.now() + TIMEOUT_MS
  while (true) { // poll until the job finishes
    if (Date.now() > deadline) {
      // cancel best-effort so an abandoned job can't keep billing, then let a retry resubmit
      if (cancel_url) await fetch(cancel_url, { method: 'PUT', headers, signal: shortTimeout() }).catch(() => {})
      const err = new Error('fal render timed out')
      err.terminal = true
      throw err
    }
    const res = await fetch(status_url, { headers, signal: shortTimeout() })
    if (!res.ok) {
      const err = new Error(`fal status failed: ${res.status} ${await res.text()}`)
      err.terminal = res.status === 404 || res.status === 410 // the job no longer exists
      throw err
    }
    const status = await res.json()
    if (status.status === 'COMPLETED') {
      if (status.error) { // the render itself failed, retrying this job is pointless
        const err = new Error(`fal render failed: ${status.error_type || ''} ${JSON.stringify(status.error)}`)
        err.terminal = true
        throw err
      }
      break
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }

  const result = await fetch(response_url, { headers, signal: shortTimeout() })
  if (!result.ok) {
    const err = new Error(`fal render failed: ${result.status} ${await result.text()}`)
    // 4xx means the render itself failed and must be resubmitted, except transient 408/429
    err.terminal = result.status < 500 && result.status !== 408 && result.status !== 429
    throw err
  }
  return await result.json()
}

// wait for a submitted image-to-video job and download the clip to outPath
export async function awaitJob(job, outPath) {
  const { video } = await pollResult(job)
  if (!video?.url) {
    const err = new Error('fal returned no video url')
    err.terminal = true
    throw err
  }
  const clip = await fetch(video.url, { signal: AbortSignal.timeout(3 * 60 * 1000) })
  if (!clip.ok) throw new Error(`clip download failed: ${clip.status}`)
  fs.writeFileSync(outPath, Buffer.from(await clip.arrayBuffer()))
}

// submit a 16:9 text-to-image job to seedream 4.5, returns the queue handle urls
export async function submitImageJob(prompt) {
  const submit = await fetch(IMAGE_ENDPOINT, {
    method: 'POST',
    headers,
    signal: shortTimeout(),
    body: JSON.stringify({ prompt, image_size: 'landscape_16_9' }),
  })
  if (!submit.ok) throw new Error(`fal submit failed: ${submit.status} ${await submit.text()}`)
  return await submit.json()
}

// wait for a submitted image job, save it as outBase plus extension, return the path
export async function awaitImageJob(job, outBase) {
  const { images } = await pollResult(job)
  const image = images?.[0]
  if (!image?.url) {
    const err = new Error('fal returned no image url')
    err.terminal = true
    throw err
  }
  const res = await fetch(image.url, { signal: shortTimeout() })
  if (!res.ok) throw new Error(`image download failed: ${res.status}`)
  // trust the download's content-type over the optional schema field, fall back to the url extension
  const mime = (res.headers.get('content-type') || image.content_type || '').split(';')[0]
  const urlExt = path.extname(new URL(image.url).pathname).toLowerCase().replace('.jpeg', '.jpg')
  const ext = { 'image/png': '.png', 'image/webp': '.webp', 'image/jpeg': '.jpg' }[mime]
    || (['.png', '.webp', '.jpg'].includes(urlExt) ? urlExt : '.jpg')
  const outPath = outBase + ext
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()))
  return outPath
}
