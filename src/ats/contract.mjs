/**
 * The ATS adapter contract.
 *
 * Every supported job board is implemented as an adapter that satisfies this
 * interface. Nothing else in the codebase is allowed to know that Greenhouse
 * exists: the workflow talks to `adapter.endpoints` and `adapter.capabilities`,
 * never to a hostname or a CSS class.
 *
 * @typedef {Object} BoardContext
 * @property {string} ats              adapter name
 * @property {string} host             e.g. job-boards.greenhouse.io
 * @property {string} boardToken       e.g. "monzo"
 * @property {string} jobId            e.g. "8222576"
 * @property {string} jobUrl           canonical job page
 * @property {string} role             derived role slug
 * @property {string} company          derived company slug
 *
 * @typedef {Object} AtsEndpoints
 * @property {(ctx: BoardContext) => string} jobPage      GET  the job description
 * @property {(ctx: BoardContext) => string} application  GET  the form to fill
 * @property {(ctx: BoardContext) => string} submit       POST where a submission goes
 * @property {boolean} submitIsPublicApi  true only for a documented, non-browser API
 *
 * @typedef {Object} AtsCapabilities
 * @property {boolean} fileUpload        can attach a CV
 * @property {false|'recaptcha'|'hcaptcha'|'turnstile'} botCheck  which bot check, if any
 * @property {boolean} botCheckBlocksSubmit  true when the bot check is enforced server-side
 *                                            on submit, so an automated click is rejected
 * @property {boolean} securityCodeStep  a code is emailed to confirm the submission
 * @property {boolean} eoiQuestions      board collects equality/demographic data
 *
 * @typedef {Object} SubmitOutcome
 * @property {boolean} clicked
 * @property {boolean} success           a real confirmation was observed
 * @property {boolean} [securityCode]    a code prompt is now showing
 * @property {{status: number, code: string|null, message: string|null}|null} [boardError]
 * @property {string[]} errors
 * @property {string} [url]              page URL after the click
 * @property {string} [text]             page text after the click
 *
 * @typedef {Object} AtsAdapter
 * @property {string} name
 * @property {(hostname: string) => boolean} matches
 * @property {(url: string|URL) => BoardContext} resolve
 * @property {(ctx: BoardContext) => AtsEndpoints} endpoints  factory: endpoints depend on board + job id
 * @property {AtsCapabilities} capabilities
 * @property {(driver: object) => Promise<object[]>} extractFields
 * @property {(driver: object) => Promise<SubmitOutcome>} submit
 * @property {(outcome: SubmitOutcome) => boolean} isConfirmed
 */

/** Endpoint keys every adapter must declare. */
export const REQUIRED_ENDPOINTS = ['jobPage', 'application', 'submit'];

/** Capability keys every adapter must declare, with their default. */
export const DEFAULT_CAPABILITIES = Object.freeze({
  fileUpload: false,
  botCheck: false,
  botCheckBlocksSubmit: false,
  securityCodeStep: false,
  eoiQuestions: false,
});

/**
 * Recognised bot-check vendors. `false` also means "none".
 *
 * `datadome` is here to be declared, not solved: DataDome fingerprints the
 * browser and network before the form even renders, so a board behind it is
 * hand-ed to a human up front instead of being discovered as a mystery failure.
 */
export const BOT_CHECK_VENDORS = Object.freeze(['recaptcha', 'hcaptcha', 'turnstile', 'datadome']);

/**
 * Validate an adapter at registration time. Failing here means a malformed
 * adapter is a startup error, not a confusing runtime failure three stages in.
 * @param {AtsAdapter} adapter
 */
export function assertAdapter(adapter) {
  const bad = (msg) => {
    throw new Error(`Adapter contract violation: ${msg}`);
  };
  if (!adapter || typeof adapter !== 'object') bad('adapter must be an object');
  if (!adapter.name || typeof adapter.name !== 'string') bad('adapter.name must be a non-empty string');
  if (typeof adapter.matches !== 'function') bad(`${adapter.name}.matches must be a function`);
  if (typeof adapter.resolve !== 'function') bad(`${adapter.name}.resolve must be a function`);
  if (typeof adapter.extractFields !== 'function') bad(`${adapter.name}.extractFields must be a function`);
  if (typeof adapter.submit !== 'function') bad(`${adapter.name}.submit must be a function`);
  if (typeof adapter.isConfirmed !== 'function') bad(`${adapter.name}.isConfirmed must be a function`);

  // Endpoints are a factory: they depend on the board token and job id, so they
  // can only be validated per-board (see assertEndpoints below).
  if (typeof adapter.endpoints !== 'function') {
    bad(`${adapter.name}.endpoints must be a function (ctx) => endpoints`);
  }

  if (!adapter.capabilities || typeof adapter.capabilities !== 'object') bad(`${adapter.name}.capabilities missing`);
  for (const [key, dflt] of Object.entries(DEFAULT_CAPABILITIES)) {
    const v = adapter.capabilities[key];
    if (v === undefined) { bad(`${adapter.name}.capabilities.${key} missing`); continue; }
    // botCheck is the one union-typed capability: false, or which vendor it is.
    if (key === 'botCheck') {
      if (v !== false && !BOT_CHECK_VENDORS.includes(v)) {
        bad(`${adapter.name}.capabilities.botCheck must be false or one of ${BOT_CHECK_VENDORS.join(', ')}`);
      }
      continue;
    }
    if (typeof v !== typeof dflt) {
      bad(`${adapter.name}.capabilities.${key} must be a ${typeof dflt}, got ${typeof v}`);
    }
  }
  return adapter;
}

/** Validate the endpoints an adapter resolves for one specific board. */
export function assertEndpoints(adapter, ctx) {
  const bad = (msg) => { throw new Error(`Adapter contract violation: ${msg}`); };
  let resolved;
  try {
    resolved = adapter.endpoints(ctx);
  } catch (e) {
    bad(`${adapter.name}.endpoints threw for board "${ctx?.boardToken}": ${e?.message || e}`);
  }
  if (!resolved || typeof resolved !== 'object') bad(`${adapter.name}.endpoints returned no object`);
  for (const key of REQUIRED_ENDPOINTS) {
    if (typeof resolved[key] !== 'function') bad(`${adapter.name}.endpoints.${key} must be a function`);
  }
  if (typeof resolved.submitIsPublicApi !== 'boolean') {
    bad(`${adapter.name}.endpoints.submitIsPublicApi must be a boolean`);
  }
  // A board that blocks submits on a bot check and also claims a documented
  // public API is a contradiction; refuse it rather than fail confusingly later.
  if (adapter.capabilities.botCheckBlocksSubmit && resolved.submitIsPublicApi) {
    bad(`${adapter.name} declares both a blocking bot check and a public submit API`);
  }
  return resolved;
}
