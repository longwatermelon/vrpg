import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatChoices } from './llm.js'
import { submitJob, awaitJob } from './fal.js'
import { extractLastFrame, generateInitialImage } from './media.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(ROOT, 'data')

const SYSTEM_PROMPT = `You are the game master of a video-rendered first-person RPG. The player never reads your text; they only watch generated video clips. Your responses are consumed by a program that feeds them to a video generation model.

Each turn you receive the player's chosen action plus an image of the frame where the story currently stands. You respond with ONLY a JSON object (no markdown fences, no commentary) in exactly this format:
{"choices": [{"label": "...", "prompt": "..."}]}

Rules:
- Offer 2-3 choices per turn.
- "label" is a short action the player can pick, e.g. "Eat the sandwich" or "Say: \\"What are you doing here?\\"".
- "prompt" describes a 5-second first-person POV video clip that starts from the current frame. The video model has no story memory, so each prompt must be fully self-contained: restate the appearance of characters, objects, and setting so everything stays visually consistent with what has been seen so far.
- Write spoken dialogue as <d>[English] ...</d>.
- The clips are the player's only source of information, so anything the player must learn has to be shown visually or spoken aloud in the clip.
- End every prompt with an explicit description of the final state of the scene, because the next clip continues from this clip's last frame.
- Keep the story coherent, reactive to the player's choices, and interesting.`

let session = null // single in-memory session
let token = 0 // monotonically increasing turn token, never reused across sessions
let busy = false
let pendingRender = null // finished render awaiting a successful llm turn, avoids re-billing on retry
let pendingStart = null // finished opening frame awaiting a successful llm turn, avoids regenerating on retry

// run fn while holding the busy flag, rejects overlapping requests
async function exclusive(fn) {
  if (busy) throw new Error('another request is already in progress')
  busy = true
  try {
    return await fn()
  } finally {
    busy = false
  }
}

// read an image file as a base64 data uri
function toDataUri(file) {
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file).toLowerCase()]
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
}

// convert an absolute path under data/ into a servable url
function toUrl(file) {
  return '/' + path.relative(ROOT, file).split(path.sep).join('/')
}

// ask the llm for the next choices given a user message with a frame attached, no mutation of s
async function nextTurn(s, text, frame) {
  const userMsg = {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: toDataUri(frame) } },
    ],
  }
  const { raw, choices } = await chatChoices([...s.messages.map(stripImage), userMsg]) // only the new frame goes out
  return { msgs: [userMsg, { role: 'assistant', content: raw }], choices }
}

// drop the image from an older user message, the text alone carries the history
function stripImage(msg) {
  if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg
  return { ...msg, content: msg.content.filter(p => p.type !== 'image_url') }
}

// commit a finished turn to session s, only called after every step succeeded
function commitTurn(s, { msgs, choices }, frame, turn) {
  s.messages = s.messages.map(stripImage) // keep stored history slim, images live on disk
  s.messages.push(...msgs)
  s.choices = choices
  s.frame = frame
  s.turn = turn
  token++
}

// snapshot of the current session so the client can resync after a lost response
export function getState() {
  if (!session) return { active: false, busy }
  return {
    active: true,
    busy,
    token,
    frameUrl: toUrl(session.frame),
    clipUrl: session.clip ? toUrl(session.clip) : null,
    choices: session.choices.map(c => c.label),
  }
}

// start a new game from the player's context, returns the opening frame and choices
export function startGame(context) {
  return exclusive(async () => {
    // reuse an already generated opening frame if this is a retry of the same start
    let dir, frame
    if (pendingStart?.context === context) {
      ({ dir, frame } = pendingStart)
    } else {
      dir = path.join(DATA_DIR, String(Date.now()))
      fs.mkdirSync(dir, { recursive: true })
      frame = await generateInitialImage(context, path.join(dir, 'frame-0'))
      pendingStart = { context, dir, frame }
    }
    const candidate = { dir, turn: 0, frame, messages: [{ role: 'system', content: SYSTEM_PROMPT }], choices: [] }
    const turn = await nextTurn(candidate, `Start a new game. The player's starting context: ${context}\nAttached image is the opening frame of the game.`, frame)
    commitTurn(candidate, turn, frame, 0)
    session = candidate // replace any previous game only once the opening turn succeeded
    pendingStart = null
    return { frameUrl: toUrl(frame), choices: turn.choices.map(c => c.label), token }
  })
}

// advance the game with the chosen option, returns the rendered clip and next choices
export function chooseOption(index, clientToken) {
  return exclusive(async () => {
    if (!session) throw new Error('no active game')
    if (clientToken !== token) throw new Error('stale turn, the game has already advanced')
    if (!Number.isInteger(index) || !session.choices[index]) throw new Error('invalid choice index')
    const choice = session.choices[index]
    const clip = path.join(session.dir, `clip-${session.turn}.mp4`)
    const frame = path.join(session.dir, `frame-${session.turn + 1}.jpg`)
    // reuse the submitted job or finished render on retry instead of paying for another
    if (pendingRender?.token === token && pendingRender.index !== index) {
      throw new Error(`a render for "${session.choices[pendingRender.index].label}" is already pending, retry that choice`)
    }
    if (pendingRender?.token !== token) {
      pendingRender = { token, index, job: await submitJob(`First-person POV. ${choice.prompt}`, toDataUri(session.frame)), done: false }
    }
    if (!pendingRender.done) {
      try {
        await awaitJob(pendingRender.job, clip)
      } catch (err) {
        if (err.terminal) pendingRender = null // job itself failed, a retry must resubmit
        throw err
      }
      await extractLastFrame(clip, frame)
      pendingRender.done = true
    }
    const next = await nextTurn(session, `Choose option: ${choice.label}\nAttached image is the last frame of where this chosen action left off.`, frame)
    commitTurn(session, next, frame, session.turn + 1)
    session.clip = clip
    pendingRender = null
    return { clipUrl: toUrl(clip), frameUrl: toUrl(frame), choices: next.choices.map(c => c.label), token }
  })
}
