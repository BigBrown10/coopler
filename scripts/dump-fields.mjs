import { AtsDriver } from '../src/drive/driver.mjs';

const url = process.argv[2];
const driver = await AtsDriver.launch({
  browser: undefined,
  channel: 'chrome',
  profileDir: 'C:/Users/edogu/OneDrive/Documents/job stuff/autoapply/profiles/default',
  headless: true,
});

try {
  await driver.goto(url);
  const fields = await driver.extractFields();
  for (const f of fields) {
    console.log(
      [
        `question=${JSON.stringify(f.question||'<null>')} kind=${f.kind}`,
        `key=${f.key}`,
        `label=${JSON.stringify(f.label)}`,
        `name=${JSON.stringify(f.name || '')}`,
        `guard=${f.guard}`,
        `required=${f.required}`,
        `opts=${JSON.stringify((f.options || []).slice(0, 6))}`,
      ].join(' ')
    );
  }
  console.log(`\nTOTAL ${fields.length}`);
} finally {
  await driver.close();
}

