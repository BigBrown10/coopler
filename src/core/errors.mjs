/**
 * Typed failures.
 *
 * A bare `throw new Error(...)` loses which step failed and why it was
 * terminal. These carry a machine-readable `reason` so the CLI can print
 * something a person can act on, and so tests can assert on the cause rather
 * than on message text.
 */

export const REASON = Object.freeze({
  UNSUPPORTED_BOARD: 'unsupported_board',
  SSRF: 'ssrf',
  ADAPTER_CONTRACT: 'adapter_contract',
  ADAPTER_MISSING: 'adapter_missing',
  NAVIGATION: 'navigation',
  EXTRACTION: 'extraction',
  TAILORING: 'tailoring',
  FILL: 'fill',
  NO_SUBMIT_CONTROL: 'no_submit_control',
  BOARD_REJECTED: 'board_rejected',
  BOT_CHECK: 'bot_check',
  NOT_SUBMITTED: 'not_submitted',
  UNCONFIRMED: 'unconfirmed',
  SECURITY_CODE: 'security_code',
  ERROR: 'error',
});

export class StageFailure extends Error {
  /**
   * @param {string} stage  which stage failed
   * @param {string} reason one of REASON
   * @param {string} [detail] human-readable specifics
   */
  constructor(stage, reason, detail = '', { cause } = {}) {
    super(`${stage}: ${reason}${detail ? ` — ${detail}` : ''}`);
    this.name = 'StageFailure';
    this.stage = stage;
    this.reason = reason;
    this.detail = detail;
    if (cause) this.cause = cause;
  }
}

/**
 * Advice for a person, keyed by reason. Keeping this in one table means the
 * CLI never has to invent its own wording per failure site.
 */
export const REMEDIATION = Object.freeze({
  [REASON.BOT_CHECK]: 'This board verifies a bot check server-side on submit and rejects automated clicks. Complete the final Submit yourself in the open browser (--handover).',
  [REASON.BOARD_REJECTED]: 'The board\'s API refused the submission. The reason it gave is shown above; fix it and re-run.',
  [REASON.SECURITY_CODE]: 'The board emails a security code to confirm the submission. Enter it in the form to finish.',
  [REASON.UNCONFIRMED]: 'Submit was clicked but no confirmation was seen. Check the board before assuming it went through.',
  [REASON.NOT_SUBMITTED]: 'Nothing was sent. Re-run once the review output above is correct.',
  [REASON.NO_SUBMIT_CONTROL]: 'No submit control could be identified on the page. This is an extractor gap, not a rejected application.',
  [REASON.UNSUPPORTED_BOARD]: 'No adapter is registered for this board. Add one under src/ats/.',
  [REASON.ADAPTER_MISSING]: 'The board resolved, but its adapter is missing. Add one under src/ats/.',
  [REASON.ADAPTER_CONTRACT]: 'The adapter does not satisfy the contract in src/ats/contract.mjs, so the run was refused before any browser work.',
  [REASON.SSRF]: 'The URL resolved to a private or non-public host, so the run was refused.',
  [REASON.NAVIGATION]: 'The application page did not load. Check the URL, then whether the board is up.',
  [REASON.EXTRACTION]: 'The form exposed no fields this extractor understands. The page may have changed, or the board may need a new adapter.',
  [REASON.TAILORING]: 'The tailored CV could not be produced; the run fell back to the static CV.',
  [REASON.FILL]: 'A field could not be written. The review output above shows which one.',
  [REASON.ERROR]: 'An unexpected error stopped the run. The detail above is the raw cause.',
});

/**
 * Remediation for a reason, never empty. An unlisted reason is a gap in the
 * table, not a reason to tell the user nothing.
 */
export function remediationFor(reason) {
  return REMEDIATION[reason] || `The run stopped at "${reason}". Re-run with --trace to see which stage failed.`;
}
