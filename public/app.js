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

// shared per-turn ui refresh: dev panel, usage tracker, idle loop, timeline
function turnUiTail() {
  if ($('dev').open) loadDev() // keep an open dev panel in sync with the new turn
  loadCost() // the turn may have spent money, refresh the tracker
  startIdleLoop() // idle animation from the moment the options are up
  refreshTimeline() // keep an open sidebar in sync with the new position
}

// render the choice buttons plus the write-your-own box for the current turn
// idea prefills the box, so a failed custom action can be retried without retyping
function renderChoices(labels, idea = '') {
  const box = $('choices')
  box.innerHTML = ''
  box.classList.remove('pending')
  labels.forEach((label, i) => {
    const btn = document.createElement('button')
    btn.textContent = label
    btn.onclick = () => choose(i, labels)
    box.appendChild(btn)
  })
  // fourth box: the player writes their own idea, the llm turns it into a real action
  const wrap = document.createElement('div')
  wrap.className = 'custom-choice'
  const input = document.createElement('input')
  input.maxLength = 300
  input.placeholder = 'Or write your own idea...'
  input.value = idea
  const go = document.createElement('button')
  go.textContent = 'Go'
  const submit = () => { if (input.value.trim()) chooseCustom(input.value.trim(), labels) }
  go.onclick = submit
  input.onkeydown = e => { if (e.key === 'Enter') submit() }
  wrap.append(input, go)
  box.appendChild(wrap)
  turnUiTail()
}

// render the single continue button shown while browsing past turns
function renderContinue() {
  const box = $('choices')
  box.innerHTML = ''
  box.classList.remove('pending')
  const btn = document.createElement('button')
  btn.className = 'continue'
  btn.textContent = 'Continue'
  btn.onclick = () => continueStory()
  box.appendChild(btn)
  turnUiTail()
}

// choices at the tip, a bare continue while browsing history, a spinner while the llm still writes
function renderTurnUi(labels, mode, idea = '') {
  if (mode === 'continue') renderContinue()
  else if (mode === 'pending') renderThinking()
  else renderChoices(labels, idea)
}

// pending-choices ui: polls the server until the turn's choices land; the spinner only
// paints once a check confirms they're still pending, so a committed turn shows no flash
function renderThinking(poll = true) {
  if (poll) pollChoices()
  else paintThinking()
}

const THINKING_ESTIMATE = 35 // rough seconds a choices generation takes, drives the thinking bar

// paint the spinner into the choices area, with a loading bar against a flat time estimate
// elapsed is how long the generation has already been running, so a bar shown
// mid-load (it kicks off behind the clip playback) starts partway through
function paintThinking(elapsed = 0) {
  const box = $('choices')
  box.innerHTML = ''
  box.classList.add('pending')
  const wrap = document.createElement('div')
  wrap.className = 'thinking'
  const spin = document.createElement('div')
  spin.className = 'spinner'
  const label = document.createElement('span')
  label.textContent = 'Thinking about next choices...'
  wrap.append(spin, label)
  box.appendChild(wrap)
  const bar = document.createElement('div')
  bar.className = 'bar'
  const fill = document.createElement('div')
  fill.className = 'bar-fill'
  bar.appendChild(fill)
  box.appendChild(bar)
  const rebase = startThinkingBar(fill, elapsed)
  turnUiTail() // the idle loop should take the stage during the wait
  return rebase
}

// animate the thinking bar from the generation's real start until it leaves the dom
// returns a fn that rebases the bar onto the server's real elapsed time
function startThinkingBar(fill, elapsed) {
  let start = Date.now() - elapsed * 1000 // the generation began before the bar was shown
  const draw = () => { fill.style.width = `${Math.min((Date.now() - start) / 1000 / THINKING_ESTIMATE, 0.98) * 100}%` }
  draw() // show the progress already made immediately
  const id = setInterval(() => {
    if (!fill.isConnected) return clearInterval(id) // bar replaced, done
    draw()
  }, 250)
  return e => { start = Date.now() - e * 1000; draw() }
}

// poll the server until the pending turn's choices land, then render them
async function pollChoices() {
  const gen = uiGen
  const myToken = currentToken
  let painted = false
  let rebase = null // set when the bar was painted before any state arrived, to sync it later
  for (;;) {
    let state = null
    try { state = await (await fetch('/api/state')).json() } catch {} // transient, try again
    if (gen !== uiGen || currentToken !== myToken) return // superseded by another flow
    if (state) {
      if (!state.active) return toStartScreen() // reset from another tab
      if (state.token !== myToken) return resync().catch(() => {}) // the game advanced elsewhere, sync to it
      renderTracker(state)
      if (state.turnError) return renderRetry(state.turnError)
      if (state.mode !== 'pending') {
        devToken = null // same token but new prompts, an open dev panel must refetch
        return renderChoices(state.choices)
      }
      if (rebase) { rebase(state.thinkingElapsed || 0); rebase = null } // bar painted blind, sync it to the real progress
    }
    if (!painted) {
      painted = true
      const r = paintThinking(state?.thinkingElapsed || 0) // really still pending (or unreachable), show the wait
      if (!state) rebase = r // no state yet, sync the bar once one lands
    }
    await new Promise(r => setTimeout(r, 1500))
  }
}

// the choices llm failed after the clip was delivered: show the error and offer a retry
function renderRetry(msg) {
  const box = $('choices')
  box.innerHTML = ''
  box.classList.remove('pending')
  setStatus(msg, true)
  const btn = document.createElement('button')
  btn.className = 'continue'
  btn.textContent = 'Retry'
  btn.onclick = () => retryChoices()
  box.appendChild(btn)
  turnUiTail()
}

// re-run the failed llm half of the turn, the server reuses the already-rendered clip
async function retryChoices() {
  if (opBusy) return
  setOperationBusy(true)
  const gen = uiGen
  try {
    setStatus('')
    renderThinking(false) // spinner without a poller, the request itself reports the outcome
    const data = await api('/api/retry', { token: currentToken })
    if (gen !== uiGen) return
    setToken(data.token)
    loadCost()
    devToken = null // same token but new prompts, an open dev panel must refetch
    renderChoices(data.choices)
  } catch (err) {
    if (gen !== uiGen) return
    // the retry may have committed (or still be running) with only the response lost
    try {
      const state = await (await fetch('/api/state')).json()
      if (gen !== uiGen) return
      if (!state.active) return toStartScreen()
      if (state.token === currentToken && !state.turnError) {
        renderTracker(state)
        if (state.mode === 'pending') return renderThinking() // still finishing server-side, poll it up
        devToken = null
        return renderChoices(state.choices)
      }
    } catch {}
    if (gen !== uiGen) return
    renderRetry(err.message)
  } finally {
    setOperationBusy(false)
  }
}

// update the sidebar cost tracker from the state's cost payload
function renderCost(cost) {
  if (!cost) return
  const fmt = n => `$${n.toFixed(2)}`
  $('cost-llm').textContent = fmt(cost.llm)
  $('cost-fal').textContent = fmt(cost.fal)
  $('cost-total').textContent = fmt(cost.total)
  $('cost').hidden = false
}

// update the context row from the provider's last reported story completion
function renderContext(context) {
  const label = $('context-usage')
  const bar = $('context-bar')
  const fill = $('context-fill')
  const compact = n => n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n)
  if (!context) {
    label.textContent = '—'
    fill.style.width = '0%'
    bar.setAttribute('aria-valuenow', '0')
    return
  }
  label.textContent = context.limit ? `${compact(context.used)} / ${compact(context.limit)}` : compact(context.used)
  const percent = context.limit ? Math.min(context.used / context.limit * 100, 100) : 0
  fill.style.width = `${percent}%`
  bar.setAttribute('aria-valuenow', String(Math.round(percent)))
}

function renderTracker(state) {
  renderCost(state.cost)
  renderContext(state.context)
}

// fetch the running api spend and refresh the tracker
async function loadCost() {
  try { renderTracker(await (await fetch('/api/state')).json()) } catch {}
}

const providerModels = new Map() // provider -> model metadata from /api/models
const modelLoads = new Map()
const rememberedModels = new Map()

const effortLabels = {
  default: 'model default',
  none: 'no reasoning',
  minimal: 'minimal reasoning',
  low: 'low reasoning',
  medium: 'medium reasoning',
  high: 'high reasoning',
  xhigh: 'xhigh reasoning',
  max: 'max reasoning',
  ultra: 'ultra reasoning',
}

function selectedProvider() {
  return document.querySelector('.provider-select').value
}

// set a model select to a value, creating the option when the list doesn't have it
// (the saved model may predate the fetched list, or the list may not be loaded yet)
function setModelValue(el, model) {
  if (model && ![...el.options].some(o => o.value === model)) {
    const opt = document.createElement('option')
    opt.value = opt.textContent = model
    el.appendChild(opt)
  }
  el.value = model
}

// fill every settings control (start screen and sidebar) with the given settings
function renderSettings(s) {
  for (const el of document.querySelectorAll('.provider-select')) el.value = s.provider
  rememberedModels.set(s.provider, s.model)
  renderModelOptions(s.provider, s.model)
  for (const el of document.querySelectorAll('.effort-select')) el.value = s.effort
  for (const el of document.querySelectorAll('.loops-check')) el.checked = s.loops !== false // old servers omit the field, loops default on
  updateEffortOptions()
  showCodexAuth(s.provider === 'codex')
  loadModels(s.provider).catch(() => {})
}

function renderModelOptions(provider, selected) {
  const models = providerModels.get(provider)
  for (const el of document.querySelectorAll('.model-select')) {
    if (models) {
      el.innerHTML = ''
      for (const model of models) {
        const opt = document.createElement('option')
        opt.value = model.id
        opt.textContent = model.label || model.id
        el.appendChild(opt)
      }
    }
    setModelValue(el, selected)
  }
}

// show only efforts the picked model exposes; unknown models keep the existing options
function updateEffortOptions() {
  const provider = selectedProvider()
  const model = document.querySelector('.model-select').value
  const efforts = providerModels.get(provider)?.find(item => item.id === model)?.efforts
  if (!efforts) return
  for (const el of document.querySelectorAll('.effort-select')) {
    const current = el.value
    el.innerHTML = ''
    for (const effort of efforts) {
      const opt = document.createElement('option')
      opt.value = effort
      opt.textContent = effortLabels[effort]
      el.appendChild(opt)
    }
    el.value = efforts.includes(current) ? current : 'default'
    el.hidden = efforts.length === 1
  }
}

let settingsGen = 0 // bumped per fetch or save so only the latest result renders

// fetch the current llm settings into the controls, only rendering while still the latest change
// returns whether the fetch succeeded, so recovery flows know the controls are in sync
async function loadSettings(gen = ++settingsGen) {
  try {
    const res = await fetch('/api/settings')
    if (!res.ok) return false // an error body must not render as settings
    const s = await res.json()
    if (gen === settingsGen) renderSettings(s) // superseded, don't touch the controls
    return true
  } catch { return false }
}

// initial load and later saves are awaited before paid llm calls; resolves false on failure
let settingsPending

// retry a failed initial/recovery fetch whenever the player next requests a paid action
async function settingsReady() {
  if (await settingsPending) return true
  settingsPending = loadSettings()
  return settingsPending
}

// save a changed setting and mirror the result into all controls
// saves chain onto each other so an older response can't overwrite a newer one
function saveSettings(patch) {
  const gen = ++settingsGen // claimed at enqueue, an older queued save can't outrank this one
  const p = settingsPending.then(async () => {
    try {
      const s = await api('/api/settings', patch)
      if (gen === settingsGen) renderSettings(s)
      return true
    } catch (err) {
      alert(err.message)
      return false
    }
  })
  settingsPending = p
  // no newer save queued: restore the server's settings, and once the controls are
  // back in sync reopen the gate so later actions aren't cancelled forever
  // (a failed reload keeps it closed, the controls may still show unsaved values)
  p.then(ok => { if (!ok && p === settingsPending) settingsPending = loadSettings() })
  return p
}

async function loadModels(provider) {
  if (providerModels.has(provider)) return providerModels.get(provider)
  if (!modelLoads.has(provider)) {
    modelLoads.set(provider, (async () => {
      const res = await fetch(`/api/models?provider=${encodeURIComponent(provider)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'failed to load models')
      providerModels.set(provider, data.models)
      return data.models
    })().finally(() => modelLoads.delete(provider)))
  }
  const models = await modelLoads.get(provider)
  if (selectedProvider() === provider) {
    const current = rememberedModels.get(provider) || document.querySelector('.model-select').value
    renderModelOptions(provider, current)
    updateEffortOptions()
  }
  return models
}

function showCodexAuth(show) {
  for (const el of document.querySelectorAll('.codex-auth')) el.hidden = !show
  if (show) loadCodexStatus()
}

let codexStatusPromise = null
let codexLoginPrompt = null

function renderCodexStatus(status) {
  const waiting = !status.connected && codexLoginPrompt?.userCode
  const label = status.connected
    ? `connected${status.account?.email ? ` as ${status.account.email}` : ''}${status.account?.plan ? ` (${status.account.plan})` : ''}`
    : waiting ? 'Enter this code on the opened ChatGPT page:'
      : status.available ? 'ChatGPT not connected' : (status.error || 'Codex unavailable')
  for (const el of document.querySelectorAll('.codex-auth-status')) el.textContent = label
  for (const el of document.querySelectorAll('.codex-device-code')) {
    el.textContent = waiting || ''
    el.hidden = !waiting
  }
  for (const el of document.querySelectorAll('.codex-copy')) el.hidden = !waiting
  for (const el of document.querySelectorAll('.codex-login')) el.hidden = status.connected || !status.available || !!waiting
  for (const el of document.querySelectorAll('.codex-logout')) {
    el.hidden = !status.connected
    el.disabled = opBusy
  }
}

async function copyCodexCode() {
  const code = codexLoginPrompt?.userCode
  if (!code) return
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(code)
    } else {
      const input = document.createElement('textarea')
      input.value = code
      input.style.position = 'fixed'
      input.style.opacity = '0'
      document.body.appendChild(input)
      input.select()
      const copied = document.execCommand('copy')
      input.remove()
      if (!copied) throw new Error('copy failed')
    }
    for (const el of document.querySelectorAll('.codex-copy')) el.textContent = 'Copied'
    setTimeout(() => {
      for (const el of document.querySelectorAll('.codex-copy')) el.textContent = 'Copy Code'
    }, 1200)
  } catch {
    alert('Could not copy the code. Select it and copy it manually.')
  }
}

async function loadCodexStatus() {
  if (codexStatusPromise) return codexStatusPromise
  codexStatusPromise = (async () => {
    try {
      const res = await fetch('/api/codex/status')
      const status = await res.json()
      renderCodexStatus(status)
      return status
    } catch (err) {
      const status = { available: false, connected: false, error: err.message }
      renderCodexStatus(status)
      return status
    }
  })().finally(() => { codexStatusPromise = null })
  return codexStatusPromise
}

async function connectCodex() {
  const popup = window.open('about:blank', 'vrpg-codex-login')
  if (!popup) {
    alert('Allow popups for this site, then try connecting ChatGPT again.')
    return
  }
  let loginId = null
  let connected = false
  for (const el of document.querySelectorAll('.codex-login')) el.disabled = true
  try {
    const login = await api('/api/codex/login', {})
    if (!login.authUrl || !login.userCode) throw new Error('Codex did not return complete device sign-in instructions')
    loginId = login.loginId
    popup.location = login.authUrl
    codexLoginPrompt = { loginId, userCode: login.userCode }
    renderCodexStatus({ available: true, connected: false, account: null })
    for (let i = 0; i < 90; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      const loginStatus = await (await fetch(`/api/codex/login/status?loginId=${encodeURIComponent(loginId)}`)).json()
      if (loginStatus.done && !loginStatus.success) throw new Error(loginStatus.error || 'ChatGPT sign-in failed')
      const status = await loadCodexStatus()
      if (status.connected) {
        connected = true
        providerModels.delete('codex')
        await loadModels('codex')
        return
      }
      if (!status.available) throw new Error(status.error || 'Codex App Server became unavailable')
      if (popup.closed) throw new Error('ChatGPT sign-in window was closed')
    }
    throw new Error('ChatGPT sign-in timed out')
  } catch (err) {
    if (popup && !popup.closed) popup.close()
    alert(err.message)
  } finally {
    if (loginId && !connected) await api('/api/codex/login/cancel', { loginId }).catch(() => {})
    codexLoginPrompt = null
    for (const el of document.querySelectorAll('.codex-login')) el.disabled = false
    await loadCodexStatus()
  }
}

async function disconnectCodex() {
  if (opBusy) return
  setOperationBusy(true)
  try {
    await api('/api/codex/logout', {})
    providerModels.delete('codex')
  } catch (err) {
    alert(err.message)
  } finally {
    setOperationBusy(false)
    await loadCodexStatus()
  }
}

function selectProvider(provider) {
  const gen = ++settingsGen
  for (const el of document.querySelectorAll('.provider-select')) el.value = provider
  showCodexAuth(provider === 'codex')
  const p = settingsPending.then(async () => {
    try {
      const models = await loadModels(provider)
      const remembered = rememberedModels.get(provider)
      const model = models.find(item => item.id === remembered)?.id || (models.find(item => item.default) || models[0])?.id
      if (!model) throw new Error(`no compatible ${provider} models are available`)
      const s = await api('/api/settings', { provider, model })
      if (gen === settingsGen) renderSettings(s)
      return true
    } catch (err) {
      alert(err.message)
      return false
    }
  })
  settingsPending = p
  p.then(ok => { if (!ok && p === settingsPending) settingsPending = loadSettings() })
  return p
}

let devGen = 0 // bumped to invalidate stale dev panel fetches
let devToken = null // turn token the panel currently shows, avoids duplicate fetches per turn

// fill the dev panel with the step times and llm-generated prompts behind the current turn
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
    if (d.times) { // step durations and costs of the last finished generation
      const price = n => `$${n.toFixed(4)}`
      const lines = d.times.steps.map(s => `${s.name}: ${s.secs.toFixed(1)}s / ${price(s.cost)}`)
      lines.push(`total: ${d.times.total.toFixed(1)}s / ${price(d.times.cost)}`)
      parts.push(`[last generation usage]\n${lines.join('\n')}`)
    }
    if (d.scenePrompt) parts.push(`[opening frame prompt]\n${d.scenePrompt}`)
    if (d.clipPrompt) parts.push(`[current clip prompt (${d.clipDuration}s)]\n${d.clipPrompt}`)
    if (d.loopPrompt) parts.push(`[idle loop prompt]\n${d.loopPrompt}`)
    d.choices.forEach((c, i) => parts.push(`[option ${i + 1}: ${c.label} (${c.duration}s)]\n${c.prompt}`))
    el.textContent = parts.join('\n\n')
    devToken = d.pending ? null : d.token // pending usage is from the prior turn; refetch when this one finishes
  } catch (err) {
    if (gen === devGen) el.textContent = `failed to load prompts: ${err.message}`
  }
}

// disable or enable all choice buttons and the custom idea box
function setChoicesDisabled(disabled) {
  for (const el of $('choices').querySelectorAll('button, input')) el.disabled = disabled
}

// drive the loading bar from the server's weighted pipeline progress until it leaves the dom
function startProgressBar() {
  const fill = $('choices').querySelector('.bar-fill')
  if (!fill) return
  let snap = null // latest server progress plus when it arrived
  const poll = async () => {
    try {
      const p = (await (await fetch('/api/state')).json()).progress
      if (p) snap = { ...p, at: Date.now() }
    } catch {} // transient, keep the last snapshot
  }
  poll()
  const pollId = setInterval(poll, 2000)
  let shown = 2 // the bar only ever grows, a reweighted total or late snapshot must not pull it back
  const drawId = setInterval(() => {
    if (!fill.isConnected) { clearInterval(pollId); clearInterval(drawId); return } // bar replaced, done
    if (!snap) return
    const total = snap.weights.reduce((a, b) => a + b, 0)
    // completed steps count in full, the running step by its live elapsed time capped at its weight
    let done = snap.weights.slice(0, snap.step).reduce((a, b) => a + b, 0)
    done += Math.min(snap.elapsed + (Date.now() - snap.at) / 1000, snap.weights[snap.step] || 0)
    shown = Math.max(shown, Math.min(done / total, 0.98) * 100)
    fill.style.width = `${shown}%`
  }, 250)
}

// replace the options with the picked one centered in the area, a loading bar beneath
function showPending(label) {
  const box = $('choices')
  box.innerHTML = ''
  box.classList.add('pending')
  if (label) {
    const btn = document.createElement('button')
    btn.className = 'picked'
    btn.textContent = label
    btn.disabled = true
    box.appendChild(btn)
  }
  const bar = document.createElement('div')
  bar.className = 'bar'
  const fill = document.createElement('div')
  fill.className = 'bar-fill'
  bar.appendChild(fill)
  box.appendChild(bar)
  startProgressBar()
}

// play a clip and show the given choices (or a continue button) when it ends
// idea prefills the custom box afterward, a pending custom action must survive playback
async function playClip(clipUrl, frameUrl, choices, mode = 'choices', idea = '') {
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
  $('choices').classList.remove('pending')
  if ($('dev').open) loadDev() // the turn has advanced server-side, refresh an open dev panel now
  $('frame').src = frameUrl // keep the hidden img on the latest frozen frame for fallbacks
  if (!ok) { // preload broke or stalled, degrade to the outcome frame instead of cutting to black
    standby.removeAttribute('src')
    setStatus('Clip playback failed, showing its final frame', true)
    showFrame(frameUrl)
    renderTurnUi(choices, mode, idea)
    return
  }
  swapPlayers()
  const v = video // handlers stick to this element even if the stage swaps again
  // clip won't play, fall back to its last frame so the player still sees the outcome
  const fallback = () => {
    if (gen !== playGen) return // superseded, don't touch the ui
    setStatus('Clip playback failed, showing its final frame', true)
    showFrame(frameUrl)
    renderTurnUi(choices, mode, idea)
  }
  v.onended = () => { if (gen === playGen) renderTurnUi(choices, mode, idea) } // video pauses on its last frame
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
    if (self.handoff) self.handoff() // release a clip waiting on the loop cycle
  }
  const tick = async () => {
    try {
      const state = await (await fetch('/api/state')).json()
      renderTracker(state) // free refresh while polling
      if (self.stopped || gen !== uiGen) return
      if (state.token !== self.token) return // the game advanced elsewhere, this loop is obsolete
      if (state.loopFailed) { self.stop(); return ensureStage() } // no loop this turn (or loops off), the frame stands; a re-enable restarts the poll
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
  $('choices').classList.remove('pending')
  $('sidebar').hidden = true // close the timeline with the game it belongs to
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
    if (s.clips > 0 && s.resumable) actions.appendChild(storyBtn('Render + Choices', e => renderStory(s.id, e.target, true))) // needs the transcript for the options
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
// choices overlays each turn's options on its clip, the picked one highlighted
async function renderStory(id, btn, choices = false) {
  btn.disabled = true
  const old = btn.textContent
  btn.textContent = 'Rendering...'
  try {
    const { url } = await api('/api/render', { id, choices })
    const a = document.createElement('a')
    a.href = url
    a.download = `vrpg-story-${id}${choices ? '-choices' : ''}.mp4`
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
  // a pending-choices turn is showable as-is: its clip and spinner state are already served
  while (state.busy && state.mode !== 'pending') { // a turn is still running server-side, wait for it to settle first
    if (gen !== uiGen) return false
    setStatus('A turn is still in progress...')
    await new Promise(r => setTimeout(r, 3000))
    state = await (await fetch('/api/state')).json()
  }
  if (gen !== uiGen) return false // restarted meanwhile, drop this stale flow
  renderTracker(state)
  if (!state.active) return false
  if (mustAdvancePast !== null && state.token === mustAdvancePast) return false
  const advanced = state.token !== currentToken
  setToken(state.token)
  $('start-screen').hidden = true
  $('game-screen').hidden = false
  setStatus('Recovered current game state') // replace any stale progress or error text
  if (advanced && state.clipUrl && !state.loadedClip) {
    await playClip(state.clipUrl, state.frameUrl, state.choices, state.mode, state.pendingIdea || '') // the missed clip
  } else {
    showPosition(state) // reset the stage like a seek, an old video must not stay up
  }
  return true
}

// start a new game from the character and context textboxes
async function begin() {
  if (opBusy) return
  setOperationBusy(true)
  try {
    await beginInner()
  } finally {
    setOperationBusy(false)
  }
}

async function beginInner() {
  const context = $('context').value.trim()
  const character = $('character').value.trim()
  if (!context || !character) return
  toStartScreen() // cancel any in-flight init resync and clear anything it staged
  const gen = uiGen
  $('begin').disabled = true
  $('start-screen').hidden = true
  $('game-screen').hidden = false
  showPending(null) // no picked option yet, just the loading bar
  const done = startTimer('Generating opening scene...')
  // capture the server's token first so a failed start can't recover an unrelated old game
  let baseline = currentToken
  try {
    const state = await (await fetch('/api/state')).json()
    if (state.active) baseline = state.token
  } catch {}
  if (gen !== uiGen) return // restarted meanwhile, don't start a game the ui already left
  const saved = await settingsReady() // a just-changed model must reach the server before the paid call
  if (gen !== uiGen) return // restarted while waiting out the save
  if (!saved) { // settings are unknown, don't start a paid game under an accidental model
    toStartScreen()
    return alert('Could not load model settings')
  }
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

let opBusy = false // one turn or timeline request at a time client-side, their recovery flows must not interleave

function setOperationBusy(busy) {
  opBusy = busy
  for (const el of document.querySelectorAll('.codex-logout')) el.disabled = busy
}

// run a turn-advancing api call with ambiguous-failure recovery, then play the resulting clip
// restore re-renders the pre-call ui when the server provably did not advance
// picked, when given, is the chosen option's label shown centered with the loading bar
async function advanceTurn(label, request, restore, picked) {
  if (opBusy) return
  setOperationBusy(true)
  try {
    await advanceTurnInner(label, request, restore, picked)
  } finally {
    setOperationBusy(false)
  }
}

// body of advanceTurn, wrapped so the busy flag always releases
async function advanceTurnInner(label, request, restore, picked) {
  const gen = uiGen
  setChoicesDisabled(true)
  if (picked !== undefined) showPending(picked)
  const done = label ? startTimer(label) : () => setStatus('') // instant actions get no timer
  if (label) { // free actions (continue) skip the gate, they never touch the llm
    const saved = await settingsReady() // a just-changed model must reach the server before the paid call
    if (gen !== uiGen) return // restarted while waiting out the save
    if (!saved) { // the save failed, don't run a paid turn under stale settings
      setStatus('Could not load model settings, action cancelled', true)
      restore()
      return
    }
  }
  let data
  try {
    data = await request() // the idle loop keeps playing meanwhile
  } catch (err) {
    if (gen !== uiGen) return // restarted meanwhile, drop this stale flow
    // the failure may be ambiguous, recover only if the server actually advanced;
    // keep probing until the server gives a conclusive answer
    setStatus(err.message, true)
    let settled = null // last state fetch once the server settles without advancing
    for (;;) {
      try {
        if (await resync(currentToken)) return
        if (gen !== uiGen) return
        // the game may have been reset from another tab, return to the start screen
        const state = await (await fetch('/api/state')).json()
        if (!state.active) return toStartScreen()
        settled = state
        break // settled without advancing, the request really failed
      } catch {
        if (gen !== uiGen) return
        await new Promise(r => setTimeout(r, 3000)) // server unreachable, try again
      }
    }
    if (gen !== uiGen) return
    setStatus(err.message, true) // resync's progress text may have replaced the error
    restore(settled?.pendingIdea) // server did not advance, the old ui and error stand; a pending idea wins the box
    return
  }
  if (gen !== uiGen) return
  // the server has advanced, from here on only the new state may be shown
  setToken(data.token)
  loadCost() // show the spend so far, the choices poll keeps it fresh
  done() // hold the final generation time
  // a pending turn's choices are still generating, the spinner takes over when the clip ends
  await playClip(data.clipUrl, data.frameUrl, data.choices || [], data.pending ? 'pending' : data.mode, data.pendingIdea || '') // waits out the current loop cycle itself
}

// pick a choice, render the clip, play it, then show the next choices
function choose(index, labels) {
  const idea = $('choices').querySelector('.custom-choice input')?.value || '' // keep a half-typed idea across a failure
  return advanceTurn('Rendering clip...',
    () => api('/api/choose', { index, token: currentToken }),
    pendingIdea => renderChoices(labels, pendingIdea ?? idea),
    labels[index])
}

// send the player's own idea, the llm writes an action from it, then render and play it
function chooseCustom(text, labels) {
  return advanceTurn('Writing your action and rendering clip...',
    () => api('/api/choose-custom', { text, token: currentToken }),
    // keep the idea in the box, a retry must resend the same text; a differing server-pending idea wins
    pendingIdea => renderChoices(labels, pendingIdea ?? text),
    text)
}

// replay the next canonical clip while browsing history, already rendered so no timer
function continueStory() {
  return advanceTurn(null,
    () => api('/api/continue', { token: currentToken }),
    () => renderContinue())
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

let timelineGen = 0 // bumped per fetch so only the latest timeline render wins

// open or close the timeline sidebar, fetching fresh points on open
function toggleSidebar(open) {
  const sb = $('sidebar')
  sb.hidden = open === undefined ? !sb.hidden : !open
  if (!sb.hidden) loadTimeline()
}

// refresh the timeline if the sidebar is open
function refreshTimeline() {
  if (!$('sidebar').hidden) loadTimeline()
}

// fetch the timeline and render one point per turn, current position highlighted
async function loadTimeline() {
  const gen = ++timelineGen
  let data = null
  try { data = await (await fetch('/api/timeline')).json() } catch {}
  if (gen !== timelineGen || $('sidebar').hidden) return // superseded or closed meanwhile
  const box = $('timeline')
  box.innerHTML = ''
  if (!data?.active) return
  for (const p of data.points) {
    const el = document.createElement('div')
    el.className = 'tl-point' + (p.turn === data.pos ? ' current' : '')
    const main = document.createElement('button') // real button, the timeline works by keyboard too
    main.type = 'button'
    main.className = 'tl-main'
    const img = document.createElement('img')
    if (p.frameUrl) img.src = p.frameUrl
    img.alt = `turn ${p.turn + 1}`
    img.loading = 'lazy'
    const info = document.createElement('div')
    info.className = 'tl-info'
    const num = document.createElement('div')
    num.className = 'tl-turn'
    num.textContent = `Turn ${p.turn + 1}${p.turn === data.turn ? ' · latest' : ''}`
    const label = document.createElement('div')
    label.className = 'tl-label'
    label.textContent = p.label || (p.turn === data.turn ? 'Awaiting your choice' : '')
    info.append(num, label)
    main.append(img, info)
    main.disabled = p.turn === data.pos // already here, nothing to seek to
    main.onclick = () => seekTo(p.turn)
    el.appendChild(main)
    if (p.turn !== data.turn) { // the tip has nothing after it to delete
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'tl-del'
      del.textContent = '✂'
      del.title = 'Delete everything after this point'
      del.onclick = () => truncateTo(p.turn)
      el.appendChild(del)
    }
    box.appendChild(el)
  }
  box.querySelector('.current')?.scrollIntoView({ block: 'nearest' }) // keep the current point in view
}

// put a seeked or resynced position on stage: frozen frame first, its idle loop takes over
function showPosition(data) {
  uiGen++ // supersede any in-flight playback flow so a stale clip can't retake the stage
  stopMedia()
  showFrame(data.frameUrl)
  renderTurnUi(data.choices, data.mode, data.pendingIdea || '') // a pending custom idea goes back in the box
}

// jump the timeline via a seek or truncate call, recovering if the response is lost
async function timelineJump(path, body) {
  if (opBusy) return setStatus('Another action is in progress, wait for it to finish', true)
  setOperationBusy(true)
  try {
    await timelineJumpInner(path, body)
  } finally {
    setOperationBusy(false)
  }
}

// body of timelineJump, wrapped so the busy flag always releases
async function timelineJumpInner(path, body) {
  const gen = uiGen
  try {
    const data = await api(path, body)
    if (gen !== uiGen) return // restarted meanwhile, drop this stale flow
    setToken(data.token)
    setStatus('')
    showPosition(data)
  } catch (err) {
    if (gen !== uiGen) return
    setStatus(err.message, true)
    // the server may have moved with only the response lost, recover if it advanced
    try {
      if (await resync(currentToken)) return
    } catch {}
    if (gen !== uiGen) return
    setStatus(err.message, true) // resync's progress text may have replaced the error
  }
}

// jump the game to a turn on the timeline
function seekTo(turn) {
  return timelineJump('/api/seek', { turn, token: currentToken })
}

// delete every turn after this one and land on it with its choices live again
function truncateTo(turn) {
  if (!confirm('Delete everything after this point? Those turns are removed permanently.')) return
  return timelineJump('/api/truncate', { turn, token: currentToken })
}

$('begin').onclick = begin
$('restart').onclick = restart
$('timeline-toggle').onclick = () => toggleSidebar()
$('sidebar-close').onclick = () => toggleSidebar(false)
$('dev').ontoggle = () => { if ($('dev').open) loadDev(true) } // always fetch fresh prompts on open

// wire both settings control sets
for (const el of document.querySelectorAll('.provider-select')) {
  el.onchange = () => selectProvider(el.value)
}
for (const el of document.querySelectorAll('.model-select')) {
  el.onchange = () => {
    rememberedModels.set(selectedProvider(), el.value)
    saveSettings({ model: el.value })
  }
}
for (const el of document.querySelectorAll('.effort-select')) {
  el.onchange = () => saveSettings({ effort: el.value })
}
for (const el of document.querySelectorAll('.loops-check')) {
  el.onchange = async () => {
    const on = el.checked
    if (!await saveSettings({ loops: on })) return // save failed, the controls were restored
    // apply on the spot: a playing loop yields to the frozen frame, re-enabling polls for a loop again
    if (!on && loop) {
      const playing = loop.playing
      loop.stop() // a polling or preloading loop must not take the stage later either
      if (playing) { video.pause(); showFrame($('frame').src) }
      else ensureStage() // a dropped preload must not leave an empty stage
    }
    // only restart while idle on a frame; mid-playback the clip-end ui refresh starts it,
    // polling now would steal the standby element from a preloading or playing clip
    if (on && !$('game-screen').hidden && !opBusy && (video.hidden || video.paused)) startIdleLoop()
  }
}
for (const el of document.querySelectorAll('.codex-login')) el.onclick = connectCodex
for (const el of document.querySelectorAll('.codex-copy')) el.onclick = copyCodexCode
for (const el of document.querySelectorAll('.codex-logout')) el.onclick = disconnectCodex
settingsPending = loadSettings()

// rejoin an active game after a page refresh
async function init() {
  try {
    // no active game: normalize to the start screen, unless a begin already took over the ui
    if (!(await resync()) && !$('start-screen').hidden) toStartScreen()
  } catch {}
}
init()
