// tests/cv-consulting-additions.test.mjs — #3961: engagements sub-lists,
// per-entry page-break control, multiline text, and skills qualifier notes.
//
// All four are opt-in payload fields that are meaningless for a plain CV, so
// the important half of this test is the absent side: a payload without them
// must render byte-for-byte the markup it rendered before the fields existed,
// and the strict key validator (#3523) must not warn on the new names.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pass, fail, run, NODE, ROOT, lastRunFailure } from './helpers.mjs';

console.log('\nbuild-cv-html.mjs — consultations, keepTogether, multiline, skill notes (#3961)');

const BASE = {
  lang: 'en',
  page_format: 'letter',
  candidate: { name: 'Plain Candidate', email: 'plain@example.com' },
  summary: 'Plain summary.',
  competencies: ['Delivery'],
  experience: [{ company: 'Plain Co', role: 'Engineer', dates: '2018-2020', bullets: ['Did work'] }],
  skills: [{ category: 'Languages', items: ['TypeScript', 'SQL'] }],
};

const CONSULTING = {
  ...BASE,
  candidate: { name: 'Consulting Candidate', email: 'consult@example.com' },
  experience: [
    {
      company: 'Umbrella & Co',
      role: 'Principal <Consultant>',
      dates: '2020-2024',
      bullets: ['Led a programme'],
      keepTogether: true,
      engagements: [
        { name: 'Bank A', detail: 'Payments platform\nSecond line' },
        { name: 'Retailer <B>', detail: 'Checkout rebuild' },
      ],
    },
    { company: 'Earlier Co', role: 'Engineer', dates: '2016-2020', bullets: ['Shipped'] },
  ],
  skills: [
    { category: 'Languages', items: ['TypeScript', 'SQL\nPL/pgSQL'], note: 'Working familiarity\nnot depth' },
    { category: 'Tools', items: ['Git'] },
  ],
};

const dir = mkdtempSync(join(tmpdir(), 'cv-consulting-'));
const templates = ['templates/cv-template.html', 'templates/ats/cv-template.ats.html'];

function build(name, payload, template, label) {
  const input = join(dir, `${name}.json`);
  const output = join(dir, `${name}.html`);
  writeFileSync(input, JSON.stringify(payload));
  const stdout = run(NODE, [join(ROOT, 'build-cv-html.mjs'), input, output, join(ROOT, template)], { timeout: 60_000 });
  if (stdout === null) {
    const f = lastRunFailure();
    fail(`${label}: builder crashed (exit ${f?.status}) - ${(f?.stderr || '').trim().split('\n').pop()}`);
    return null;
  }
  return { html: readFileSync(output, 'utf-8'), report: JSON.parse(stdout) };
}

try {
  for (const template of templates) {
    const label = template.includes('/ats/') ? 'ats pack' : 'default pack';
    const plain = build(`plain-${label.replace(/\W+/g, '-')}`, BASE, template, `${label} base payload`);
    const rich = build(`rich-${label.replace(/\W+/g, '-')}`, CONSULTING, template, `${label} consulting payload`);

    if (plain) {
      const checks = [
        ['no engagements markup on a payload without them', !plain.html.includes('<ul class="sub-list">') && !plain.html.includes('<div class="sub-label">')],
        ['no keepTogether class on a payload without it', !plain.html.includes('class="job job--keep-together"')],
        ['no skills note on a payload without one', !plain.html.includes('<span class="skill-note">')],
        ['new fields produce no validator warnings', Array.isArray(plain.report.warnings) && plain.report.warnings.length === 0],
      ];
      for (const [what, ok] of checks) ok ? pass(`${label}: ${what}`) : fail(`${label}: ${what}`);
    }

    if (!rich) continue;

    const { html, report } = rich;
    const checks = [
      ['keepTogether marks only the entry that asked for it', html.includes('class="job job--keep-together"')
        && (html.match(/class="job job--keep-together"/g) || []).length === 1],
      ['engagements render as a labelled sub-list', html.includes('<div class="sub-label">Selected engagements</div>')
        && html.includes('<ul class="sub-list">')],
      ['engagement names are bold and escaped', html.includes('<li><strong>Bank A</strong>')
        && html.includes('<strong>Retailer &lt;B&gt;</strong>')],
      ['multiline engagement detail keeps its break', html.includes('Payments platform<br>Second line')],
      ['company and role text are escaped', html.includes('Umbrella &amp; Co') && html.includes('Principal &lt;Consultant&gt;')],
      ['no raw tags from payload text', !html.includes('<Consultant>') && !html.includes('<B>')],
      ['skills note renders in its own span with breaks', html.includes('<span class="skill-note">Working familiarity<br>not depth</span>')],
      ['multiline skill items keep their break', html.includes('SQL<br>PL/pgSQL')],
      ['a category without a note gets no empty skill-note', (html.match(/class="skill-note"/g) || []).length === 1],
      ['new fields produce no validator warnings', Array.isArray(report.warnings) && report.warnings.length === 0],
    ];
    for (const [what, ok] of checks) ok ? pass(`${label}: ${what}`) : fail(`${label}: ${what}`);
  }

  const blank = build('blank-note', { ...BASE, skills: [{ category: 'X', items: ['A'], note: '' }] }, templates[0], 'blank note');
  if (blank) {
    blank.html.includes('<span class="skill-note">')
      ? fail('default pack: an empty note renders an empty qualifier span')
      : pass('default pack: an empty note renders nothing');
  }
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
