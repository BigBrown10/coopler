/**
 * SmartRecruiters. Postings are served from two hosts depending on how old
 * the customer's board is:
 *   jobs.smartrecruiters.com/{company}/{jobId}            (current)
 *   careers.smartrecruiters.com/{Company}/{Dept}/{jobId}  (legacy)
 * Both put the job id last, so the job id is the last path segment and a
 * company board on its own is not a posting. Applications are form posts;
 * the company jobs API is public and read-only.
 */

import { makeGenericAdapter, makeBoardResolver } from '../generic.mjs';

const SMART = Object.freeze({
  name: 'smartrecruiters',
  hosts: Object.freeze(['jobs.smartrecruiters.com', 'careers.smartrecruiters.com']),
});

export function resolveSmartRecruitersBoard(url) {
  const u = url instanceof URL ? url : new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  return {
    boardToken: parts[0] || '',
    // Last segment is the id on both the current and legacy shapes; the
    // legacy board inserts a department segment before it.
    jobId: parts.length >= 2 ? parts[parts.length - 1] : '',
  };
}

export const smartRecruitersAdapter = makeGenericAdapter({
  name: SMART.name,
  hosts: SMART.hosts,
  // Any subdomain boundary, so both hosts and per-customer variants resolve.
  hostPattern: 'smartrecruiters.com',
  resolve: makeBoardResolver({
    name: SMART.name,
    toContext: (u) => {
      const { boardToken, jobId } = resolveSmartRecruitersBoard(u);
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
  capabilities: {
    // Verified live on 2026-09-30: pressing "I'm interested" opens
    // /oneclick-ui, which sits behind DataDome and answered an automated
    // profile with "Access is temporarily restricted ... Automated (bot)
    // activity on your network". The form is never rendered, so there is
    // nothing to fill and nothing to solve — this board needs a human.
    botCheck: 'datadome',
    botCheckBlocksSubmit: true,
  },
  /**
   * The posting page has no form on it at all — only an "I'm interested"
   * control that opens one. The run calls this after extraction came back
   * empty, so the page is never clicked at when the form is already visible.
   */
  async revealForm(driver) {
    const clicked = await driver.page.evaluate(() => {
      const cands = [...document.querySelectorAll('a, button, [role="button"]')];
      const apply = cands.find((el) => {
        const t = (el.innerText || '').trim().toLowerCase();
        const hidden = el.getBoundingClientRect().height === 0;
        return !hidden && (t === "i'm interested" || t === 'apply now' || t === 'apply');
      });
      if (!apply) return false;
      apply.click();
      return true;
    }).catch(() => false);
    if (!clicked) return false;
    // The form renders client-side after the click.
    await driver.page.waitForTimeout(1500);
    return true;
  },
});
