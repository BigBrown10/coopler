/**
 * Telegram Bot API client, minimal and testable.
 *
 * Long messages are split at Telegram's 4096-character limit, inline buttons
 * ride on the last chunk, replies arrive through getUpdates long polling, and
 * voice notes are downloaded and handed to a transcription endpoint.
 *
 * Every network call goes through an injectable fetch so the tests never touch
 * the network.
 */

const TG_LIMIT = 4000; // margin under Telegram's hard 4096

export function createTelegram({ token, chatId, fetchImpl = fetch, apiBase = 'https://api.telegram.org' }) {
  const call = async (method, params) => {
    const resp = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await resp.json().catch(() => ({}));
    if (!data.ok) throw new Error(`telegram ${method} failed: ${data.description || resp.status}`);
    return data.result;
  };

  return {
    /**
     * Split a long message into chunks; buttons attach to the last one.
     *
     * @returns {Promise<number[]>} the message_ids of the chunks sent
     */
    async send(text, { buttons } = {}) {
      const chunks = splitMessage(String(text || ''));
      const messageIds = [];
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        const params = { chat_id: chatId, text: chunks[i] };
        if (last && buttons && buttons.length) {
          params.reply_markup = {
            inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))],
          };
        }
        const sent = await call('sendMessage', params);
        messageIds.push(sent.message_id);
      }
      return messageIds;
    },

    /**
     * Long-poll for the next user message (text or voice). Returns messages in
     * order; the offset advances so nothing is consumed twice.
     *
     * @returns {Promise<Array<{updateId: number, text: string, voiceFileId: string,
     *                          data: string|null, replyToMessageId: number, date: number}>>}
     */
    async pollOnce(offset, { pollTimeoutSec = 25 } = {}) {
      const updates = await call('getUpdates', {
        timeout: pollTimeoutSec, offset, allowed_updates: ['message', 'callback_query'],
      });
      return updates.map((u) => {
        const m = u.message || u.callback_query?.message;
        return {
          updateId: u.update_id,
          // A button press arrives as callback_data, a reply as text.
          data: u.callback_query?.data || null,
          text: u.callback_query?.data || m?.text || '',
          voiceFileId: m?.voice?.file_id || '',
          // A reply to one of our questions is the answer to that question.
          replyToMessageId: m?.reply_to_message?.message_id || 0,
          date: (m?.date || 0) * 1000,
        };
      });
    },

    /** Download a voice note as bytes. */
    async downloadVoice(fileId) {
      const file = await call('getFile', { file_id: fileId });
      const resp = await fetchImpl(`${apiBase}/file/bot${token}/${file.file_path}`);
      if (!resp.ok) throw new Error(`telegram voice download failed: HTTP ${resp.status}`);
      return new Uint8Array(await resp.arrayBuffer());
    },
  };
}

/**
 * Transcribe a voice note through an OpenAI-compatible audio endpoint
 * (Groq's whisper-large-v3 on the free tier).
 *
 * @param {object} opts
 * @param {Uint8Array} opts.bytes
 * @param {{baseUrl: string, apiKey: string, model: string}} opts.audio
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<string>} the transcript
 */
export async function transcribeVoice({ bytes, audio, fetchImpl = fetch }) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('model', audio.model);
  const resp = await fetchImpl(`${audio.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${audio.apiKey}` },
    body: form,
  });
  if (!resp.ok) throw new Error(`transcription failed: HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.text || '').trim();
}

function splitMessage(text) {
  if (text.length <= TG_LIMIT) return [text];
  const out = [];
  let rest = text;
  while (rest.length > TG_LIMIT) {
    // Prefer breaking on a line, then on a word, so the summary stays readable.
    let cut = rest.lastIndexOf('\n', TG_LIMIT);
    if (cut < TG_LIMIT * 0.5) cut = rest.lastIndexOf(' ', TG_LIMIT);
    if (cut < TG_LIMIT * 0.5) cut = TG_LIMIT;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out;
}
