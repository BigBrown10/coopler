/**
 * Recruitee. Public boards live at {company}.recruitee.com, a posting at
 * .../o/{slug}. Plain forms, no server-side bot check.
 */

import { makeGenericAdapter, makeBoardResolver } from '../generic.mjs';

const RECRUITEE = Object.freeze({
  name: 'recruitee',
  hosts: Object.freeze([]),
});

export function resolveRecruiteeBoard(url) {
  const u = url instanceof URL ? url : new URL(url);
  // A board also lists talent-pool and "can't find the job" placeholders; they
  // are not postings, so they resolve to no job rather than a fake one.
  const m = u.pathname.match(/\/o\/([^/]+)\/?$/);
  const slug = m ? m[1] : '';
  const placeholder = /cant-find-the-job|talent-pool|speculative|general-application|send-us-your/i.test(slug);
  return {
    boardToken: u.hostname.split('.')[0] || '',
    jobId: placeholder ? '' : slug,
  };
}

export const recruiteeAdapter = makeGenericAdapter({
  name: RECRUITEE.name,
  hosts: RECRUITEE.hosts,
  hostPattern: 'recruitee.com',
  resolve: makeBoardResolver({
    name: RECRUITEE.name,
    toContext: (u) => {
      const { boardToken, jobId } = resolveRecruiteeBoard(u);
      return { boardToken, jobId, role: jobId, company: boardToken };
    },
  }),
  endpoints(ctx) {
    return {
      jobPage: () => ctx.jobUrl,
      application: () => ctx.jobUrl,
      submit: () => ctx.jobUrl,
      submitIsPublicApi: false,
    };
  },
  capabilities: {},
  /**
   * Recruitee posts the form as a traditional HTML form POST. The success page
   * carries the job posting again with a "thank you" banner rather than
   * navigating to a separate confirmation route. We rely on the driver's
   * page-evaluate success detection, which covers the banner text.
   */
  async submit(driver) {
    return driver.submitApplication();
  },
});
