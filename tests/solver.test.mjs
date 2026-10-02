import { test } from 'node:test';
import assert from 'node:assert/strict';

import { solveRecaptcha, solveRecaptchaWithFallback, extractSitekeyFromHtml, isEnterpriseRecaptchaHtml } from '../src/captcha/solver.mjs';

/**
 * The solving services are paid, so every network call here is faked. What
 * these tests pin down is the clients' own behaviour: submit a job, poll
 * until ready, fall through to the next provider on failure, and fail
 * loudly on every way a service can say no.
 */

const noSleep = async () => {};

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

/* ------------------------------------------------------------- CapSolver */

test('capsolver: submits a job and polls until the token arrives', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push([String(url), opts?.body ? JSON.parse(opts.body) : null]);
    if (url.includes('createTask')) return jsonResponse({ errorId: 0, taskId: 'task-7' });
    if (url.includes('getTaskResult')) return jsonResponse({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'CAP-TOKEN' } });
    throw new Error(`unexpected url ${url}`);
  };

  const token = await solveRecaptcha({
    provider: 'capsolver', apiKey: 'k', sitekey: 'sk', pageUrl: 'https://board.test/apply',
    fetchImpl, sleep: noSleep, pollMs: 0,
  });

  assert.equal(token, 'CAP-TOKEN');
  assert.equal(calls.length, 2);
  // The job carries the board's own details, and asks for the right product.
  assert.match(calls[0][0], /api\.capsolver\.com\/createTask$/);
  assert.equal(calls[0][1].clientKey, 'k');
  assert.equal(calls[0][1].task.type, 'ReCaptchaV2Task');
  assert.equal(calls[0][1].task.websiteKey, 'sk');
  assert.equal(calls[0][1].task.websiteURL, 'https://board.test/apply');
  assert.match(calls[1][0], /api\.capsolver\.com\/getTaskResult$/);
  assert.equal(calls[1][1].taskId, 'task-7');
});

test('capsolver: an enterprise board asks for the enterprise task type', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(opts?.body ? JSON.parse(opts.body) : null);
    if (url.includes('createTask')) return jsonResponse({ errorId: 0, taskId: 't' });
    return jsonResponse({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'T' } });
  };
  await solveRecaptcha({
    provider: 'capsolver', apiKey: 'k', sitekey: 'sk', pageUrl: 'u', enterprise: true,
    fetchImpl, sleep: noSleep, pollMs: 0,
  });
  assert.equal(calls[0].task.type, 'ReCaptchaV2EnterpriseTask');

  // And a plain v2 board must not claim enterprise.
  await solveRecaptcha({
    provider: 'capsolver', apiKey: 'k', sitekey: 'sk', pageUrl: 'u',
    fetchImpl, sleep: noSleep, pollMs: 0,
  });
  assert.equal(calls[2].task.type, 'ReCaptchaV2Task');
});

test('capsolver: keeps polling while the task is processing', async () => {
  let polls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('createTask')) return jsonResponse({ errorId: 0, taskId: 't' });
    polls += 1;
    return polls < 3
      ? jsonResponse({ errorId: 0, status: 'processing' })
      : jsonResponse({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'OK' } });
  };
  const token = await solveRecaptcha({
    provider: 'capsolver', apiKey: 'k', sitekey: 'sk', pageUrl: 'u',
    fetchImpl, sleep: noSleep, pollMs: 0,
  });
  assert.equal(token, 'OK');
  assert.equal(polls, 3);
});

test('capsolver: a refusal at submit is surfaced, not swallowed', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('createTask')) return jsonResponse({ errorId: 12, errorDescription: 'ERROR_KEY_DOES_NOT_EXIST' });
    throw new Error('getTaskResult should not be reached');
  };
  await assert.rejects(
    () => solveRecaptcha({ provider: 'capsolver', apiKey: 'bad', sitekey: 'sk', pageUrl: 'u', fetchImpl, sleep: noSleep, pollMs: 0 }),
    /ERROR_KEY_DOES_NOT_EXIST/,
  );
});

test('capsolver: a failure mid-poll is surfaced', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('createTask')) return jsonResponse({ errorId: 0, taskId: 't' });
    return jsonResponse({ errorId: 16, errorDescription: 'ERROR_ZERO_BALANCE' });
  };
  await assert.rejects(
    () => solveRecaptcha({ provider: 'capsolver', apiKey: 'k', sitekey: 'sk', pageUrl: 'u', fetchImpl, sleep: noSleep, pollMs: 0 }),
    /ERROR_ZERO_BALANCE/,
  );
});

/* -------------------------------------------------------------- 2Captcha */

test('2captcha: submits a job and polls until the token arrives', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (url.includes('in.php')) return jsonResponse({ status: 1, request: 'job-7' });
    if (url.includes('res.php')) return jsonResponse({ status: 1, request: 'TOKEN-XYZ' });
    throw new Error(`unexpected url ${url}`);
  };

  const token = await solveRecaptcha({
    provider: '2captcha', apiKey: 'k', sitekey: 'sk', pageUrl: 'https://board.test/apply',
    fetchImpl, sleep: noSleep, pollMs: 0,
  });

  assert.equal(token, 'TOKEN-XYZ');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /in\.php\?/);
  assert.match(calls[0], /googlekey=sk/);
  assert.match(calls[0], /pageurl=https%3A%2F%2Fboard.test%2Fapply/);
  assert.match(calls[1], /res\.php\?/);
  assert.match(calls[1], /id=job-7/);
});

test('2captcha: an enterprise board is solved as enterprise', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (url.includes('in.php')) return jsonResponse({ status: 1, request: 'job-e' });
    return jsonResponse({ status: 1, request: 'ENT-TOKEN' });
  };

  await solveRecaptcha({
    provider: '2captcha', apiKey: 'k', sitekey: 'sk', pageUrl: 'u', enterprise: true,
    fetchImpl, sleep: noSleep, pollMs: 0,
  });
  assert.match(calls[0], /enterprise=1/);

  // And a plain v2 board must not claim enterprise.
  await solveRecaptcha({
    provider: '2captcha', apiKey: 'k', sitekey: 'sk', pageUrl: 'u',
    fetchImpl, sleep: noSleep, pollMs: 0,
  });
  assert.match(calls.filter((c) => c.includes('in.php')).pop(), /enterprise=0/);
});

test('2captcha: keeps polling while the service says not ready', async () => {
  let polls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('in.php')) return jsonResponse({ status: 1, request: 'job-1' });
    polls += 1;
    return polls < 3
      ? jsonResponse({ status: 0, request: 'CAPCHA_NOT_READY' })
      : jsonResponse({ status: 1, request: 'OK' });
  };

  const token = await solveRecaptcha({
    provider: '2captcha', apiKey: 'k', sitekey: 'sk', pageUrl: 'u',
    fetchImpl, sleep: noSleep, pollMs: 0,
  });
  assert.equal(token, 'OK');
  assert.equal(polls, 3);
});

test('2captcha: surfaces a job the service refuses to accept', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('in.php')) return jsonResponse({ status: 0, request: 'ERROR_WRONG_USER_KEY' });
    throw new Error('res.php should not be reached');
  };
  await assert.rejects(
    () => solveRecaptcha({ provider: '2captcha', apiKey: 'k', sitekey: 'sk', pageUrl: 'u', fetchImpl, sleep: noSleep, pollMs: 0 }),
    /ERROR_WRONG_USER_KEY/,
  );
});

test('2captcha: surfaces a job that fails mid-poll', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('in.php')) return jsonResponse({ status: 1, request: 'job-2' });
    return jsonResponse({ status: 0, request: 'ERROR_CAPTCHA_TIMEOUT' });
  };
  await assert.rejects(
    () => solveRecaptcha({ provider: '2captcha', apiKey: 'k', sitekey: 'sk', pageUrl: 'u', fetchImpl, sleep: noSleep, pollMs: 0 }),
    /ERROR_CAPTCHA_TIMEOUT/,
  );
});

test('a provider gives up after the deadline', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('in.php')) return jsonResponse({ status: 1, request: 'job-3' });
    return jsonResponse({ status: 0, request: 'CAPCHA_NOT_READY' });
  };
  await assert.rejects(
    () => solveRecaptcha({
      provider: '2captcha', apiKey: 'k', sitekey: 'sk', pageUrl: 'u',
      fetchImpl, sleep: noSleep, pollMs: 0, timeoutMs: 50,
    }),
    /did not solve within/,
  );
});

test('an unknown provider name is refused before any network call', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; return jsonResponse({ status: 1, request: 'x' }); };
  await assert.rejects(
    () => solveRecaptcha({ provider: 'wecaptcha', apiKey: 'k', sitekey: 'sk', pageUrl: 'u', fetchImpl, sleep: noSleep }),
    /unknown captcha provider "wecaptcha"/,
  );
  assert.equal(called, 0);
});

test('a solve needs a key and a sitekey before any network call', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; return jsonResponse({ status: 1, request: 'x' }); };
  await assert.rejects(() => solveRecaptcha({ sitekey: 'sk', pageUrl: 'u', fetchImpl, sleep: noSleep }), /needs an API key/);
  await assert.rejects(() => solveRecaptcha({ apiKey: 'k', pageUrl: 'u', fetchImpl, sleep: noSleep }), /sitekey/);
  assert.equal(called, 0, 'a missing input must not cost money');
});

/* --------------------------------------------------------------- fallback */

test('the fallback chain moves to the next provider when the first fails', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(String(url));
    if (url.includes('createTask')) return jsonResponse({ errorId: 11, errorDescription: 'ERROR_KEY_DOES_NOT_EXIST' });
    if (url.includes('in.php')) return jsonResponse({ status: 1, request: 'job-2' });
    return jsonResponse({ status: 1, request: 'FALLBACK-TOKEN' });
  };

  const { token, provider } = await solveRecaptchaWithFallback({
    providers: [
      { name: 'capsolver', apiKey: 'bad' },
      { name: '2captcha', apiKey: 'good' },
    ],
    sitekey: 'sk', pageUrl: 'u',
    fetchImpl, sleep: noSleep, pollMs: 0,
  });

  assert.equal(token, 'FALLBACK-TOKEN');
  assert.equal(provider, '2captcha');
  assert.ok(calls.some((c) => c.includes('createTask')), 'the first provider was tried');
  assert.ok(calls.some((c) => c.includes('in.php')), 'the second provider was tried');
});

test('the first provider that succeeds wins; the rest are not paid', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (url.includes('createTask')) return jsonResponse({ errorId: 0, taskId: 't' });
    return jsonResponse({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'FIRST-TOKEN' } });
  };

  const { token, provider } = await solveRecaptchaWithFallback({
    providers: [
      { name: 'capsolver', apiKey: 'a' },
      { name: '2captcha', apiKey: 'b' },
    ],
    sitekey: 'sk', pageUrl: 'u',
    fetchImpl, sleep: noSleep, pollMs: 0,
  });

  assert.equal(token, 'FIRST-TOKEN');
  assert.equal(provider, 'capsolver');
  assert.equal(calls.filter((c) => c.includes('in.php')).length, 0, '2captcha was never called');
});

test('every provider failing is reported with each reason', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('createTask')) return jsonResponse({ errorId: 12, errorDescription: 'ERROR_ZERO_BALANCE' });
    if (url.includes('in.php')) return jsonResponse({ status: 0, request: 'ERROR_WRONG_USER_KEY' });
    throw new Error(`unexpected ${url}`);
  };
  await assert.rejects(
    () => solveRecaptchaWithFallback({
      providers: [
        { name: 'capsolver', apiKey: 'a' },
        { name: '2captcha', apiKey: 'b' },
        { name: 'wecaptcha', apiKey: 'c' },
      ],
      sitekey: 'sk', pageUrl: 'u',
      fetchImpl, sleep: noSleep, pollMs: 0,
    }),
    (e) => {
      assert.match(e.message, /every captcha provider failed/);
      assert.match(e.message, /capsolver: .*ERROR_ZERO_BALANCE/);
      assert.match(e.message, /2captcha: .*ERROR_WRONG_USER_KEY/);
      assert.match(e.message, /wecaptcha: unknown provider/);
      return true;
    },
  );
});

/* ------------------------------------------------------- sitekey extraction */

test('the sitekey is found in every shape boards embed it', () => {
  // 1. the standard widget div
  assert.equal(
    extractSitekeyFromHtml('<div class="g-recaptcha" data-sitekey="6LeAAAAAAAAAAAAAAAAAAAAAAB"></div>'),
    '6LeAAAAAAAAAAAAAAAAAAAAAAB',
  );
  // 2. the classic anchor iframe Google injects
  assert.equal(
    extractSitekeyFromHtml('<iframe src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=6LeBBBBBBBBBBBBBBBBBBBBB&co=a"></iframe>'),
    '6LeBBBBBBBBBBBBBBBBBBBBB',
  );
  // 3. the api.js render parameter
  assert.equal(
    extractSitekeyFromHtml('<script src="https://www.google.com/recaptcha/api.js?render=6LeCCCCCCCCCCCCCCCCCCCCC"></script>'),
    '6LeCCCCCCCCCCCCCCCCCCCCC',
  );
  // 4. the Enterprise anchor served from recaptcha.net — the shape Greenhouse
  //    actually uses on live Monzo forms.
  assert.equal(
    extractSitekeyFromHtml('<iframe src="https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=6LfmcbcpAAAAAChNTbhUShzUOAMj_wY9LQIvLFX0&co=aHR0cHM6Ly9qb2ItYm9hcmRzLmdyZWVuaG91c2UuaW86NDQz&hl=en&v=abc&size=invisible"></iframe>'),
    '6LfmcbcpAAAAAChNTbhUShzUOAMj_wY9LQIvLFX0',
  );
  // 5. the Enterprise script
  assert.equal(
    extractSitekeyFromHtml('<script src="https://www.google.com/recaptcha/enterprise.js?render=6LeDDDDDDDDDDDDDDDDDDDDD"></script>'),
    '6LeDDDDDDDDDDDDDDDDDDDDD',
  );
  // 6. serialized HTML escapes & to &amp; — the anchor param still matches
  assert.equal(
    extractSitekeyFromHtml('<iframe src="https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&amp;k=6LeEEEEEEEEEEEEEEEEEEEEE&amp;co=a"></iframe>'),
    '6LeEEEEEEEEEEEEEEEEEEEEE',
  );
});

test('an enterprise board is detected as enterprise', () => {
  assert.equal(isEnterpriseRecaptchaHtml('<iframe src="https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=6Le"></iframe>'), true);
  assert.equal(isEnterpriseRecaptchaHtml('<script src="https://www.google.com/recaptcha/enterprise.js?render=6Le"></script>'), true);
  assert.equal(isEnterpriseRecaptchaHtml('<iframe src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Le"></iframe>'), false);
  assert.equal(isEnterpriseRecaptchaHtml('<div class="g-recaptcha" data-sitekey="6Le"></div>'), false);
});

test('a page with no reCAPTCHA yields an empty sitekey, not a guess', () => {
  assert.equal(extractSitekeyFromHtml('<form><input name="q"></form>'), '');
  assert.equal(extractSitekeyFromHtml(''), '');
});

test('a lookalike attribute is not mistaken for a sitekey', () => {
  assert.equal(extractSitekeyFromHtml('<div data-sitekey="too-short"></div>'), '');
});
