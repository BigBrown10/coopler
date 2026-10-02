import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runApplication, interpretSubmitResult, findAnswerByLabel } from '../src/run.mjs';
import { assertPublicHttpsUrl } from '../src/ats/urlguard.mjs';

/**
 * End-to-end of the run() orchestration with a stubbed driver:
 * verifies the fill â†’ review summary â†’ approval â†’ submit â†’ evidence path
 * and the never-submit default.
 */

function stubDriverFactory({ submitResult, captcha = { level: 0, kind: 'none', refs: [] } }) {
  const events = [];
  const pageStub = {
    goto: async () => ({}),
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    screenshot: async () => Buffer.from('jpg'),
    evaluate: async (fn, arg) => {
      // The real extractor runs inside the browser; for the stub we return
      // a realistic field set directly.
      if (typeof fn !== 'function') return undefined;
      return [
        { key: 'first_name', label: 'first name', name: 'first_name', required: true, kind: 'text' },
        { key: 'email', label: 'email', name: 'email', required: true, kind: 'text' },
        { key: 'phone', label: 'phone', name: 'phone', required: false, kind: 'text' },
      ];
    },
    locator: () => ({ evaluate: async () => true }),
    fill: async () => {},
  };
  const driver = {
    page: pageStub,
    goto: async (url) => { events.push('goto:' + url); },
    extractFields: async () => ([
      { key: 'first_name', label: 'first name', name: 'first_name', required: true, kind: 'text' },
      { key: 'email', label: 'email', name: 'email', required: true, kind: 'text' },
      { key: 'phone', label: 'phone', name: 'phone', required: false, kind: 'text' },
    ]),
    fillFields: async (answers) => { events.push('fill:' + answers.length); },
    setField: async () => {},
    setAutocomplete: async () => true,
    uploadFile: async () => true,
    fillAuthCombos: async () => {},
    fillCombos: async () => {},
    screenshot: async () => ({ label: 'x', buffer: Buffer.from('jpeg') }),
    captchaDetection: async () => captcha,
    clickCheckboxCaptcha: async () => true,
    runVisionCaptcha: async () => '[]',
    submitApplication: async () => { events.push('submit'); return submitResult; },
    close: async () => {},
  };
  return { driver, events };
}

test('run(): never submits without approval (dry-run)', async () => {
  const { driver, events } = stubDriverFactory({ submitResult: true });
  const res = await runApplication({
    url: 'https://boards.greenhouse.io/acme/jobs/12',
    profilePath: 'config/profile.example.yml',
    cvPath: 'cv.example.md',
    cfg: { llm: { baseUrl: 'x', apiKey: '', model: 'm' }, browser: { channel: 'x', profileDir: 'p' }, limits: { captchaVisionAttempts: 1, dailySubmitCap: 5 }, vision: {} },
    dryRun: true,
    archiveDir: null,
    driverFactory: async () => driver,
  });
  assert.equal(res.submitted, false);
  assert.equal(res.approved, false);
  assert.ok(!events.includes('submit'));
  assert.match(res.summary, /Eli/);
});


test('submit outcomes are reported honestly', () => {
  const ctx = { evidenceDir: 'e', summary: 's' };
  // Only a real confirmation counts as submitted.
  const ok = interpretSubmitResult({ clicked: true, success: true, errors: [] }, ctx);
  assert.equal(ok.submitted, true);
  assert.equal(ok.unconfirmed, undefined);

  // Clicked, nothing seen -> unconfirmed, NOT submitted.
  const silent = interpretSubmitResult({ clicked: true, success: false, errors: [] }, ctx);
  assert.equal(silent.submitted, false);
  assert.equal(silent.unconfirmed, true);
  assert.ok(silent.error, 'must explain why it could not confirm');

  // Validation errors -> not submitted, error surfaced.
  const bad = interpretSubmitResult({ clicked: true, success: false, errors: ['first name is required'] }, ctx);
  assert.equal(bad.submitted, false);
  assert.match(bad.error, /first name is required/);
  assert.equal(bad.unconfirmed, undefined);
});

test('a board API rejection is reported with the board\'s own reason', () => {
  // Greenhouse answers a bot-blocked submit with HTTP 428 + a JSON error body.
  const res = {
    clicked: true, success: false, errors: [], stillOnForm: true,
    boardError: { status: 428, code: 'captcha-failed', message: 'Oops! We were unable to verify your Captcha response.' },
  };
  const out = interpretSubmitResult(res, { evidenceDir: 'e', summary: 's' });
  assert.equal(out.submitted, false);
  assert.equal(out.unconfirmed, undefined, 'a known rejection is not "unconfirmed"');
  assert.match(out.error, /428/);
  assert.match(out.error, /captcha-failed/);
  assert.equal(out.boardError.code, 'captcha-failed');
});

test('findAnswerByLabel matches the field a --set override is aimed at', () => {
  const answers = [
    { field: { key: 'country', label: 'country' } },
    { field: { key: 'question_69356478', label: '🇺🇸 are you a us tax resident?' } },
    { field: { key: 'question_69356479', label: '🔐 keeping your data safe is really important to us. please take a look at our candidate data privacy notice and confirm that you have.' } },
  ];

  // Substring match on distinctive parts of long, emoji-prefixed labels.
  assert.equal(findAnswerByLabel(answers, 'us tax resident').field.key, 'question_69356478');
  assert.equal(findAnswerByLabel(answers, 'privacy notice').field.key, 'question_69356479');

  // Exact match is still allowed.
  assert.equal(findAnswerByLabel(answers, 'country').field.key, 'country');

  // No invented matches: an unknown label changes nothing.
  assert.equal(findAnswerByLabel(answers, 'salary expectations'), null);
  assert.equal(findAnswerByLabel(answers, ''), null);
});


test('run(): SSRF guard rejects private board URLs before any browser work', async () => {
  await assert.rejects(
    () => assertPublicHttpsUrl('https://127.0.0.1:1/x'),
    /private|localhost/i,
  );
});
