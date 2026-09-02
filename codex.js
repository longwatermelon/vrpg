import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = process.env.VRPG_CODEX_HOME || path.join(ROOT, 'data', 'codex-home')
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vrpg-codex-'))
const BASE_INSTRUCTIONS = 'You are the language model for a video role-playing game. Never use tools, inspect files, or run commands. Follow the supplied developer instructions and conversation, then return only the requested final response.'
const APP_SERVER_ARGS = [
  'app-server', '--strict-config',
  '--disable', 'shell_tool', '--disable', 'unified_exec',
  '--disable', 'multi_agent', '--disable', 'apps', '--disable', 'plugins',
  '--disable', 'computer_use', '--disable', 'browser_use', '--disable', 'browser_use_external',
  '--disable', 'browser_use_full_cdp_access', '--disable', 'in_app_browser',
  '--disable', 'view_image', '--disable', 'image_generation',
  '--disable', 'skill_search', '--disable', 'skill_mcp_dependency_install',
  '--disable', 'memories', '--disable', 'hooks',
  '-c', 'web_search="disabled"', '-c', 'cli_auth_credentials_store="file"',
  '-c', 'check_for_update_on_startup=false',
]

fs.chmodSync(WORK_DIR, 0o700)
process.once('exit', () => { try { fs.rmdirSync(WORK_DIR) } catch {} })

let child = null
let starting = null
let modelsPromise = null
let nextId = 1
const pending = new Map()
const turnWaiters = new Map()
const finishedTurns = new Map()
const turnMessages = new Map()
const turnUsage = new Map()
const abandonedTurns = new Set()
const loginResults = new Map()

function key(threadId, turnId) {
  return `${threadId}:${turnId}`
}

function failProcess(err, proc) {
  if (child !== proc) return
  child = null
  starting = null
  modelsPromise = null
  for (const entry of pending.values()) entry.reject(err)
  pending.clear()
  for (const entry of turnWaiters.values()) entry.reject(err)
  turnWaiters.clear()
  finishedTurns.clear()
  turnMessages.clear()
  turnUsage.clear()
  abandonedTurns.clear()
}

function send(message) {
  if (!child?.stdin.writable) throw new Error('Codex App Server is not running')
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

function requestRaw(method, params = {}, timeoutMs = 30000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Codex App Server timed out during ${method}`))
    }, timeoutMs)
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value) },
      reject: err => { clearTimeout(timer); reject(err) },
    })
    try { send({ method, id, params }) } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      reject(err)
    }
  })
}

function handleServerRequest(message) {
  // VRPG never enables tools or externally managed auth, so App Server should not
  // need a host response. Fail closed if a model or future server version asks.
  send({ id: message.id, error: { code: -32601, message: `unsupported server request: ${message.method}` } })
}

function handleNotification(message) {
  const { method, params } = message
  if (method === 'account/updated') modelsPromise = null
  if (method === 'account/login/completed' && params?.loginId) {
    loginResults.set(params.loginId, { done: true, success: params.success, error: params.error })
    if (params.success) modelsPromise = null
  }
  if (method === 'item/completed' && params?.item?.type === 'agentMessage') {
    const k = key(params.threadId, params.turnId)
    if (abandonedTurns.has(k)) return
    const messages = turnMessages.get(k) || { final: null, last: null }
    messages.last = params.item.text
    if (params.item.phase === 'final_answer') messages.final = params.item.text
    turnMessages.set(k, messages)
  }
  if (method === 'thread/tokenUsage/updated' && params?.turnId) {
    const k = key(params.threadId, params.turnId)
    if (!abandonedTurns.has(k)) turnUsage.set(k, params.tokenUsage)
  }
  if (method === 'turn/completed' && params?.turn?.id) {
    const k = key(params.threadId, params.turn.id)
    if (abandonedTurns.delete(k)) { turnUsage.delete(k); return }
    const waiter = turnWaiters.get(k)
    if (waiter) {
      turnWaiters.delete(k)
      waiter.resolve(params.turn)
    } else {
      finishedTurns.set(k, params.turn)
    }
  }
}

function handleLine(line) {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method) {
    if (message.id !== undefined) handleServerRequest(message)
    else handleNotification(message)
    return
  }
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(message.error.message || 'Codex App Server request failed'))
  else entry.resolve(message.result)
}

async function ensureServer() {
  if (starting) return starting
  fs.mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })
  const authStat = fs.lstatSync(AUTH_DIR)
  if (!authStat.isDirectory() || authStat.isSymbolicLink()) throw new Error('Codex credential path must be a real directory')
  fs.chmodSync(AUTH_DIR, 0o700)
  const inherited = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'CODEX_CA_CERTIFICATE']
  const env = { CODEX_HOME: AUTH_DIR }
  for (const name of inherited) if (typeof process.env[name] === 'string') env[name] = process.env[name]
  const proc = spawn(process.env.CODEX_BIN || 'codex', APP_SERVER_ARGS, {
    cwd: WORK_DIR,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child = proc
  readline.createInterface({ input: proc.stdout }).on('line', handleLine)
  proc.stdin.on('error', err => failProcess(new Error(`Codex App Server input failed: ${err.message}`), proc))
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', text => process.stderr.write(`[codex] ${text}`))
  proc.once('error', err => failProcess(new Error(`could not start Codex App Server: ${err.message}`), proc))
  proc.once('exit', code => failProcess(new Error(`Codex App Server exited${code === null ? '' : ` with code ${code}`}`), proc))
  starting = (async () => {
    await requestRaw('initialize', {
      clientInfo: { name: 'vrpg', title: 'VRPG', version: '1.0.0' },
      capabilities: { experimentalApi: false },
    })
    send({ method: 'initialized', params: {} })
  })()
  try {
    await starting
  } catch (err) {
    if (child === proc) proc.kill()
    failProcess(err, proc)
    throw err
  }
}

async function request(method, params = {}, timeoutMs) {
  await ensureServer()
  return requestRaw(method, params, timeoutMs)
}

function waitForTurn(threadId, turnId) {
  const k = key(threadId, turnId)
  const done = finishedTurns.get(k)
  if (done) {
    finishedTurns.delete(k)
    return Promise.resolve(done)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      turnWaiters.delete(k)
      reject(new Error('Codex generation timed out'))
    }, 3 * 60 * 1000)
    turnWaiters.set(k, {
      resolve: value => { clearTimeout(timer); resolve(value) },
      reject: err => { clearTimeout(timer); reject(err) },
    })
  })
}

function contentParts(content, role) {
  const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  if (!Array.isArray(parts)) return []
  const out = []
  for (const part of parts) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      out.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text })
    } else if (role === 'user' && part?.type === 'image_url' && typeof part.image_url?.url === 'string') {
      out.push({ type: 'input_image', image_url: part.image_url.url })
    }
  }
  return out
}

function historyItems(messages) {
  return messages.filter(message => message.role !== 'system').map(message => ({
    type: 'message',
    role: message.role,
    content: contentParts(message.content, message.role),
  })).filter(item => item.content.length)
}

function turnInput(message) {
  const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
  if (!Array.isArray(parts)) return []
  return parts.flatMap(part => {
    if (part?.type === 'text' && typeof part.text === 'string') return [{ type: 'text', text: part.text, text_elements: [] }]
    if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') return [{ type: 'image', url: part.image_url.url }]
    return []
  })
}

export async function getCodexStatus() {
  try {
    const result = await request('account/read', { refreshToken: false })
    const account = result.account
    return {
      available: true,
      connected: account?.type === 'chatgpt',
      account: account?.type === 'chatgpt' ? { email: account.email, plan: account.planType } : null,
    }
  } catch (err) {
    return { available: false, connected: false, account: null, error: err.message }
  }
}

export async function startCodexLogin() {
  const result = await request('account/login/start', { type: 'chatgptDeviceCode' })
  loginResults.clear()
  loginResults.set(result.loginId, { done: false, success: false, error: null })
  return { authUrl: result.verificationUrl, loginId: result.loginId, userCode: result.userCode }
}

export function getCodexLoginStatus(loginId) {
  return loginResults.get(loginId) || { done: false, success: false, error: null }
}

export async function cancelCodexLogin(loginId) {
  try {
    await request('account/login/cancel', { loginId })
  } finally {
    loginResults.delete(loginId)
  }
  return { ok: true }
}

export async function logoutCodex() {
  await request('account/logout')
  return { ok: true }
}

export async function listCodexModels() {
  if (!modelsPromise) {
    modelsPromise = (async () => {
      const models = []
      let cursor = null
      do {
        const result = await request('model/list', { limit: 100, cursor, includeHidden: false })
        models.push(...result.data)
        cursor = result.nextCursor
      } while (cursor)
      return models.filter(model => !model.inputModalities || model.inputModalities.includes('image')).map(model => ({
        id: model.model || model.id,
        label: model.displayName || model.model || model.id,
        efforts: ['default', ...(model.supportedReasoningEfforts || []).map(option => option.reasoningEffort).filter(Boolean)],
        reasoning: (model.supportedReasoningEfforts || []).length > 0,
        contextLength: null, // App Server reports the exact window with each turn's usage
        default: !!model.isDefault,
      }))
    })()
    modelsPromise.catch(() => { modelsPromise = null })
  }
  return modelsPromise
}

export async function completeWithCodex(messages, schema, config) {
  const status = await getCodexStatus()
  if (!status.available) throw new Error(status.error || 'Codex App Server is unavailable')
  if (!status.connected) throw new Error('connect a ChatGPT account before using the Codex provider')
  const last = messages.at(-1)
  if (last?.role !== 'user') throw new Error('Codex requests must end with a user message')
  const developerInstructions = messages.filter(message => message.role === 'system')
    .map(message => typeof message.content === 'string' ? message.content : contentParts(message.content, 'user').map(part => part.text).filter(Boolean).join('\n'))
    .join('\n\n')
  const started = await request('thread/start', {
    model: config.model,
    cwd: WORK_DIR,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    serviceName: 'vrpg',
    baseInstructions: BASE_INSTRUCTIONS,
    developerInstructions,
    ephemeral: true,
  })
  const threadId = started.thread.id
  let turnId
  let turnFinished = false
  try {
    const history = historyItems(messages.slice(0, -1))
    if (history.length) await request('thread/inject_items', { threadId, items: history })
    const params = {
      threadId,
      input: turnInput(last),
      outputSchema: schema,
      ...(config.effort !== 'default' && { effort: config.effort }),
    }
    const turn = await request('turn/start', params)
    turnId = turn.turn.id
    const completed = await waitForTurn(threadId, turnId)
    turnFinished = true
    if (completed.status !== 'completed') throw new Error(completed.error?.message || `Codex turn ${completed.status}`)
    const messagesForTurn = turnMessages.get(key(threadId, turnId))
    const text = messagesForTurn?.final || messagesForTurn?.last
    if (!text) throw new Error('Codex returned no final response')
    const tokenUsage = turnUsage.get(key(threadId, turnId))
    return {
      text,
      context: tokenUsage ? {
        inputTokens: tokenUsage.last?.inputTokens,
        outputTokens: tokenUsage.last?.outputTokens,
        totalTokens: tokenUsage.last?.totalTokens,
        limit: tokenUsage.modelContextWindow,
      } : null,
    }
  } catch (err) {
    if (turnId && !turnFinished && child) {
      const k = key(threadId, turnId)
      abandonedTurns.add(k)
      await requestRaw('turn/interrupt', { threadId, turnId }, 5000).catch(() => {})
      const timer = setTimeout(() => abandonedTurns.delete(k), 60_000)
      timer.unref()
    }
    throw err
  } finally {
    if (turnId) {
      const k = key(threadId, turnId)
      turnMessages.delete(k)
      turnUsage.delete(k)
      finishedTurns.delete(k)
    }
    if (child) {
      await requestRaw('thread/unsubscribe', { threadId }, 5000).catch(() => {})
      await requestRaw('thread/delete', { threadId }, 5000).catch(() => {})
    }
  }
}
