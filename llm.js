const MODEL = 'anthropic/claude-opus-4.6'
const API_URL = 'https://openrouter.ai/api/v1/chat/completions'

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

let cost = 0 // running openrouter spend in usd for this process

// running openrouter spend in usd
export function getLlmCost() { return cost }

// call openrouter chat completions and return the assistant text, format is an optional response_format
async function complete(messages, format) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      usage: { include: true }, // harmless opt-in in case usage reporting isn't automatic
      ...(format && {
        response_format: format,
        provider: { require_parameters: true }, // only route to endpoints that honor the schema
      }),
    }),
    signal: AbortSignal.timeout(3 * 60 * 1000), // don't hang the game on a stalled request
  })
  if (!res.ok) throw new Error(`openrouter request failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  cost += data.usage?.cost || 0 // billed even when the content turns out unusable
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
function parseChoices(raw) {
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
async function completeJson(messages, format, parse, what) {
  let raw = await complete(messages, format)
  let out = parse(raw)
  if (!out) { // one retry asking the llm to fix its format
    raw = await complete([
      ...messages,
      { role: 'assistant', content: raw },
      { role: 'user', content: 'That response was not valid. Respond with only the JSON object in the required format.' },
    ], format)
    out = parse(raw)
    if (!out) throw new Error(`llm returned invalid ${what} json`)
  }
  return { raw, out }
}

// get the next set of choices plus idle loop prompt from the llm, retrying once on bad json
export async function chatChoices(messages) {
  const { raw, out } = await completeJson(messages, RESPONSE_FORMAT, parseChoices, 'choices')
  return { raw, choices: out.choices, loopPrompt: out.loopPrompt }
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
export async function startScene(context, player) {
  const { out } = await completeJson([
    { role: 'system', content: SCENE_SYSTEM },
    { role: 'user', content: `Starting context: ${context}\nPlayer character: ${player}` },
  ], SCENE_FORMAT, parseScene, 'scene')
  return out
}
