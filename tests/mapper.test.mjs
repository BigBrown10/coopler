import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deterministicMatch, isGuardField, tokenize, llmMatch, equalityAnswer, workAuthAnswer,
  isDraftableField, isRealLabel, isConsentField, consentAnswer, oneAnswerPerGroup,
} from '../src/mapper/mapper.mjs';

const PROFILE = {
  identity: { first_name: 'Eli', last_name: 'Doe', email: 'eli@example.com', phone: '+15550101133', location: 'San Francisco, CA' },
  cvText: '# Eli\nSenior software engineer. Led 6-person team.',
  experience: [{ company: 'Acme Corp', title: 'Senior Software Engineer', start: '2022-01' }],
};

const field = (over = {}) => ({ key: 'k', kind: 'text', label: '', name: '', required: false, ...over });

test('tokenize splits and lowercases', () => {
  assert.deepEqual(tokenize('First name — "ABC"'), ['first', 'name', 'abc']);
});

test('deterministicMatch fills identity fields from profile', () => {
  const fields = [
    field({ key: 'first_name', label: 'first name', name: 'fname', required: true }),
    field({ key: 'email', label: 'email', name: 'email', required: true }),
    field({ key: 'phone', label: 'phone', name: 'phone' }),
  ];
  const { answers, unmatched } = deterministicMatch(fields, PROFILE);
  assert.equal(unmatched.length, 0);
  const byKey = Object.fromEntries(answers.map((a) => [a.field.key, a]));
  assert.equal(byKey.first_name.value, 'Eli');
  assert.equal(byKey.email.value, 'eli@example.com');
  assert.equal(byKey.phone.value, '+15550101133');
  assert.equal(byKey.email.source, 'profile');
  assert.equal(byKey.email.needs_confirmation, false);
});

test('a permanent right to work never matches a temporary option, or the reverse', () => {
  const opts = ['UK Citizen', 'Permanent resident', 'Temporary visa', 'Will require sponsorship'];
  const f = field({ kind: 'select', label: 'right to work status', name: 'rtw', options: opts });
  assert.equal(workAuthAnswer(f, { right_to_work_status: 'permanent_license', auto_answer: true }), 'Permanent resident');
  assert.equal(workAuthAnswer(f, { right_to_work_status: 'temporary_license', auto_answer: true }), 'Temporary visa');
  assert.equal(workAuthAnswer(f, { right_to_work_status: 'citizen_pr', auto_answer: true }), 'UK Citizen');
});

test('a race question is answered like an ethnicity question', () => {
  // Ashby's EOI block asks "race", so a missing branch here left every option
  // blank for a candidate who had already stated their ethnicity.
  const opts = ['Hispanic or Latino', 'Black or African American (Not Hispanic or Latino)', 'White (Not Hispanic or Latino)', 'Asian'];
  const opts2 = ['Black or African American (Not Hispanic or Latino)'];
  const eq = { ethnicity: 'Black or African' };
  assert.equal(equalityAnswer(field({ kind: 'radio', label: opts2[0].toLowerCase(), name: 'answer', group: 'g', question: 'Race/Ethnicity' }), eq), opts2[0].toLowerCase());
  // The other options in that same group must stay blank.
  for (const other of ['Hispanic or Latino', 'White (Not Hispanic or Latino)', 'Asian']) {
    assert.equal(equalityAnswer(field({ kind: 'radio', label: other.toLowerCase(), name: 'answer', group: 'g', question: 'Race/Ethnicity' }), eq), '', other);
  }
  assert.equal(equalityAnswer(field({ kind: 'select', label: 'race', name: 'r', options: opts }), eq), opts[1]);
});

test('"legal name" is an identity question, not a legal declaration', () => {
  // It was being caught by the /legal/ guard word and left blank on every
  // posting, even though the user had already stated their name.
  assert.equal(isGuardField(field({ label: 'legal name', name: 'legal_name' })), false);
  assert.equal(isGuardField(field({ label: 'legal name (required)', name: 'x' })), false);
  const { answers } = deterministicMatch([field({ key: 'ln', label: 'legal name', name: 'legal_name' })], PROFILE);
  assert.equal(answers[0].value, 'Eli Doe');
  // The declaration sense of "legal" must still be a guard.
  assert.equal(isGuardField(field({ label: 'do you have the legal right to work in the UK?' })), true);
  assert.equal(isGuardField(field({ label: 'are you legally authorised to work?' })), true);
});

test('a generic key like "name" only matches a field that is exactly about a name', () => {
  // "name" must not swallow "first name", and a field labelled with other words
  // must not claim the candidate's full name.
  const fields = [
    field({ key: 'a', label: 'first name', name: 'first_name' }),
    field({ key: 'b', label: 'name of reference', name: 'ref' }),
  ];
  const { answers } = deterministicMatch(fields, PROFILE);
  const byKey = Object.fromEntries(answers.map((a) => [a.field.key, a]));
  assert.equal(byKey.a.value, 'Eli', 'first name resolves to the given name');
  assert.ok(!byKey.b || byKey.b.value !== 'Eli Doe', 'must not invent a full name for a reference field');
});

test('a required field with no profile value is surfaced rather than dropped', () => {
  const fields = [field({ key: 'linkedin', label: 'linkedin profile url', name: 'linkedin', required: true })];
  const { answers } = deterministicMatch(fields, { ...PROFILE, identity: { ...PROFILE.identity, linkedin: '' } });
  assert.equal(answers.length, 1);
  assert.equal(answers[0].value, '');
  assert.equal(answers[0].source, 'profile-empty');
  assert.equal(answers[0].needs_confirmation, true);
});

test('guard fields are never silently answered without the user opting in', () => {
  const fields = [field({ key: 'sal', label: 'desired salary', name: 'salary', required: true })];
  const { answers } = deterministicMatch(fields, PROFILE);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].value, '', 'salary stays blank');
  assert.equal(answers[0].needs_confirmation, true);
});

test('workAuthAnswer refuses to claim a legal status that is not on file', () => {
  const yesNo = field({ kind: 'select', label: 'are you legally authorized to work?', name: 'auth', options: ['Yes', 'No'] });
  // A plain Yes/No question is answered from the stated flag, which claims
  // nothing more than "legally authorized".
  assert.equal(workAuthAnswer(yesNo, { legally_authorized_uk: true, auto_answer: true }), 'Yes');
  assert.equal(workAuthAnswer(yesNo, { legally_authorized_uk: false, auto_answer: true }), 'No');

  const statusOpts = ['Citizen', 'Permanent resident', 'Temporary visa', 'Will require sponsorship'];
  const statusField = field({ kind: 'select', label: 'right to work status', name: 'rtw', options: statusOpts });
  // "Legally authorized" is not citizenship, so with no status on file the
  // precise options must be left alone rather than guessed at.
  assert.equal(workAuthAnswer(statusField, { legally_authorized_uk: true, auto_answer: true }), '', 'no status on file -> no claim');
  assert.equal(
    workAuthAnswer(statusField, { right_to_work_status: 'temporary_license', auto_answer: true }),
    'Temporary visa',
    'a stated status is used',
  );
  assert.equal(
    workAuthAnswer(statusField, { legally_authorized_uk: true, requires_sponsorship: true, auto_answer: true }),
    'Will require sponsorship',
  );
});

test('workAuthAnswer handles the sponsorship question from the user stance', () => {
  const opts = ['Yes', 'No'];
  const q = field({ kind: 'select', label: 'will you require sponsorship?', name: 'sponsorship', options: opts });
  assert.equal(workAuthAnswer(q, { requires_sponsorship: false, auto_answer: true }), 'No');
  assert.equal(workAuthAnswer(q, { requires_sponsorship: true, auto_answer: true }), 'Yes');
});

test('isConsentField only recognises data-processing consent', () => {
  assert.equal(isConsentField(field({ kind: 'checkbox', label: 'I consent to the processing of my data', name: 'consent' })), true);
  assert.equal(isConsentField(field({ kind: 'checkbox', label: 'I agree to the terms of service', name: 'tos' })), false);
  assert.equal(isConsentField(field({ kind: 'text', label: 'I consent', name: 'consent' })), false, 'not a checkbox');
});

test('EOI consent box is ticked only when EOI data is actually being submitted', () => {
  const c = field({ kind: 'checkbox', label: 'I consent to my equality data being collected', name: 'consent' });
  assert.equal(consentAnswer(c, 0), '', 'nothing to consent to -> stay blank');
  assert.equal(consentAnswer(c, 2), 'Yes');
  // Independent legal promises are never ticked on the user's behalf.
  const tos = field({ kind: 'checkbox', label: 'I agree to the terms of service', name: 'tos' });
  assert.equal(consentAnswer(tos, 2), '');
  const marketing = field({ kind: 'checkbox', label: 'I consent to receive marketing email', name: 'consent_marketing' });
  assert.equal(consentAnswer(marketing, 2), '');
});

test('equalityAnswer maps a select to the board\'s own option text', () => {
  const eq = { gender_identity: 'Man', ethnicity: 'Black or African', sexual_orientation: 'Heterosexual' };
  const gender = field({ kind: 'select', label: 'gender identity', name: 'gender', options: ['Female', 'Male', 'Non-binary', 'Prefer not to say'] });
  assert.equal(equalityAnswer(gender, eq), 'Male');
  const ethnicity = field({ kind: 'select', label: 'ethnicity', name: 'eth', options: ['Black or Black British: African', 'White', 'Mixed'] });
  assert.equal(equalityAnswer(ethnicity, eq), 'Black or Black British: African', 'the specific pair, not "Black" broadly');
  const orientation = field({ kind: 'select', label: 'sexual orientation', name: 'so', options: ['Gay or Lesbian', 'Heterosexual'] });
  assert.equal(equalityAnswer(orientation, eq), 'Heterosexual');
});

test('a yes/no EOI question is answered from the stored value, not the first option', () => {
  const eq = { transgender: 'No', neurodivergent: 'No', disability: 'No' };
  const t = field({ kind: 'select', label: 'do you identify as transgender?', name: 'trans', options: ['Yes', 'No'] });
  assert.equal(equalityAnswer(t, eq), 'No');
  const tYes = field({ kind: 'select', label: 'do you identify as transgender?', name: 'trans', options: ['Yes', 'No'] });
  assert.equal(equalityAnswer(tYes, { transgender: 'Yes' }), 'Yes');
});

test('an EOI question with no matching option stays blank', () => {
  const gender = field({ kind: 'select', label: 'gender', name: 'g', options: ['Non-binary', 'Prefer not to say'] });
  assert.equal(equalityAnswer(gender, { gender_identity: 'Man' }), '', 'Man is not offered, so nothing is claimed');
  assert.equal(equalityAnswer(field({ label: 'unrelated question', name: 'x' }), { gender_identity: 'Man' }), '');
  assert.equal(equalityAnswer(field({ label: 'gender', name: 'g' }), null), '');
});

test('guard labels seen live on Ashby are recognised as guard', () => {
  // A model was about to tick an arbitration agreement.
  for (const label of [
    'i acknowledge that i have opened, read, and understood the arbitration agreement',
    'i confirm i have read the above',
    'do you agree to the terms of service?',
    'i certify that the information provided is accurate',
  ]) {
    assert.equal(isGuardField({ label, name: '', kindRef: '' }), true, label);
    assert.equal(isDraftableField({ label, kind: 'text', guard: true }), false, label);
  }
  // Ordinary questions must stay draftable.
  for (const label of ['when can you start a new role?', 'additional information', 'preferred name (if applicable)']) {
    assert.equal(isGuardField({ label, name: '', kindRef: '' }), false, label);
  }
});

test('a guard select is recognised from its options when the label is blank', () => {
  // Greenhouse renders some guard dropdowns with no label at all, so the option
  // text is the only thing left to go on.
  const blank = field({
    kind: 'select', label: '', name: 'f',
    options: ['Yes, I am authorized to work', 'I will require sponsorship'],
  });
  assert.equal(isGuardField(blank), true);
  // An ordinary dropdown with no guard wording is not a guard field.
  const plain = field({ kind: 'select', label: '', name: 'g', options: ['Full time', 'Part time'] });
  assert.equal(isGuardField(plain), false);
});

test('file inputs and unlabelled boxes are never drafted', () => {
  assert.equal(isDraftableField({ key: 'r', label: 'resume', kind: 'file' }), false);
  assert.equal(isDraftableField({ key: 'a', label: 'Start typing...', kind: 'text' }), false);
  assert.equal(isDraftableField({ key: 'a', label: 'Type here...', kind: 'text' }), false);
  assert.equal(isDraftableField({ key: 'bed95633-1b6e-4cd0-9eaf-c5a9f75ac35d', label: 'bed95633-1b6e-4cd0-9eaf-c5a9f75ac35d', kind: 'text' }), false, 'a UUID is not a question');
  assert.equal(isDraftableField({ key: 'a', label: '', kind: 'text' }), false);
  assert.equal(isDraftableField({ key: 'a', label: 'describe a project you led', kind: 'textarea' }), true);
  assert.equal(isRealLabel('pick date...'), false);
  assert.equal(isRealLabel('what is your notice period?'), true);
});

test('llmMatch keeps only answers whose key resolves to a field, and marks them for review', async () => {
  const fields = [
    field({ key: 'notice', label: 'what is your notice period?', name: 'notice' }),
    field({ key: 'other', label: 'anything else?', name: 'other' }),
  ];
  const chat = async () => JSON.stringify([
    { key: 'notice', value: '1 month', needs_confirmation: false },
    { key: 'not_a_field', value: 'invented', needs_confirmation: false },
  ]);
  const answers = await llmMatch(fields, PROFILE, 'jd', chat);
  assert.equal(answers.length, 1, 'a key that matches no field is discarded');
  assert.equal(answers[0].value, '1 month');
  assert.equal(answers[0].source, 'llm');
});

test('llmMatch never drafts a guard field, even if the model volunteers an answer', async () => {
  const fields = [
    field({ key: 'sal', label: 'desired salary', name: 'salary', guard: true }),
    field({ key: 'ok', label: 'why this role?', name: 'why' }),
  ];
  let promptSeen = '';
  const chat = async (_sys, user) => { promptSeen = user; return JSON.stringify([{ key: 'sal', value: '200000', needs_confirmation: false }]); };
  const answers = await llmMatch(fields, PROFILE, 'jd', chat);
  assert.equal(answers.length, 0, 'the guard field is not even offered to the model');
  assert.ok(!promptSeen.includes('"sal"'), 'the guard field is not in the prompt');
});

test('llmMatch ignores a prose preamble and trailing commas in the reply', async () => {
  const chat = async () => 'Sure! Here is the array you asked for:\n```json\n[{"key":"a","value":"yes",},]\n```';
  const fields = [field({ key: 'a', label: 'have you worked in saas?', name: 'a' })];
  const answers = await llmMatch(fields, PROFILE, 'saas role', chat);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].value, 'yes');
});

test('llmMatch refuses to answer when the model replies with only prose', async () => {
  const chat = async () => 'I think the candidate should say yes to this question.';
  const fields = [field({ key: 'a', label: 'have you worked in saas?', name: 'a' })];
  await assert.rejects(() => llmMatch(fields, PROFILE, 'saas role', chat), /No JSON array|prose/);
});

test('a radio group gets exactly one answer, on the option the value names', () => {
  // The live Ashby shape: each radio is a separate field whose label is the
  // option, and the group is the question. Answering these independently put
  // "Man" on female AND male at the same time.
  const eq = { gender_identity: 'Man', ethnicity: 'Black or African', auto_propose: true };
  const groupOf = (opts, question) => opts.map((label) => field({
    key: label.replace(/\s+/g, '_'), kind: 'radio', label: label.toLowerCase(),
    name: 'answer', group: question, question, required: true,
  }));
  const fields = [
    ...groupOf(['Male', 'Female', 'Decline to self-identify'], 'Gender identity'),
    ...groupOf(['Black or African American', 'White', 'Asian'], 'Ethnicity'),
  ];
  const { answers } = deterministicMatch(fields, { ...PROFILE, equality: eq });
  const filled = answers.filter((a) => a.value);
  assert.equal(filled.length, 2, 'one answer per question, not per option');
  for (const a of filled) {
    // The value must be an option this candidate was actually offered.
    assert.equal(a.field.label, a.value.toLowerCase(), `${a.field.question} answered with an option it was not given`);
  }
  const byQ = Object.fromEntries(filled.map((a) => [a.field.question, a.value]));
  assert.equal(byQ['Gender identity'], 'male');
  assert.equal(byQ.Ethnicity, 'black or african american');
});

test('oneAnswerPerGroup blanks the losers instead of dropping the question', () => {
  const mk = (label, value) => ({ field: field({ label, kind: 'radio', group: 'g', question: 'Gender' }), value, source: 'profile' });
  // 'female' holding 'male' is the exact bug this guards against.
  const out = oneAnswerPerGroup([mk('male', 'male'), mk('female', 'male'), mk('other', 'other')]);
  assert.equal(out.length, 3, 'every option stays visible to the reviewer');
  const filled = out.filter((a) => a.value);
  assert.equal(filled.length, 1, 'only one option in a group may be answered');
  assert.equal(filled[0].field.label, 'male', 'the option the value names is the one kept');
  for (const a of out.filter((x) => !x.value)) assert.ok(a.withheld, 'a blanked option says why');
});

test('oneAnswerPerGroup leaves a single answered option alone', () => {
  const mk = (label, value) => ({ field: field({ label, kind: 'radio', group: 'g' }), value, source: 'profile' });
  const out = oneAnswerPerGroup([mk('yes', 'yes'), mk('no', '')]);
  assert.equal(out.filter((a) => a.value).length, 1);
  assert.equal(out.filter((a) => a.withheld).length, 0);
});

test('an EOI radio is a guard field even when the board names the input "answer"', () => {
  // Without the question in scope this would be drafted like any other field.
  const f = field({ label: 'female', name: 'answer_1', kind: 'radio', question: 'Gender identity' });
  assert.equal(isGuardField(f), true);
  assert.equal(isDraftableField({ ...f, guard: true }), false);
});

test('equalityAnswer never returns a value the board did not offer', () => {
  const eq = { gender_identity: 'Man', ethnicity: 'Black or African' };
  // "Female" is not an option this candidate can be. It must stay blank.
  const female = field({ kind: 'radio', label: 'female', name: 'answer', group: 'g1', question: 'Gender identity' });
  const male = field({ kind: 'radio', label: 'male', name: 'answer', group: 'g1', question: 'Gender identity' });
  assert.equal(equalityAnswer(female, eq), '');
  assert.equal(equalityAnswer(male, eq), 'male');
});
