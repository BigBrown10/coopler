/**
 * Ashby. Public boards live at jobs.ashbyhq.com/{company} and per-company
 * subdomains {company}.jobs.ashbyhq.com; a posting is
 * .../{company}/{job-id-or-slug}. The form carries a reCAPTCHA checkbox —
 * the solver pipeline injects a token on submit so the click is not refused
 * server-side.
 *
 * The user's posting URL is authoritative: the adapter loads it exactly as
 * given rather than reconstructing a shape it cannot guarantee.
 */

import { makeGenericAdapter, makeBoardResolver } from '../generic.mjs';

const ASHBY = Object.freeze({
  name: 'ashby',
  hosts: Object.freeze(['jobs.ashbyhq.com']),
});

export function resolveAshbyBoard(url) {
  const u = url instanceof URL ? url : new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  // On the shared host the company is the first segment and the job the last;
  // on a company subdomain the single segment is the job. A board-level URL
  // has no job, and says so rather than borrowing the company as a job id.
  const sharedHost = u.hostname.replace(/^www\./, '') === ASHBY.hosts[0];
  const jobId = sharedHost ? (parts.length >= 2 ? parts[parts.length - 1] : '') : (parts[0] || '');
  return {
    boardToken: parts[0] || u.hostname.split('.')[0] || '',
    jobId,
  };
}

export const ashbyAdapter = makeGenericAdapter({
  name: ASHBY.name,
  hosts: ASHBY.hosts,
  hostPattern: 'jobs.ashbyhq.com',
  resolve: makeBoardResolver({
    name: ASHBY.name,
    toContext: (u) => {
      const { boardToken, jobId } = resolveAshbyBoard(u);
      return { boardToken, jobId, role: jobId, company: boardToken };
    },
  }),
  endpoints(ctx) {
    const base = ctx.jobUrl.replace(/\/$/, '');
    return {
      jobPage: () => base,
      // Ashby keeps the posting and its form on separate routes: the apply
      // form lives at /application, and the posting page has no fields at all.
      application: () => `${base}/application`,
      // Ashby posts the form to its own posting endpoint.
      submit: () => base,
      submitIsPublicApi: false,
    };
  },
  capabilities: Object.freeze({
    botCheck: 'recaptcha',
    botCheckBlocksSubmit: true,
  }),
});
