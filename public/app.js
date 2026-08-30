// tiny client for the vrpg server

const $ = id => document.getElementById(id)

let video = $('player') // video element currently on stage
let standby = $('player-b') // hidden element the next clip preloads into

// put the preloaded standby element on stage and retire the current one
function swapPlayers() {
  const old = video
  video = standby
  standby = old
  old.onended = old.onerror = old.onclick = old.onloadeddata = null
  old.pause()
  old.removeAttribute('src')
  old.hidden = true
  video.onloadeddata = null
  video.hidden = false
  $('frame').hidden = true
}

// server turn token, guards against acting on stale choices
// persisted per tab so a refresh doesn't count as a missed turn and replay the last clip
let currentToken = 0
try { currentToken = parseInt(sessionStorage.getItem('vrpg-token')) || 0 } catch {}

let playGen = 0 // bumped to invalidate stale playback callbacks
let uiGen = 0 // bumped on return to the start screen to cancel stale async flows

// update the acknowledged token
function setToken(t) {
  currentToken = t
  try { sessionStorage.setItem('vrpg-token', String(t)) } catch {}
}

// post json to the server api and return the parsed response
async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'request failed')
  return data
}

let statusTimer = null // interval driving the live elapsed counter, killed by any setStatus

// show a status line, styled as an error if flagged, stops any running elapsed counter
function setStatus(text, isError = false) {
  clearInterval(statusTimer)
  statusTimer = null
  const el = $('status')
  el.textContent = text
  el.hidden = !text
  el.classList.toggle('error', isError)
}

// format whole seconds as 42s or 1m 30s
function fmtElapsed(s) {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

// show a status line with a live elapsed counter, returns a fn that holds the final time
function startTimer(label) {
  const start = Date.now()
  const elapsed = () => fmtElapsed(Math.floor((Date.now() - start) / 1000))
  setStatus(`${label} ${elapsed()}`)
  const id = setInterval(() => { $('status').textContent = `${label} ${elapsed()}` }, 1000)
  statusTimer = id
  return () => { if (statusTimer === id) setStatus(`Generated in ${elapsed()}`) } // superseded status wins otherwise
}

// show the frozen frame image instead of the video
function showFrame(url) {
  $('frame').src = url
  $('frame').hidden = false
  video.hidden = true
}

// render the choice buttons for the current turn
function renderChoices(labels) {
  const box = $('choices')
  box.innerHTML = ''
  labels.forEach((label, i) => {
    const btn = document.createElement('button')
    btn.textContent = label
    btn.onclick = () => choose(i, labels)
    box.appendChild(btn)
  })
  if ($('dev').open) loadDev() // keep an open dev panel in sync with the new turn
  loadCost() // the turn spent money, refresh the tracker
  startIdleLoop() // idle animation from the moment the options are up
}

// update the top-left cost tracker from the state's cost payload
function renderCost(cost) {
  if (!cost) return
  const fmt = n => `$${n.toFixed(2)}`
  $('cost-llm').textContent = fmt(cost.llm)
  $('cost-fal').textContent = fmt(cost.fal)
  $('cost-total').textContent = fmt(cost.total)
  $('cost').hidden = false
}

// fetch the running api spend and refresh the tracker
async function loadCost() {
  try { renderCost((await (await fetch('/api/state')).json()).cost) } catch {}
}

let devGen = 0 // bumped to invalidate stale dev panel fetches
let devToken = null // turn token the panel currently shows, avoids duplicate fetches per turn

// fill the dev panel with the llm-generated prompts behind the current turn
async function loadDev(force = false) {
  if (!force && devToken === currentToken) return // panel already shows this turn
  const gen = ++devGen
  const el = $('dev-body')
  el.textContent = 'loading...'
  try {
    const d = await (await fetch('/api/debug')).json()
    if (gen !== devGen) return // superseded, don't touch the panel
    if (!d.active) return (el.textContent = 'no active game')
    const parts = []
    if (d.scenePrompt) parts.push(`[opening frame prompt]\n${d.scenePrompt}`)
    if (d.clipPrompt) parts.push(`[current clip prompt (${d.clipDuration}s)]\n${d.clipPrompt}`)
    if (d.loopPrompt) parts.push(`[idle loop prompt]\n${d.loopPrompt}`)
    d.choices.forEach((c, i) => parts.push(`[option ${i + 1}: ${c.label} (${c.duration}s)]\n${c.prompt}`))
    el.textContent = parts.join('\n\n')
    devToken = d.token // cache under the server's token, another tab may have advanced the game
  } catch (err) {
    if (gen === devGen) el.textContent = `failed to load prompts: ${err.message}`
  }
}

// disable or enable all choice buttons
function setChoicesDisabled(disabled) {
  for (const btn of $('choices').children) btn.disabled = disabled
}

// play a clip and show the given choices when it ends
async function playClip(clipUrl, frameUrl, choices) {
  const ui = uiGen
  if (loop && !loop.playing) loop.stop() // a loop that never made it on stage is stale, free its standby element
  new Image().src = frameUrl // warm the browser cache off-screen, fallbacks may need the outcome frame instantly
  // preload the clip into the standby element so the swap onto the stage has no load gap
  standby.muted = false // make sure audio is on whatever the element played before
  standby.src = clipUrl
  const loaded = new Promise(r => { standby.onloadeddata = () => r(true); standby.onerror = () => r(false) })
  if (loop && !loop.stopped && loop.playing) {
    // let the current loop cycle end so the cut to the clip lands on the shared keyframe
    // the cap only rescues stuck playback: a cycle is 5s, so a healthy loop ends well within it
    await new Promise(r => { loop.handoff = r; setTimeout(r, 15000) })
    if (ui !== uiGen) return
  }
  const ok = await Promise.race([loaded, new Promise(r => setTimeout(() => r(false), 15000))])
  if (ui !== uiGen) return
  loop?.stop() // the clip supersedes any idle loop
  const gen = ++playGen
  $('choices').innerHTML = ''
  if ($('dev').open) loadDev() // the turn has advanced server-side, refresh an open dev panel now
  $('frame').src = frameUrl // keep the hidden img on the latest frozen frame for fallbacks
  if (!ok) { // preload broke or stalled, degrade to the outcome frame instead of cutting to black
    standby.removeAttribute('src')
    setStatus('Clip playback failed, showing its final frame', true)
    showFrame(frameUrl)
    renderChoices(choices)
    return
  }
  swapPlayers()
  const v = video // handlers stick to this element even if the stage swaps again
  // clip won't play, fall back to its last frame so the player still sees the outcome
  const fallback = () => {
    if (gen !== playGen) return // superseded, don't touch the ui
    setStatus('Clip playback failed, showing its final frame', true)
    showFrame(frameUrl)
    renderChoices(choices)
  }
  v.onended = () => { if (gen === playGen) renderChoices(choices) } // video pauses on its last frame
  v.onerror = fallback
  try {
    await v.play()
  } catch (err) {
    if (gen !== playGen) return
    if (err.name !== 'NotAllowedError') return fallback()
    // audible autoplay blocked (no recent gesture, e.g. a clip replayed right
    // after a page refresh), play muted so the action still shows; a click restores sound
    v.muted = true
    setStatus('Click the video for sound')
    v.onclick = () => {
      v.onclick = null
      v.muted = false
      if ($('status').textContent === 'Click the video for sound') setStatus('')
    }
    v.play().catch(fallback)
  }
}

let loop = null // idle loop controller for the current turn's frame

// show the frozen frame only if the stage is still empty (opening turn with no loop)
function ensureStage() {
  if (video.hidden && $('frame').hidden) $('frame').hidden = false
}

// poll for the current turn's idle loop and play it on repeat until a clip takes over
// plays from the moment it's ready: while the player picks and through the render wait
function startIdleLoop() {
  if (loop && !loop.stopped && loop.token === currentToken) return // already running for this turn
  loop?.stop()
  const gen = uiGen
  const self = { token: currentToken, stopped: false, playing: false, handoff: null, timer: null }
  loop = self
  // stop polling and playback, whatever is on stage stays as the caller left it
  self.stop = () => {
    if (self.stopped) return
    self.stopped = true
    clearTimeout(self.timer)
    if (self.playing) {
      self.playing = false
      playGen++ // drop the loop's handlers
    }
  }
  const tick = async () => {
    try {
      const state = await (await fetch('/api/state')).json()
      renderCost(state.cost) // free refresh while polling
      if (self.stopped || gen !== uiGen) return
      if (state.token !== self.token) return // the game advanced elsewhere, this loop is obsolete
      if (state.loopFailed) return ensureStage() // no loop this turn, the frame stands
      if (state.loopUrl) {
        const myGen = ++playGen
        const next = standby // preload off stage, the current picture holds until the loop is decoded
        // loop broke after taking the stage, fall back to the frozen frame and release any waiting handoff
        const fail = () => {
          if (playGen !== myGen) return
          self.playing = false
          video.hidden = true
          $('frame').hidden = false
          if (self.handoff) self.handoff()
        }
        next.muted = false // loops carry ambient audio like clips do
        next.src = state.loopUrl
        next.onerror = () => ensureStage() // load failed, whatever's on stage stands (the frame if nothing is)
        // preload stalled with neither loadeddata nor error, don't hold an empty stage forever
        setTimeout(() => { if (playGen === myGen && !self.playing) ensureStage() }, 15000)
        next.onloadeddata = () => {
          if (playGen !== myGen || self.stopped) return
          swapPlayers() // the decoded loop takes the stage with no load gap
          self.playing = true
          const v = video
          v.onended = () => {
            if (playGen !== myGen) return
            if (self.handoff) return self.handoff() // cut to the clip on the shared keyframe
            v.currentTime = 0 // restart the cycle
            v.play().catch(fail)
          }
          v.onerror = fail
          v.play().catch(err => {
            if (err.name !== 'NotAllowedError') return fail()
            // no gesture yet (fresh page load), start muted so the loop still shows
            v.muted = true
            // stale info text may be replaced, only a live render timer is preserved
            // (a running timer implies a prior click, so audible autoplay wouldn't be blocked then anyway)
            if (!statusTimer) setStatus('Click the video for sound')
            v.onclick = () => {
              v.onclick = null
              v.muted = false // first click restores audio
              if ($('status').textContent === 'Click the video for sound') setStatus('')
            }
            v.play().catch(fail)
          })
        }
        return
      }
    } catch {} // transient poll failure, just try again
    if (!self.stopped) self.timer = setTimeout(tick, 3000)
  }
  tick() // check immediately, the loop may already be rendered
}

// stop playback and drop media handlers so nothing fires afterward
function stopMedia() {
  if (loop) { loop.stop(); loop = null } // drop the idle loop with everything else
  playGen++ // cancel any pending playback callbacks
  for (const v of [video, standby]) {
    v.onended = v.onerror = v.onclick = v.onloadeddata = null
    v.pause()
    v.removeAttribute('src')
    v.hidden = true
  }
  $('frame').removeAttribute('src')
  $('frame').hidden = true
}

// clear all game ui and show the start screen, cancels stale async flows
function toStartScreen() {
  uiGen++
  stopMedia()
  devGen++ // drop any in-flight dev fetch and clear the old game's prompts
  devToken = null
  $('dev-body').textContent = ''
  $('choices').innerHTML = ''
  $('begin').disabled = false
  $('game-screen').hidden = true
  $('start-screen').hidden = false
  setStatus('')
  loadStories() // refresh the saved stories list
}

// small pill button for a story card
function storyBtn(label, onclick, primary = false) {
  const btn = document.createElement('button')
  btn.textContent = label
  btn.onclick = onclick
  if (primary) btn.classList.add('primary')
  return btn
}

let storiesGen = 0 // bumped per fetch so only the latest list render wins

// fetch saved stories and render the list on the start screen
async function loadStories() {
  const gen = ++storiesGen
  let stories = []
  try { stories = (await (await fetch('/api/stories')).json()).stories || [] } catch {}
  if (gen !== storiesGen) return // superseded, don't touch the list
  const box = $('stories')
  box.innerHTML = ''
  $('stories-section').hidden = !stories.length
  for (const s of stories) {
    const card = document.createElement('div')
    card.className = 'story'
    const img = document.createElement('img')
    img.src = s.frameUrl
    img.alt = 'last frame'
    img.loading = 'lazy'
    const info = document.createElement('div')
    info.className = 'story-info'
    const title = document.createElement('div')
    title.className = 'story-title'
    title.textContent = s.context || 'untitled story'
    const meta = document.createElement('div')
    meta.className = 'story-meta'
    meta.textContent = `${new Date(Number(s.id)).toLocaleString()} · ${s.clips} clip${s.clips === 1 ? '' : 's'}`
    const actions = document.createElement('div')
    actions.className = 'story-actions'
    if (s.resumable) actions.appendChild(storyBtn('Resume', () => resumeStory(s.id), true))
    if (s.clips > 0) actions.appendChild(storyBtn('Render', e => renderStory(s.id, e.target)))
    actions.appendChild(storyBtn('Delete', () => deleteStory(s.id)))
    info.append(title, meta, actions)
    card.append(img, info)
    box.appendChild(card)
  }
}

// load a saved story server-side and drop back into the game at its last frame
async function resumeStory(id) {
  toStartScreen() // cancel any in-flight flows first
  const gen = uiGen
  $('start-screen').hidden = true
  $('game-screen').hidden = false
  setStatus('Loading story...')
  // capture the server's token first so a lost response can be told apart from a real failure
  let baseline = currentToken
  try {
    const state = await (await fetch('/api/state')).json()
    if (state.active) baseline = state.token
  } catch {}
  if (gen !== uiGen) return
  let data
  try {
    data = await api('/api/load', { id })
  } catch (err) {
    if (gen !== uiGen) return // restarted meanwhile, drop this stale flow
    // the story may have loaded server-side with only the response lost,
    // recover only if the server moved beyond the pre-load baseline
    try {
      if (await resync(baseline)) return
    } catch {}
    if (gen !== uiGen) return
    toStartScreen()
    alert(err.message)
    return
  }
  if (gen !== uiGen) return
  setToken(data.token)
  setStatus('')
  // stage the frame hidden, the idle loop takes the stage (ensureStage reveals the frame if it can't)
  $('frame').src = data.frameUrl
  renderChoices(data.choices)
}

// render the story's main clips into one video server-side, then download it
async function renderStory(id, btn) {
  btn.disabled = true
  const old = btn.textContent
  btn.textContent = 'Rendering...'
  try {
    const { url } = await api('/api/render', { id })
    const a = document.createElement('a')
    a.href = url
    a.download = `vrpg-story-${id}.mp4`
    a.click()
  } catch (err) {
    alert(err.message)
  }
  btn.textContent = old
  btn.disabled = false
}

// delete a saved story after confirmation and refresh the list
async function deleteStory(id) {
  if (!confirm('Delete this story permanently?')) return
  try {
    await api('/api/delete', { id })
  } catch (err) {
    alert(err.message)
  }
  loadStories()
}

// resync the ui with the server's current session state after an ambiguous failure
// with mustAdvancePast set, only counts as success if the server moved beyond that token
async function resync(mustAdvancePast = null) {
  const gen = uiGen
  let state = await (await fetch('/api/state')).json()
  while (state.busy) { // a turn is still running server-side, wait for it to settle first
    if (gen !== uiGen) return false
    setStatus('A turn is still in progress...')
    await new Promise(r => setTimeout(r, 3000))
    state = await (await fetch('/api/state')).json()
  }
  if (gen !== uiGen) return false // restarted meanwhile, drop this stale flow
  renderCost(state.cost)
  if (!state.active) return false
  if (mustAdvancePast !== null && state.token === mustAdvancePast) return false
  const advanced = state.token !== currentToken
  setToken(state.token)
  $('start-screen').hidden = true
  $('game-screen').hidden = false
  setStatus('Recovered current game state') // replace any stale progress or error text
  if (advanced && state.clipUrl && !state.loadedClip) {
    await playClip(state.clipUrl, state.frameUrl, state.choices) // the missed clip
  } else {
    // stage the frame hidden, the idle loop takes the stage (ensureStage reveals the frame if it can't)
    $('frame').src = state.frameUrl
    renderChoices(state.choices)
  }
  return true
}

// start a new game from the character and context textboxes
async function begin() {
  const context = $('context').value.trim()
  const character = $('character').value.trim()
  if (!context || !character) return
  toStartScreen() // cancel any in-flight init resync and clear anything it staged
  const gen = uiGen
  $('begin').disabled = true
  $('start-screen').hidden = true
  $('game-screen').hidden = false
  const done = startTimer('Generating opening scene...')
  // capture the server's token first so a failed start can't recover an unrelated old game
  let baseline = currentToken
  try {
    const state = await (await fetch('/api/state')).json()
    if (state.active) baseline = state.token
  } catch {}
  if (gen !== uiGen) return // restarted meanwhile, don't start a game the ui already left
  let data
  try {
    data = await api('/api/start', { context, character })
  } catch (err) {
    if (gen !== uiGen) return // restarted meanwhile, drop this stale flow
    // the game may have started server-side with only the response lost,
    // recover only if the server moved beyond the pre-start baseline
    try {
      if (await resync(baseline)) return
    } catch {}
    // bring the start form back so the player can retry
    toStartScreen()
    alert(err.message)
    return
  }
  if (gen !== uiGen) return resync().catch(() => {}) // a game got created anyway, surface it instead of hiding it
  setToken(data.token)
  done() // hold the final generation time
  // the opening loop is rendered by the time start returns; keep the frame as a
  // hidden fallback and let startIdleLoop put the loop on stage, never the frame
  $('frame').src = data.frameUrl
  renderChoices(data.choices)
}

// pick a choice, render the clip, play it, then show the next choices
async function choose(index, labels) {
  const gen = uiGen
  setChoicesDisabled(true)
  const done = startTimer('Rendering clip...')
  let data
  try {
    data = await api('/api/choose', { index, token: currentToken }) // the idle loop keeps playing meanwhile
  } catch (err) {
    if (gen !== uiGen) return // restarted meanwhile, drop this stale flow
    // the failure may be ambiguous, recover only if the server actually advanced;
    // keep probing until the server gives a conclusive answer
    setStatus(err.message, true)
    for (;;) {
      try {
        if (await resync(currentToken)) return
        if (gen !== uiGen) return
        // the game may have been reset from another tab, return to the start screen
        const state = await (await fetch('/api/state')).json()
        if (!state.active) return toStartScreen()
        break // settled without advancing, the choice really failed
      } catch {
        if (gen !== uiGen) return
        await new Promise(r => setTimeout(r, 3000)) // server unreachable, try again
      }
    }
    if (gen !== uiGen) return
    setStatus(err.message, true) // resync's progress text may have replaced the error
    renderChoices(labels) // server did not advance, the old choices and error stand
    return
  }
  if (gen !== uiGen) return
  // the server has advanced, from here on only the new choices may be shown
  setToken(data.token)
  loadCost() // the turn's spend is final, don't wait out the clip to show it
  done() // hold the final generation time
  await playClip(data.clipUrl, data.frameUrl, data.choices) // waits out the current loop cycle itself
}

// end the current game server-side and return to the start screen
async function restart() {
  if (!confirm('Restart and abandon the current game?')) return
  $('restart').disabled = true
  setChoicesDisabled(true)
  setStatus('Restarting... (waits for any turn in progress to finish)')
  try {
    await api('/api/reset', {})
  } catch (err) {
    // the reset may have succeeded or still be queued server-side, wait for the server to settle
    let failed
    try {
      let state = await (await fetch('/api/state')).json()
      while (state.busy) {
        await new Promise(r => setTimeout(r, 3000))
        state = await (await fetch('/api/state')).json()
      }
      failed = state.active // still active once settled means the reset really failed
    } catch {
      failed = true
    }
    if (failed) {
      setChoicesDisabled(false)
      $('restart').disabled = false
      return setStatus(err.message, true)
    }
  }
  toStartScreen()
  $('restart').disabled = false
  $('context').value = ''
  $('character').value = ''
}

$('begin').onclick = begin
$('restart').onclick = restart
$('dev').ontoggle = () => { if ($('dev').open) loadDev(true) } // always fetch fresh prompts on open

// rejoin an active game after a page refresh
async function init() {
  try {
    // no active game: normalize to the start screen, unless a begin already took over the ui
    if (!(await resync()) && !$('start-screen').hidden) toStartScreen()
  } catch {}
}
init()
