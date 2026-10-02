/**
 * Teamtailor. Public boards live at {company}.teamtailor.com, a posting at
 * .../jobs/{jobId}. Plain forms, no server-side bot check.
 */

import { makeGenericAdapter, makeBoardResolver } from '../generic.mjs';

const TEAMTAILOR = Object.freeze({
  name: 'teamtailor',
  hosts: Object.freeze([]),
});

export function resolveTeamtailorBoard(url) {
  const u = url instanceof URL ? url : new URL(url);
  const m = u.pathname.match(/\/jobs\/([^/]+)/);
  return {
    boardToken: u.hostname.split('.')[0] || '',
    jobId: m ? m[1] : '',
  };
}

export const teamtailorAdapter = makeGenericAdapter({
  name: TEAMTAILOR.name,
  hosts: TEAMTAILOR.hosts,
  hostPattern: 'teamtailor.com',
  resolve: makeBoardResolver({
    name: TEAMTAILOR.name,
    toContext: (u) => {
      const { boardToken, jobId } = resolveTeamtailorBoard(u);
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
   * Teamtailor posts the form as a traditional HTML form POST (not XHR).
   * The confirmation page is a redirect that may carry a thank-you message.
   * We click the native submit button and let the driver's response
   * interceptor and page-evaluate detect success.
   */
  async submit(driver) {
    return driver.submitApplication();
  },
  /**
   * Verified live on 2026-09-30: the posting page carries the description only,
   * and "Apply for this job" opens the form in place. Only called when
   * extraction came back empty, so a page that already shows its form is left
   * alone.
   */
  async revealForm(driver) {
    // Dismiss the cookie consent banner that otherwise sits over the form and
    // blocks navigation to the confirmation page after submit.
    await driver.page.evaluate(() => {
      const norm = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
      for (const el of document.querySelectorAll('button, a, [role="button"]')) {
        const t = norm(el.textContent || '');
        if (/(accept|decline|deny|reject).*cookie|cookie.*(accept|decline|deny|reject)/i.test(t)) {
          try { el.click(); } catch {}
          break;
        }
      }
    }).catch(() => {});
    const clicked = await driver.page.evaluate(() => {
      const norm = (s) => (s || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").trim();
      const el = [...document.querySelectorAll('a, button, [role="button"]')]
        .find((e) => e.getBoundingClientRect().height > 0 && /^apply( for this job| now)?$/.test(norm(e.innerText)));
      if (!el) return false;
      el.click();
      return true;
    }).catch(() => false);
    if (!clicked) return false;
    await driver.page.waitForTimeout(1500);
    return true;
  },
});
