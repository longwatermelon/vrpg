// tiny client for the vrpg server

const $ = id => document.getElementById(id)

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

// show a status line, styled as an error if flagged
function setStatus(text, isError = false) {
  const el = $('status')
  el.textContent = text
  el.hidden = !text
  el.classList.toggle('error', isError)
}

// show the frozen frame image instead of the video
function showFrame(url) {
  $('frame').src = url
  $('frame').hidden = false
  $('player').hidden = true
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
    if (d.clipPrompt) parts.push(`[current clip prompt]\n${d.clipPrompt}`)
    d.choices.forEach((c, i) => parts.push(`[option ${i + 1}: ${c.label}]\n${c.prompt}`))
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
  const gen = ++playGen
  $('choices').innerHTML = ''
  if ($('dev').open) loadDev() // the turn has advanced server-side, refresh an open dev panel now
  const video = $('player')
  video.src = clipUrl
  video.hidden = false
  $('frame').hidden = true
  // clip won't play, fall back to its last frame so the player still sees the outcome
  const fallback = () => {
    if (gen !== playGen) return // superseded, don't touch the ui
    setStatus('Clip playback failed, showing its final frame', true)
    showFrame(frameUrl)
    renderChoices(choices)
  }
  video.onended = () => { if (gen === playGen) renderChoices(choices) } // video pauses on its last frame
  video.onerror = fallback
  try {
    await video.play()
  } catch (err) {
    if (gen !== playGen) return
    if (err.name !== 'NotAllowedError') return fallback()
    // autoplay blocked, ask for a click
    setStatus('Click the video to play')
    video.onclick = () => {
      video.onclick = null
      setStatus('')
      video.play().catch(fallback)
    }
  }
}

// stop playback and drop media handlers so nothing fires afterward
function stopMedia() {
  playGen++ // cancel any pending playback callbacks
  const video = $('player')
  video.onended = video.onerror = video.onclick = null
  video.pause()
  video.removeAttribute('src')
  video.hidden = true
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
  if (!state.active) return false
  if (mustAdvancePast !== null && state.token === mustAdvancePast) return false
  const advanced = state.token !== currentToken
  setToken(state.token)
  $('start-screen').hidden = true
  $('game-screen').hidden = false
  setStatus('Recovered current game state') // replace any stale progress or error text
  if (advanced && state.clipUrl) {
    await playClip(state.clipUrl, state.frameUrl, state.choices) // the missed clip
  } else {
    showFrame(state.frameUrl)
    renderChoices(state.choices)
  }
  return true
}

// start a new game from the context textbox
async function begin() {
  const context = $('context').value.trim()
  if (!context) return
  const gen = uiGen
  $('begin').disabled = true
  $('start-screen').hidden = true
  $('game-screen').hidden = false
  setStatus('Generating opening scene... (1-3 minutes)')
  // capture the server's token first so a failed start can't recover an unrelated old game
  let baseline = currentToken
  try {
    const state = await (await fetch('/api/state')).json()
    if (state.active) baseline = state.token
  } catch {}
  if (gen !== uiGen) return // restarted meanwhile, don't start a game the ui already left
  let data
  try {
    data = await api('/api/start', { context })
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
  showFrame(data.frameUrl)
  setStatus('')
  renderChoices(data.choices)
}

// pick a choice, render the clip, play it, then show the next choices
async function choose(index, labels) {
  const gen = uiGen
  setChoicesDisabled(true)
  setStatus('Rendering clip... (about a minute)')
  let data
  try {
    data = await api('/api/choose', { index, token: currentToken })
  } catch (err) {
    if (gen !== uiGen) return // restarted meanwhile, drop this stale flow
    // the failure may be ambiguous, recover only if the server actually advanced
    setStatus(err.message, true)
    try {
      if (await resync(currentToken)) return
      if (gen !== uiGen) return
      // the game may have been reset from another tab, return to the start screen
      const state = await (await fetch('/api/state')).json()
      if (!state.active) return toStartScreen()
    } catch {}
    if (gen !== uiGen) return
    renderChoices(labels) // server did not advance, the old choices and error stand
    return
  }
  if (gen !== uiGen) return
  // the server has advanced, from here on only the new choices may be shown
  setToken(data.token)
  setStatus('')
  await playClip(data.clipUrl, data.frameUrl, data.choices)
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
