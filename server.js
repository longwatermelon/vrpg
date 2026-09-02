import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

// load KEY=VALUE pairs from .env into process.env
function loadEnv() {
  const file = path.join(ROOT, '.env')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
}
loadEnv()

const { startGame, chooseOption, chooseCustom, retryTurn, getState, getDebug, resetGame, listStories, loadStory, deleteStory, renderStory, getTimeline, seekTurn, continueStory, truncateStory, isBusy, stopIdleLoops, resumeIdleLoop } = await import('./game.js') // import after env is loaded
const { getSettings, setSettings, normalizeSettings, listModels, getSelectableModel, EFFORTS, isValidModel, isValidProvider } = await import('./llm.js')
const { getCodexStatus, startCodexLogin, getCodexLoginStatus, cancelCodexLogin, logoutCodex } = await import('./codex.js')

// serialize settings validation and writes so concurrent tabs can't combine stale fields
let settingsWork = Promise.resolve()
function withSettingsLock(fn) {
  const run = settingsWork.then(fn)
  settingsWork = run.catch(() => {})
  return run
}

function apiError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

async function applySettings(provider, model, effort, loops) {
  if (isBusy()) throw apiError(409, 'a turn is in progress, change settings once it finishes')
  const current = getSettings()
  const nextProvider = provider === undefined ? current.provider : provider
  if (model !== undefined && !isValidModel(model, nextProvider)) throw apiError(400, 'invalid model')
  let saved
  if (provider === undefined && model === undefined && effort === undefined) {
    saved = setSettings({ loops }) // loops-only change needs no model validation
  } else {
    let nextModel = model === undefined && nextProvider === current.provider ? current.model : model
    if (nextModel === undefined) {
      const models = await listModels(nextProvider)
      nextModel = (models.find(m => m.default) || models[0])?.id
    }
    const selected = nextModel ? await getSelectableModel(nextProvider, nextModel) : null
    if (!selected) throw apiError(400, 'model must support image input and structured text output')
    let nextEffort = effort === undefined ? current.effort : effort
    if (!selected?.efforts.includes(nextEffort)) {
      if (effort !== undefined && effort !== 'default') throw apiError(400, 'reasoning effort is not supported by this model')
      nextEffort = 'default' // a model change resets an incompatible old effort
    }
    if (isBusy()) throw apiError(409, 'a turn started while settings were being checked, try again once it finishes')
    saved = setSettings({ provider: nextProvider, model: nextModel, effort: nextEffort, reasoning: selected.reasoning, loops })
  }
  if (loops === false) stopIdleLoops() // an in-flight loop render is hidden spend now, cancel it
  if (loops === true) resumeIdleLoop() // best-effort render of the tip frame's loop
  return saved
}

function readySettings() {
  return withSettingsLock(normalizeSettings)
}

async function readyForTurn() {
  const settings = await readySettings()
  if (settings.provider === 'codex') {
    const status = await getCodexStatus()
    if (!status.available) throw apiError(503, status.error || 'Codex App Server is unavailable')
    if (!status.connected) throw apiError(401, 'connect a ChatGPT account before using the Codex provider')
  }
  return settings
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
}

// read the full request body and parse it as json, capped at 1mb
function readJson(req) {
  return new Promise((resolve, reject) => {
    req.setEncoding('utf8') // decode utf-8 across chunk boundaries safely
    let body = ''
    let tooBig = false
    req.on('data', c => {
      if (tooBig) return // keep draining without buffering
      body += c
      if (body.length > 1024 * 1024) {
        tooBig = true
        body = ''
        const err = new Error('request body too large')
        err.status = 413
        reject(err)
      }
    })
    req.on('end', () => {
      if (tooBig) return
      try { resolve(JSON.parse(body)) } catch { reject(new Error('invalid json body')) }
    })
    req.on('error', reject)
  })
}

// send a json response
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

// serve a static file from disk with the right mime type, supports byte ranges for video
// cacheable marks immutable rendered media so preloading warms the browser cache
function serveFile(req, res, filePath, cacheable = false) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404)
    return res.end('not found')
  }
  const size = fs.statSync(filePath).size
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
  if (range && (range[1] || range[2])) {
    // partial content, needed for video seeking and safari playback
    const start = range[1] ? parseInt(range[1]) : Math.max(0, size - parseInt(range[2]))
    const end = range[1] && range[2] ? Math.min(parseInt(range[2]), size - 1) : size - 1
    if (isNaN(start) || start < 0 || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      return res.end()
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      ...(cacheable && { 'Cache-Control': 'public, max-age=86400' }),
    })
    return fs.createReadStream(filePath, { start, end }).pipe(res)
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    ...(cacheable && { 'Cache-Control': 'public, max-age=86400' }),
  })
  fs.createReadStream(filePath).pipe(res)
}

// reject cross-origin browser requests, the api triggers paid model calls
// localhost plus this machine's tailnet names, so other tailscale devices can play
function isLocalRequest(req) {
  const local = h => /^(localhost|127\.0\.0\.1|100\.64\.148\.71|smint\.taila3ad62\.ts\.net)(:\d+)?$/.test(h)
  const origin = req.headers.origin
  if (origin && !local(origin.replace(/^https?:\/\//, ''))) return false
  return local(req.headers.host || '')
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!isLocalRequest(req)) return sendJson(res, 403, { error: 'forbidden' })
      if (req.method === 'POST' && !req.headers['content-type']?.includes('application/json')) {
        return sendJson(res, 415, { error: 'content-type must be application/json' })
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/start') {
      const { context, character } = await readJson(req)
      if (typeof context !== 'string' || !context.trim()) return sendJson(res, 400, { error: 'context is required' })
      if (typeof character !== 'string' || !character.trim()) return sendJson(res, 400, { error: 'character is required' })
      if (context.length > 2000) return sendJson(res, 400, { error: 'context too long, keep it under 2000 characters' })
      if (character.length > 500) return sendJson(res, 400, { error: 'character too long, keep it under 500 characters' })
      await readyForTurn()
      return sendJson(res, 200, await startGame(context.trim(), character.trim()))
    }
    if (req.method === 'POST' && url.pathname === '/api/choose') {
      const { index, token } = await readJson(req)
      await readyForTurn()
      return sendJson(res, 200, await chooseOption(index, token))
    }
    if (req.method === 'POST' && url.pathname === '/api/choose-custom') {
      const { text, token } = await readJson(req)
      if (typeof text !== 'string' || !text.trim()) return sendJson(res, 400, { error: 'text is required' })
      if (text.length > 300) return sendJson(res, 400, { error: 'idea too long, keep it under 300 characters' })
      await readyForTurn()
      return sendJson(res, 200, await chooseCustom(text.trim(), token))
    }
    if (req.method === 'POST' && url.pathname === '/api/retry') {
      const { token } = await readJson(req)
      return sendJson(res, 200, await retryTurn(token)) // reuses the turn's llm settings snapshot, no readySettings needed
    }
    if (req.method === 'GET' && url.pathname === '/api/timeline') {
      return sendJson(res, 200, getTimeline())
    }
    if (req.method === 'POST' && url.pathname === '/api/seek') {
      const { turn, token } = await readJson(req)
      return sendJson(res, 200, await seekTurn(turn, token))
    }
    if (req.method === 'POST' && url.pathname === '/api/continue') {
      const { token } = await readJson(req)
      return sendJson(res, 200, await continueStory(token))
    }
    if (req.method === 'POST' && url.pathname === '/api/truncate') {
      const { turn, token } = await readJson(req)
      return sendJson(res, 200, await truncateStory(turn, token))
    }
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      await readJson(req) // drain the body
      await resetGame()
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/api/stories') {
      return sendJson(res, 200, { stories: listStories() })
    }
    if (req.method === 'POST' && url.pathname === '/api/load') {
      const { id } = await readJson(req)
      return sendJson(res, 200, await loadStory(id))
    }
    if (req.method === 'POST' && url.pathname === '/api/delete') {
      const { id } = await readJson(req)
      return sendJson(res, 200, await deleteStory(id))
    }
    if (req.method === 'POST' && url.pathname === '/api/render') {
      const { id, choices } = await readJson(req)
      return sendJson(res, 200, await renderStory(id, choices === true))
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      return sendJson(res, 200, await readySettings())
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const { provider, model, effort, loops } = await readJson(req)
      if (provider !== undefined && !isValidProvider(provider)) return sendJson(res, 400, { error: 'invalid provider' })
      if (effort !== undefined && !EFFORTS.includes(effort)) return sendJson(res, 400, { error: 'invalid effort' })
      if (loops !== undefined && typeof loops !== 'boolean') return sendJson(res, 400, { error: 'invalid loops flag' })
      return sendJson(res, 200, await withSettingsLock(() => applySettings(provider, model, effort, loops)))
    }
    if (req.method === 'GET' && url.pathname === '/api/models') {
      const provider = url.searchParams.get('provider') || getSettings().provider
      if (!isValidProvider(provider)) return sendJson(res, 400, { error: 'invalid provider' })
      return sendJson(res, 200, { provider, models: await listModels(provider) })
    }
    if (req.method === 'GET' && url.pathname === '/api/codex/status') {
      return sendJson(res, 200, await getCodexStatus())
    }
    if (req.method === 'POST' && url.pathname === '/api/codex/login') {
      await readJson(req)
      return sendJson(res, 200, await startCodexLogin())
    }
    if (req.method === 'POST' && url.pathname === '/api/codex/login/cancel') {
      const { loginId } = await readJson(req)
      if (typeof loginId !== 'string' || !loginId) return sendJson(res, 400, { error: 'login id is required' })
      return sendJson(res, 200, await cancelCodexLogin(loginId))
    }
    if (req.method === 'GET' && url.pathname === '/api/codex/login/status') {
      const loginId = url.searchParams.get('loginId')
      if (!loginId) return sendJson(res, 400, { error: 'login id is required' })
      return sendJson(res, 200, getCodexLoginStatus(loginId))
    }
    if (req.method === 'POST' && url.pathname === '/api/codex/logout') {
      await readJson(req)
      if (isBusy()) throw apiError(409, 'a turn is in progress, disconnect ChatGPT once it finishes')
      return sendJson(res, 200, await logoutCodex())
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return sendJson(res, 200, getState())
    }
    if (req.method === 'GET' && url.pathname === '/api/debug') {
      return sendJson(res, 200, getDebug())
    }
    // static files: /data/* from the session data dir, everything else from public/
    const pathname = decodeURIComponent(url.pathname)
    if (pathname.includes('..')) {
      res.writeHead(400)
      return res.end('bad path')
    }
    const isData = pathname.startsWith('/data/')
    if (isData && !MIME[path.extname(pathname).toLowerCase()]) {
      res.writeHead(403) // only media leaves data/, transcripts stay private
      return res.end('forbidden')
    }
    const filePath = isData
      ? path.join(ROOT, pathname)
      : path.join(ROOT, 'public', pathname === '/' ? 'index.html' : pathname)
    return serveFile(req, res, filePath, isData) // rendered media never changes once served
  } catch (err) {
    console.error(err)
    return sendJson(res, err.status || 500, { error: err.message })
  }
})

const PORT = process.env.PORT || 3000
server.listen(PORT, '127.0.0.1', () => console.log(`vrpg running at http://localhost:${PORT}`)) // local only, apis cost money
