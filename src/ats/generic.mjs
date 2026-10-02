/**
 * The generic board adapter.
 *
 * Most ATS boards are the same story for this tool: a public job page, a
 * plain form the driver's DOM walker can read, and a submit button that is
 * not verified by a server-side bot check. For those, an adapter is pure
 * declaration — hosts, URL shapes, and what the board enforces — and this
 * factory supplies the behaviour.
 *
 * Boards that differ structurally (Greenhouse's emailed security code,
 * Workday's iframe forms) declare it in `capabilities` and, when needed,
 * override the methods.
 */

import { assertPublicHttpsUrl } from './urlguard.mjs';

/**
 * @param {object} board
 * @param {string} board.name          registry key, e.g. 'ashby'
 * @param {string[]} board.hosts        exact hostnames this adapter owns
 * @param {string} board.hostPattern    substring a hostname must end with
 * @param {Function} board.resolve      (URL) => BoardContext
 * @param {object} board.endpoints      (ctx) => { jobPage, application, submit, submitIsPublicApi }
 * @param {object} board.capabilities    what the board enforces
 */
export function makeGenericAdapter({
  name,
  hosts,
  hostPattern,
  resolve,
  endpoints,
  capabilities,
  revealForm,
}) {
  const known = new Set(hosts.map((h) => h.toLowerCase()));

  function matches(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/^www\./, '');
    if (known.has(h)) return true;
    // Subdomain boards (acme.jobs.ashbyhq.com), but never a lookalike that
    // merely ends in the string: the suffix must be a domain boundary.
    return Boolean(hostPattern) && h.endsWith(`.${hostPattern}`);
  }

  return Object.freeze({
    name,
    matches,
    resolve,
    endpoints,
    capabilities: Object.freeze({
      fileUpload: true,
      botCheck: false,
      botCheckBlocksSubmit: false,
      securityCodeStep: false,
      eoiQuestions: false,
      // Not part of the contract, but read as a plain boolean by consumers.
      iframeForms: false,
      needsConsentWall: false,
      applyIsModal: false,
      ...capabilities,
    }),
    /**
     * Some boards show no form until you press their apply control (a modal, a
     * second route, a client-side render). A board that works that way declares
     * this; the run calls it only after extraction has already come back empty,
     * so a page that already shows its form is never clicked at.
     */
    revealForm: revealForm || null,
    /** The driver's DOM walk is board-agnostic by design. */
    async extractFields(driver) {
      return driver.extractFields();
    },
    /** Click the board's own submit control. */
    async submit(driver) {
      return driver.submitApplication();
    },
    /** A submission counts only on a real confirmation — no errors. */
    isConfirmed(outcome) {
      return Boolean(
        outcome && outcome.clicked && outcome.success &&
        (!outcome.errors || !outcome.errors.length),
      );
    },
  });
}

/**
 * Resolve a board context common to "one job per path segment" boards.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {Function} opts.toContext (u: URL) => BoardContext, may throw
 */
export function makeBoardResolver({ name, toContext }) {
  return function resolve(url) {
    const u = url instanceof URL ? url : new URL(url);
    return {
      ats: name,
      host: u.hostname.replace(/^www\./, ''),
      jobUrl: u.toString(),
      ...toContext(u),
    };
  };
}

/** Reject private hosts — used by adapters whose resolve() hits the network. */
export { assertPublicHttpsUrl };
