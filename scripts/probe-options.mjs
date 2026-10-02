import { chromium } from 'playwright';

const url = process.argv[2] || 'https://job-boards.greenhouse.io/monzo/jobs/8222576';
const ids = process.argv.slice(3);

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

for (const id of ids) {
  const el = page.locator(`[id="${id}"]`).first();
  if (!(await el.count().catch(() => 0))) { console.log(`${id}: NOT FOUND`); continue; }
  await el.click({ force: true }).catch(() => {});
  await page.waitForTimeout(1200);
  const opts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.select__option')).map((o) => o.textContent.trim()));
  console.log(`${id}: ${JSON.stringify(opts)}`);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(400);
}

await browser.close();
