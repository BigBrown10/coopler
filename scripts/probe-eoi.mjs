import { chromium } from 'playwright';

const url = process.argv[2] || 'https://job-boards.greenhouse.io/monzo/jobs/8222576';
const ids = process.argv.slice(3);

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

const info = await page.evaluate((wanted) => {
  const out = [];
  for (const id of wanted) {
    const el = document.getElementById(id);
    if (!el) { out.push({ id, found: false }); continue; }
    const wrap = el.closest('.select__container, .select, fieldset, .field, div');
    out.push({
      id, found: true,
      tag: el.tagName,
      type: el.type || null,
      role: el.getAttribute('role'),
      cls: (el.className || '').toString().slice(0, 80),
      isReactSelect: !!el.closest('.select__container'),
      wrapCls: wrap ? (wrap.className || '').toString().slice(0, 80) : null,
      nearbyCheckbox: !!wrap?.querySelector('input[type=checkbox]'),
      nearbyRadio: !!wrap?.querySelector('input[type=radio]'),
    });
  }
  return out;
}, ids);

console.log(JSON.stringify(info, null, 2));
await browser.close();
