import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatChoices, startScene, customChoice, writeLoopPrompt, parseChoices, getLlmSettings, getSettings } from './llm.js'
import { submitJob, awaitJob, submitImageJob, awaitImageJob, cancelJob } from './fal.js'
import { extractLastFrame, concatClips, concatClipsWithChoices } from './media.js'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(ROOT, 'data')

// build the game master system prompt around the fleshed-out player character description
function systemPrompt(character) {
  return `You are the game master of a video-rendered RPG. The player never reads your text; they only watch generated video clips. Your responses are consumed by a program that feeds them to a video generation model.

The player controls one character in the story. Their appearance: ${character}

Each turn you receive the player's chosen action plus an image of the frame where the story currently stands. Respond with ONLY a JSON object (no markdown fences, no commentary) offering 2-3 choices:
{"choices": [{"label": "...", "prompt": "...", "duration": 8, "loop-prompt": "..."}]}

Sometimes a user message will instead ask you to turn the player's own typed idea into a single choice, or to write an idle loop prompt for the current frame. Respond then with ONLY the JSON object that message asks for.

## Fields

"label" is a short action the player's character can take, e.g. "Eat the sandwich" or "Say: \\"What are you doing here?\\"".

"prompt" describes a video clip starting from the current frame. The video model sees only the start keyframe and your prompt, nothing else, so each prompt must be self-contained: re-describe anything not visible in the frame, and refer to characters by appearance, never by name or story role (for the player's character, reuse the appearance above). If a character is off-screen, re-describe them and describe how they enter the scene.

"duration" is the clip length in seconds, an integer from 8 to 15.

"loop-prompt" is a prompt for a 5-second idle animation of that choice's end state, shown looping while the player picks their next option. It continues whatever repeatable action the end state leaves the characters doing: if they're walking against a repeatable background, keep them walking; if a character is typing, keep them typing. Use natural, loopable actions that don't make it obvious a loop is occurring. Loops may also be action scenes, not just idle rote actions, as long as the net result over the 5 seconds is "nothing was achieved overall, nothing truly progressed" - the loop must never advance the story. It's rendered from the clip's real last frame as both start and end keyframe, and like a clip prompt it must be self-contained: re-describe characters by appearance. The camera stays roughly still and the animation ends with everything back exactly at its starting pose so it loops seamlessly.

Because of the loop, consider the loopability of what the characters are doing in the end state of each prompt; make sure the end state is configured so that the characters are doing something that's loopable. For example, if a character is walking into a building and the clip ends around the character opening the door and entering, make sure the end state has the camera perspective viewing the character in an angle such that the background is loopable; maybe a side view as they enter the building, relatively close-up, so that they can continue walking and background elements can continue repeating.

## How to make good choices for the player to pick

Make the story interesting and fun; be creative. Keep the story progressing - pace it properly. Not too slow, not too fast. If the scene is starting to lull / there's no particularly interesting options left, make the third option be something that cuts away from the current scene and skips to later in a different setting and time and context.

Scenes can span many turns, each turn only needs to cover a portion of the scene. Pace the scenes. For example, in action scenes, you might let them run across many turns, with the player making executive decisions throughout.

The world around the player should have agency; the player's choice is only what they WANT to do, not necessarily what will always succeed. Sometimes things can occur even completely unrelated to what the player was trying to do.
  * Example: the player might choose an option labeled "Take the elevator", but then hidden inside that option is a prompt to reveal that once the doors close, the dude inside the elevator with the player starts creeping on them.
  * Another example: the player might choose an option in the middle of some cooking scene like "Baste the steak", but then hidden inside that option is a prompt for someone to run in while the player bastes the steak to deliver news to them - maybe that someone wants to talk to them. Or, maybe suddenly a customer starts shrieking in the dining area.

Regardless of what you can choose, you can see how making things unpredictable OUTSIDE of what the player would expect according to the labels on each option makes the world feel more interactive and full.

REMEMBER: the player CANNOT SEE THE PROMPT FIELD for each choice, ONLY THE LABEL. So ALL THE UNPREDICTABILITY SHOULD LIVE IN THE PROMPT FIELD, NOT THE LABEL. You may also make multiple choices *all* have the same unpredictable outcome; for example, the cook may have two options to "Keep cooking the steak, it's not ready" vs. "Plate the steak, it's ready" in the middle of cooking, and BOTH choices have someone run in and tell the cook about someone in the dining area being unsatisfied with their steak and wanting to talk with the cook; the event may occur regardless of which choice the cook makes. *YOU HAVE THE CHOICE* on it. Not making a surprise event forced is TOTALLY OKAY TOO - for example, maybe someone only runs in to talk to the cook if he keeps cooking, but if he chooses to plate the steak and get onto the next, then nothing happens. This is NOT to imply that continuing to cook the steak caused something to happen; it's purely simply "random chance" - on top of you randomly deciding if events happen at all, there's another layer of randomness in which options may be "poisoned" with unexpected events (could be none, could be some, could be all).

BUT: DO NOT force "agency" in the world if it isn't natural. Too many unexpected encounters in the world will make it feel unnatural. The player should do be able to do roughly half of their intended actions successfully; it should essentially be a coin toss on if something unexpected happens, except heavily biased towards expected success when the expected route is very natural. Don't force agency for the sake of agency and turn every action into an unexpected event.

MOST IMPORTANTLY: make sure that the events depicted throughout the entire story are REALISTIC and GROUNDED IN REALITY. Do NOT let the story randomly drift towards novelty sludge - that is, don't just say something like "and then there was an evil vampire secretly watching him from behind...", it's cheap. Keep the story focused and grounded, flesh out specific arcs rather than picking a bit of something for every possible topic, make creative grounded choices rather than random "crazy" choices.

Example response (player character: a tall young man with short brown hair in a gray hoodie; frame: him at dinner with his girlfriend, a sandwich on her plate - labels may use story knowledge, prompts may not):
  * {"choices": [{"label": "Eat your girlfriend's sandwich", "prompt": "The man in the gray hoodie sitting at the table picks up the half-eaten sandwich from the woman's plate and eats it. A crunch sound plays as the sandwich is consumed. She glares at him, annoyed, and says <d>[English] Would you stop eating my food? Ugh...</d>. End state: the sandwich is completely gone from her plate and she sits glaring at the man in the gray hoodie.", "duration": 8, "loop-prompt": "The man in the gray hoodie sits at the restaurant table chewing slowly, avoiding eye contact with the woman across from him, who glares at him with her arms crossed, occasionally blinking. The camera stays still and both end back exactly at their starting poses."}, {"label": "Call the waiter over", "prompt": "The man in the gray hoodie sitting at the table raises his hand and beckons at a waiter who is currently off-screen; the camera pans to the waiter, who looks like a middle-aged man in the white apron, ignoring the call of the man in the gray hoodie. The man in the gray hoodie laughs it off and gives up, slightly embarrassed. End state: the man is looking away from the woman up at nothing, trying to casually play it off, while the woman looks unimpressed.", "duration": 8, "loop-prompt": "The man in the gray hoodie sits at the restaurant table looking away from the woman, idly glancing around the room; the woman watches him unimpressed, lightly tapping her fingers on the table. The camera stays still and both end back exactly at their starting poses."}]}`
}

let session = null // single in-memory session
let token = 0 // monotonically increasing turn token, never reused across sessions
let busy = false
let pendingRender = null // finished render awaiting a successful llm turn, avoids re-billing on retry
let pendingStart = null // finished opening frame awaiting a successful llm turn, avoids regenerating on retry

let resetInFlight = null // dedupes overlapping resets and blocks new game ops from overtaking one

let idleLoop = null // this turn's 5s idle loop render, best-effort

let navClip = null // clip replayed by the last continue, keyed by token, so a lost response can still replay it

let progress = null // weighted pipeline progress for the client loading bar

// begin tracking a pipeline, weights are rough seconds per step
function progressStart(weights) {
  progress = { weights, step: 0, t: Date.now() }
}

// mark the current step done and start timing the next
function progressStep() {
  if (progress) { progress.step++; progress.t = Date.now() }
}

let turnTimes = null // named step durations of the last finished pipeline, for the dev panel
let timesDraft = null // steps collected by the running pipeline

// begin collecting step times for a pipeline run, returns the steps array;
// passing a pending entry's array resumes it, so a retry keeps the times of steps it reuses
function timeStart(steps = []) {
  timesDraft = steps
  return steps
}

// run fn and record its duration as a named step in the running pipeline's draft
async function timed(name, fn) {
  const t = Date.now()
  const out = await fn()
  timesDraft?.push({ name, secs: (Date.now() - t) / 1000 })
  return out
}

// publish the draft as the last pipeline's times, total is the sum of its steps
function timeEnd() {
  if (timesDraft) turnTimes = { total: timesDraft.reduce((a, s) => a + s.secs, 0), steps: timesDraft }
  timesDraft = null
}

// forget the current idle loop, best-effort canceling a still-running render
function dropIdleLoop() {
  if (idleLoop && !idleLoop.url && !idleLoop.failed) {
    idleLoop.aborted = true // tells a submit still in flight to cancel on arrival
    cancelJob(idleLoop.job)
  }
  idleLoop = null
}

// render a 5s idle loop of a frame, best-effort, returns a never-rejecting promise
// s carries dir, turn (names the loop file), frame, loopPrompt, cost; a session object fits directly
function startIdleLoopRender(s, tok) {
  if (!getSettings().loops) { failIdleLoop(tok); return Promise.resolve() } // loops disabled, don't pay for the render
  // a real render (even a failed one) for this turn is reused so nothing resubmits;
  // promise-less entries (hold/fail placeholders) and settled canceled renders are replaced
  if (idleLoop?.token === tok && idleLoop.promise && !(idleLoop.aborted && idleLoop.failed)) return idleLoop.promise
  dropIdleLoop() // a previous turn's loop still rendering is stale, cancel it
  const out = path.join(s.dir, `loop-${s.turn}.mp4`)
  const state = { token: tok, url: null, out }
  idleLoop = state
  state.promise = (async () => {
    const frameUri = toDataUri(s.frame)
    state.job = await submitJob(s.loopPrompt, frameUri, 5, frameUri) // same frame as start and end forces a closed loop
    // aborted while submitting: cancel best-effort but keep awaiting, so the entry settles
    // truthfully (url if the cancel loses, failed if it wins) and a retry can't double-submit
    if (state.aborted) cancelJob(state.job)
    await awaitJob(state.job, out, s.cost)
    state.url = toUrl(out)
  })().catch(() => { state.failed = true }) // no loop, the static frame stands; keep the entry so nothing resubmits
  return state.promise
}

// mark the turn as having no loop coming, the static frame stands
function failIdleLoop(tok) {
  dropIdleLoop()
  idleLoop = { token: tok, failed: true }
}

// wait out the current frame's idle loop render in short slices,
// so a queued reset isn't stuck behind a cosmetic render
async function awaitIdleLoop(s, tok) {
  const loopReady = startIdleLoopRender(s, tok).then(() => true)
  while (!(await Promise.race([loopReady, new Promise(r => setTimeout(r, 500))])) && !resetInFlight) {}
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
    progress = null // whatever pipeline ran is over, a stale bar must not show
  }
}

// read an image file as a base64 data uri
function toDataUri(file) {
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file).toLowerCase()]
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
}

// convert an absolute path under data/ into a servable url, versioned by mtime
// so the browser's long-lived media cache can never serve a deleted branch's file recreated under the same name
function toUrl(file) {
  const rel = '/' + path.relative(ROOT, file).split(path.sep).join('/')
  try { return `${rel}?v=${Math.trunc(fs.statSync(file).mtimeMs)}` } catch { return rel }
}

// ask the llm for the next choices given a user message with a frame attached, no mutation of s
async function nextTurn(s, text, frame, llmSettings) {
  const userMsg = {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: toDataUri(frame) } },
    ],
  }
  const { raw, choices } = await chatChoices([...s.messages.map(stripImage), userMsg], s.cost, llmSettings) // only the new frame goes out
  return { msgs: [userMsg, { role: 'assistant', content: raw }], choices }
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
// callers set s.loopPrompt themselves (baked into the picked choice, or the start call's)
function applyTurn(s, { msgs, choices }, frame, turn) {
  s.messages = [...s.messages.map(stripImage), ...msgs] // keep stored history slim, images live on disk
  s.choices = choices
  s.frame = frame
  s.turn = turn
  s.pos = turn // a fresh turn always lands at the tip of the timeline
}

// locate the frame image for a turn on disk, any known extension
function findFrame(dir, n) {
  for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
    const f = path.join(dir, `frame-${n}${ext}`)
    if (fs.existsSync(f)) return f
  }
  return null
}

let parkedLoop = null // the tip's still-running loop render, kept alive while browsing history

// whether a loop entry is a render still in flight
function loopInFlight(st) {
  return !!(st && st.promise && !st.url && !st.failed)
}

// cancel and forget the parked tip render, for resets and deletions that make it stale
function dropParkedLoop() {
  if (loopInFlight(parkedLoop)) {
    parkedLoop.aborted = true
    cancelJob(parkedLoop.job)
  }
  parkedLoop = null
}

// point the idle loop at an already-rendered loop file on disk, if present; the live tip's
// still-running render is parked (not canceled) while browsing, and re-adopted on return
function setDiskLoop(dir, turnNo) {
  const f = path.join(dir, `loop-${turnNo}.mp4`)
  if (loopInFlight(idleLoop) && idleLoop.out === f) { idleLoop.token = token; return } // already rendering this very loop
  if (loopInFlight(idleLoop) && session && idleLoop.out === path.join(session.dir, `loop-${session.turn}.mp4`)) {
    dropParkedLoop() // only one render can be parked, an older one is stale
    parkedLoop = idleLoop // the tip's render keeps going while we browse
    idleLoop = null
  }
  dropIdleLoop()
  if (parkedLoop?.failed) parkedLoop = null // the parked render failed meanwhile, forget it
  if (parkedLoop?.out === f) { // back at the parked render's frame, re-adopt it
    idleLoop = parkedLoop
    idleLoop.token = token
    parkedLoop = null
    return
  }
  if (fs.existsSync(f)) idleLoop = { token, url: toUrl(f) }
  else idleLoop = { token, failed: true } // no loop for this frame, the static frame stands
}

// client view of the current timeline position: live choices at the tip, a bare continue while browsing
function positionState(s) {
  const atTip = s.pos === s.turn
  const frame = atTip ? s.frame : findFrame(s.dir, s.pos) || s.frame
  return {
    frameUrl: toUrl(frame),
    mode: atTip ? 'choices' : 'continue',
    choices: atTip ? s.choices.map(c => c.label) : [],
    // text of a pending custom action, so the client can put it back in the box for the retry
    pendingIdea: pendingRender?.token === token && typeof pendingRender.key === 'string' ? pendingRender.key.slice('custom:'.length) : null,
  }
}

const costs = new Map() // one tracker per story dir, so a late charge from an abandoned render can't go stale

// a story's cost tracker: llm.js and fal.js bill into it, every charge persists to
// the story's cost.json immediately so no spend is lost to a failed turn or restart
function makeCost(dir) {
  if (costs.has(dir)) return costs.get(dir)
  const file = path.join(dir, 'cost.json')
  const c = { llm: 0, fal: 0 }
  try { // resume the story's spend where it left off, older stories predate cost tracking
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (typeof d.llm === 'number' && typeof d.fal === 'number') { c.llm = d.llm; c.fal = d.fal }
  } catch {}
  c.bill = (kind, amount) => {
    c[kind] += amount
    try { // best-effort, memory stays right; atomic so a crash can't leave a torn file
      fs.writeFileSync(file + '.tmp', JSON.stringify({ llm: c.llm, fal: c.fal }))
      fs.renameSync(file + '.tmp', file)
    } catch {}
  }
  costs.set(dir, c)
  return c
}

// api spend of the active story, exact for openrouter, rate-estimated for fal
function getCost() {
  const { llm, fal } = session?.cost || pendingStart?.cost || { llm: 0, fal: 0 } // cost always matches the story the rest of the state shows
  return { llm, fal, total: llm + fal }
}

// cancel in-flight idle loop renders, the loops setting was just turned off
// already-rendered loops are kept, only masked, so a re-enable can show them again
// the canceled entry is kept too: it settles on its own (url if the cancel lost the race,
// failed otherwise), and a quick re-enable reuses it instead of double-submitting its file
export function stopIdleLoops() {
  if (loopInFlight(idleLoop)) {
    idleLoop.aborted = true // a submit still in flight cancels on arrival
    cancelJob(idleLoop.job)
  }
  dropParkedLoop() // a parked tip render would be hidden spend too
}

// best-effort render the current frame's idle loop, the loops setting was just turned back on
// only the tip (or an unfinished turn's outcome frame) renders fresh; historical positions
// reuse disk loops via the getState unmask
export function resumeIdleLoop() {
  if (!session) return
  // a turn whose clip is out but whose choices failed shows its outcome frame, not the session's
  const pending = pendingRender?.turnToken === token ? pendingRender : null
  if (!pending && (session.pos !== session.turn || !session.loopPrompt)) return
  const cur = idleLoop
  if (cur?.token === token && !cur.failed) {
    // a canceled render still settling is reused; if the cancel wins, retry so the loop still arrives
    if (cur.aborted && cur.promise) cur.promise.then(() => {
      if (idleLoop === cur && cur.failed && getSettings().loops) resumeIdleLoop()
    })
    return
  }
  const turnNo = pending ? session.turn + 1 : session.turn
  const f = path.join(session.dir, `loop-${turnNo}.mp4`)
  if (fs.existsSync(f)) { idleLoop = { token, url: toUrl(f) }; return } // already on disk
  if (pending) {
    if (pending.choice['loop-prompt']) startIdleLoopRender({ dir: session.dir, turn: turnNo, frame: pending.frame, loopPrompt: pending.choice['loop-prompt'], cost: session.cost }, token)
    return // a choice without a loop prompt (old save) stays on the static frame
  }
  startIdleLoopRender(session, token)
}

// whether a game operation is running, settings changes are rejected meanwhile
// so one turn can't mix two models or efforts across its llm calls
export function isBusy() {
  return busy || !!resetInFlight
}

// snapshot of the current session so the client can resync after a lost response
export function getState() {
  const settling = busy || resetInFlight !== null // a queued reset counts as busy
  // weighted step progress of the running pipeline, for the client loading bar
  const prog = busy && progress
    ? { weights: progress.weights, step: progress.step, elapsed: (Date.now() - progress.t) / 1000 }
    : null
  if (!session) return { active: false, busy: settling, cost: getCost(), progress: prog }
  // a turn whose clip is out but whose choices are still being written (or failed) overlays the tip
  const pending = pendingRender?.turnToken === token ? pendingRender : null
  return {
    active: true,
    busy: settling,
    token,
    ...(pending
      ? { frameUrl: toUrl(pending.frame), mode: 'pending', choices: [], turnError: pending.error || null, pendingIdea: null,
          thinkingElapsed: pending.thinkingAt ? (Date.now() - pending.thinkingAt) / 1000 : 0 } // how far the choices llm already got, for the thinking bar
      : positionState(session)), // frameUrl, mode, choices for the current position
    // a just-continued clip replays even off-tip, otherwise clip replay only makes sense at the tip
    clipUrl: pending ? toUrl(pending.clip) : (navClip?.token === token ? navClip.url : null) ||
      (session.pos === session.turn && session.clip ? toUrl(session.clip) : null),
    // historical clip of a resumed story, not a missed turn; a pending clip replays only on a lost response
    loadedClip: pending || navClip?.token === token ? false : !!(session.clip && session.loaded),
    // loops disabled masks even an already-rendered loop, the static frame stands
    loopUrl: getSettings().loops && idleLoop?.token === token ? idleLoop.url : null, // current frame's idle loop, if ready
    loopFailed: !getSettings().loops || (idleLoop?.token === token ? !!idleLoop.failed : true), // no loop coming, stop waiting
    cost: getCost(),
    progress: prog,
  }
}

// loop prompt behind frame k: baked into the choice picked at turn k-1 (whose clip
// rendered into frame k), falling back to the legacy top-level loop-prompt of turn k's message
function frameLoopPrompt(s, k) {
  const own = s.messages[2 + 2 * k]?.content
  const legacy = typeof own === 'string' ? parseChoices(own)?.loopPrompt || null : null
  if (k < 1) return legacy
  const m = s.messages[3 + 2 * (k - 1)] // user message holding turn k-1's pick
  const text = Array.isArray(m?.content) ? m.content.find(p => p.type === 'text')?.text : m?.content
  if (typeof text !== 'string') return legacy
  if (text.startsWith('Choose custom action: ')) { // a custom action's loop prompt lives in the user message itself
    const match = text.match(/\nIts idle loop prompt: ([\s\S]*?)\nAttached image/)
    return match?.[1] || legacy
  }
  const raw = s.messages[2 + 2 * (k - 1)]?.content // assistant response offering turn k-1's choices
  const parsed = typeof raw === 'string' ? parseChoices(raw) : null
  const picked = parsed?.choices.find(c => c.label === chosenLabel(s, k - 1))
  return picked?.['loop-prompt'] || legacy
}

// prompts behind the current position for the dev panel
export function getDebug() {
  if (!session) return { active: false }
  const atTip = session.pos === session.turn
  // at a historical position the prompts come from that turn's saved assistant message
  const parsed = atTip ? null : parseChoices(session.messages[2 + 2 * session.pos]?.content || '')
  return {
    active: true,
    token,
    scenePrompt: session.scenePrompt,
    clipPrompt: atTip ? session.clipPrompt || null : null, // a historical clip's prompt isn't tracked
    clipDuration: atTip ? session.clipDuration || null : null,
    loopPrompt: atTip ? session.loopPrompt || null : frameLoopPrompt(session, session.pos),
    choices: atTip ? session.choices : parsed?.choices || [],
    times: turnTimes, // step durations of the last finished generation
  }
}

// start a new game from the player's context and character, returns the opening frame and choices
export function startGame(context, player) {
  return exclusive(async () => {
    // reuse the paid steps of a previous attempt if this is a retry of the same start
    if (pendingStart?.context !== context || pendingStart?.player !== player) {
      const dir = path.join(DATA_DIR, String(Date.now()))
      fs.mkdirSync(dir, { recursive: true })
      pendingStart = { context, player, dir, cost: makeCost(dir), llmSettings: getLlmSettings(), times: [] } // tracker and llm snapshot exist before the first paid call
    }
    const loops = getSettings().loops // one snapshot per attempt, settings are locked while busy
    progressStart(loops ? [8, 20, 10, 3, 15] : [8, 20, 10]) // scene write, image gen, first turn llm, then loop llm + idle loop render when loops are on
    timeStart(pendingStart.times) // a retry keeps the reused steps' times
    // flesh out the character and write the opening frame prompt before paying for the image
    if (!pendingStart.scene) Object.assign(pendingStart, await timed('scene llm', () => startScene(context, player, pendingStart.cost, pendingStart.llmSettings)))
    progressStep() // scene written
    const { dir, character, scene } = pendingStart
    if (!pendingStart.frame) {
      await timed('frame image', async () => {
        if (!pendingStart.job) pendingStart.job = await submitImageJob(scene)
        try {
          pendingStart.frame = await awaitImageJob(pendingStart.job, path.join(dir, 'frame-0'), pendingStart.cost)
        } catch (err) {
          if (err.terminal) pendingStart.job = null // job itself failed, a retry resubmits it but keeps the paid steps
          throw err
        }
      })
    }
    progressStep() // opening frame ready
    const frame = pendingStart.frame
    const candidate = { dir, turn: 0, frame, context, player, character, scenePrompt: scene, cost: pendingStart.cost, messages: [{ role: 'system', content: systemPrompt(character) }], choices: [] }
    const turn = await timed('choices llm', () => nextTurn(candidate, `Start a new game. The player's starting context: ${context}\nAttached image is the opening frame of the game.`, frame, pendingStart.llmSettings))
    progressStep() // choices llm done
    applyTurn(candidate, turn, frame, 0)
    // separate quick reasoning-off call writes the opening idle loop prompt, best-effort; skipped when loops are off
    candidate.loopPrompt = loops ? await timed('loop llm', () =>
      writeLoopPrompt(candidate.messages.map(stripImage), toDataUri(frame), pendingStart.cost, pendingStart.llmSettings)).catch(() => null) : null
    progressStep() // loop prompt written, only the idle loop render remains
    saveSession(candidate) // persist first so a failed save fails the start cleanly, memory untouched
    session = candidate // replace any previous game only once the opening turn succeeded
    dropParkedLoop() // a parked render of a replaced game is stale
    token++
    // hold the start until the opening frame's idle loop is rendered, so the first
    // thing the player sees is the scene in motion, never the static frame
    // (this also drops a replaced game's still-rendering loop)
    if (session.loopPrompt) await timed('loop render', () => awaitIdleLoop(session, token))
    else failIdleLoop(token) // no loop prompt, the static frame stands
    pendingStart = null
    timeEnd()
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
      navClip = null
      turnTimes = null // the old game's times must not show under a new one
      dropIdleLoop() // the turn that was in flight may have started another one meanwhile
      dropParkedLoop() // a parked tip render belongs to the abandoned game too
    }, true).finally(() => { resetInFlight = null })
  }
  return resetInFlight
}

// common guards for advancing the story with a new choice
function checkAtTip(clientToken) {
  if (!session) throw new Error('no active game')
  if (clientToken !== token) throw new Error('stale turn, the game has already advanced')
  if (session.pos !== session.turn) throw new Error('not at the end of the timeline, continue or delete forward history first')
}

// run a turn fn under the busy flag, resolving as soon as it responds with the rendered
// clip; the fn keeps running in the background to finish the llm work and commit
function runTurn(fn) {
  return new Promise((resolve, reject) => {
    let responded = false
    const respond = v => { responded = true; resolve(v) }
    exclusive(() => fn(respond)).catch(err => {
      if (!responded) reject(err) // before the clip is out the request fails normally
      else console.error(err) // after, the error is kept on pendingRender for the client to retry
    })
  })
}

// phase one of a turn, shared by preset and custom picks: render the picked choice's
// clip and respond so it starts playing, then finish the llm work in the background
// expects pendingRender to hold the choice to render
async function commitChoice(choice, custom, respond) {
  const clip = path.join(session.dir, `clip-${session.turn}.mp4`)
  const frame = path.join(session.dir, `frame-${session.turn + 1}.jpg`)
  if (!pendingRender.done) {
    await timed('clip render', async () => {
      if (!pendingRender.job) pendingRender.job = await submitJob(choice.prompt, toDataUri(session.frame), choice.duration)
      try {
        await awaitJob(pendingRender.job, clip, session.cost)
      } catch (err) {
        if (err.terminal) pendingRender.job = null // job itself failed, a retry resubmits it but keeps the choice
        throw err
      }
      await extractLastFrame(clip, frame)
    })
    pendingRender.done = true
  }
  pendingRender.clip = clip
  pendingRender.frame = frame
  // the clip is out: new token, the client plays it while the llm work runs behind it
  if (pendingRender.turnToken !== token) {
    token++
    pendingRender.turnToken = token
    pendingRender.token = token // keep the reuse guards valid under the new token
    // the loop prompt is baked into the choice, so its render starts right away, best-effort
    if (choice['loop-prompt']) startIdleLoopRender({ dir: session.dir, turn: session.turn + 1, frame, loopPrompt: choice['loop-prompt'], cost: session.cost }, token)
    else failIdleLoop(token) // a choice from an old save has no loop prompt, the static frame stands
  }
  progress = null // the visible wait is over, the client's thinking spinner takes it from here
  respond({ clipUrl: toUrl(clip), frameUrl: toUrl(frame), token, pending: true })
  await finishTurn(choice, custom)
}

// phase two of a turn: generate the next choices, then commit; also run directly by a retry
// the loop render is already going, kicked off by commitChoice from the choice's baked prompt
async function finishTurn(choice, custom) {
  const s = session
  const frame = pendingRender.frame
  pendingRender.thinkingAt = Date.now() // choices generation starts now, drives the client's thinking bar (a retry restarts it)
  pendingRender.error = null // a retry clears the previous failure
  try {
    // a finished choices call is cached so a save failure's retry doesn't pay for it again
    if (!pendingRender.next) {
      // a custom choice's prompt lives nowhere in the transcript, so carry it in the user message;
      // preset prompts are already in the preceding assistant message
      const text = custom
        ? `Choose custom action: ${choice.label}\nThe action was rendered from this clip prompt: ${choice.prompt}\nIts idle loop prompt: ${choice['loop-prompt']}\nAttached image is the last frame of where this chosen action left off.`
        : `Choose option: ${choice.label}\nAttached image is the last frame of where this chosen action left off.`
      pendingRender.next = await timed('choices llm', () => nextTurn(s, text, frame, pendingRender.llmSettings))
    }
    const next = pendingRender.next
    // stage the committed state on a copy and persist it before publishing in memory,
    // so a failed disk save leaves the turn cleanly retryable
    const committed = { ...s }
    applyTurn(committed, next, frame, s.turn + 1)
    committed.loopPrompt = choice['loop-prompt'] || null
    committed.loaded = false // this clip is newly committed, resync may replay it
    committed.clip = pendingRender.clip
    committed.clipPrompt = choice.prompt
    committed.clipDuration = choice.duration
    saveSession(committed)
    session = committed
    pendingRender = null
    timeEnd()
    return { frameUrl: toUrl(frame), choices: next.choices.map(c => c.label), mode: 'choices', token }
  } catch (err) {
    pendingRender.error = err.message || 'turn failed' // polled up by the client, which offers a retry
    throw err
  }
}

// re-run the unfinished llm half of a turn whose clip is already out, blocking until committed
export function retryTurn(clientToken) {
  return exclusive(async () => {
    if (!session) throw new Error('no active game')
    if (clientToken !== token) throw new Error('stale turn, the game has already advanced')
    if (pendingRender?.turnToken !== token) throw new Error('no unfinished turn to retry')
    timeStart(pendingRender.times) // keep the finished steps' times
    return finishTurn(pendingRender.choice, typeof pendingRender.key === 'string')
  })
}

// advance the game with the chosen option, responds with the rendered clip while the
// next choices generate in the background
export function chooseOption(index, clientToken) {
  return runTurn(async respond => {
    checkAtTip(clientToken)
    if (!Number.isInteger(index) || !session.choices[index]) throw new Error('invalid choice index')
    const choice = session.choices[index]
    // reuse the submitted job or finished render on retry instead of paying for another;
    // a job-less entry is a terminal render failure, any other choice may replace it
    if (pendingRender?.token === token && pendingRender.key !== index && pendingRender.job) {
      throw new Error(`a render for "${pendingRender.choice.label}" is already pending, retry that choice`)
    }
    if (pendingRender?.token !== token || pendingRender.key !== index) pendingRender = { token, key: index, choice, done: false, llmSettings: getLlmSettings(), times: [] }
    progressStart([1.1 * choice.duration]) // only the clip render is a visible wait now
    timeStart(pendingRender.times) // a retry keeps the reused steps' times
    await commitChoice(pendingRender.choice, false, respond)
  })
}

// advance the game with a choice the llm writes from the player's own idea
export function chooseCustom(text, clientToken) {
  return runTurn(async respond => {
    checkAtTip(clientToken)
    const key = `custom:${text}`
    // reuse the generated choice and submitted job on retry instead of paying again;
    // a job-less entry is a terminal render failure, any other choice may replace it
    if (pendingRender?.token === token && pendingRender.key !== key && pendingRender.job) {
      throw new Error(`a render for "${pendingRender.choice.label}" is already pending, retry that choice`)
    }
    if (pendingRender?.token !== token || pendingRender.key !== key) {
      progressStart([8, 13]) // action write, clip render (weight refined below)
      const times = timeStart()
      const llmSettings = getLlmSettings() // one snapshot writes the custom action and the following choices, including retries
      // the llm takes inspiration from the idea and writes a proper self-contained choice,
      // cached before the render submit so a submit failure never repeats the paid llm call
      const choice = await timed('action llm', () => customChoice(session.messages.map(stripImage), text, toDataUri(session.frame), session.cost, llmSettings))
      pendingRender = { token, key, choice, done: false, llmSettings, times }
      progress.weights[1] = 1.1 * choice.duration // the real clip length is now known
      progressStep() // action written
    } else {
      progressStart([1.1 * pendingRender.choice.duration]) // retry skips the write
      timeStart(pendingRender.times) // a retry keeps the reused steps' times
    }
    await commitChoice(pendingRender.choice, true, respond)
  })
}

// label of the choice taken at a turn, parsed from the following user message
function chosenLabel(s, k) {
  const m = s.messages[3 + 2 * k] // [system, user0, asst0, user1, ...], user k+1 holds turn k's pick
  const text = Array.isArray(m?.content) ? m.content.find(p => p.type === 'text')?.text : m?.content
  const match = typeof text === 'string' ? text.match(/^Choose (?:custom action|option): (.*)/) : null
  return match ? match[1] : null
}

// timeline of the active story: one point per turn with its frame and the choice taken there
export function getTimeline() {
  if (!session) return { active: false }
  const points = []
  for (let k = 0; k <= session.turn; k++) {
    const frame = findFrame(session.dir, k)
    points.push({ turn: k, frameUrl: frame ? toUrl(frame) : null, label: chosenLabel(session, k) })
  }
  return { active: true, token, pos: session.pos, turn: session.turn, points }
}

// move the viewing position to a turn on the timeline without changing history
export function seekTurn(turnNo, clientToken) {
  return exclusive(async () => {
    if (!session) throw new Error('no active game')
    if (clientToken !== token) throw new Error('stale turn, the game has already advanced')
    if (!Number.isInteger(turnNo) || turnNo < 0 || turnNo > session.turn) throw new Error('invalid turn')
    if (turnNo !== session.turn && !findFrame(session.dir, turnNo)) throw new Error('frame missing on disk for that turn')
    session.pos = turnNo
    session.loaded = true // navigation makes the tip clip historical, a lost-response resync must not replay it
    retagPending(token + 1) // the tip's paid pending render must survive browsing
    token++
    setDiskLoop(session.dir, turnNo)
    return { ...positionState(session), token }
  })
}

// carry a current pending render across a token bump, pure position changes must not strand a paid job
function retagPending(newToken) {
  if (pendingRender?.token === token) pendingRender.token = newToken
}

// step one turn forward along the already-rendered canonical timeline, free
export function continueStory(clientToken) {
  return exclusive(async () => {
    if (!session) throw new Error('no active game')
    if (clientToken !== token) throw new Error('stale turn, the game has already advanced')
    if (session.pos >= session.turn) throw new Error('already at the end of the timeline')
    const clip = path.join(session.dir, `clip-${session.pos}.mp4`)
    if (!fs.existsSync(clip)) throw new Error('clip missing on disk')
    if (session.pos + 1 !== session.turn && !findFrame(session.dir, session.pos + 1)) throw new Error('frame missing on disk for that turn')
    session.pos++
    session.loaded = true // navigation makes the tip clip historical, a lost-response resync must not replay it
    retagPending(token + 1) // the tip's paid pending render must survive browsing
    token++
    setDiskLoop(session.dir, session.pos)
    navClip = { token, url: toUrl(clip) } // a lost response can still replay this step's clip via resync
    return { clipUrl: toUrl(clip), ...positionState(session), token }
  })
}

// delete every turn after the given one, making it the live tip with its original choices
export function truncateStory(turnNo, clientToken) {
  return exclusive(async () => {
    if (!session) throw new Error('no active game')
    if (clientToken !== token) throw new Error('stale turn, the game has already advanced')
    if (!Number.isInteger(turnNo) || turnNo < 0 || turnNo > session.turn) throw new Error('invalid turn')
    if (renders.has(path.basename(session.dir))) throw new Error('story is being rendered, wait for it to finish')
    if (turnNo === session.turn) { // nothing after the tip, just land there
      session.pos = turnNo
      retagPending(token + 1) // nothing was deleted, the tip's pending render stays valid
      token++
      setDiskLoop(session.dir, turnNo)
      return { ...positionState(session), token }
    }
    const raw = session.messages[2 + 2 * turnNo]?.content // assistant response that offered this turn's choices
    const parsed = typeof raw === 'string' ? parseChoices(raw) : null
    if (!parsed) throw new Error('cannot restore the choices at that turn')
    const frame = findFrame(session.dir, turnNo)
    if (!frame) throw new Error('frame missing on disk for that turn')
    // stage on a copy and persist before publishing, so a failed save leaves history untouched
    const committed = { ...session }
    committed.messages = session.messages.slice(0, 3 + 2 * turnNo) // keep through this turn's assistant response
    committed.choices = parsed.choices
    committed.loopPrompt = frameLoopPrompt(committed, turnNo) // the prompt behind this turn's frame, cosmetic
    committed.turn = turnNo
    committed.pos = turnNo
    committed.frame = frame
    committed.loaded = true // the clip into this turn is historical, resync must not replay it
    const clip = turnNo > 0 ? path.join(session.dir, `clip-${turnNo - 1}.mp4`) : null
    committed.clip = clip && fs.existsSync(clip) ? clip : null
    committed.clipPrompt = null // the prompt behind a historical clip isn't recoverable, dev panel goes without
    committed.clipDuration = null
    saveSession(committed)
    session = committed
    // any cached render belongs to the deleted future, cancel a still-running job
    if (pendingRender?.token === token && pendingRender.job && !pendingRender.done) cancelJob(pendingRender.job)
    pendingRender = null
    dropParkedLoop() // a parked render targets a deleted turn's loop
    token++
    // remove the now-orphaned files of the deleted turns; clip-k leads out of turn k so >= goes
    for (const name of fs.readdirSync(session.dir)) {
      const m = name.match(/^(frame|clip|loop)-(\d+)\.\w+$/)
      const cut = m && (m[1] === 'clip' ? parseInt(m[2]) >= turnNo : parseInt(m[2]) > turnNo)
      if (cut || name === 'story.mp4' || name === 'story-choices.mp4') fs.rmSync(path.join(session.dir, name), { force: true }) // stitched renders are stale too
    }
    setDiskLoop(session.dir, turnNo)
    return { ...positionState(session), token }
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
        !Array.isArray(d.messages) || !Array.isArray(d.choices) || (d.loopPrompt != null && typeof d.loopPrompt !== 'string') ||
        !d.choices.every(c => typeof c?.label === 'string' && typeof c?.prompt === 'string' && Number.isInteger(c?.duration))) {
      throw new Error('saved transcript is corrupt')
    }
    const isFile = f => fs.existsSync(f) && fs.statSync(f).isFile()
    const s = {
      dir,
      turn: d.turn,
      pos: d.turn, // a resumed story always opens at the tip
      frame: path.join(dir, d.frame),
      context: d.context,
      player: d.player,
      character: d.character,
      scenePrompt: d.scenePrompt,
      messages: d.messages,
      choices: d.choices,
      loopPrompt: d.loopPrompt || null,
      cost: makeCost(dir), // resumes the story's persisted spend
      loaded: true, // marks the saved clip as historical so resync won't replay it
    }
    // refresh the saved system prompt to the current contract, older saves predate schema changes
    if (typeof d.character === 'string' && d.character && s.messages[0]?.role === 'system') {
      s.messages = [{ role: 'system', content: systemPrompt(d.character) }, ...s.messages.slice(1)]
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
    turnTimes = null // a resumed story has no last generation to show times for
    dropParkedLoop() // a parked render of a replaced game is stale
    token++
    setDiskLoop(dir, s.turn) // reuse the idle loop already rendered for this frame instead of paying again
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
  costs.delete(dir) // a deleted story's spend is gone with it
  return { ok: true }
}

const renders = new Map() // per-story render chain, serializes concurrent requests

// per-clip choice ui specs for the overlay render, reconstructed from the saved transcript;
// a clip whose turn can't be parsed gets null and renders bare
function choiceOverlays(meta, clips) {
  return clips.map(f => {
    const k = fileNum(path.basename(f)) // clip-k leads out of turn k
    const raw = meta.messages[2 + 2 * k]?.content // assistant response that offered turn k's choices
    const parsed = typeof raw === 'string' ? parseChoices(raw) : null
    if (!parsed) return null
    const labels = parsed.choices.map(c => c.label)
    const m = meta.messages[3 + 2 * k] // following user message holds the pick
    const text = Array.isArray(m?.content) ? m.content.find(p => p.type === 'text')?.text : m?.content
    const match = typeof text === 'string' ? text.match(/^Choose (?:custom action|option): (.*)/) : null
    if (!match) return null
    let picked = labels.indexOf(match[1])
    if (picked < 0) { labels.push(match[1]); picked = labels.length - 1 } // custom action, shown as an extra option
    return { labels, picked }
  })
}

// stitch a story's main clips (loops excluded) into one downloadable mp4;
// withChoices overlays each turn's options ui at its clip's start, picked one highlighted
export function renderStory(id, withChoices = false) {
  const dir = storyDir(id)
  // run after any in-flight render for this story, then recheck freshness,
  // so a request made after a newer clip lands never gets a stale snapshot
  const prev = renders.get(id) || Promise.resolve()
  const p = prev.catch(() => {}).then(async () => {
    if (!fs.existsSync(dir)) throw new Error('story not found')
    const metaFile = path.join(dir, 'session.json')
    let meta = null // committed progress bound, a failed turn can leave an orphan clip
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) } catch {}
    if (withChoices && !Array.isArray(meta?.messages)) throw new Error('story has no saved transcript, the choices cannot be recovered')
    const started = Date.now() // clip list snapshot moment
    const clips = fs.readdirSync(dir)
      .filter(f => /^clip-\d+\.mp4$/.test(f) && (!meta || fileNum(f) < meta.turn))
      .sort((a, b) => fileNum(a) - fileNum(b))
      .map(f => path.join(dir, f))
    if (!clips.length) throw new Error('story has no clips to render')
    const out = path.join(dir, withChoices ? 'story-choices.mp4' : 'story.mp4')
    // reuse a previous render unless a newer clip or commit has landed since;
    // the commit check catches a clip excluded because its turn was still mid-save
    let newest = Math.max(...clips.map(f => fs.statSync(f).mtimeMs))
    if (meta) try { newest = Math.max(newest, fs.statSync(metaFile).mtimeMs) } catch {}
    if (!fs.existsSync(out) || fs.statSync(out).mtimeMs <= newest) {
      if (withChoices) await concatClipsWithChoices(clips, choiceOverlays(meta, clips), out)
      else await concatClips(clips, out)
      fs.utimesSync(out, new Date(started), new Date(started)) // a clip landing mid-render still reads as newer
    }
    return { url: toUrl(out) } // toUrl versions by mtime, the browser must not serve a stale cached render
  }).finally(() => { if (renders.get(id) === p) renders.delete(id) })
  renders.set(id, p)
  return p
}
