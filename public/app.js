// tiny client for the vrpg server

const $ = id => document.getElementById(id)

// server turn token, guards against acting on stale choices
// persisted per tab so a refresh doesn't count as a missed turn and replay the last clip
let currentToken = 0
try { currentToken = parseInt(sessionStorage.getItem('vrpg-token')) || 0 } catch {}

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
}

// disable or enable all choice buttons
function setChoicesDisabled(disabled) {
  for (const btn of $('choices').children) btn.disabled = disabled
}

// play a clip and show the given choices when it ends
async function playClip(clipUrl, frameUrl, choices) {
  $('choices').innerHTML = ''
  const video = $('player')
  video.src = clipUrl
  video.hidden = false
  $('frame').hidden = true
  // clip won't play, fall back to its last frame so the player still sees the outcome
  const fallback = () => {
    setStatus('Clip playback failed, showing its final frame', true)
    showFrame(frameUrl)
    renderChoices(choices)
  }
  video.onended = () => renderChoices(choices) // video pauses on its last frame
  video.onerror = fallback
  try {
    await video.play()
  } catch (err) {
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

// resync the ui with the server's current session state after an ambiguous failure
// with mustAdvancePast set, only counts as success if the server moved beyond that token
async function resync(mustAdvancePast = null) {
  let state = await (await fetch('/api/state')).json()
  while (state.busy) { // a turn is still running server-side, wait for it to settle first
    setStatus('A turn is still in progress...')
    await new Promise(r => setTimeout(r, 3000))
    state = await (await fetch('/api/state')).json()
  }
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
  let data
  try {
    data = await api('/api/start', { context })
  } catch (err) {
    // the game may have started server-side with only the response lost,
    // recover only if the server moved beyond the pre-start baseline
    try {
      if (await resync(baseline)) return
    } catch {}
    // bring the start form back so the player can retry
    $('start-screen').hidden = false
    $('game-screen').hidden = true
    $('begin').disabled = false
    setStatus('')
    alert(err.message)
    return
  }
  setToken(data.token)
  showFrame(data.frameUrl)
  setStatus('')
  renderChoices(data.choices)
}

// pick a choice, render the clip, play it, then show the next choices
async function choose(index, labels) {
  setChoicesDisabled(true)
  setStatus('Rendering clip... (about a minute)')
  let data
  try {
    data = await api('/api/choose', { index, token: currentToken })
  } catch (err) {
    // the failure may be ambiguous, recover only if the server actually advanced
    setStatus(err.message, true)
    try {
      if (await resync(currentToken)) return
    } catch {}
    renderChoices(labels) // server did not advance, the old choices and error stand
    return
  }
  // the server has advanced, from here on only the new choices may be shown
  setToken(data.token)
  setStatus('')
  await playClip(data.clipUrl, data.frameUrl, data.choices)
}

$('begin').onclick = begin

// rejoin an active game after a page refresh
async function init() {
  try {
    if (!(await resync())) {
      // no active game, make sure the start screen is showing
      $('start-screen').hidden = false
      $('game-screen').hidden = true
      setStatus('')
    }
  } catch {}
}
init()
