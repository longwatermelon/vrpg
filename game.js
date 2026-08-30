import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatChoices } from './llm.js'
import { submitJob, awaitJob, submitImageJob, awaitImageJob } from './fal.js'
import { extractLastFrame } from './media.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(ROOT, 'data')

const SYSTEM_PROMPT = `You are the game master of a video-rendered first-person RPG. The player never reads your text; they only watch generated video clips. Your responses are consumed by a program that feeds them to a video generation model.

Each turn you receive the player's chosen action plus an image of the frame where the story currently stands. You respond with ONLY a JSON object (no markdown fences, no commentary) in exactly this format:
{"choices": [{"label": "...", "prompt": "..."}]}

Rules:
- Offer 2-3 choices per turn.
- "label" is a short action the player can pick, e.g. "Eat the sandwich" or "Say: \\"What are you doing here?\\"".
- "prompt" describes a 5-second first-person POV video clip that starts from the current frame. The video model starts from scratch on every clip: it sees only the start keyframe and your prompt, nothing else. Each prompt must be stateless and fully self-contained: restate the appearance of characters, objects, and setting so everything stays visually consistent with what has been seen so far.
- Never refer to a character by name or story role ("Marcus", "your girlfriend") in a prompt; the video model has no idea who they are. Refer to each character by their current position in the start keyframe (e.g. "the woman seated across the table"), or if they are not visible in the keyframe, note "(currently off-screen)" for them.
- Write spoken dialogue as <d>[English] ...</d>.
- The clips are the player's only source of information, so anything the player must learn has to be shown visually or spoken aloud in the clip.
- End every prompt with an explicit description of the final state of the scene, because the next clip continues from this clip's last frame.
- Keep the story coherent, reactive to the player's choices, and interesting.

Example response (label may use story knowledge, prompt may not):
{"choices": [{"label": "Eat your girlfriend's sandwich", "prompt": "First-person view seated at a wooden table in a cozy diner with red booth seats and warm lighting. You pick up the half-eaten sandwich from the plate of the young woman seated across the table, who has short black hair and wears a yellow hoodie, and eat it. A crunch sound plays as the sandwich is consumed. She looks at you, annoyed, and says <d>[English] Would you stop eating my food? Ugh...</d>. In the end, the sandwich is completely gone from her plate and she is looking annoyed at the camera, the diner unchanged around you."}, {"label": "Call the waiter over", "prompt": "First-person view seated at a wooden table in a cozy diner with red booth seats and warm lighting, a young woman with short black hair in a yellow hoodie seated across the table. You raise your hand, and a middle-aged man in a white apron (currently off-screen) walks into view from the right and stops beside the table, saying <d>[English] What can I get you?</d>. In the end, the man in the white apron stands beside the table holding a notepad, the woman across the table watching him."}]}`

let session = null // single in-memory session
let token = 0 // monotonically increasing turn token, never reused across sessions
let busy = false
let pendingRender = null // finished render awaiting a successful llm turn, avoids re-billing on retry
let pendingStart = null // finished opening frame awaiting a successful llm turn, avoids regenerating on retry

let resetInFlight = null // dedupes overlapping resets and blocks new game ops from overtaking one

// run fn while holding the busy flag, rejects overlapping requests unless wait is set
async function exclusive(fn, wait = false) {
  if (!wait && resetInFlight) throw new Error('a reset is in progress')
  while (busy) {
    if (!wait) throw new Error('another request is already in progress')
    await new Promise(r => setTimeout(r, 500)) // recheck-then-set below is race-free, js is single-threaded
  }
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
  const settling = busy || resetInFlight !== null // a queued reset counts as busy
  if (!session) return { active: false, busy: settling }
  return {
    active: true,
    busy: settling,
    token,
    frameUrl: toUrl(session.frame),
    clipUrl: session.clip ? toUrl(session.clip) : null,
    choices: session.choices.map(c => c.label),
  }
}

// start a new game from the player's context, returns the opening frame and choices
export function startGame(context) {
  return exclusive(async () => {
    // reuse the submitted job or finished opening frame if this is a retry of the same start
    if (pendingStart?.context !== context) {
      const dir = path.join(DATA_DIR, String(Date.now()))
      fs.mkdirSync(dir, { recursive: true })
      pendingStart = { context, dir, job: await submitImageJob(`First-person POV from the perspective of what a person who is describing the following scene is seeing: ${context}. REMEMBER: EXTREMELY IMPORTANT, GENERATE THE FIRST-PERSON POV FROM THE PERSPECTIVE OF THE NARRATOR DESCRIBING THIS SCENE. IT STRICTLY **MUST** BE FIRST-PERSON.`) }
    }
    const { dir } = pendingStart
    if (!pendingStart.frame) {
      try {
        pendingStart.frame = await awaitImageJob(pendingStart.job, path.join(dir, 'frame-0'))
      } catch (err) {
        if (err.terminal) pendingStart = null // job itself failed, a retry must resubmit
        throw err
      }
    }
    const frame = pendingStart.frame
    const candidate = { dir, turn: 0, frame, messages: [{ role: 'system', content: SYSTEM_PROMPT }], choices: [] }
    const turn = await nextTurn(candidate, `Start a new game. The player's starting context: ${context}\nAttached image is the opening frame of the game.`, frame)
    commitTurn(candidate, turn, frame, 0)
    session = candidate // replace any previous game only once the opening turn succeeded
    pendingStart = null
    return { frameUrl: toUrl(frame), choices: turn.choices.map(c => c.label), token }
  })
}

// end the current game so a fresh one can be started, waits out any in-flight turn
export function resetGame() {
  resetInFlight ??= exclusive(async () => {
    session = null
    pendingStart = null
    pendingRender = null
  }, true).finally(() => { resetInFlight = null })
  return resetInFlight
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
      pendingRender = { token, index, job: await submitJob(`First-person POV; you are the camera. ${choice.prompt}`, toDataUri(session.frame)), done: false }
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
