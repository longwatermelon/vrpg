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

const { startGame, chooseOption, getState, getDebug, resetGame } = await import('./game.js') // import after env is loaded

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
function serveFile(req, res, filePath) {
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
    })
    return fs.createReadStream(filePath, { start, end }).pipe(res)
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' })
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
      const { context } = await readJson(req)
      if (typeof context !== 'string' || !context.trim()) return sendJson(res, 400, { error: 'context is required' })
      if (context.length > 2000) return sendJson(res, 400, { error: 'context too long, keep it under 2000 characters' })
      return sendJson(res, 200, await startGame(context.trim()))
    }
    if (req.method === 'POST' && url.pathname === '/api/choose') {
      const { index, token } = await readJson(req)
      return sendJson(res, 200, await chooseOption(index, token))
    }
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      await readJson(req) // drain the body
      await resetGame()
      return sendJson(res, 200, { ok: true })
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
    const filePath = pathname.startsWith('/data/')
      ? path.join(ROOT, pathname)
      : path.join(ROOT, 'public', pathname === '/' ? 'index.html' : pathname)
    return serveFile(req, res, filePath)
  } catch (err) {
    console.error(err)
    return sendJson(res, err.status || 500, { error: err.message })
  }
})

const PORT = process.env.PORT || 3000
server.listen(PORT, '127.0.0.1', () => console.log(`vrpg running at http://localhost:${PORT}`)) // local only, apis cost money
