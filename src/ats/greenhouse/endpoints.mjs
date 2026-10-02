/**
 * Greenhouse endpoints.
 *
 * This is the single place that knows where Greenhouse lives. Everything else
 * — the workflow, the driver, the review gate — asks the adapter for a URL
 * and never builds one.
 *
 * Endpoint map for a public Greenhouse board:
 *
 *   GET  https://job-boards.greenhouse.io/{board}/jobs/{jobId}
 *        the job description page. Note the host is `job-boards` on modern
 *        boards and `boards` on older ones; both serve the same content.
 *
 *   GET  https://job-boards.greenhouse.io/{board}/jobs/{jobId}#app
 *        same page, application form section.
 *
 *   POST https://boards.greenhouse.io/{board}/jobs/{jobId}
 *        the form submission target. This is the same call the browser makes,
 *        and it is NOT a documented public API — it is the board's own form
 *        endpoint. It is declared here so its existence and its constraints
 *        are visible rather than buried in a click handler.
 *
 * Constraints on the POST, observed from live responses:
 *   - It carries a reCAPTCHA Enterprise token that the server verifies. A
 *     submit whose token does not verify is refused with HTTP 428 and
 *     {"code":"captcha-failed"}.
 *   - On success the board emails a security code to the address supplied, and
 *     the application is only final once that code is entered.
 */

export const GREENHOUSE = Object.freeze({
  name: 'greenhouse',

  hosts: Object.freeze({
    /** Modern boards. */
    jobBoard: 'job-boards.greenhouse.io',
    /** Older boards and the form POST target. */
    board: 'boards.greenhouse.io',
  }),

  /** Path shapes, kept as templates so the pattern is visible in one place. */
  paths: Object.freeze({
    jobPage: '/{board}/jobs/{jobId}',
    submit: '/{board}/jobs/{jobId}',
  }),

  /**
   * Build the resolved endpoints for one board/job.
   *
   * Referenced by name rather than `this`, because adapters are plain frozen
   * objects and a detached method would lose its receiver.
   *
   * @param {{boardToken: string, jobId: string}} ctx
   */
  endpoints(ctx) {
    const board = ctx.boardToken;
    const jobId = ctx.jobId;
    const ep = {
      /** GET the job description. */
      jobPage: () => `https://${GREENHOUSE.hosts.jobBoard}${fill(GREENHOUSE.paths.jobPage, { board, jobId })}`,
      /** GET the form (same document, anchored on the application section). */
      application: () => `${ep.jobPage(ctx)}#app`,
      /**
       * POST the application. This is the board's form endpoint, not a public
       * API, and it is enforced with a server-verified bot check.
       */
      submit: () => `https://${GREENHOUSE.hosts.board}${fill(GREENHOUSE.paths.submit, { board, jobId })}`,
      submitIsPublicApi: false,
    };
    return ep;
  },
});

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));
}
