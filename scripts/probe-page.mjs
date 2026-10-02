/**
 * Page probe.
 *
 * Answers one question about a live posting: does this page expose form fields
 * the extractor can see, and if not, what is actually there? It reads the DOM
 * and takes a screenshot. It never types, never submits, and never logs
 * anything it finds beyond field shapes.
 *
 *   node scripts/probe-page.mjs <url> [--shot out.png] [--wait 3000]
 */

import { AtsDriver } from '../src/drive/driver.mjs';

const url = process.argv[2];
if (!url) {
  console.error('usage: node scripts/probe-page.mjs <url> [--shot file] [--wait ms]');
  process.exit(1);
}
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const waitMs = Number(arg('--wait', 2500));
const shot = arg('--shot', null);

const driver = await AtsDriver.launch({
  channel: process.env.BROWSER_CHANNEL || 'chrome',
  profileDir: process.env.PROBE_PROFILE || 'profiles/probe',
  headless: !process.argv.includes('--headed'),
});
try {
  await driver.goto(url);
  if (waitMs) await new Promise((r) => setTimeout(r, waitMs));

  const report = await driver.page.evaluate(() => {
    const q = (s) => [...document.querySelectorAll(s)];
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') || '').toLowerCase() || null,
      name: el.getAttribute('name') || null,
      id: el.getAttribute('id') || null,
      placeholder: el.getAttribute('placeholder') || null,
      label: (() => {
        const aria = el.getAttribute('aria-label');
        if (aria) return aria;
        const id = el.getAttribute('id');
        if (id) {
          const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lab) return lab.textContent.trim();
        }
        const wrap = el.closest('label');
        return wrap ? wrap.textContent.trim().slice(0, 80) : null;
      })(),
      visible: vis(el),
    });
    return {
      url: location.href,
      title: document.title.slice(0, 90),
      counts: {
        inputs: q('input').length,
        visibleInputs: q('input').filter(vis).length,
        textareas: q('textarea').length,
        selects: q('select').length,
        iframes: q('iframe').length,
        forms: q('form').length,
        buttons: q('button, input[type=submit]').length,
      },
      iframeSrcs: q('iframe').map((f) => f.getAttribute('src')).filter(Boolean).slice(0, 5),
      fields: q('input, textarea, select').map(describe).slice(0, 40),
      bodyStart: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
    };
  });

  console.log(JSON.stringify(report, null, 2));
  if (shot) {
    const { buffer } = await driver.screenshot({ label: 'probe' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(shot, buffer);
    console.error(`screenshot: ${shot}`);
  }
} finally {
  await driver.close();
}
