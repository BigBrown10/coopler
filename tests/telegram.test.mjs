import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTelegram, transcribeVoice } from '../src/notify/telegram.mjs';
import { makeTelegramGate, parseCommand } from '../src/gate/telegram-gate.mjs';
import { rewordAnswer } from '../src/mapper/reword.mjs';

/**
 * The Telegram layer never touches the network in these tests: every call is
 * scripted. What is pinned down is the contract the user actually relies on —
 * the summary arrives, replies decide, voice becomes text, edits land, and
 * nothing submits without an explicit go.
 */

const noSleep = async () => {};

/** Scripted bot: send() records, pollOnce replays, drain returns nothing. */
function fakeTelegram(scripted = []) {
  const sent = [];
  let i = 0;
  return {
    sent,
    async send(text, opts) {
      sent.push({ text: String(text), buttons: opts?.buttons || null });
      return [sent.length];
    },
    async pollOnce(offset, opts = {}) {
      if (opts.pollTimeoutSec === 0) return []; // the gate's backlog drain
      return scripted[i++] || [];
    },
    async downloadVoice() {
      return new Uint8Array([1, 2, 3]);
    },
  };
}

function fakeFetchJson(handler) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const body = handler(String(url), opts);
    return {
      ok: body.ok !== false,
      status: body.status || 200,
      json: async () => body.json,
      arrayBuffer: async () => body.bytes || new ArrayBuffer(8),
    };
  };
  return { fetchImpl, calls };
}

/* ------------------------------------------------------------- the client */

test('send splits long messages and puts buttons on the last chunk', async () => {
  const { fetchImpl, calls } = fakeFetchJson(() => ({ json: { ok: true, result: { message_id: 1 } } }));
  const tg = createTelegram({ token: 't', chatId: 'c', fetchImpl });
  const long = 'line\n'.repeat(1200); // ~6000 chars
  await tg.send(long, { buttons: [{ text: '✅', data: 'go' }] });

  assert.ok(calls.length >= 2, 'a long summary is split');
  const chunks = calls.map((c) => JSON.parse(c.opts.body).text);
  for (const c of chunks) assert.ok(c.length <= 4000, 'every chunk fits the limit');
  assert.equal(chunks.join('').replace(/\s+/g, ''), long.replace(/\s+/g, ''), 'nothing is lost or reordered');
  const last = JSON.parse(calls[calls.length - 1].opts.body);
  const others = calls.slice(0, -1).map((c) => JSON.parse(c.opts.body));
  assert.deepStrictEqual(last.reply_markup.inline_keyboard, [[{ text: '✅', callback_data: 'go' }]]);
  for (const o of others) assert.equal(o.reply_markup, undefined, 'buttons only on the last chunk');
});

test('pollOnce surfaces text, buttons, voice and which message was replied to', async () => {
  const { fetchImpl } = fakeFetchJson(() => ({
    json: {
      ok: true,
      result: [{
        update_id: 7,
        message: { text: 'set city: Leeds', reply_to_message: { message_id: 3 }, voice: { file_id: 'v1' } },
      }],
    },
  }));
  const tg = createTelegram({ token: 't', chatId: 'c', fetchImpl });
  const updates = await tg.pollOnce(0);
  assert.equal(updates[0].text, 'set city: Leeds');
  assert.equal(updates[0].voiceFileId, 'v1');
  assert.equal(updates[0].replyToMessageId, 3);
});

test('transcribeVoice posts the audio with auth to the configured endpoint', async () => {
  const { fetchImpl, calls } = fakeFetchJson(() => ({ json: { text: 'I led the migration' } }));
  const out = await transcribeVoice({ bytes: new Uint8Array([1]), audio: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k', model: 'whisper-large-v3' }, fetchImpl });
  assert.equal(out, 'I led the migration');
  assert.match(calls[0].url, /\/audio\/transcriptions$/);
  assert.match(calls[0].opts.headers.authorization, /^Bearer k$/);
  assert.equal(calls[0].opts.body.get('model'), 'whisper-large-v3');
  assert.equal(calls[0].opts.body.get('file').name, 'voice.ogg');
});

/* --------------------------------------------------------- command parsing */

test('parseCommand understands how people actually reply', () => {
  assert.deepEqual(parseCommand('go'), { type: 'go' });
  assert.deepEqual(parseCommand('GO'), { type: 'go' });
  assert.deepEqual(parseCommand('yes'), { type: 'go' });
  assert.deepEqual(parseCommand('no'), { type: 'no' });
  assert.deepEqual(parseCommand('stop'), { type: 'no' });
  assert.deepEqual(parseCommand('set city: Leeds'), { type: 'set', label: 'city', value: 'Leeds' });
  assert.deepEqual(parseCommand('edit why do you want this job: I ship things'), { type: 'set', label: 'why do you want this job', value: 'I ship things' });
  assert.deepEqual(parseCommand('develop motivation: i did x then y'), { type: 'develop', label: 'motivation', thoughts: 'i did x then y' });
  assert.equal(parseCommand('hm maybe'), null);
  assert.equal(parseCommand(''), null);
});

/* ------------------------------------------------------------------ reword */

test('rewordAnswer keeps the user\'s facts and returns only the answer', async () => {
  const seen = [];
  const chat = async (messages) => {
    seen.push(messages);
    return '  "I led the payments migration, cutting settlement time by 40%."  ';
  };
  const out = await rewordAnswer({
    label: 'Describe a project you led',
    thoughts: 'i did the payments migration. it cut settlement time by 40 percent',
    profile: { name: 'Eli' },
    jdText: 'Technical Program Manager role',
    chat,
  });
  assert.equal(out, 'I led the payments migration, cutting settlement time by 40%.');
  const [sys, user] = seen[0];
  assert.match(sys.content, /STAR/);
  assert.match(user.content, /payments migration/);
  assert.match(user.content, /Technical Program Manager/);
});

/* -------------------------------------------------------------------- gate */

function makeGate({ telegram, chat = async () => 'Reworded answer.', fetchImpl } = {}) {
  return makeTelegramGate({
    telegram,
    audio: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k', model: 'whisper-large-v3' },
    chat,
    fetchImpl: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => ({ text: 'i led the payments migration' }) })),
    profile: { name: 'Eli' },
    jdText: 'jd',
    timeoutMs: 10_000,
    sleep: noSleep,
  });
}

const gateArgs = (edits = []) => ({
  onEdit: async (label, value) => { edits.push({ label, value }); return true; },
  render: () => 'updated summary',
  questions: [{ label: 'What is your religion?', options: ['Christian', 'Muslim', 'Prefer not to say'] }],
});

test('the gate sends the summary, a question per snag, and buttons', async () => {
  const tg = fakeTelegram([[]]);
  await makeGate({ telegram: tg })('SUMMARY', gateArgs());
  const texts = tg.sent.map((s) => s.text);
  assert.match(texts[0], /👋 Application ready[\s\S]*SUMMARY/);
  assert.match(texts[1], /❓ What is your religion\?[\s\S]*reply to THIS message/);
  assert.match(texts[1], /Christian \| Muslim \| Prefer not to say/);
  assert.ok(tg.sent.some((s) => s.buttons?.length === 2), 'approve and abort buttons');
});

test('an explicit go decides in favour of submitting', async () => {
  const tg = fakeTelegram([[{ updateId: 1, text: 'go', voiceFileId: '', data: null, replyToMessageId: 0, date: 0 }]]);
  const edits = [];
  const approved = await makeGate({ telegram: tg })('SUMMARY', gateArgs(edits));
  assert.equal(approved, true);
  assert.equal(edits.length, 0, 'no edits, just a decision');
  assert.match(tg.sent[tg.sent.length - 1].text, /🚀/);
});

test('an abort decides against submitting', async () => {
  const tg = fakeTelegram([[{ updateId: 1, text: 'no', voiceFileId: '', data: null, replyToMessageId: 0, date: 0 }]]);
  const approved = await makeGate({ telegram: tg })('SUMMARY', gateArgs());
  assert.equal(approved, false);
});

test('a button press decides like the equivalent text', async () => {
  const tg = fakeTelegram([[{ updateId: 1, text: 'go', voiceFileId: '', data: 'go', replyToMessageId: 0, date: 0 }]]);
  assert.equal(await makeGate({ telegram: tg })('SUMMARY', gateArgs()), true);
});

test('a set command lands verbatim — "use this instead" means exactly this', async () => {
  const tg = fakeTelegram([
    [{ updateId: 1, text: 'set city: Leeds', voiceFileId: '', data: null, replyToMessageId: 0, date: 0 }],
    [{ updateId: 2, text: 'go', voiceFileId: '', data: null, replyToMessageId: 0, date: 0 }],
  ]);
  const edits = [];
  const approved = await makeGate({ telegram: tg })('SUMMARY', gateArgs(edits));
  assert.equal(approved, true);
  assert.deepEqual(edits, [{ label: 'city', value: 'Leeds' }]);
});

test('a develop command rewords the user\'s own words before landing', async () => {
  const tg = fakeTelegram([
    [{ updateId: 1, text: 'develop motivation: i led payments, cut time 40%', voiceFileId: '', data: null, replyToMessageId: 0, date: 0 }],
    [{ updateId: 2, text: 'go', voiceFileId: '', data: null, replyToMessageId: 0, date: 0 }],
  ]);
  const edits = [];
  const chat = async () => 'I led payments, cutting time by 40%.';
  const approved = await makeGate({ telegram: tg, chat })('SUMMARY', gateArgs(edits));
  assert.equal(approved, true);
  assert.deepEqual(edits, [{ label: 'motivation', value: 'I led payments, cutting time by 40%.' }]);
});

test('a voice reply to a question is transcribed and reworded as that answer', async () => {
  const tg = fakeTelegram([
    [{ updateId: 1, text: '', voiceFileId: 'v1', data: null, replyToMessageId: 2, date: 0 }],
    [{ updateId: 2, text: 'go', voiceFileId: '', data: null, replyToMessageId: 0, date: 0 }],
  ]);
  const edits = [];
  const chat = async () => 'Rewritten from my voice: I led the migration.';
  const approved = await makeGate({ telegram: tg, chat })('SUMMARY', gateArgs(edits));
  assert.equal(approved, true);
  assert.deepEqual(edits, [{ label: 'What is your religion?', value: 'Rewritten from my voice: I led the migration.' }]);
  assert.ok(tg.sent.some((s) => /🎤 Heard/.test(s.text)), 'the transcript is echoed back');
});

test('a typed reply to a question lands verbatim as that answer', async () => {
  const tg = fakeTelegram([
    [{ updateId: 1, text: 'Prefer not to say', voiceFileId: '', data: null, replyToMessageId: 2, date: 0 }],
    [{ updateId: 2, text: 'go', voiceFileId: '', data: null, replyToMessageId: 0, date: 0 }],
  ]);
  const edits = [];
  const approved = await makeGate({ telegram: tg })('SUMMARY', gateArgs(edits));
  assert.equal(approved, true);
  assert.deepEqual(edits, [{ label: 'What is your religion?', value: 'Prefer not to say' }]);
});

test('an unrecognised reply gets help, not a silent drop', async () => {
  const tg = fakeTelegram([
    [{ updateId: 1, text: 'hmm not sure', voiceFileId: '', data: null, replyToMessageId: 0, date: 0 }],
    [{ updateId: 2, text: 'no', voiceFileId: '', data: null, replyToMessageId: 0, date: 0 }],
  ]);
  const approved = await makeGate({ telegram: tg })('SUMMARY', gateArgs());
  assert.equal(approved, false);
  assert.ok(tg.sent.some((s) => /Didn't catch that/.test(s.text)), 'an unknown reply gets help');
});

test('timing out waits and reports honestly — nothing submitted', async () => {
  const tg = fakeTelegram([[]]);
  const gate = makeTelegramGate({
    telegram: tg,
    audio: {},
    chat: async () => 'x',
    timeoutMs: 0,
    sleep: noSleep,
  });
  const approved = await gate('SUMMARY', gateArgs());
  assert.equal(approved, false);
  assert.match(tg.sent[tg.sent.length - 1].text, /⌛ Timed out/);
});

test('an edit that matches no field tells the user, and the run can still proceed', async () => {
  const tg = fakeTelegram([
    [{ updateId: 1, text: 'set nonsense: x', voiceFileId: '', data: null, replyToMessageId: 0, date: 0 }],
    [{ updateId: 2, text: 'go', voiceFileId: '', data: null, replyToMessageId: 0, date: 0 }],
  ]);
  const edits = [];
  const args = {
    onEdit: async (label, value) => {
      const ok = label !== 'nonsense';
      if (ok) edits.push({ label, value });
      return ok;
    },
    render: () => 's',
    questions: [],
  };
  const approved = await makeGate({ telegram: tg })('SUMMARY', args);
  assert.equal(approved, true);
  assert.ok(tg.sent.some((s) => /No field matches "nonsense"/.test(s.text)), 'the user learns the edit missed');
});
