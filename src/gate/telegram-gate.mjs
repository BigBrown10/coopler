/**
 * The review gate, over Telegram.
 *
 * Same contract as the terminal gate: show every answer, change nothing
 * without the user's word, submit only on an explicit yes. The difference is
 * where the user happens to be — a shift, a bus, anywhere with a phone.
 *
 * The loop:
 *   1. send the summary and a question per answer that needs the user's word
 *   2. wait for replies: buttons, text commands, or voice notes
 *   3. text answers land verbatim ("use this instead"), voice notes and
 *      `develop` are reworded from the user's own words (STAR where it fits)
 *   4. repeat until an explicit go / no / timeout
 *
 * A reply to a specific question is the answer to that question — that is how
 * a voice note knows which field it is about without the user typing a label.
 */

import { transcribeVoice } from '../notify/telegram.mjs';
import { rewordAnswer } from '../mapper/reword.mjs';

const HELP = [
  'Reply to a question message to answer it (text lands as-is, voice gets reworded in your words).',
  'Commands: go — submit | no — abort',
  'set <label>: <value> — replace an answer with exactly this',
  'develop <label>: <your thoughts> — I rewrite your words into a polished answer',
].join('\n');

/**
 * Build the gate.
 *
 * @param {object} opts
 * @param {object} opts.telegram        the bot client
 * @param {object} opts.audio            transcription config for voice notes
 * @param {Function} opts.chat           (messages) => string, for rewording
 * @param {object} [opts.profile]       for grounding the reword
 * @param {string} [opts.jdText]        the job description, for tailoring
 * @param {object} [opts.log]
 * @param {number} [opts.timeoutMs=6h]  how long to wait for the user
 * @param {Function} [opts.fetchImpl]   for the transcription call (tests)
 * @param {Function} [opts.sleep]       for tests
 * @returns {Promise<boolean>} true only on an explicit go
 */
export function makeTelegramGate({
  telegram,
  audio,
  chat,
  profile = {},
  jdText = '',
  log,
  timeoutMs = 6 * 3600 * 1000,
  fetchImpl,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  return async function askApprovalViaTelegram(summary, { onEdit, render, questions = [] }) {
    // Drain the backlog so old messages cannot decide this application.
    let offset = 0;
    const backlog = await telegram.pollOnce(0, { pollTimeoutSec: 0 }).catch(() => []);
    if (backlog.length) offset = backlog[backlog.length - 1].updateId + 1;

    await telegram.send(`👋 Application ready for your review:\n\n${summary}`, {
      buttons: [
        { text: '✅ Approve & submit', data: 'go' },
        { text: '❌ Abort', data: 'no' },
      ],
    });

    // One message per answer that needs the user's word. Remembering the
    // message id is what lets a voice reply name its field.
    const questionByMessageId = new Map();
    for (const q of questions) {
      const lines = [`❓ ${q.label}`, 'Not in your profile — reply to THIS message.'];
      if (q.options && q.options.length) lines.push(`Options: ${q.options.join(' | ')}`);
      const ids = await telegram.send(lines.join('\n'));
      questionByMessageId.set(ids[ids.length - 1], q.label);
    }
    if (questions.length) await telegram.send(HELP);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Date.now() > deadline) {
        await telegram.send('⌛ Timed out waiting for your review — nothing was submitted.').catch(() => {});
        return false;
      }
      let updates;
      try {
        updates = await telegram.pollOnce(offset);
      } catch (e) {
        log?.warn('telegram.poll_failed', { error: e?.message || String(e) });
        await sleep(3000);
        continue;
      }
      if (!updates.length) {
        // The long poll blocks ~25s server-side; a beat here keeps the loop
        // honest when it does not.
        await sleep(500);
        continue;
      }
      offset = updates[updates.length - 1].updateId + 1;

      for (const u of updates) {
        // A button press decides outright.
        if (u.data === 'go') {
          await telegram.send('🚀 Submitting now...');
          return true;
        }
        if (u.data === 'no') {
          await telegram.send('🛑 Aborted — nothing was submitted.');
          return false;
        }

        let text = u.text || '';
        // A voice note is the user's words: transcribe, then treat as text.
        if (u.voiceFileId) {
          try {
            const bytes = await telegram.downloadVoice(u.voiceFileId);
            text = await transcribeVoice({ bytes, audio, fetchImpl });
            await telegram.send(`🎤 Heard: "${text.slice(0, 300)}"`);
          } catch (e) {
            await telegram.send(`⚠️ Could not transcribe the voice note: ${e?.message || e}`);
            continue;
          }
        }

        // A reply to a question is the answer to that question. Voice gets the
        // reword; typed text lands exactly as typed.
        if (u.replyToMessageId && questionByMessageId.has(u.replyToMessageId)) {
          const label = questionByMessageId.get(u.replyToMessageId);
          const value = u.voiceFileId
            ? await develop(label, text)
            : text;
          const ok = await onEdit(label, value);
          await telegram.send(ok ? `✅ Set ${label} → "${String(value).slice(0, 200)}"` : `❓ No field matches "${label}".`);
          continue;
        }

        const cmd = parseCommand(text);
        if (!cmd) {
          await telegram.send(`Didn't catch that.\n${HELP}`);
          continue;
        }
        if (cmd.type === 'go') {
          await telegram.send('🚀 Submitting now...');
          return true;
        }
        if (cmd.type === 'no') {
          await telegram.send('🛑 Aborted — nothing was submitted.');
          return false;
        }
        if (cmd.type === 'set') {
          const ok = await onEdit(cmd.label, cmd.value);
          await telegram.send(ok ? `✅ Set ${cmd.label} → "${cmd.value.slice(0, 200)}"` : `❓ No field matches "${cmd.label}".`);
        }
        if (cmd.type === 'develop') {
          const value = await develop(cmd.label, cmd.thoughts);
          const ok = await onEdit(cmd.label, value);
          await telegram.send(ok ? `✨ Reworded ${cmd.label} → "${value.slice(0, 300)}"` : `❓ No field matches "${cmd.label}".`);
        }
      }
    }
  };

  /** The user's words, made submittable — facts theirs, structure STAR. */
  async function develop(label, thoughts) {
    const reworded = await rewordAnswer({ label, thoughts, profile, jdText, chat });
    log?.info('review.reworded', { label });
    return reworded;
  }
}

/** go / no / set / develop, tolerant of how people actually type. */
export function parseCommand(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/^(go|yes|y|approve|submit)\b/i.test(s)) return { type: 'go' };
  if (/^(no|n|abort|stop)\b/i.test(s)) return { type: 'no' };

  let m = s.match(/^(?:set|edit)\s+(.+?)\s*:\s*([\s\S]+)$/i);
  if (m) return { type: 'set', label: m[1].trim(), value: m[2].trim() };

  m = s.match(/^develop\s+(.+?)\s*:\s*([\s\S]+)$/i);
  if (m) return { type: 'develop', label: m[1].trim(), thoughts: m[2].trim() };

  return null;
}
