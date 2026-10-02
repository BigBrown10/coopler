import { AtsDriver } from '../src/drive/driver.mjs';

const url = process.argv[2];
const ids = process.argv.slice(3);

const driver = await AtsDriver.launch({
  browser: undefined,
  channel: 'chrome',
  profileDir: 'C:/Users/edogu/OneDrive/Documents/job stuff/autoapply/profiles/default',
  headless: true,
});

try {
  await driver.goto(url);
  const dump = await driver.page.evaluate((wanted) => {
    const out = [];
    for (const id of wanted) {
      const el = document.getElementById(id);
      if (!el) { out.push({ id, found: false }); continue; }
      let node = el;
      const chain = [];
      for (let i = 0; i < 4 && node; i++) {
        chain.push({
          tag: node.tagName.toLowerCase(),
          cls: node.className && String(node.className).slice(0, 120),
          text: (node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 220),
          childTags: Array.from(node.children || []).map((c) => c.tagName.toLowerCase()).join(','),
        });
        node = node.parentElement;
      }
      out.push({ id, found: true, outer: el.outerHTML.slice(0, 300), chain });
    }
    return out;
  }, ids);
  console.log(JSON.stringify(dump, null, 2));
} finally {
  await driver.close();
}
