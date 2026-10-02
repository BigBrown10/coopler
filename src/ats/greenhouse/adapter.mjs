/**
 * Greenhouse adapter.
 *
 * Implements the ATS contract. All board knowledge is here or in
 * `./endpoints.mjs`; the driver is left holding only browser mechanics.
 */

import { GREENHOUSE } from './endpoints.mjs';

/**
 * Turn a Greenhouse job URL into a BoardContext.
 *
 * Handles both host generations and both path shapes:
 *   https://job-boards.greenhouse.io/monzo/jobs/8222576
 *   https://boards.greenhouse.io/monzo/jobs/8222576?gh_jid=8222576
 */
export function resolveGreenhouseBoard(url) {
  const u = url instanceof URL ? url : new URL(url);
  const host = u.hostname.replace(/^www\./, '');

  let jobId = u.searchParams.get('gh_jid');
  if (!jobId) {
    const m = u.pathname.match(/\/jobs\/(\d+)/);
    if (m) jobId = m[1];
  }
  const parts = u.pathname.split('/').filter(Boolean);
  const boardToken = parts[0] || '';
  const role = jobId ? `job-${jobId}` : '';

  return {
    ats: GREENHOUSE.name,
    host,
    boardToken,
    jobId: jobId || '',
    jobUrl: u.toString(),
    role,
    company: boardToken,
  };
}

/** Hosts this adapter owns. The apex domain is Greenhouse's corporate site. */
const KNOWN_HOSTS = new Set([
  GREENHOUSE.hosts.jobBoard,
  GREENHOUSE.hosts.board,
  'greenhouse.io',
]);

export function matchesGreenhouse(hostname) {
  const h = String(hostname || '').replace(/^www\./, '');
  if (KNOWN_HOSTS.has(h)) return true;
  // Per-board subdomains (e.g. eu.greenhouse.io), but never a lookalike that
  // merely ends in the string: the suffix must be a real domain boundary.
  return h.endsWith('.greenhouse.io');
}

export const greenhouseAdapter = Object.freeze({
  name: GREENHOUSE.name,

  matches: matchesGreenhouse,

  resolve: resolveGreenhouseBoard,

  endpoints: GREENHOUSE.endpoints,

  /**
   * Declared, not discovered at runtime. `botCheckBlocksSubmit: true` is the
   * reason the SUBMIT stage hands control to a human on this board: the bot
   * check is verified server-side on the POST, so an automated click is
   * refused with HTTP 428 captcha-failed regardless of how correct the answers
   * are. The workflow reads this flag and does not attempt to work around it.
   */
  capabilities: Object.freeze({
    fileUpload: true,
    botCheck: 'recaptcha',
    botCheckBlocksSubmit: true,
    securityCodeStep: true,
    eoiQuestions: true,
  }),

  /** Extract the form's fields. Delegated to the driver's DOM walk. */
  async extractFields(driver) {
    return driver.extractFields();
  },

  /** Click the board's own submit control. */
  async submit(driver) {
    return driver.submitApplication();
  },

  /**
   * A submission counts only on a real confirmation. A click, a 200, or an
   * absent error message are all insufficient on their own.
   */
  isConfirmed(outcome) {
    return Boolean(outcome && outcome.clicked && outcome.success);
  },
});
