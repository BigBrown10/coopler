import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runApplication, STAGE_ORDER, STAGE, buildApplyPipeline } from '../src/run.mjs';
import { applyJob } from '../src/workflow/apply.mjs';
import { runPipeline, definePipeline, skip } from '../src/core/pipeline.mjs';
import { StageFailure, REASON, remediationFor } from '../src/core/errors.mjs';
import { resolveBoard } from '../src/ats/registry.mjs';
import { createRegistry } from '../src/ats/registry.mjs';
import { greenhouseAdapter } from '../src/ats/greenhouse/adapter.mjs';

const silentLog = () => ({ info() {}, warn() {}, error() {}, debug() {} });

/**
 * These tests cover the composition root's dependency wiring, which is exactly
 * what a unit test of each module cannot see: whether the pipeline can actually
 * reach the LLM, the CV tailor, and the driver through `deps`.
 */

function makeDeps(overrides = {}) {
  return {
    url: 'https://boards.greenhouse.io/acme/jobs/12',
    registry: createRegistry([greenhouseAdapter]),
    profile: { name: 'Eli Ogundipe', identity: {}, cvText: 'cv', work_authorization: {} },
    cfg: {
      llm: { baseUrl: 'x', apiKey: '', model: 'm' },
      browser: { channel: 'x', profileDir: 'p' },
      limits: { captchaVisionAttempts: 1, dailySubmitCap: 5 },
      vision: {},
      captcha: { order: ['capsolver', '2captcha'], keys: {}, pollMs: 0 },
      // autoApprove renders the review and moves on without prompting and
      // without submitting, so these tests never touch stdin.
      dryRun: false, autoApprove: true, approveSubmit: false, handover: false, preEdits: [],
    },
    resumePath: null,
    headless: true,
    driverFactory: async () => makeDriver(),
    archiveDir: null,
    log: silentLog(),
    driverRef: { current: null },
    chatCompletion: async () => '[]',
    tailorForRole: async () => ({ summary: 's', email: 'e', keywords: [] }),
    saveTailored: () => 'out.html',
    ...overrides,
  };
}

function makeDriver(fields, rec = {}) {
  return {
    page: {
      title: async () => 'Software Engineer at Monzo',
      evaluate: async () => 'job description text',
      fill: async () => {},
      screenshot: async () => Buffer.from('jpg'),
    },
    goto: async () => {},
    extractFields: async () => fields,
    fillFields: async () => {},
    setField: async () => {},
    setAutocomplete: async () => true,
    uploadFile: async () => true,
    fillCombos: async () => {},
    screenshot: async () => ({ label: 'x', buffer: Buffer.from('jpeg') }),
    captchaDetection: async () => ({ level: 0, kind: 'none', refs: [] }),
    getRecaptchaInfo: async () => ({ sitekey: '6LeTESTKEYTESTKEYTESTKEYTESTKE', enterprise: true }),
    injectRecaptchaToken: async (t) => { rec.injected = t; return 1; },
    fillSecurityCode: async (code) => { rec.securityCode = code; return true; },
    close: async () => {},
    renderPdf: async () => {},
  };
}

const oneField = [{ key: 'motivation', label: 'why do you want this job', name: 'motivation', required: true, kind: 'text' }];

test('the pipeline reaches the LLM through deps when a field is unmatched', async () => {
  let called = 0;
  const { result } = await applyJob(makeDeps({
    driverFactory: async () => makeDriver(oneField),
    chatCompletion: async () => { called++; return JSON.stringify([{ key: 'motivation', value: 'because' }]); },
  }));
  assert.equal(called, 1, 'chatCompletion must be callable via deps, not cfg');
  assert.equal(result.submitted, false);
});

test('the pipeline resolves the CV path from deps, not from tailoring', async () => {
  // CV tailoring was removed — the static cv.pdf is used directly. Career-ops
  // generates tailored CVs independently via its pdf mode.
  const { ctx } = await applyJob(makeDeps({
    driverFactory: async () => makeDriver(oneField),
    resumePath: 'cv-static.pdf',
  }));
  assert.equal(ctx.tailoredResumePath, 'cv-static.pdf', 'resume path comes from deps.resumePath');
  assert.ok(ctx.tailoredResumePath, 'a resume path is always resolved');
});

test('the pipeline logs the board protections from the guard stage', async () => {
  const lines = [];
  const log = { info: (e, f) => lines.push([e, f]), warn() {}, error() {}, debug() {} };
  await applyJob(makeDeps({ log, driverFactory: async () => makeDriver(oneField) }));
  const guardLine = lines.find(([e]) => e === 'board.protections');
  assert.ok(guardLine, 'the guard stage must report what the board enforces');
  assert.match(guardLine[1].protections, /recaptcha \(enforced on submit\)/);
});

test('a bot check that blocks submit stops the pipeline before any click', async () => {
  let submits = 0;
  const deps = makeDeps({
    driverFactory: async () => {
      const d = makeDriver(oneField);
      d.submitApplication = async () => { submits++; return { clicked: true, success: true, errors: [] }; };
      return d;
    },
  });
  deps.cfg = { ...deps.cfg, autoApprove: false, approveSubmit: true, preEdits: [] };
  const { trace, result } = await applyJob(deps);
  assert.equal(submits, 0, 'a board-enforced bot check must not be clicked through');
  const submitEntry = trace.find((t) => t.stage === STAGE.SUBMIT);
  assert.equal(submitEntry.status, 'skipped');
  assert.match(submitEntry.reason, /human must press the final control/);
  assert.equal(result.submitted, false);
});

test('a configured solver buys the token and the click goes through', async () => {
  const rec = {};
  let submits = 0;
  const deps = makeDeps({
    driverFactory: async () => {
      const d = makeDriver(oneField, rec);
      d.submitApplication = async () => { submits++; return { clicked: true, success: true, errors: [] }; };
      return d;
    },
  });
  deps.cfg = {
    ...deps.cfg, autoApprove: false, approveSubmit: true, preEdits: [],
    captcha: { order: ['capsolver', '2captcha'], keys: { capsolver: 'test-key' }, pollMs: 0 },
  };

  // Fake the solving service: accept the job, hand back a token immediately.
  const realFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    if (String(url).includes('createTask')) {
      return { ok: true, status: 200, json: async () => ({ errorId: 0, taskId: 'task-9' }) };
    }
    return { ok: true, status: 200, json: async () => ({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'SOLVED-TOKEN' } }) };
  };
  try {
    const { trace, result } = await applyJob(deps);
    assert.equal(result.submitted, true);
    assert.equal(submits, 1, 'with a solved token the board is clicked exactly once');
    assert.equal(rec.injected, 'SOLVED-TOKEN', 'the token must land in the form before the click');
    assert.ok(fetchCalls.some((u) => /createTask/.test(u)), 'the job was submitted to the service');
    const submitEntry = trace.find((t) => t.stage === STAGE.SUBMIT);
    assert.equal(submitEntry.status, 'ok');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a captcha-failed 428 that names a recipient is the code step, not a rejection', async () => {
  const rec = {};
  let submits = 0;
  // First submit: the board answers 428 captcha-failed and names the recipient.
  // Retry after the code: confirmed.
  let first = true;
  const deps = makeDeps({
    driverFactory: async () => {
      const d = makeDriver(oneField, rec);
      d.submitApplication = async () => {
        submits += 1;
        if (first) {
          first = false;
          return {
            clicked: true, errors: [], success: false, securityCode: false,
            boardError: { status: 428, code: 'captcha-failed', message: 'Oops! We were unable to verify your Captcha response.', securityCodeRecipient: 'applicant@test' },
          };
        }
        return { clicked: true, errors: [], success: true };
      };
      return d;
    },
  });
  deps.cfg = {
    ...deps.cfg, autoApprove: false, approveSubmit: true, preEdits: [],
    captcha: { order: ['capsolver'], keys: { capsolver: 'test-key' }, pollMs: 0 },
  };
  deps.fetchSecurityCode = async () => 'A33S0V4A';

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('createTask')) {
      return { ok: true, status: 200, json: async () => ({ errorId: 0, taskId: 'task-1' }) };
    }
    return { ok: true, status: 200, json: async () => ({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'SOLVED-TOKEN' } }) };
  };
  try {
    const { result } = await applyJob(deps);
    // The code completed the application on the retry.
    assert.equal(result.submitted, true);
    assert.equal(submits, 2, 'submit runs once for the form, once for the code');
    assert.equal(rec.securityCode, 'A33S0V4A', 'the emailed code was typed into the board\'s field');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a code the email cannot supply is an honest failure, not a fake success', async () => {
  const rec = {};
  let submits = 0;
  const deps = makeDeps({
    driverFactory: async () => {
      const d = makeDriver(oneField, rec);
      d.submitApplication = async () => {
        submits += 1;
        return {
          clicked: true, errors: [], success: false, securityCode: false,
          boardError: { status: 428, code: 'captcha-failed', message: 'unverified', securityCodeRecipient: 'applicant@test' },
        };
      };
      return d;
    },
  });
  deps.cfg = {
    ...deps.cfg, autoApprove: false, approveSubmit: true, preEdits: [],
    captcha: { order: ['capsolver'], keys: { capsolver: 'test-key' }, pollMs: 0 },
  };
  deps.fetchSecurityCode = async () => null;

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('createTask')) {
      return { ok: true, status: 200, json: async () => ({ errorId: 0, taskId: 'task-1' }) };
    }
    return { ok: true, status: 200, json: async () => ({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'SOLVED-TOKEN' } }) };
  };
  try {
    const { result } = await applyJob(deps);
    assert.equal(result.submitted, false);
    assert.equal(submits, 1, 'no pointless resubmit without a code');
    assert.match(result.error, /security code required/i);
    assert.match(result.error, /applicant@test/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a solver failure is a typed bot-check failure, not a silent skip', async () => {
  // first_name is answerable from the example profile, so the run reaches the
  // SUBMIT stage without any LLM call.
  const nameField = [{ key: 'first_name', label: 'first name', name: 'first_name', required: true, kind: 'text' }];
  const deps = makeDeps({ driverFactory: async () => makeDriver(nameField) });
  deps.cfg = {
    ...deps.cfg, autoApprove: false, approveSubmit: true, preEdits: [],
    captcha: { order: ['capsolver'], keys: { capsolver: 'test-key' }, pollMs: 0 },
  };
  // The service refuses the job outright.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ errorId: 12, errorDescription: 'ERROR_ZERO_BALANCE' }) });
  try {
    const res = await runApplication({
      url: deps.url,
      profilePath: 'config/profile.example.yml',
      cvPath: 'cv.example.md',
      cfg: { ...deps.cfg, browser: { channel: 'x', profileDir: 'p' }, limits: { captchaVisionAttempts: 1, dailySubmitCap: 5 }, vision: {} },
      approveSubmit: true,
      archiveDir: null,
      log: silentLog(),
      driverFactory: async () => makeDriver(nameField),
    });
    assert.equal(res.submitted, false);
    assert.equal(res.reason, REASON.BOT_CHECK);
    assert.match(res.error, /ERROR_ZERO_BALANCE|captcha solving failed/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the driver is closed even when a stage throws', async () => {
  let closed = 0;
  const res = await runApplication({
    url: 'https://boards.greenhouse.io/acme/jobs/12',
    profilePath: 'config/profile.example.yml',
    cvPath: 'cv.example.md',
    cfg: { llm: { baseUrl: 'x', apiKey: '', model: 'm' }, browser: { channel: 'x', profileDir: 'p' }, limits: { captchaVisionAttempts: 1, dailySubmitCap: 5 }, vision: {} },
    dryRun: true,
    archiveDir: null,
    log: silentLog(),
    driverFactory: async () => ({
      page: { evaluate: async () => { throw new Error('boom'); } },
      goto: async () => {},
      extractFields: async () => { throw new Error('extractor blew up'); },
      close: async () => { closed++; },
    }),
  });
  assert.equal(closed, 1, 'the browser must not leak on failure');
  assert.equal(res.submitted, false);
  assert.equal(res.reason, REASON.EXTRACTION);
  assert.ok(res.remediation, 'a typed failure must tell the user what to do next');
});

test('the run trace names every stage in order', async () => {
  const { trace } = await applyJob(makeDeps({ driverFactory: async () => makeDriver(oneField) }));
  const names = trace.map((t) => t.stage);
  for (const s of STAGE_ORDER) assert.ok(names.includes(s), `trace is missing ${s}`);
  // Order is the contract of the workflow, not an accident of map().
  const seen = names.filter((n) => STAGE_ORDER.indexOf(n) >= 0);
  assert.deepEqual(seen, [...STAGE_ORDER].filter((s) => seen.includes(s)));
});

test('resolveBoard is the single entry point from URL to adapter and endpoints', () => {
  const reg = createRegistry([greenhouseAdapter]);
  const { adapter, board } = resolveBoard(reg, 'https://job-boards.greenhouse.io/monzo/jobs/8222576');
  assert.equal(adapter.name, 'greenhouse');
  assert.equal(board.jobId, '8222576');
  // The declared submit target is the board's own form endpoint.
  assert.match(adapter.endpoints(board).submit(), /^https:\/\/boards\.greenhouse\.io\/monzo\/jobs\/8222576$/);
});

test('the job title is read from the page, not guessed from the URL', async () => {
  const { ctx } = await applyJob(makeDeps({ driverFactory: async () => makeDriver(oneField) }));
  assert.equal(ctx.roleTitle, 'Software Engineer at Monzo', 'the human-readable title must come from the page');
  assert.ok(ctx.board.jobId, 'the id still comes from the URL');
});

test('remediationFor always returns actionable text', () => {
  for (const reason of Object.values(REASON)) {
    const text = remediationFor(reason);
    assert.ok(text && text.length > 10, `reason ${reason} has no useful remediation`);
  }
});

/* ------------------------------------------------------- telegram wiring */

/** A bot that records what it was sent and replies with a scripted decision. */
function fakeTelegram(replies = []) {
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
      const next = replies[i++];
      return next ? [next] : [];
    },
    async downloadVoice() { return new Uint8Array([1]); },
  };
}

const goUpdate = { updateId: 1, text: 'go', voiceFileId: '', data: null, replyToMessageId: 0, date: 0 };
const noUpdate = { updateId: 1, text: 'no', voiceFileId: '', data: null, replyToMessageId: 0, date: 0 };

test('a configured bot takes over the review gate: a go submits', async () => {
  const telegram = fakeTelegram([goUpdate]);
  const { ctx, result } = await applyJob(makeDeps({
    driverFactory: async () => makeDriver(oneField),
    cfg: { ...makeDeps().cfg, autoApprove: false, approveSubmit: false, telegram: { timeoutMs: 10_000 } },
    telegram,
  }));
  assert.ok(telegram.sent.some((s) => /Application ready for your review/.test(s.text)), 'the summary went to Telegram');
  assert.equal(ctx.approved, true, 'the go approved the run');
});

test('a no from the phone aborts â€” nothing is submitted', async () => {
  const telegram = fakeTelegram([noUpdate]);
  const { ctx, result } = await applyJob(makeDeps({
    driverFactory: async () => makeDriver(oneField),
    cfg: { ...makeDeps().cfg, autoApprove: false, approveSubmit: false, telegram: { timeoutMs: 10_000 } },
    telegram,
  }));
  assert.equal(ctx.approved, false);
  assert.equal(result.submitted, false);
  assert.ok(telegram.sent.some((s) => /Aborted/.test(s.text)));
});

test('without a bot the terminal gate still stands: autoApprove never submits', async () => {
  const { ctx, result } = await applyJob(makeDeps({ driverFactory: async () => makeDriver(oneField) }));
  assert.equal(ctx.approved, false, 'autoApprove renders the review without approving');
  assert.equal(result.submitted, false);
});

test('an explicit --submit still works with no bot configured', async () => {
  const { ctx } = await applyJob(makeDeps({
    driverFactory: async () => makeDriver(oneField),
    cfg: { ...makeDeps().cfg, autoApprove: false, approveSubmit: true },
  }));
  assert.equal(ctx.approved, true, 'the terminal path approves without any Telegram hop');
});

/* ------------------------------------------------------------ pipeline core */

test('runPipeline stops at the first failure and preserves the partial trace', async () => {
  const pipeline = definePipeline([
    { name: 'resolve', run: async () => ({ a: 1 }) },
    { name: 'guard', run: async () => { throw new StageFailure('guard', REASON.BOT_CHECK, 'nope'); } },
    { name: 'open', run: async () => { throw new Error('open must not run'); } },
  ]);
  let err;
  try {
    await runPipeline({ pipeline, ctx: {}, log: silentLog() });
  } catch (e) { err = e; }

  assert.ok(err instanceof StageFailure, 'a typed failure propagates');
  assert.equal(err.reason, REASON.BOT_CHECK);
  // Stages after the failure are never attempted.
  assert.deepEqual(err.trace.map((t) => t.stage), ['resolve', 'guard']);
  assert.equal(err.trace[0].status, 'ok');
  assert.equal(err.trace[1].status, 'failed');
  assert.equal(err.trace[1].detail, 'nope');
});

test('a non-typed error is wrapped so the reason is always machine-readable', async () => {
  const pipeline = definePipeline([
    { name: 'resolve', run: async () => { throw new TypeError('cannot read x of undefined'); } },
  ]);
  await assert.rejects(
    () => runPipeline({ pipeline, ctx: {}, log: silentLog() }),
    (e) => e instanceof StageFailure && e.reason === REASON.ERROR && /undefined/.test(e.detail),
  );
});

test('an optional stage records its failure and the pipeline continues', async () => {
  const pipeline = definePipeline([
    { name: 'resolve', run: async () => ({ a: 1 }) },
    { name: 'guard', optional: true, run: async () => { throw new Error('cosmetic'); } },
    { name: 'open', run: async () => ({ b: 2 }) },
  ]);
  const { ctx, trace } = await runPipeline({ pipeline, ctx: {}, log: silentLog() });
  assert.equal(trace[1].status, 'failed');
  assert.equal(trace[2].status, 'ok');
  assert.equal(ctx.b, 2);
});

test('a stage can skip itself with a reason and the pipeline still completes', async () => {
  const pipeline = definePipeline([
    { name: 'resolve', run: async () => skip('nothing to do') },
    { name: 'guard', run: async () => ({ b: 2 }) },
  ]);
  const { ctx, trace } = await runPipeline({ pipeline, ctx: {}, log: silentLog() });
  assert.equal(trace[0].status, 'skipped');
  assert.equal(trace[1].status, 'ok');
  assert.equal(ctx.b, 2, 'a skip must not discard the rest of the run');
});

test('definePipeline refuses an empty pipeline and reports the stage order', () => {
  assert.throws(() => definePipeline([]), /at least one stage/);
  const p = buildApplyPipeline(makeDeps());
  assert.equal(p.stages[0].name, STAGE.RESOLVE);
  assert.equal(p.stages[p.stages.length - 1].name, STAGE.ARCHIVE);
});

test('a standing answer fills a guard field the mapper would leave blank', async () => {
  const fields = [
    { key: 'legal', label: 'legal name', name: 'legal_name', required: true, kind: 'text' },
    { key: 'ack', label: 'i confirm i have read the above', name: 'ack', required: true, kind: 'checkbox' },
  ];
  const answers = { byKey: new Map([
    ['legal name', 'Osamudiamen Edogun'],
    ['i confirm i have read the above', 'Yes'],
  ]), count: 2, exists: true, path: 'test' };
  const { ctx } = await applyJob(makeDeps({
    driverFactory: async () => makeDriver(fields),
    answers,
  }));
  const byLabel = Object.fromEntries(ctx.answers.map((a) => [a.field.label, a]));
  assert.equal(byLabel['i confirm i have read the above'].value, 'Yes');
  assert.equal(byLabel['i confirm i have read the above'].source, 'user');
  // The user answered it, but it is still their call to send: never unattended.
  assert.equal(byLabel['i confirm i have read the above'].needs_confirmation, true);
});

test('a standing answer cannot tick a radio option it does not name', async () => {
  // Answering "the arbitration question" must not light up an unrelated option.
  const fields = [
    { key: 'o1', label: 'yes', name: 'opt', kind: 'radio', group: 'g1', question: 'Do you accept the arbitration agreement?' },
    { key: 'o2', label: 'no', name: 'opt', kind: 'radio', group: 'g1', question: 'Do you accept the arbitration agreement?' },
  ];
  const answers = { byKey: new Map([['do you accept the arbitration agreement', 'Yes']]), count: 1, exists: true, path: 't' };
  const { ctx } = await applyJob(makeDeps({ driverFactory: async () => makeDriver(fields), answers }));
  const filled = ctx.answers.filter((a) => a.value);
  assert.equal(filled.length, 1, 'only the option the answer names');
  assert.equal(filled[0].field.label, 'yes');
});

test('a standing answer never leaves a radio group with two answers', async () => {
  const fields = [
    { key: 'o1', label: 'male', name: 'opt', kind: 'radio', group: 'g1', question: 'Gender identity' },
    { key: 'o2', label: 'female', name: 'opt', kind: 'radio', group: 'g1', question: 'Gender identity' },
  ];
  const answers = { byKey: new Map([['gender identity', 'female']]), count: 1, exists: true, path: 't' };
  const { ctx } = await applyJob(makeDeps({
    driverFactory: async () => makeDriver(fields),
    answers,
    profile: { name: 'Eli', identity: { first_name: 'Eli', last_name: 'D' }, cvText: 'cv', equality: { gender_identity: 'Man', auto_propose: true } },
  }));
  const filled = ctx.answers.filter((a) => a.value);
  assert.equal(filled.length, 1, 'one question, one answer');
  assert.equal(filled[0].field.label, 'female', 'the user answer wins over the profile');
});

test('a questions-only run fills nothing, uploads nothing and skips review', async () => {
  let filled = 0;
  let uploaded = 0;
  const driver = makeDriver(oneField);
  driver.fillFields = async () => { filled++; };
  driver.uploadFile = async () => { uploaded++; return true; };
  // A real directory, so the archive stage is skipped by the questions-only rule
  // rather than by there being nowhere to write. "Nothing was written" is the
  // promise this command makes, so it has to hold when there IS somewhere to
  // write to.
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoapply-questions-only-'));
  const { trace } = await applyJob(makeDeps({
    driverFactory: async () => driver,
    archiveDir,
    cfg: {
      ...makeDeps().cfg,
      questionsOnly: true,
      autoApprove: false,
    },
  }));
  assert.equal(filled, 0, 'nothing may be written to the page');
  assert.equal(uploaded, 0, 'nothing may be uploaded');
  const skipped = trace.filter((t) => t.status === 'skipped').map((t) => t.stage);
  for (const stage of ['fill', 'attach', 'review', 'archive']) {
    assert.ok(skipped.includes(stage), `${stage} must be skipped, got ${skipped.join(',')}`);
  }
  assert.deepEqual(fs.readdirSync(archiveDir), [], 'no evidence may be written');
  // The whole point is still to read the questions, so extract and plan must run.
  assert.ok(trace.some((t) => t.stage === 'plan' && t.status === 'ok'));
});
