/**
 * Lever. Public boards live at jobs.lever.co/{company}/{jobId}; a posting's
 * application form is on the posting page itself. Lever also documents a
 * public application API, but the browser path keeps one flow for all boards.
 */

import { makeGenericAdapter, makeBoardResolver } from '../generic.mjs';

const LEVER = Object.freeze({
  name: 'lever',
  hosts: Object.freeze(['jobs.lever.co']),
});

export function resolveLeverBoard(url) {
  const u = url instanceof URL ? url : new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  // .../{company}/{jobId} — a company board alone is not a posting.
  return {
    boardToken: parts[0] || '',
    jobId: parts.length >= 2 ? parts[parts.length - 1] : '',
  };
}

export const leverAdapter = makeGenericAdapter({
  name: LEVER.name,
  hosts: LEVER.hosts,
  hostPattern: 'jobs.lever.co',
  resolve: makeBoardResolver({
    name: LEVER.name,
    toContext: (u) => {
      const { boardToken, jobId } = resolveLeverBoard(u);
      return { boardToken, jobId, role: jobId, company: boardToken };
    },
  }),
  endpoints(ctx) {
    return {
      jobPage: () => ctx.jobUrl,
      application: () => `${ctx.jobUrl.replace(/\/$/, '')}/apply`,
      // Lever's API is genuinely public and documented.
      submit: () => `https://api.lever.co/v1/postings/${ctx.boardToken}/${ctx.jobId}/apply`,
      submitIsPublicApi: true,
    };
  },
  capabilities: {},
});
