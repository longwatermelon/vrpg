import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatChoices, startScene, getLlmCost } from './llm.js'
import { submitJob, awaitJob, submitImageJob, awaitImageJob, cancelJob, getFalCost } from './fal.js'
import { extractLastFrame, concatClips } from './media.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(ROOT, 'data')

// build the game master system prompt around the fleshed-out player character description
function systemPrompt(character) {
  return `You are the game master of a video-rendered RPG. The player never reads your text; they only watch generated video clips. Your responses are consumed by a program that feeds them to a video generation model.

The player controls one character in the story. Their appearance: ${character}

Each turn you receive the player's chosen action plus an image of the frame where the story currently stands. Respond with ONLY a JSON object (no markdown fences, no commentary) offering 2-3 choices:
{"choices": [{"label": "...", "prompt": "...", "duration": 8}], "loop-prompt": "..."}

"label" is a short action the player's character can take, e.g. "Eat the sandwich" or "Say: \\"What are you doing here?\\"".

"prompt" describes a video clip starting from the current frame. The video model sees only the start keyframe and your prompt, nothing else, so each prompt must be self-contained: re-describe anything not visible in the frame, and refer to characters by appearance, never by name or story role (for the player's character, reuse the appearance above). If a character is off-screen, re-describe them and describe how they enter the scene.

"duration" is the clip length in seconds, an integer from 5 to 15: 5 for a short one-shot action, 7-12 for most actions, 15 for explanations, back-and-forth dialogue, or fights.

"loop-prompt" is a prompt for a 5-second idle animation starting from the current frame, shown looping while the player picks an option and while their chosen clip renders. Continue whatever repeatable action the characters are currently doing. For example, if they're walking with a repeatable background (ie, a wall or a crowd or a streetside), keep them walking against that background. If a character is typing, keep them typing. If a character is drinking, keep them drinking. Use natural, loopable actions that don't make it obvious a loop is occurring. You must also consider the loopability of what the characters are doing in the end state for each prompt; make sure the end state is configured so that the characters are doing something that's loopable. For example, if a character is walking into a building and the clip ends around the character opening the door and entering, make sure the end state has the camera perspective viewing the character in an angle such that the background is loopable; maybe a side view as they enter the building, relatively close-up, so that they can continue walking and background elements can continue repeating.

Loops may also be action scenes, not just idle rote actions; as long as it's natural as a loop and doesn't involve characters needing to weirdly backtrack to preserve the loop, then it works. For example, if a clip ends in the middle of a high-action fighting scene, the loop can continue the fighting, as long as the net result of the fighting over the course of the 5 seconds is basically "nothing was achieved overall, nothing truly progressed".

The loop must not perform any of the choices or advance the story. Like "prompt", it must be self-contained.

Make the story interesting and fun; be creative. Keep the story progressing - pace it properly. Not too slow, not too fast. If the scene is starting to lull / there's no particularly interesting options left, make the third option be something that cuts away from the current scene and skips to later in a different setting and time and context.

Example response (player character: a tall young man with short brown hair in a gray hoodie; frame: him at dinner with his girlfriend, a sandwich on her plate - labels may use story knowledge, prompts may not):
{"choices": [{"label": "Eat your girlfriend's sandwich", "prompt": "The man in the gray hoodie sitting at the table picks up the half-eaten sandwich from the woman's plate and eats it. A crunch sound plays as the sandwich is consumed. She glares at him, annoyed, and says <d>[English] Would you stop eating my food? Ugh...</d>. End state: the sandwich is completely gone from her plate and she sits glaring at the man in the gray hoodie.", "duration": 8}, {"label": "Call the waiter over", "prompt": "The man in the gray hoodie sitting at the table raises his hand, and a middle-aged man in a white apron (currently off-screen) walks into view and stops beside the table, saying <d>[English] What can I get you?</d>. End state: the man in the white apron stands beside the table holding a notepad, the woman watching him.", "duration": 6}], "loop-prompt": "A tall young man with short brown hair in a gray hoodie and a young woman sit facing each other at a restaurant table. The camera stays still. They idle in place, breathing softly and glancing around; the woman lightly drums her fingers on the table. By the end both have returned exactly to their starting poses."}`
}

let session = null // single in-memory session
let token = 0 // monotonically increasing turn token, never reused across sessions
let busy = false
let pendingRender = null // finished render awaiting a successful llm turn, avoids re-billing on retry
let pendingStart = null // finished opening frame awaiting a successful llm turn, avoids regenerating on retry

let resetInFlight = null // dedupes overlapping resets and blocks new game ops from overtaking one

let idleLoop = null // this turn's 5s idle loop render, best-effort

// forget the current idle loop, best-effort canceling a still-running render
function dropIdleLoop() {
  if (idleLoop && !idleLoop.url && !idleLoop.failed) {
    idleLoop.aborted = true // tells a submit still in flight to cancel on arrival
    cancelJob(idleLoop.job)
  }
  idleLoop = null
}

// render a 5s idle loop of the current frame, best-effort, returns a never-rejecting promise
function startIdleLoopRender(s, tok) {
  if (idleLoop?.token === tok) return idleLoop.promise // already rendering for this turn
  dropIdleLoop() // a previous turn's loop still rendering is stale, cancel it
  const out = path.join(s.dir, `loop-${s.turn}.mp4`)
  const state = { token: tok, url: null }
  idleLoop = state
  state.promise = (async () => {
    const frameUri = toDataUri(s.frame)
    state.job = await submitJob(s.loopPrompt, frameUri, 5, frameUri) // same frame as start and end forces a closed loop
    if (state.aborted) return cancelJob(state.job) // dropped while submitting
    await awaitJob(state.job, out)
    state.url = toUrl(out)
  })().catch(() => { state.failed = true }) // no loop, the static frame stands; keep the entry so nothing resubmits
  return state.promise
}

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
  const { raw, choices, loopPrompt } = await chatChoices([...s.messages.map(stripImage), userMsg]) // only the new frame goes out
  return { msgs: [userMsg, { role: 'assistant', content: raw }], choices, loopPrompt }
}

// drop the image from an older user message, the text alone carries the history
function stripImage(msg) {
  if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg
  return { ...msg, content: msg.content.filter(p => p.type !== 'image_url') }
}

// persist the session transcript and turn state into its dir so the story can be resumed
function saveSession(s) {
  const data = {
    context: s.context,
    player: s.player,
    character: s.character,
    scenePrompt: s.scenePrompt,
    messages: s.messages.map(stripImage), // images live on disk as frames
    choices: s.choices,
    loopPrompt: s.loopPrompt,
    turn: s.turn,
    frame: path.basename(s.frame),
    clip: s.clip ? path.basename(s.clip) : null,
    clipPrompt: s.clipPrompt || null,
    clipDuration: s.clipDuration || null,
  }
  const file = path.join(s.dir, 'session.json')
  fs.writeFileSync(file + '.tmp', JSON.stringify(data))
  fs.renameSync(file + '.tmp', file) // atomic so a crash can't leave a torn save
}

// apply a finished turn to session object s; callers persist to disk, then publish
function applyTurn(s, { msgs, choices, loopPrompt }, frame, turn) {
  s.messages = [...s.messages.map(stripImage), ...msgs] // keep stored history slim, images live on disk
  s.choices = choices
  s.loopPrompt = loopPrompt
  s.frame = frame
  s.turn = turn
}

// running api spend for this process, exact for openrouter, rate-estimated for fal
function getCost() {
  const llm = getLlmCost()
  const fal = getFalCost()
  return { llm, fal, total: llm + fal }
}

// snapshot of the current session so the client can resync after a lost response
export function getState() {
  const settling = busy || resetInFlight !== null // a queued reset counts as busy
  if (!session) return { active: false, busy: settling, cost: getCost() }
  return {
    active: true,
    busy: settling,
    token,
    frameUrl: toUrl(session.frame),
    clipUrl: session.clip ? toUrl(session.clip) : null,
    loadedClip: !!(session.clip && session.loaded), // historical clip of a resumed story, not a missed turn
    loopUrl: idleLoop?.token === token ? idleLoop.url : null, // current frame's idle loop, if ready
    loopFailed: idleLoop?.token === token ? !!idleLoop.failed : true, // no loop entry means none is coming, stop waiting
    choices: session.choices.map(c => c.label),
    cost: getCost(),
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
    clipDuration: session.clipDuration || null,
    loopPrompt: session.loopPrompt || null,
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
    const candidate = { dir, turn: 0, frame, context, player, character, scenePrompt: scene, messages: [{ role: 'system', content: systemPrompt(character) }], choices: [] }
    const turn = await nextTurn(candidate, `Start a new game. The player's starting context: ${context}\nAttached image is the opening frame of the game.`, frame)
    applyTurn(candidate, turn, frame, 0)
    saveSession(candidate) // persist first so a failed save fails the start cleanly, memory untouched
    session = candidate // replace any previous game only once the opening turn succeeded
    token++
    // hold the start until the opening frame's idle loop is rendered, so the first
    // thing the player sees is the scene in motion, never the static frame,
    // waiting in short slices so a queued reset isn't stuck behind a cosmetic render
    // (this also drops a replaced game's still-rendering loop)
    const loopReady = startIdleLoopRender(session, token).then(() => true)
    while (!(await Promise.race([loopReady, new Promise(r => setTimeout(r, 500))])) && !resetInFlight) {}
    pendingStart = null
    return { frameUrl: toUrl(frame), choices: turn.choices.map(c => c.label), token }
  })
}

// end the current game so a fresh one can be started, waits out any in-flight turn
export function resetGame() {
  if (!resetInFlight) {
    dropIdleLoop() // cancel a rendering idle loop right away, an in-flight turn stops waiting on it
    resetInFlight = exclusive(async () => {
      session = null
      pendingStart = null
      pendingRender = null
      dropIdleLoop() // the turn that was in flight may have started another one meanwhile
    }, true).finally(() => { resetInFlight = null })
  }
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
      pendingRender = { token, index, job: await submitJob(choice.prompt, toDataUri(session.frame), choice.duration), done: false }
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
    // stage the committed state on a copy and persist it before publishing in memory,
    // so a failed disk save leaves the turn cleanly retryable
    const committed = { ...session }
    applyTurn(committed, next, frame, session.turn + 1)
    committed.loaded = false // this clip is newly committed, resync may replay it
    committed.clip = clip
    committed.clipPrompt = choice.prompt
    committed.clipDuration = choice.duration
    saveSession(committed)
    session = committed
    token++
    // hold the turn until the new frame's idle loop is also rendered, so the loop is
    // guaranteed ready the moment the clip ends and the handoff stays seamless,
    // waiting in short slices so a queued reset isn't stuck behind a cosmetic render
    const loopReady = startIdleLoopRender(session, token).then(() => true)
    while (!(await Promise.race([loopReady, new Promise(r => setTimeout(r, 500))])) && !resetInFlight) {}
    pendingRender = null
    return { clipUrl: toUrl(clip), frameUrl: toUrl(frame), choices: next.choices.map(c => c.label), token }
  })
}

// resolve a story id to its directory under data/, rejecting anything unsafe
function storyDir(id) {
  if (typeof id !== 'string' || !/^\d+$/.test(id)) {
    const err = new Error('invalid story id')
    err.status = 400
    throw err
  }
  return path.join(DATA_DIR, id)
}

// numeric suffix of a frame/clip/loop filename, for ordering
function fileNum(name) {
  return parseInt(name.match(/\d+/)[0])
}

// list saved stories in data/, newest first, each with its last frame as thumbnail
export function listStories() {
  if (!fs.existsSync(DATA_DIR)) return []
  const out = []
  for (const name of fs.readdirSync(DATA_DIR)) {
    if (!/^\d+$/.test(name)) continue
    const dir = path.join(DATA_DIR, name)
    if (!fs.statSync(dir).isDirectory()) continue
    const files = fs.readdirSync(dir)
    const frames = files.filter(f => /^frame-\d+\.(jpg|jpeg|png|webp)$/.test(f)).sort((a, b) => fileNum(a) - fileNum(b))
    if (!frames.length) continue // nothing to show
    let meta = null // stories from before transcripts were saved have no session.json
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')) } catch {}
    // bound to committed progress, a failed turn can leave orphan files behind
    const clips = files.filter(f => /^clip-\d+\.mp4$/.test(f) && (!meta || fileNum(f) < meta.turn))
    const frame = meta && files.includes(meta.frame) ? meta.frame : frames[frames.length - 1]
    out.push({
      id: name,
      frameUrl: toUrl(path.join(dir, frame)),
      clips: clips.length,
      context: meta?.context || null,
      resumable: !!meta,
    })
  }
  return out.sort((a, b) => Number(b.id) - Number(a.id))
}

// load a saved story from disk as the active session so the player can resume it
export function loadStory(id) {
  const dir = storyDir(id)
  return exclusive(async () => {
    const file = path.join(dir, 'session.json')
    if (!fs.existsSync(file)) throw new Error('story has no saved transcript, it cannot be resumed')
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    // validate the saved shape fully before touching global state
    if (!Number.isInteger(d.turn) || d.turn < 0 ||
        typeof d.frame !== 'string' || !/^frame-\d+\.(jpg|jpeg|png|webp)$/.test(d.frame) ||
        (d.clip != null && (typeof d.clip !== 'string' || !/^clip-\d+\.mp4$/.test(d.clip))) ||
        !Array.isArray(d.messages) || !Array.isArray(d.choices) || typeof d.loopPrompt !== 'string' ||
        !d.choices.every(c => typeof c?.label === 'string' && typeof c?.prompt === 'string' && Number.isInteger(c?.duration))) {
      throw new Error('saved transcript is corrupt')
    }
    const isFile = f => fs.existsSync(f) && fs.statSync(f).isFile()
    const s = {
      dir,
      turn: d.turn,
      frame: path.join(dir, d.frame),
      context: d.context,
      player: d.player,
      character: d.character,
      scenePrompt: d.scenePrompt,
      messages: d.messages,
      choices: d.choices,
      loopPrompt: d.loopPrompt,
      loaded: true, // marks the saved clip as historical so resync won't replay it
    }
    if (!isFile(s.frame)) throw new Error('story frame is missing on disk')
    if (d.clip && isFile(path.join(dir, d.clip))) {
      s.clip = path.join(dir, d.clip)
      s.clipPrompt = d.clipPrompt
      s.clipDuration = d.clipDuration
    }
    // everything checked out, publish as the active session
    session = s
    pendingStart = null
    pendingRender = null
    token++
    dropIdleLoop()
    // reuse the idle loop already rendered for this frame instead of paying again
    const loopFile = path.join(dir, `loop-${s.turn}.mp4`)
    if (fs.existsSync(loopFile)) idleLoop = { token, url: toUrl(loopFile) }
    return { frameUrl: toUrl(s.frame), choices: s.choices.map(c => c.label), token }
  })
}

// permanently delete a saved story directory
export async function deleteStory(id) {
  const dir = storyDir(id)
  if (session?.dir === dir || pendingStart?.dir === dir) throw new Error('story is currently being played, restart first')
  if (renders.has(id)) throw new Error('story is being rendered, wait for it to finish')
  if (!fs.existsSync(dir)) throw new Error('story not found')
  fs.rmSync(dir, { recursive: true, force: true })
  return { ok: true }
}

const renders = new Map() // per-story render chain, serializes concurrent requests

// stitch a story's main clips (loops excluded) into one downloadable mp4
export function renderStory(id) {
  const dir = storyDir(id)
  // run after any in-flight render for this story, then recheck freshness,
  // so a request made after a newer clip lands never gets a stale snapshot
  const prev = renders.get(id) || Promise.resolve()
  const p = prev.catch(() => {}).then(async () => {
    if (!fs.existsSync(dir)) throw new Error('story not found')
    const metaFile = path.join(dir, 'session.json')
    let meta = null // committed progress bound, a failed turn can leave an orphan clip
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) } catch {}
    const started = Date.now() // clip list snapshot moment
    const clips = fs.readdirSync(dir)
      .filter(f => /^clip-\d+\.mp4$/.test(f) && (!meta || fileNum(f) < meta.turn))
      .sort((a, b) => fileNum(a) - fileNum(b))
      .map(f => path.join(dir, f))
    if (!clips.length) throw new Error('story has no clips to render')
    const out = path.join(dir, 'story.mp4')
    // reuse a previous render unless a newer clip or commit has landed since;
    // the commit check catches a clip excluded because its turn was still mid-save
    let newest = Math.max(...clips.map(f => fs.statSync(f).mtimeMs))
    if (meta) try { newest = Math.max(newest, fs.statSync(metaFile).mtimeMs) } catch {}
    if (!fs.existsSync(out) || fs.statSync(out).mtimeMs <= newest) {
      await concatClips(clips, out)
      fs.utimesSync(out, new Date(started), new Date(started)) // a clip landing mid-render still reads as newer
    }
    return { url: `${toUrl(out)}?v=${fs.statSync(out).mtimeMs}` } // versioned, the browser must not serve a stale cached render
  }).finally(() => { if (renders.get(id) === p) renders.delete(id) })
  renders.set(id, p)
  return p
}
