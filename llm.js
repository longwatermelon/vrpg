const MODEL = 'anthropic/claude-sonnet-4.5'
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

// call openrouter chat completions and return the assistant text
async function complete(messages) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      response_format: RESPONSE_FORMAT,
      provider: { require_parameters: true }, // only route to endpoints that honor the schema
    }),
    signal: AbortSignal.timeout(3 * 60 * 1000), // don't hang the game on a stalled request
  })
  if (!res.ok) throw new Error(`openrouter request failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error(`openrouter returned no content: ${JSON.stringify(data).slice(0, 500)}`)
  return text
}

// parse and validate the choices json from raw llm output, null if invalid
function parseChoices(raw) {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const choices = JSON.parse(text).choices
    if (Array.isArray(choices) && choices.length >= 2 && choices.length <= 3 &&
        choices.every(c => typeof c.label === 'string' && c.label.trim() &&
                           typeof c.prompt === 'string' && c.prompt.trim())) {
      return choices
    }
  } catch {}
  return null
}

// get the next set of choices from the llm, retrying once on bad json
export async function chatChoices(messages) {
  let raw = await complete(messages)
  let choices = parseChoices(raw)
  if (!choices) { // one retry asking the llm to fix its format
    raw = await complete([
      ...messages,
      { role: 'assistant', content: raw },
      { role: 'user', content: 'That response was not valid. Respond with only the JSON object in the required format.' },
    ])
    choices = parseChoices(raw)
    if (!choices) throw new Error('llm returned invalid choices json')
  }
  return { raw, choices }
}
