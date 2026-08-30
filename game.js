import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatChoices, startScene } from './llm.js'
import { submitJob, awaitJob, submitImageJob, awaitImageJob } from './fal.js'
import { extractLastFrame } from './media.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(ROOT, 'data')

// build the game master system prompt around the fleshed-out player character description
function systemPrompt(character) {
  return `You are the game master of a video-rendered RPG. The player never reads your text; they only watch generated video clips. Your responses are consumed by a program that feeds them to a video generation model.

The player controls one character in the story. Their appearance: ${character}

Each turn you receive the player's chosen action plus an image of the frame where the story currently stands. Respond with ONLY a JSON object (no markdown fences, no commentary) offering 2-3 choices:
{"choices": [{"label": "...", "prompt": "..."}]}

"label" is a short action the player's character can take, e.g. "Eat the sandwich" or "Say: \\"What are you doing here?\\"".

"prompt" describes a 5-second video clip starting from the current frame. The video model sees only the start keyframe and your prompt, nothing else, so each prompt must be self-contained: re-describe anything not visible in the frame, and refer to characters by appearance, never by name or story role (for the player's character, reuse the appearance above). If a character is off-screen, re-describe them and describe how they enter the scene.

Make the story interesting and fun; be creative.

Example response (player character: a tall young man with short brown hair in a gray hoodie; frame: him at dinner with his girlfriend, a sandwich on her plate - labels may use story knowledge, prompts may not):
{"choices": [{"label": "Eat your girlfriend's sandwich", "prompt": "The man in the gray hoodie sitting at the table picks up the half-eaten sandwich from the woman's plate and eats it. A crunch sound plays as the sandwich is consumed. She glares at him, annoyed, and says <d>[English] Would you stop eating my food? Ugh...</d>. End state: the sandwich is completely gone from her plate and she sits glaring at the man in the gray hoodie."}, {"label": "Call the waiter over", "prompt": "The man in the gray hoodie sitting at the table raises his hand, and a middle-aged man in a white apron (currently off-screen) walks into view and stops beside the table, saying <d>[English] What can I get you?</d>. End state: the man in the white apron stands beside the table holding a notepad, the woman watching him."}]}`
}

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

// prompts behind the current turn for the dev panel
export function getDebug() {
  if (!session) return { active: false }
  return {
    active: true,
    token,
    scenePrompt: session.scenePrompt,
    clipPrompt: session.clipPrompt || null,
    choices: session.choices,
  }
}

// start a new game from the player's context and character, returns the opening frame and choices
export function startGame(context, player) {
  return exclusive(async () => {
    // reuse the submitted job or finished opening frame if this is a retry of the same start
    if (pendingStart?.context !== context || pendingStart?.player !== player) {
      const dir = path.join(DATA_DIR, String(Date.now()))
      fs.mkdirSync(dir, { recursive: true })
      // flesh out the character and write the opening frame prompt before paying for the image
      const { character, scene } = await startScene(context, player)
      pendingStart = { context, player, character, scene, dir, job: await submitImageJob(scene) }
    }
    const { dir, character, scene } = pendingStart
    if (!pendingStart.frame) {
      try {
        pendingStart.frame = await awaitImageJob(pendingStart.job, path.join(dir, 'frame-0'))
      } catch (err) {
        if (err.terminal) pendingStart = null // job itself failed, a retry must resubmit
        throw err
      }
    }
    const frame = pendingStart.frame
    const candidate = { dir, turn: 0, frame, scenePrompt: scene, messages: [{ role: 'system', content: systemPrompt(character) }], choices: [] }
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
      pendingRender = { token, index, job: await submitJob(choice.prompt, toDataUri(session.frame)), done: false }
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
    session.clipPrompt = choice.prompt
    pendingRender = null
    return { clipUrl: toUrl(clip), frameUrl: toUrl(frame), choices: next.choices.map(c => c.label), token }
  })
}
