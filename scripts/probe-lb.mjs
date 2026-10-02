import { AtsDriver } from '../src/drive/driver.mjs';

const url = process.argv[2];
const id = process.argv[3];

const driver = await AtsDriver.launch({
  browser: undefined,
  channel: 'chrome',
  profileDir: 'C:/Users/edogu/OneDrive/Documents/job stuff/autoapply/profiles/default',
  headless: true,
});

try {
  await driver.goto(url);
  const out = await driver.page.evaluate((target) => {
    const el = document.getElementById(target);
    if (!el) return { found: false };
    const lb = el.getAttribute('aria-labelledby');
    const db = el.getAttribute('aria-describedby');
    const resolve = (attr) => {
      if (!attr) return null;
      return attr.split(/\s+/).map((ref) => {
        const n = document.getElementById(ref);
        return { ref, exists: !!n, tag: n?.tagName, text: (n?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
      });
    };
    // walk further up to find where question text lives
    const ancestry = [];
    let n = el;
    for (let i = 0; i < 8 && n; i++) {
      const t = (n.innerText || '').replace(/\s+/g, ' ').trim();
      ancestry.push({ depth: i, tag: n.tagName.toLowerCase(), cls: String(n.className || '').slice(0, 90), textLen: t.length, text: t.slice(0, 200) });
      n = n.parentElement;
    }
    return { found: true, labelledby: resolve(lb), describedby: resolve(db), ancestry };
  }, id);
  console.log(JSON.stringify(out, null, 2));
} finally {
  await driver.close();
}
