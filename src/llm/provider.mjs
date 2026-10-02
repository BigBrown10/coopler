/**
 * Minimal OpenAI-compatible chat-completions client (works with OpenRouter, Groq,
 * DeepSeek, Together, or any /chat/completions endpoint). Native fetch only.
 *
 * Vision requests are passed through the same shape with an image_url data URI,
 * which majority vision-capable endpoints accept.
 */

export class LlmError extends Error {}

/**
 * Pull one JSON object/array out of a model reply, tolerating the usual
 * wrappers: ```json fences, a "Here is the JSON:" preamble, and trailing
 * commas. Small models ignore response_format often enough that every caller
 * needs this.
 *
 * @param {string} text raw model output
 * @param {{ kind?: 'object'|'array', what?: string }} [opts]
 * @returns {any} the parsed value
 * @throws {LlmError} with the reply quoted, because "invalid JSON" on its own
 *   is useless when a run fails an hour into tailoring a CV.
 */
export function parseJsonLoose(text, { kind = 'object', what = 'response' } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new LlmError(`Empty ${what} from the model.`);
  }
  const open = kind === 'array' ? '[' : '{';
  const close = kind === 'array' ? ']' : '}';
  let body = text
    .replace(/^```(?:json|JSON)?\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = body.indexOf(open);
  const end = body.lastIndexOf(close);
  if (start === -1 || end <= start) {
    throw new LlmError(
      `No JSON ${kind} in the model's ${what} (it replied with prose): ${body.slice(0, 200)}`,
    );
  }
  body = body.slice(start, end + 1);
  // Trailing commas before a closing brace are a classic small-model slip.
  body = body.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new LlmError(`Model's ${what} was not valid JSON (${e.message}): ${body.slice(0, 200)}`);
  }
}

export async function chatCompletion({ baseUrl, apiKey, model, messages, temperature = 0.2, maxTokens = 800, timeoutMs = 60000, json = false, retries = 3 }) {
  if (!apiKey) throw new LlmError('No LLM_API_KEY configured. Set it in .env.');
  if (!model) throw new LlmError('No model configured (LLM_MODEL).');
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chatCompletionOnce({ baseUrl, apiKey, model, messages, temperature, maxTokens, timeoutMs, json });
    } catch (e) {
      lastErr = e;
      // Retry transient network failures and 5xx/429; not 4xx request errors.
      const transient = /fetch failed|timed out|LLM 5\d\d|LLM 429/.test(e.message);
      if (!transient || attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}

async function chatCompletionOnce({ baseUrl, apiKey, model, messages, temperature, maxTokens, timeoutMs, json }) {
  const url = new URL('chat/completions', baseUrl.replace(/\/?$/, '/')).toString();
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (json) {
    body.response_format = { type: 'json_object' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmError(`LLM ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new LlmError('LLM returned no content.');
    return content;
  } catch (e) {
    if (e.name === 'AbortError') throw new LlmError(`LLM request timed out after ${timeoutMs}ms.`);
    throw e instanceof LlmError ? e : new LlmError(`LLM request failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Request with a base64 image attached (for bounded level-2 vision captchas). */
export async function visionCompletion({ baseUrl, apiKey, model, prompt, imageDataUri, ...rest }) {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageDataUri } },
      ],
    },
  ];
  return chatCompletion({ baseUrl, apiKey, model, messages, ...rest });
}