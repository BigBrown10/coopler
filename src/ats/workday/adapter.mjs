/**
 * Workday. Public boards live at {company}.wd{n}.myworkdayjobs.com, and a
 * posting is /{locale}/{site}/job/{location}/{jobId} — the segment after
 * /job/ is a location code, not the id, so the id is the last segment.
 *
 * Workday is structurally different from the other boards: the application
 * form renders inside iframes and the flow is a multi-step wizard. The
 * adapter declares that honestly; extraction and submission are best-effort
 * through the generic DOM walk until a live posting proves otherwise.
 */

import { makeGenericAdapter, makeBoardResolver } from '../generic.mjs';

const WORKDAY = Object.freeze({
  name: 'workday',
  hosts: Object.freeze([]),
});

export function resolveWorkdayBoard(url) {
  const u = url instanceof URL ? url : new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  const jobAt = parts.lastIndexOf('job');
  return {
    // {company}.wd{n}.myworkdayjobs.com
    boardToken: u.hostname.split('.wd')[0] || '',
    // .../job/{location}/{jobId} — the id is last, the location is not it.
    // A tenant landing page has no /job/ at all and must not have one invented.
    jobId: jobAt >= 0 && parts.length > jobAt + 1 ? parts[parts.length - 1] : '',
  };
}

export const workdayAdapter = makeGenericAdapter({
  name: WORKDAY.name,
  hosts: WORKDAY.hosts,
  hostPattern: 'myworkdayjobs.com',
  resolve: makeBoardResolver({
    name: WORKDAY.name,
    toContext: (u) => {
      const { boardToken, jobId } = resolveWorkdayBoard(u);
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
    // Declared, not hidden: anyone extending Workday support starts here.
    iframeForms: true,
    // Verified live on 2026-09-30 against a real tenant: the posting shows a
    // cookie-consent wall, and pressing Apply opens a dialog whose fields mount
    // lazily and are not in the main document. Two deliberate choices here:
    // consent is the user's to give (this tool does not click it for them), and
    // the wizard is not driven blind. So this board is declared supported for
    // resolution and declared NOT automatable end-to-end until the dialog is
    // handled — better an honest stop than a half-filled application.
    needsConsentWall: true,
    applyIsModal: true,
  },
  /**
   * Press Apply, but do not consent to cookies on the user's behalf and do not
   * pretend the modal's fields are there when they are not.
   */
  async revealForm(driver) {
    const clicked = await driver.page.evaluate(() => {
      const el = [...document.querySelectorAll('a, button, [role="button"]')]
        .find((e) => e.getBoundingClientRect().height > 0
          && /^(apply|apply now|apply to this job)$/i.test((e.innerText || '').trim()));
      if (!el) return false;
      el.click();
      return true;
    }).catch(() => false);
    if (!clicked) return false;
    // The dialog mounts its fields lazily; give it a fair chance before the
    // extractor decides there is nothing there.
    await driver.page.waitForTimeout(3000);
    return true;
  },
});
