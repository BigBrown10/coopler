/**
 * Click-through probe: presses a board's apply control, then reports what the
 * page looks like. For boards that render no form until you ask for one.
 *
 *   node scripts/probe-apply.mjs <url> [visibleTextToClick]
 */

import { AtsDriver } from '../src/drive/driver.mjs';

const url = process.argv[2];
const clickText = (process.argv[3] || "I'm interested").toLowerCase();
if (!url) {
  console.error("usage: node scripts/probe-apply.mjs <url> [click text]");
  process.exit(1);
}

const driver = await AtsDriver.launch({
  channel: process.env.BROWSER_CHANNEL || 'chrome',
  profileDir: process.env.PROBE_PROFILE || 'profiles/probe',
  headless: !process.argv.includes('--headed'),
});
try {
  await driver.goto(url);
  await driver.page.waitForTimeout(3000);
  const clicked = await driver.page.evaluate((want) => {
    const norm = (s) => (s || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").trim();
    const target = norm(want);
    const el = [...document.querySelectorAll('a, button, [role="button"]')]
      .find((e) => e.getBoundingClientRect().height > 0 && norm(e.innerText) === target);
    if (!el) return false;
    el.click();
    return true;
  }, clickText);
  console.log('clicked:', clicked);
  await driver.page.waitForTimeout(4500);
  console.log('url after:', driver.page.url());

  for (const frame of driver.page.frames()) {
    const r = await frame.evaluate(() => ({
      url: location.href.slice(0, 90),
      inputs: document.querySelectorAll('input').length,
      visible: [...document.querySelectorAll('input, textarea, select')]
        .filter((e) => e.getBoundingClientRect().height > 0).length,
      textareas: document.querySelectorAll('textarea').length,
      selects: document.querySelectorAll('select').length,
      forms: document.querySelectorAll('form').length,
      bodyStart: document.body.innerText.replace(/\s+/g, ' ').slice(0, 260),
    })).catch(() => null);
    if (r) console.log(JSON.stringify(r));
  }
  const { buffer } = await driver.screenshot({ label: 'probe' });
  const { writeFile } = await import('node:fs/promises');
  const out = process.argv.includes('--shot')
    ? process.argv[process.argv.indexOf('--shot') + 1]
    : 'probe.png';
  await writeFile(out, buffer);
  console.error('screenshot:', out);
} finally {
  await driver.close();
}
