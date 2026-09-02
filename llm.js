import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { completeWithCodex, listCodexModels } from './codex.js'

const API_URL = 'https://openrouter.ai/api/v1/chat/completions'
const SETTINGS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'settings.json')

export const EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] // default omits the reasoning param
export const PROVIDERS = ['openrouter', 'codex']

export function isValidProvider(provider) {
  return PROVIDERS.includes(provider)
}

// safe provider model id for settings; capability validation happens through discovery
export function isValidModel(m, provider = 'openrouter') {
  if (typeof m !== 'string') return false
  const id = m.trim()
  if (!id || id.length > 200) return false
  return provider === 'codex'
    ? /^[a-z0-9][a-z0-9._:-]*$/i.test(id)
    : /^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/.test(id)
}

const DEFAULT_SETTINGS = { provider: 'openrouter', model: 'anthropic/claude-opus-4.6', effort: 'default', reasoning: null, loops: true }

// model + reasoning effort used for every llm call, persisted across restarts
let settings = { ...DEFAULT_SETTINGS }
try { // resume saved settings, a missing or corrupt file keeps the defaults
  const d = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
  if (isValidProvider(d.provider)) settings.provider = d.provider
  if (isValidModel(d.model, settings.provider)) settings.model = d.model.trim()
  if (EFFORTS.includes(d.effort)) settings.effort = d.effort
  if (typeof d.reasoning === 'boolean') settings.reasoning = d.reasoning
  if (typeof d.loops === 'boolean') settings.loops = d.loops
} catch {}

// current settings for the client
export function getSettings() {
  return { provider: settings.provider, model: settings.model, effort: settings.effort, loops: settings.loops }
}

// internal snapshot also carries whether reasoning support was metadata-validated
export function getLlmSettings() {
  return { ...settings }
}

// update and persist the settings, missing fields keep their value
// persists before publishing, so a failed save errors out with memory and disk still in sync
export function setSettings({ provider, model, effort, reasoning, loops }) {
  const next = { ...settings }
  if (isValidProvider(provider)) next.provider = provider
  if (isValidModel(model, next.provider)) {
    const id = model.trim()
    if (id !== next.model && reasoning === undefined) next.reasoning = null
    next.model = id
  }
  if (EFFORTS.includes(effort)) next.effort = effort
  if (typeof reasoning === 'boolean' || reasoning === null) next.reasoning = reasoning
  if (typeof loops === 'boolean') next.loops = loops
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
  return { id: m.id, label: m.id, efforts: modelEfforts(m), reasoning: !!m.reasoning && !!m.supported_parameters?.includes('reasoning'), default: m.id === DEFAULT_SETTINGS.model }
}

// list models for the client's picker with the effort values each one exposes
export async function listModels(provider = settings.provider) {
  if (provider === 'codex') return listCodexModels()
  return (await fetchModels())
    .filter(supportsGame)
    .map(modelInfo)
    .sort((a, b) => a.id.localeCompare(b.id))
}

// verify a newly selected model against the selected provider's capabilities
export async function getSelectableModel(provider, model) {
  const id = model.trim()
  if (provider === 'codex') return (await listCodexModels()).find(m => m.id === id) || null
  const m = (await fetchModels()).find(m => m.id === id && supportsGame(m))
  return m ? modelInfo(m) : null
}

// repair persisted settings against current metadata before exposing or using them
export async function normalizeSettings() {
  const models = await listModels(settings.provider).catch(() => null)
  if (!models) { // discovery outage: a previously validated pair can still proceed
    if (settings.effort !== 'default' && settings.reasoning === false) return setSettings({ effort: 'default' })
    if (settings.effort !== 'default' && settings.reasoning === null) {
      throw new Error('cannot validate the saved reasoning effort while model discovery is unavailable')
    }
    return getSettings()
  }
  if (!models.length) return getSettings()
  const selected = models.find(m => m.id === settings.model) ||
    models.find(m => m.default) || models[0]
  const effort = selected.efforts.includes(settings.effort) ? settings.effort : 'default'
  if (selected.id !== settings.model || effort !== settings.effort || selected.reasoning !== settings.reasoning) {
    return setSettings({ provider: settings.provider, model: selected.id, effort, reasoning: selected.reasoning })
  }
  return getSettings()
}

// whether a model takes the reasoning param at all, sending it to a model that
// doesn't would leave no provider under require_parameters; when metadata is
// unavailable, omit the optional param and let the base request continue
async function supportsReasoning(provider, model) {
  const models = await listModels(provider).catch(() => null)
  const m = models?.find(x => x.id === model)
  if (!m) throw new Error('cannot verify reasoning support while model discovery is unavailable')
  return !!m.reasoning
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
              duration: { type: 'integer', minimum: 8, maximum: 15 },
              'loop-prompt': { type: 'string' },
            },
            required: ['label', 'prompt', 'duration', 'loop-prompt'],
            additionalProperties: false,
          },
        },
      },
      required: ['choices'],
      additionalProperties: false,
    },
  },
}

// call openrouter chat completions and return the assistant text, format is an optional response_format
// cost is the story's cost tracker, billed usd goes through cost.bill
async function completeOpenRouter(messages, format, cost, config) {
  const { model, effort } = config
  const reasoning = effort !== 'default' && (typeof config.reasoning === 'boolean' ? config.reasoning : await supportsReasoning('openrouter', model))
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

// route one normalized request through the selected provider
async function complete(messages, format, cost, config) {
  if (config.provider === 'codex') {
    return completeWithCodex(messages, format?.json_schema?.schema || null, config)
  }
  return completeOpenRouter(messages, format, cost, config)
}

// strip markdown fences and parse json from raw llm output, null on failure
function parseJson(raw) {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(text) } catch { return null }
}

// parse and validate the choices json from raw llm output, null if invalid
// exported so a saved assistant message can be re-parsed when the timeline is truncated
// live responses must carry a per-choice loop-prompt; saved messages may lack it, and
// duration accepts down to 5, for stories saved under older rules
export function parseChoices(raw, live = false) {
  const obj = parseJson(raw)
  const choices = obj?.choices
  const loopOk = c => typeof c['loop-prompt'] === 'string' && c['loop-prompt'].trim()
  if (Array.isArray(choices) && choices.length >= 2 && choices.length <= 3 &&
      choices.every(c => typeof c.label === 'string' && c.label.trim() &&
                         typeof c.prompt === 'string' && c.prompt.trim() &&
                         (live ? loopOk(c) : c['loop-prompt'] === undefined || loopOk(c)) &&
                         Number.isInteger(c.duration) && c.duration >= 5 && c.duration <= 15)) {
    return { choices, loopPrompt: typeof obj['loop-prompt'] === 'string' && obj['loop-prompt'].trim() ? obj['loop-prompt'] : null }
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

// get the next set of choices from the llm, retrying once on bad json
export async function chatChoices(messages, cost, config = settings) {
  const { raw, out } = await completeJson(messages, RESPONSE_FORMAT, r => parseChoices(r, true), 'choices', cost, config)
  return { raw, choices: out.choices }
}

// strict schema for the idle loop prompt call
const LOOP_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'loop',
    strict: true,
    schema: {
      type: 'object',
      properties: { 'loop-prompt': { type: 'string' } },
      required: ['loop-prompt'],
      additionalProperties: false,
    },
  },
}

// parse and validate the loop prompt json, null if invalid
function parseLoop(raw) {
  const obj = parseJson(raw)
  return typeof obj?.['loop-prompt'] === 'string' && obj['loop-prompt'].trim() ? { loopPrompt: obj['loop-prompt'] } : null
}

// effort that turns reasoning off for the quick loop call: none when the model
// allows it, the model default when reasoning is mandatory or unsupported
async function loopEffort(config) {
  if (!config.reasoning) return 'default' // model takes no reasoning param, nothing to turn off
  const model = await getSelectableModel(config.provider, config.model).catch(() => null)
  return model?.efforts.includes('none') ? 'none' : 'default'
}

// write the idle loop prompt for the opening frame, a quick reasoning-off call on the same transcript
// turn loops are baked into each choice instead, this call only serves the start
export async function writeLoopPrompt(messages, frameUri, cost, config = settings) {
  const ask = {
    role: 'user',
    content: [
      { type: 'text', text: `The attached image is the frame where the story now stands. Write a prompt for a 5-second idle animation starting from this frame, shown looping while the player picks their next option. Continue whatever repeatable action the characters are currently doing. For example, if they're walking with a repeatable background (ie, a wall or a crowd or a streetside), keep them walking against that background. If a character is typing, keep them typing. If a character is drinking, keep them drinking. Use natural, loopable actions that don't make it obvious a loop is occurring. Loops may also be action scenes, not just idle rote actions; for example, if the frame is in the middle of a high-action fighting scene, the loop can continue the fighting, as long as the net result of the fighting over the 5 seconds is basically "nothing was achieved overall, nothing truly progressed". The loop must not perform any of the player's choices or advance the story. Like a clip prompt, it must be self-contained: the video model sees only this frame and the prompt, so re-describe characters by appearance. The camera stays roughly still and the animation ends with everything back exactly at its starting pose so it loops seamlessly.\nRespond with ONLY a JSON object: {"loop-prompt": "..."}` },
      { type: 'image_url', image_url: { url: frameUri } },
    ],
  }
  const effort = await loopEffort(config)
  const { out } = await completeJson([...messages, ask], LOOP_FORMAT, parseLoop, 'loop prompt', cost, { ...config, effort })
  return out.loopPrompt
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
        duration: { type: 'integer', minimum: 8, maximum: 15 },
        'loop-prompt': { type: 'string' },
      },
      required: ['label', 'prompt', 'duration', 'loop-prompt'],
      additionalProperties: false,
    },
  },
}

// parse and validate a single choice object, null if invalid
function parseCustom(raw) {
  const c = parseJson(raw)
  if (c && typeof c.label === 'string' && c.label.trim() &&
      typeof c.prompt === 'string' && c.prompt.trim() &&
      typeof c['loop-prompt'] === 'string' && c['loop-prompt'].trim() &&
      Number.isInteger(c.duration) && c.duration >= 8 && c.duration <= 15) {
    return { label: c.label.trim(), prompt: c.prompt, duration: c.duration, 'loop-prompt': c['loop-prompt'] }
  }
  return null
}

// turn the player's own idea into one concrete choice, taking inspiration rather than quoting it
export async function customChoice(messages, idea, frameUri, cost, config = settings) {
  const ask = {
    role: 'user',
    content: [
      { type: 'text', text: `The player typed their own idea for what to do next: "${idea}"\n\nTake inspiration from that idea and turn it into one concrete choice: a short label plus a video clip prompt, duration, and loop-prompt following the same rules as your "choices" entries. Stay grounded in the current scene; if the idea doesn't quite fit, adapt its spirit into something that does. Do not offer regular choices for this message. Respond with ONLY a JSON object: {"label": "...", "prompt": "...", "duration": 8, "loop-prompt": "..."}\nAttached image is the current frame the clip will start from.` },
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
