import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'
const SETTINGS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'settings.json')

export const EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] // default omits the reasoning param

// valid openrouter model id for the settings, shared by load, update, and the api route
export function isValidModel(m) {
  if (typeof m !== 'string') return false
  const id = m.trim()
  return id.length <= 200 && /^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/.test(id)
}

const DEFAULT_SETTINGS = { model: 'anthropic/claude-opus-4.6', effort: 'default', reasoning: null }

// model + reasoning effort used for every llm call, persisted across restarts
let settings = { ...DEFAULT_SETTINGS }
try { // resume saved settings, a missing or corrupt file keeps the defaults
  const d = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
  if (isValidModel(d.model)) settings.model = d.model.trim()
  if (EFFORTS.includes(d.effort)) settings.effort = d.effort
  if (typeof d.reasoning === 'boolean') settings.reasoning = d.reasoning
} catch {}

// current llm settings for the client
export function getSettings() {
  return { model: settings.model, effort: settings.effort }
}

// internal snapshot also carries whether reasoning support was metadata-validated
export function getLlmSettings() {
  return { ...settings }
}

// update and persist the llm settings, missing fields keep their value
// persists before publishing, so a failed save errors out with memory and disk still in sync
export function setSettings({ model, effort, reasoning }) {
  const next = { ...settings }
  if (isValidModel(model)) {
    const id = model.trim()
    if (id !== next.model && reasoning === undefined) next.reasoning = null
    next.model = id
  }
  if (EFFORTS.includes(effort)) next.effort = effort
  if (typeof reasoning === 'boolean' || reasoning === null) next.reasoning = reasoning
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  fs.writeFileSync(SETTINGS_FILE + '.tmp', JSON.stringify(next))
  fs.renameSync(SETTINGS_FILE + '.tmp', SETTINGS_FILE) // atomic so a crash can't leave a torn file
  settings = next
  return { ...settings }
}

let modelsPromise = null // in-flight or completed metadata fetch, shared across callers

// fetch and cache openrouter's model capability metadata, a success is kept for
// the server run, a failure is kept a minute so llm calls don't stack retries
function fetchModels() {
  if (!modelsPromise) {
    modelsPromise = (async () => {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: process.env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {},
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) throw new Error(`openrouter models request failed: ${res.status}`)
      const data = (await res.json()).data
      if (!Array.isArray(data)) throw new Error('openrouter models response was invalid')
      return data
    })()
    modelsPromise.catch(() => setTimeout(() => { modelsPromise = null }, 60000))
  }
  return modelsPromise
}

// every game call requires image input, text output, and strict json schemas
function supportsGame(m) {
  return typeof m?.id === 'string' && !m.id.endsWith(':batch') &&
    m.architecture?.input_modalities?.includes('image') &&
    m.architecture?.output_modalities?.includes('text') &&
    m.supported_parameters?.includes('structured_outputs')
}

// effort values a model explicitly exposes; default always means omit the param
function modelEfforts(m) {
  const supported = m.reasoning?.supported_efforts
  const reasoning = !!m.reasoning && m.supported_parameters?.includes('reasoning')
  if (!reasoning) return ['default']
  if (supported === null) return EFFORTS.filter(e => e !== 'none' || !m.reasoning?.mandatory)
  const efforts = Array.isArray(supported)
    ? supported.filter(e => EFFORTS.includes(e) && e !== 'default' && e !== 'none')
    : []
  return ['default', ...(!m.reasoning?.mandatory ? ['none'] : []), ...efforts]
}

function modelInfo(m) {
  return { id: m.id, efforts: modelEfforts(m), reasoning: !!m.reasoning && !!m.supported_parameters?.includes('reasoning') }
}

// list models for the client's picker with the effort values each one exposes
export async function listModels() {
  return (await fetchModels())
    .filter(supportsGame)
    .map(modelInfo)
    .sort((a, b) => a.id.localeCompare(b.id))
}

// verify a newly selected model against current openrouter capabilities
export async function getSelectableModel(model) {
  const id = model.trim()
  const m = (await fetchModels()).find(m => m.id === id && supportsGame(m))
  return m ? modelInfo(m) : null
}

// repair persisted settings against current metadata before exposing or using them
export async function normalizeSettings() {
  const metadata = await fetchModels().catch(() => null)
  if (!metadata) { // discovery outage: a previously validated pair can still proceed
    if (settings.effort !== 'default' && settings.reasoning === false) return setSettings({ effort: 'default' })
    if (settings.effort !== 'default' && settings.reasoning === null) {
      throw new Error('cannot validate the saved reasoning effort while openrouter model discovery is unavailable')
    }
    return getSettings()
  }
  const models = metadata.filter(supportsGame).map(modelInfo)
  if (!models.length) return getSettings()
  const selected = models.find(m => m.id === settings.model) ||
    models.find(m => m.id === DEFAULT_SETTINGS.model) || models[0]
  const effort = selected.efforts.includes(settings.effort) ? settings.effort : 'default'
  if (selected.id !== settings.model || effort !== settings.effort || selected.reasoning !== settings.reasoning) {
    return setSettings({ model: selected.id, effort, reasoning: selected.reasoning })
  }
  return getSettings()
}

// whether a model takes the reasoning param at all, sending it to a model that
// doesn't would leave no provider under require_parameters; when metadata is
// unavailable, omit the optional param and let the base request continue
async function supportsReasoning(model) {
  const models = await fetchModels().catch(() => null)
  const m = models?.find(x => x.id === model)
  if (!m) throw new Error('cannot verify reasoning support while openrouter model discovery is unavailable')
  return !!m.reasoning && !!m.supported_parameters?.includes('reasoning')
}

// strict schema for the choices contract, enforced server-side by openrouter
const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'choices',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        choices: {
          type: 'array',
          minItems: 2,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              prompt: { type: 'string' },
              duration: { type: 'integer', minimum: 5, maximum: 15 },
            },
            required: ['label', 'prompt', 'duration'],
            additionalProperties: false,
          },
        },
        'loop-prompt': { type: 'string' },
      },
      required: ['choices', 'loop-prompt'],
      additionalProperties: false,
    },
  },
}

// call openrouter chat completions and return the assistant text, format is an optional response_format
// cost is the story's cost tracker, billed usd goes through cost.bill
async function complete(messages, format, cost, config) {
  const { model, effort } = config
  const reasoning = effort !== 'default' && (typeof config.reasoning === 'boolean' ? config.reasoning : await supportsReasoning(model))
  if (effort !== 'default' && !reasoning) throw new Error('reasoning effort is not supported by the selected model')
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      usage: { include: true }, // harmless opt-in in case usage reporting isn't automatic
      ...(reasoning && { reasoning: { effort } }),
      ...(format && {
        response_format: format,
        provider: { require_parameters: true }, // only route to endpoints that honor the schema
      }),
    }),
    signal: AbortSignal.timeout(3 * 60 * 1000), // don't hang the game on a stalled request
  })
  if (!res.ok) throw new Error(`openrouter request failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  cost.bill('llm', data.usage?.cost || 0) // billed even when the content turns out unusable
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error(`openrouter returned no content: ${JSON.stringify(data).slice(0, 500)}`)
  return text
}

// strip markdown fences and parse json from raw llm output, null on failure
function parseJson(raw) {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(text) } catch { return null }
}

// parse and validate the choices json plus idle loop prompt from raw llm output, null if invalid
// exported so a saved assistant message can be re-parsed when the timeline is truncated
export function parseChoices(raw) {
  const obj = parseJson(raw)
  const choices = obj?.choices
  if (Array.isArray(choices) && choices.length >= 2 && choices.length <= 3 &&
      choices.every(c => typeof c.label === 'string' && c.label.trim() &&
                         typeof c.prompt === 'string' && c.prompt.trim() &&
                         Number.isInteger(c.duration) && c.duration >= 5 && c.duration <= 15) &&
      typeof obj['loop-prompt'] === 'string' && obj['loop-prompt'].trim()) {
    return { choices, loopPrompt: obj['loop-prompt'] }
  }
  return null
}

// call the llm expecting json, retrying once on invalid output, parse returns null when invalid
async function completeJson(messages, format, parse, what, cost, config = settings) {
  let raw = await complete(messages, format, cost, config)
  let out = parse(raw)
  if (!out) { // one retry asking the llm to fix its format
    raw = await complete([
      ...messages,
      { role: 'assistant', content: raw },
      { role: 'user', content: 'That response was not valid. Respond with only the JSON object in the required format.' },
    ], format, cost, config)
    out = parse(raw)
    if (!out) throw new Error(`llm returned invalid ${what} json`)
  }
  return { raw, out }
}

// get the next set of choices plus idle loop prompt from the llm, retrying once on bad json
export async function chatChoices(messages, cost, config = settings) {
  const { raw, out } = await completeJson(messages, RESPONSE_FORMAT, parseChoices, 'choices', cost, config)
  return { raw, choices: out.choices, loopPrompt: out.loopPrompt }
}

// strict schema for a single choice written from the player's own idea
const CUSTOM_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'choice',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        label: { type: 'string' },
        prompt: { type: 'string' },
        duration: { type: 'integer', minimum: 5, maximum: 15 },
      },
      required: ['label', 'prompt', 'duration'],
      additionalProperties: false,
    },
  },
}

// parse and validate a single choice object, null if invalid
function parseCustom(raw) {
  const c = parseJson(raw)
  if (c && typeof c.label === 'string' && c.label.trim() &&
      typeof c.prompt === 'string' && c.prompt.trim() &&
      Number.isInteger(c.duration) && c.duration >= 5 && c.duration <= 15) {
    return { label: c.label.trim(), prompt: c.prompt, duration: c.duration }
  }
  return null
}

// turn the player's own idea into one concrete choice, taking inspiration rather than quoting it
export async function customChoice(messages, idea, frameUri, cost, config = settings) {
  const ask = {
    role: 'user',
    content: [
      { type: 'text', text: `The player typed their own idea for what to do next: "${idea}"\n\nTake inspiration from that idea and turn it into one concrete choice: a short label plus a video clip prompt and duration following the same rules as your "choices" entries. Stay grounded in the current scene; if the idea doesn't quite fit, adapt its spirit into something that does. Do not offer regular choices for this message. Respond with ONLY a JSON object: {"label": "...", "prompt": "...", "duration": 8}\nAttached image is the current frame the clip will start from.` },
      { type: 'image_url', image_url: { url: frameUri } },
    ],
  }
  const { out } = await completeJson([...messages, ask], CUSTOM_FORMAT, parseCustom, 'custom choice', cost, config)
  return out
}

// strict schema for the game setup call: fleshed-out character plus opening frame prompt
const SCENE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'scene',
    strict: true,
    schema: {
      type: 'object',
      properties: { character: { type: 'string' }, scene: { type: 'string' } },
      required: ['character', 'scene'],
      additionalProperties: false,
    },
  },
}

const SCENE_SYSTEM = `You are receiving a scene description, along with a brief description of a character inside that scene. Respond with ONLY a JSON object in exactly this format:
{"character": "...", "scene": "..."}
  * "character": a more fleshed out and concrete visual description of the player's character in one or two sentences (age, build, hair, clothing, distinguishing features) - only what a camera can see, no name or backstory.
  * "scene": a prompt for an image model rendering the scene described, including the character.`

// parse and validate the scene json, null if invalid
function parseScene(raw) {
  const out = parseJson(raw)
  if (out && typeof out.character === 'string' && out.character.trim() &&
      typeof out.scene === 'string' && out.scene.trim()) {
    return { character: out.character.trim(), scene: out.scene.trim() }
  }
  return null
}

// flesh out the player character and write the opening frame prompt, retrying once on bad json
export async function startScene(context, player, cost, config = settings) {
  const { out } = await completeJson([
    { role: 'system', content: SCENE_SYSTEM },
    { role: 'user', content: `Starting context: ${context}\nPlayer character: ${player}` },
  ], SCENE_FORMAT, parseScene, 'scene', cost, config)
  return out
}
