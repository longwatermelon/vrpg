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

const POV_RE = /^first-person pov shot\b/i // every prompt sent to the video/image models must open with this

// true if text reads as camera language: right opener, no narrator pronouns outside <d> dialogue
// or quoted diegetic text (signs, notes)
// "mine" is deliberately not checked (doubles as a noun), "us" only lowercase so "the US" passes
function isPov(text) {
  const t = text.replace(/<d>.*?<\/d>/gs, '').replace(/"[^"]*"/g, '')
  return POV_RE.test(text) &&
    !/\b(i|me|my|myself|we|our|ours|ourselves|you|your|yours|yourself|yourselves)\b/i.test(t) &&
    !/\bus\b/.test(t)
}

// parse and validate the choices json from raw llm output, null if invalid
function parseChoices(raw) {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const choices = JSON.parse(text).choices
    if (Array.isArray(choices) && choices.length >= 2 && choices.length <= 3 &&
        choices.every(c => typeof c.label === 'string' && c.label.trim() &&
                           typeof c.prompt === 'string' && isPov(c.prompt.trim()))) {
      return choices
    }
  } catch {}
  return null
}

// get the next set of choices from the llm, retrying once on bad json
export async function chatChoices(messages) {
  let raw = await complete(messages, RESPONSE_FORMAT)
  let choices = parseChoices(raw)
  if (!choices) { // one retry asking the llm to fix its format
    raw = await complete([
      ...messages,
      { role: 'assistant', content: raw },
      { role: 'user', content: 'That response was not valid. Respond with only the JSON object in the required format, with every prompt starting with "First-person POV shot" and using no first- or second-person pronouns outside dialogue.' },
    ], RESPONSE_FORMAT)
    choices = parseChoices(raw)
    if (!choices) throw new Error('llm returned invalid choices json')
  }
  return { raw, choices }
}

const SCENE_SYSTEM = `You rewrite a player's narrative scene description into a prompt for an image generation model. The image MUST be a first-person POV shot seen through the narrator's eyes. Image models cannot do perspective-taking, so don't say something like "I do x" - the image model will not render that in first-person. Describe what the narrator sees: open with "First-person POV shot; camera from the perspective of a man in the scene.", rewrite all first-person references as what the camera sees, and have people who are looking at the narrator look into the camera (everyone else keeps their described gaze and pose). All other details remain the same. Respond with only the rewritten prompt.`

// rewrite the player's context into a first-person pov camera prompt for the image model, retrying once on a bad rewrite
export async function rewriteScenePrompt(context) {
  const messages = [
    { role: 'system', content: SCENE_SYSTEM },
    { role: 'user', content: context },
  ]
  let text = (await complete(messages)).trim()
  if (!isPov(text)) { // one retry before sending a bad prompt to a paid job
    text = (await complete([
      ...messages,
      { role: 'assistant', content: text },
      { role: 'user', content: 'That response was not valid. Respond with only the rewritten prompt, starting with "First-person POV shot" and using no first- or second-person pronouns.' },
    ])).trim()
    if (!isPov(text)) throw new Error('llm returned a non-pov scene prompt')
  }
  return text
}
