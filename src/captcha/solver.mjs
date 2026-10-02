/**
 * Paid captcha solving, with interchangeable providers and fallback.
 *
 * The board verifies the reCAPTCHA server-side on its POST, so passing the
 * checkbox is not enough: the form needs a valid `g-recaptcha-response`
 * token. This module obtains one through a solving service and hands it to the
 * driver, which injects it before the submit click.
 *
 * Two providers are supported, and `solveRecaptchaWithFallback` tries them
 * in the configured order — if one rejects the job or times out, the next
 * gets it. CapSolver is cheaper and typically stronger on reCAPTCHA
 * Enterprise/invisible, so it goes first; 2Captcha is the long-standing
 * fallback with human workers for whatever the first cannot crack.
 *
 * Everything the services need is a sitekey and the page URL; the token is
 * returned as a string. All I/O is injectable so the tests never pay for a
 * solve.
 */

/* ------------------------------------------------------------- providers */

/** POST JSON, shared by the request/response-style APIs (CapSolver). */
async function postJson(fetchImpl, url, body) {
  const resp = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`solver endpoint returned HTTP ${resp.status}.`);
  return resp.json();
}

/** GET with query string, shared by the querystring-style APIs (2Captcha). */
async function getJson(fetchImpl, url, params) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const resp = await fetchImpl(`${url}?${qs}`);
  if (!resp.ok) throw new Error(`solver endpoint returned HTTP ${resp.status}.`);
  return resp.json();
}

const providers = {
  capsolver: {
    name: 'capsolver',
    // createTask/getTaskResult. Enterprise is a different product server-side:
    // the task type must say so, or the token comes back as plain v2 and the
    // board rejects it.
    async submit({ apiKey, sitekey, pageUrl, enterprise, fetchImpl }) {
      const resp = await postJson(fetchImpl, 'https://api.capsolver.com/createTask', {
        clientKey: apiKey,
        task: {
          type: enterprise ? 'ReCaptchaV2EnterpriseTask' : 'ReCaptchaV2Task',
          websiteURL: pageUrl,
          websiteKey: sitekey,
        },
      });
      if (resp.errorId !== 0) throw new Error(`capsolver refused the job: ${resp.errorDescription || resp.errorId}`);
      if (!resp.taskId) throw new Error('capsolver returned no taskId.');
      return resp.taskId;
    },
    async poll({ apiKey, jobId, fetchImpl }) {
      const resp = await postJson(fetchImpl, 'https://api.capsolver.com/getTaskResult', {
        clientKey: apiKey, taskId: jobId,
      });
      if (resp.errorId !== 0) {
        return { done: true, error: `capsolver failed the job: ${resp.errorDescription || resp.errorId}` };
      }
      if (resp.status === 'ready' && resp.solution && resp.solution.gRecaptchaResponse) {
        return { done: true, token: resp.solution.gRecaptchaResponse };
      }
      return { done: false }; // status "processing": keep polling
    },
  },

  '2captcha': {
    name: '2captcha',
    // The classic in.php/res.php protocol.
    async submit({ apiKey, sitekey, pageUrl, enterprise, fetchImpl }) {
      const resp = await getJson(fetchImpl, 'https://2captcha.com/in.php', {
        key: apiKey, method: 'userrecaptcha', googlekey: sitekey, pageurl: pageUrl,
        enterprise: enterprise ? 1 : 0, json: 1,
      });
      // in.php answers {status:1, request:"<job id>"}.
      if (resp.status !== 1) throw new Error(`2captcha refused the job: ${resp.request}`);
      return resp.request;
    },
    async poll({ apiKey, jobId, fetchImpl }) {
      const resp = await getJson(fetchImpl, 'https://2captcha.com/res.php', {
        key: apiKey, action: 'get', id: jobId, json: 1,
      });
      // res.php answers {status:0, request:"CAPCHA_NOT_READY"} until done,
      // then {status:1, request:"<token>"}.
      if (resp.status === 1) return { done: true, token: resp.request };
      if (resp.request !== 'CAPCHA_NOT_READY') {
        return { done: true, error: `2captcha failed the job: ${resp.request}` };
      }
      return { done: false };
    },
  },
};

/** Look up a provider by name (case-insensitive). */
export function getProvider(name) {
  return providers[String(name || '').toLowerCase()] || null;
}

/* ----------------------------------------------------------------- facade */

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function solveWithProvider(provider, opts) {
  const { apiKey, sitekey, pageUrl, enterprise, fetchImpl, sleep, pollMs, timeoutMs, log } = opts;
  if (!apiKey) throw new Error(`${provider.name} needs an API key.`);
  if (!sitekey) throw new Error('the page\'s reCAPTCHA sitekey was not found on the form.');

  const jobId = await provider.submit({ apiKey, sitekey, pageUrl, enterprise, fetchImpl });
  log?.info('captcha.solver_submitted', { provider: provider.name, jobId });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`${provider.name} did not solve within ${Math.round(timeoutMs / 1000)}s (job ${jobId}).`);
    }
    await sleep(pollMs);
    const r = await provider.poll({ apiKey, jobId, fetchImpl });
    if (!r.done) continue;
    if (r.error) throw new Error(r.error);
    log?.info('captcha.solver_solved', { provider: provider.name, jobId });
    return r.token;
  }
}

/**
 * Solve a reCAPTCHA through one named provider and return the response token.
 *
 * @param {object} opts
 * @param {string} [opts.provider='capsolver'] 'capsolver' or '2captcha'
 * @param {string} opts.apiKey      the provider's account key
 * @param {string} opts.sitekey    the page's reCAPTCHA sitekey
 * @param {string} opts.pageUrl     the URL the captcha protects
 * @param {boolean} [opts.enterprise=false] true for reCAPTCHA Enterprise
 * @param {Function} [opts.fetchImpl] injectable fetch (tests)
 * @param {Function} [opts.sleep]     injectable sleep (tests)
 * @param {number} [opts.pollMs=5000]
 * @param {number} [opts.timeoutMs=240000] enterprise invisible solves can be slow
 * @param {object} [opts.log]
 * @param {object} [opts.log]
 * @returns {Promise<string>} the `g-recaptcha-response` token
 */
export async function solveRecaptcha({
  provider = 'capsolver',
  apiKey,
  sitekey,
  pageUrl,
  enterprise = false,
  fetchImpl = fetch,
  sleep = defaultSleep,
  pollMs = 5000,
  timeoutMs = 240000,
  log,
} = {}) {
  const p = getProvider(provider);
  if (!p) throw new Error(`unknown captcha provider "${provider}" (known: ${Object.keys(providers).join(', ')}).`);
  return solveWithProvider(p, { apiKey, sitekey, pageUrl, enterprise, fetchImpl, sleep, pollMs, timeoutMs, log });
}

/**
 * Solve through a chain of providers, falling through on failure.
 *
 * @param {object} opts
 * @param {Array<{name: string, apiKey: string}>} opts.providers try order
 * @param {string} opts.sitekey
 * @param {string} opts.pageUrl
 * @param {boolean} [opts.enterprise=false]
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.sleep]
 * @param {number} [opts.pollMs=5000]
 * @param {number} [opts.timeoutMs=240000]
 * @param {object} [opts.log]
 * @returns {Promise<{token: string, provider: string}>}
 */
export async function solveRecaptchaWithFallback({
  providers: chain,
  sitekey,
  pageUrl,
  enterprise = false,
  fetchImpl = fetch,
  sleep = defaultSleep,
  pollMs = 5000,
  timeoutMs = 240000,
  log,
} = {}) {
  if (!sitekey) throw new Error('the page\'s reCAPTCHA sitekey was not found on the form.');
  const attempts = [];
  for (const entry of chain) {
    const p = getProvider(entry?.name);
    if (!p) {
      attempts.push(`${entry?.name}: unknown provider`);
      continue;
    }
    try {
      const token = await solveWithProvider(p, {
        apiKey: entry.apiKey, sitekey, pageUrl, enterprise, fetchImpl, sleep, pollMs, timeoutMs, log,
      });
      return { token, provider: p.name };
    } catch (e) {
      attempts.push(`${p.name}: ${e?.message || e}`);
      log?.warn('captcha.solver_failed', { provider: p.name, error: e?.message || String(e) });
    }
  }
  throw new Error(`every captcha provider failed — ${attempts.join(' | ')}`);
}

/* ------------------------------------------------------- sitekey extraction */

/**
 * Pull the reCAPTCHA sitekey out of a page's HTML.
 *
 * Boards embed it in any of several shapes; this checks all of them rather
 * than betting on one, because the shape is not part of any contract. Both
 * Google (`google.com`) and its mirror (`recaptcha.net`) are matched, and
 * both the classic (`api2/anchor`) and Enterprise (`enterprise/anchor`)
 * widget shapes, because Greenhouse serves Enterprise from recaptcha.net.
 *
 * @param {string} html
 * @returns {string} the sitekey, or '' when the page carries no reCAPTCHA
 */
export function extractSitekeyFromHtml(html) {
  const s = String(html || '');
  let m = s.match(/data-sitekey=["']([A-Za-z0-9_-]{20,})["']/);
  if (m) return m[1];
  // <iframe src=".../recaptcha/{api2|enterprise}/anchor?...&k=SITEKEY&...">
  // The anchor path is host-agnostic: Google serves classic widgets from
  // google.com and Enterprise from recaptcha.net, but the path shape is the
  // same. Matching the path (not the host) covers both. `&amp;` appears when
  // this runs over serialized HTML rather than a live attribute value.
  m = s.match(/recaptcha\/(?:api2\/)?(?:enterprise\/)?anchor[^"']*[?&](?:amp;)?k=([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  // <script src="https://www.google.com/recaptcha/api.js?render=SITEKEY">
  m = s.match(/recaptcha\/(?:api|enterprise)\.js\?render=([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  return '';
}

/**
 * Detect whether the page's reCAPTCHA is the Enterprise product.
 *
 * The token the service returns is only valid for the product the board
 * verifies against, so this decides what we ask the service to solve.
 *
 * @param {string} html
 * @returns {boolean}
 */
export function isEnterpriseRecaptchaHtml(html) {
  const s = String(html || '');
  return /recaptcha\/enterprise\/anchor/.test(s)
    || /recaptcha\/enterprise\.js/.test(s);
}
