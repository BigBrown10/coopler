import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadAnswers, lookupAnswer, questionKey, toYamlBlock } from '../src/config/answers.mjs';
import { buildGapReport, classifyGap, formatGapReport } from '../src/gate/gaps.mjs';
import { classifyFields, isGuardField, inferQuestionFromOptions } from '../src/ats/guard.mjs';
import { isGuardField as isGuardFieldViaMapper, deterministicMatch } from '../src/mapper/mapper.mjs';

const write = (contents) => {
  const dir = mkdtempSync(join(tmpdir(), 'answers-'));
  const p = join(dir, 'answers.yml');
  writeFileSync(p, contents, 'utf8');
  return p;
};

const field = (over = {}) => ({ key: 'k', kind: 'text', label: '', name: '', required: false, ...over });

const PROFILE = {
  identity: { first_name: 'Eli', last_name: 'Doe', email: 'eli@example.com', phone: '+15550101133', location: 'San Francisco, CA' },
  cvText: '# Eli\nSenior software engineer. Led 6-person team.',
  experience: [{ company: 'Acme Corp', title: 'Senior Software Engineer', start: '2022-01' }],
};

test('a missing answers file is normal, not an error', () => {
  const store = loadAnswers(join(tmpdir(), 'definitely-not-here.yml'));
  assert.equal(store.count, 0);
  assert.equal(store.exists, false);
});

test('answers are read and keyed by a normalised question', () => {
  const store = loadAnswers(write('answers:\n  "Legal name?": "Osamudiamen Edogun"\n  notice: "1 month"\n'));
  assert.equal(store.count, 2);
  assert.equal(lookupAnswer(store.byKey, field({ label: 'legal name' }))?.value, 'Osamudiamen Edogun');
  assert.equal(lookupAnswer(store.byKey, field({ label: 'NOTICE *' }))?.value, '1 month');
});

test('an empty or non-string answer is not treated as an answer', () => {
  // A half-finished file must not look like the user already replied.
  const store = loadAnswers(write('answers:\n  "legal name": ""\n  notice: "   "\n  other: 42\n'));
  assert.equal(store.count, 0);
});

test('a malformed answers file is reported rather than silently ignored', () => {
  assert.throws(() => loadAnswers(write('answers:\n  - [unclosed\n')), /Failed to parse answers YAML/);
});

test('questionKey ignores punctuation noise but keeps wording distinct', () => {
  assert.equal(questionKey('Legal name?'), 'legal name');
  assert.equal(questionKey('  NOTICE  (Required) '), 'notice');
  assert.equal(questionKey('Are you authorized? (Yes/No)'), 'are you authorized');
  assert.notEqual(questionKey('prefer not to say'), questionKey('say nothing'));
});

test('a radio group matches on its question, not on each option', () => {
  const store = loadAnswers(write('answers:\n  "gender identity": "Non-binary"\n'));
  const hit = lookupAnswer(store.byKey, field({ kind: 'radio', label: 'non-binary', question: 'Gender identity' }));
  assert.equal(hit?.value, 'Non-binary');
});

test('the YAML block is paste-ready and quotes anything YAML would choke on', () => {
  const yaml = toYamlBlock([
    { question: 'legal name', value: 'Osamudiamen Edogun' },
    { question: 'describe: your work', value: 'line one\nline two' },
  ]);
  assert.match(yaml, /^answers:/);
  assert.match(yaml, /"describe: your work"/);
  assert.doesNotThrow(() => loadAnswers(write(yaml)));
});

test('classifyGap says who can resolve each blank', () => {
  const answered = new Map();
  assert.equal(classifyGap({ value: 'Eli' }, field({ label: 'first name' }), answered), 'answered');
  assert.equal(classifyGap({ value: '' }, field({ label: 'do you agree to the arbitration agreement' }), answered), 'yours');
  assert.equal(classifyGap({ value: '' }, field({ label: 'why this role?', kind: 'textarea' }), answered), 'open');
  assert.equal(classifyGap({ value: '' }, field({ label: 'notice period' }), answered), 'profile');
  // Already answered once: the report should say so rather than ask again.
  const store = loadAnswers(write('answers:\n  "notice period": "1 month"\n'));
  assert.equal(classifyGap({ value: '' }, field({ label: 'notice period' }), store.byKey), 'standing');
});

test('the extractor and the mapper can never disagree about a guard field', () => {
  // Two copies of this rule once drifted: the extractor flagged "legal name" as a
  // declaration while the mapper treated it as identity data, so the gap report
  // asked the user for something the run had already filled.
  const samples = [
    { key: 'ln', kind: 'text', label: 'legal name', name: 'legal_name' },
    { key: 'eoi', kind: 'radio', label: 'female', name: 'answer_1', question: 'Gender identity' },
    { key: 'sal', kind: 'text', label: 'desired salary', name: 'salary' },
    { key: 'mot', kind: 'textarea', label: 'why this role?', name: 'why' },
  ];
  for (const f of samples) {
    assert.equal(
      isGuardField(f), isGuardFieldViaMapper(f),
      `${f.label}: one rule, one answer`,
    );
  }
  // And field.guard, set at extraction time, must agree with the predicate.
  for (const f of classifyFields(samples)) {
    assert.equal(f.guard, isGuardField(f), `${f.label}: field.guard must match isGuardField`);
  }
  assert.equal(classifyFields(samples)[0].guard, false, 'legal name is not a declaration');
});

test('a question the board never names is inferred from its own options', () => {
  // Lever names survey questions surveysResponses[8dfb36ea-...], so there is no
  // question text to read — but the options still say what is being asked.
  assert.equal(inferQuestionFromOptions(['female', 'male', 'non-binary']), 'gender identity');
  assert.equal(inferQuestionFromOptions(['White (Not Hispanic)', 'Black or African American']), 'race');
  assert.equal(inferQuestionFromOptions(['I identify as a protected veteran', 'I am not a protected veteran']), 'veteran status');
  assert.equal(inferQuestionFromOptions(['17 or younger', '18-20', '60 or older']), 'age');
  assert.equal(inferQuestionFromOptions(['Yes', 'No']), null, 'yes/no says nothing');
  assert.equal(inferQuestionFromOptions([]), null);
  // Most specific first: "transgender" must not be read as "gender".
  assert.equal(inferQuestionFromOptions(['Yes, I identify as transgender', 'No']), 'transgender');
});

test('an inferred question still guards the field and still gets answered', () => {
  const radios = ['female', 'male', 'non-binary'].map((label) => field({
    key: label, kind: 'radio', label, name: 'surveysResponses[8dfb36ea-dead-4bea-aa2d-734a7b290c35][responses][gender]',
    group: 'g1', question: null, required: true,
  }));
  const withQuestion = radios.map((r, i) => ({ ...r, question: inferQuestionFromOptions(radios.map((x) => x.label)) }));
  for (const r of withQuestion) {
    assert.equal(isGuardField(r), true, 'an EOI question is a guard question');
  }
  const { answers } = deterministicMatch(withQuestion, {
    ...PROFILE, equality: { gender_identity: 'Man', auto_propose: true },
  });
  const filled = answers.filter((a) => a.value);
  assert.equal(filled.length, 1, 'one option in the group, not all of them');
  assert.equal(filled[0].field.label, 'male');
});

test('one tick answers a whole checkbox question, and the rest are not gaps', () => {
  // Lever asks "which race(s) apply?" with eight unticked checkboxes that share
  // one name. Reporting each as its own gap is wrong twice over: it is eight
  // copies of one question, and the unticked ones are the correct answer.
  const name = 'surveysResponses[8dfb36ea-fd79-4bea-aa2d-734a7b290c35][responses][field2]';
  const options = [
    'Hispanic, Latino, or Spanish origin', 'Black or African American', 'Asian',
    'Native Hawaiian or other Pacific Islander',
    'Indigenous Peoples, First Nations, Native American, or Alaska Native',
    'Middle Eastern or North African', 'Some other race, ethnicity, or origin',
    'I decline to self-identify',
  ];
  const boxes = options.map((label) => field({
    key: `${name}-${label}`, kind: 'checkbox', label, name, group: name,
    question: inferQuestionFromOptions(options), required: false,
  }));
  const { answers } = deterministicMatch(boxes, {
    ...PROFILE, equality: { ethnicity: 'Black or African', auto_propose: true },
  });
  const filled = answers.filter((a) => a.value);
  assert.equal(filled.length, 1, 'only the one box the profile names');
  assert.match(filled[0].field.label, /Black or African American/);

  const report = buildGapReport(answers, boxes, null);
  assert.equal(report.gaps.length, 0, 'an answered checkbox group has no gaps');
  assert.equal(report.total, 1, 'eight boxes, one question');
  assert.equal(report.answered, 1);
});

test('an untouched checkbox question is reported once, with every option', () => {
  const name = 'ee[additional_questions][disability]';
  const boxes = ['Yes', 'No', 'Prefer not to say'].map((label) => field({
    key: `${name}-${label}`, kind: 'checkbox', label, name, group: name,
    question: 'Do you have a disability?', required: false,
  }));
  const { answers } = deterministicMatch(boxes, PROFILE);
  const report = buildGapReport(answers, boxes, null);
  assert.equal(report.gaps.length, 1);
  assert.equal(report.gaps[0].label, 'Do you have a disability?');
  assert.equal(report.gaps[0].fieldKind, 'checkbox');
  assert.equal(report.gaps[0].options.length, 3);
});

test('a standing answer on a guard text field matches through the real lookup path', () => {
  // Recruitee asks HR function experience — a guard text question that the
  // profile does not answer. The user adds one line to answers.yml.
  const raw = `answers:
  "legal agreements": "Yes"
  "have you built or significantly rebuilt an hr function (compensation framework, performance reviews, onboarding)? what was the scope and what would you do differently today?": "check profile"
`;
  const tmp = mkdtempSync(join(tmpdir(), 'answers-test-'));
  const p = join(tmp, 'answers.yml');
  writeFileSync(p, raw);
  const store = loadAnswers(p);
  assert.equal(store.count, 2);
  const f = field({
    key: 'q', kind: 'text',
    label: 'have you built or significantly rebuilt an hr function (compensation framework, performance reviews, onboarding)? what was the scope and what would you do differently today?',
    question: null, required: false, guard: true,
  });
  const hit = lookupAnswer(store.byKey, f);
  assert.ok(hit, 'should find the answer for a guard text question');
  assert.equal(hit.value, 'check profile');
});

test('a standing answer on a guard text field is counted as answered', () => {
  const store = { byKey: new Map([[questionKey('have you built or significantly rebuilt an hr function'), 'check profile']]) };
  const f = field({ key: 'q', kind: 'text', label: 'have you built or significantly rebuilt an hr function (compensation framework, performance reviews, onboarding)? what was the scope and what would you do differently today?', required: false, guard: true });
  const { answers } = deterministicMatch([f], PROFILE);
  assert.equal(answers[0].value, '', 'deterministic match leaves guard field empty');
  answers[0].value = 'check profile';
  answers[0].source = 'user';
  const report = buildGapReport(answers, [f], store);
  assert.equal(report.answered, 1, 'standing answer counts as answered');
  assert.equal(report.gaps.length, 0);
});

test('a radio group is one question, however many options it has', () => {
  // Counting each unselected option produced 13 "missing questions" for 5 real
  // ones, and a YAML block with duplicate keys.
  const opts = ['male', 'female', 'decline to self-identify'];
  const fields = opts.map((label) => field({ key: label, kind: 'radio', label, name: 'opt', group: 'g1', question: 'Gender identity', required: true }));
  const unanswered = buildGapReport([], fields, { byKey: new Map() });
  assert.equal(unanswered.gaps.length, 1, 'one question, not one per option');
  assert.equal(unanswered.gaps[0].label, 'Gender identity');
  assert.deepEqual(unanswered.gaps[0].options, opts);
  assert.equal(unanswered.total, 1, 'the denominator counts questions, not options');
  assert.equal((unanswered.yaml.match(/^ {2}gender identity:/gim) || []).length, 1, 'no duplicate YAML keys');

  // Once one option is answered the question is answered, and none of the
  // unselected options reappear as outstanding.
  const chosen = [{ field: fields[0], value: 'male' }];
  const answered = buildGapReport(chosen, fields, { byKey: new Map() });
  assert.equal(answered.gaps.length, 0);
  assert.equal(answered.answered, 1);
});

test('the rendered report shows a radio group as a choice, not as three blanks', () => {
  const fields = ['yes', 'no'].map((label) => field({ key: label, kind: 'radio', label, name: 'opt', group: 'g1', question: 'Do you accept the arbitration agreement?' }));
  const text = formatGapReport(buildGapReport([], fields, { byKey: new Map() }));
  assert.match(text, /choose one: yes \| no/);
  assert.equal((text.match(/- Do you accept/g) || []).length, 1);
});

test('the report counts answers and groups the rest by who can fix them', () => {
  const fields = [
    field({ key: 'a', label: 'first name', kind: 'text' }),
    field({ key: 'b', label: 'resume', kind: 'file' }),
    field({ key: 'c', label: 'i agree to the arbitration agreement', kind: 'checkbox' }),
    field({ key: 'd', label: 'why this role?', kind: 'textarea' }),
    field({ key: 'e', label: 'notice period', kind: 'text' }),
  ];
  const answers = [{ field: fields[0], value: 'Eli', source: 'profile' }];
  const report = buildGapReport(answers, fields, { byKey: new Map() });
  assert.equal(report.answered, 1);
  assert.equal(report.gaps.length, 3, 'a file input is not a question');
  assert.ok(!report.gaps.some((g) => g.label === 'resume'));
  assert.equal(report.byKind.yours.length, 1);
  assert.equal(report.byKind.open.length, 1);
  assert.equal(report.byKind.profile.length, 1);
  assert.match(report.yaml, /i agree to the arbitration agreement/);
});

test('a board that needs nothing from the user says so', () => {
  const fields = [field({ key: 'a', label: 'first name' })];
  const report = buildGapReport([{ field: fields[0], value: 'Eli' }], fields, { byKey: new Map() });
  assert.equal(report.gaps.length, 0);
  assert.match(formatGapReport(report), /Nothing outstanding/);
});

test('the report names required fields and lists the options on offer', () => {
  const fields = [field({ key: 'a', label: 'right to work status', kind: 'select', required: true, options: ['Citizen', 'Temporary visa'] })];
  const report = buildGapReport([], fields, { byKey: new Map() });
  const text = formatGapReport(report);
  assert.match(text, /\[required\]/);
  assert.match(text, /Citizen \| Temporary visa/);
});

test('lookup matches a prefix when the user shortened a long question', () => {
  const store = { byKey: new Map([['have you built or significantly rebuilt an hr function', 'check profile']]) };
  const f = field({
    key: 'q', kind: 'text',
    label: 'have you built or significantly rebuilt an hr function (compensation framework, performance reviews, onboarding)? what was the scope and what would you do differently today?',
  });
  const hit = lookupAnswer(store.byKey, f);
  assert.ok(hit, 'shorter user key should match longer field label');
  assert.equal(hit.value, 'check profile');
});

test('prefix match is not confused by a single-letter key', () => {
  const store = { byKey: new Map([['a', 'z']]) };
  const f = field({ key: 'q', kind: 'text', label: 'age' });
  const hit = lookupAnswer(store.byKey, f);
  assert.equal(hit, null, 'single letter keys should not prefix-match everything');
});

test('the rendered report is readable and points at answers.yml', () => {
  const fields = [field({ key: 'a', label: 'i confirm i have read the above', kind: 'checkbox' })];
  const text = formatGapReport(buildGapReport([], fields, { byKey: new Map() }), { boardName: 'ashby' });
  assert.match(text, /Questions on ashby/);
  assert.match(text, /need you/);
  assert.match(text, /config\/answers\.yml/);
});
