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
            properties: { label: { type: 'string' }, prompt: { type: 'string' } },
            required: ['label', 'prompt'],
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
      ...(format && {
        response_format: format,
        provider: { require_parameters: true }, // only route to endpoints that honor the schema
      }),
    }),
    signal: AbortSignal.timeout(3 * 60 * 1000), // don't hang the game on a stalled request
  })
  if (!res.ok) throw new Error(`openrouter request failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error(`openrouter returned no content: ${JSON.stringify(data).slice(0, 500)}`)
  return text
}

// strip markdown fences and parse json from raw llm output, null on failure
function parseJson(raw) {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(text) } catch { return null }
}

// parse and validate the choices json from raw llm output, null if invalid
function parseChoices(raw) {
  const choices = parseJson(raw)?.choices
  if (Array.isArray(choices) && choices.length >= 2 && choices.length <= 3 &&
      choices.every(c => typeof c.label === 'string' && c.label.trim() &&
                         typeof c.prompt === 'string' && c.prompt.trim())) {
    return choices
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

// get the next set of choices from the llm, retrying once on bad json
export async function chatChoices(messages) {
  const { raw, out } = await completeJson(messages, RESPONSE_FORMAT, parseChoices, 'choices')
  return { raw, choices: out }
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

const SCENE_SYSTEM = `You are receiving a perspective written from the perspective of a character in a scene, along with a brief description of what that character looks like. Respond with ONLY a JSON object in exactly this format:
{"character": "...", "scene": "..."}
  * "character": a concrete visual description of the player's character in one or two sentences (age, build, hair, clothing, distinguishing features) - only what a camera can see, no name or backstory. It gets pasted into image/video prompts to identify the character.
  * "scene": a prompt for an image model rendering the scene the character is describing: the character should exist in third-person as just another character in the scene, and the scene around them should match the context the character describes.`

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
