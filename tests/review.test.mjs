import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewSummary, parseApproval } from '../src/gate/review.mjs';

const ANSWERS = [
  { field: { label: 'first name' }, value: 'Eli', source: 'profile', needs_confirmation: false },
  { field: { label: 'why do you want to work here' }, value: 'Fit plus evidence.', source: 'llm', needs_confirmation: false },
  { field: { label: 'salary expectation' }, value: '', source: null, needs_confirmation: true },
];

test('buildReviewSummary surfaces every answer and flags guard fields', () => {
  const s = buildReviewSummary({
    role: 'Senior Engineer', company: 'Acme',
    method: 'Deterministic first', answers: ANSWERS,
    captcha: { prompt: 'Checkbox captcha: agent clicked it.' }, jdUrl: 'https://boards.greenhouse.io/acme/jobs/1',
  });
  assert.match(s, /Senior Engineer at Acme/);
  assert.match(s, /first name/);
  assert.match(s, /why do you want to work here/);
  assert.match(s, /NEEDS YOUR INPUT/); // salary guard surfaced
  assert.match(s, /Checkbox captcha/);
  assert.match(s, /'go' to submit/i);
});

test('buildReviewSummary credits a value the user set themselves', () => {
  const s = buildReviewSummary({
    role: 'Eng', company: 'Acme', method: 'm',
    answers: [
      { field: { label: 'us tax resident' }, value: 'No', source: 'user', needs_confirmation: true, user_edited: true },
    ],
  });
  assert.match(s, /us tax resident \[set by you\]/);
  assert.doesNotMatch(s, /drafted by LLM/);
});

test('a group of options is one line on the screen the user approves from', () => {
  // Recruitee asks for language proficiency as six radios. Listed one per input,
  // the approval screen showed six bullets for one question, five of them
  // "(left empty)" — which reads as five unanswered questions, not one.
  const levels = ['a1 - beginner/elementary', 'a2 - pre intermediate', 'b1 - intermediate',
    'b2 - upper intermediate', 'c1 - advanced', 'c2 - proficient/native'];
  const answers = [
    { field: { label: 'full name' }, value: 'Eli', source: 'profile', needs_confirmation: false },
    ...levels.map((label, i) => ({
      field: {
        kind: 'radio', label, group: 'lang', question: 'Language proficiency',
      },
      value: i === 3 ? 'Upper intermediate (B2)' : '',
      source: i === 3 ? 'llm' : null,
      needs_confirmation: i === 3 ? false : true,
    })),
  ];
  const s = buildReviewSummary({ role: 'Head of HR', company: 'Intent', method: 'm', answers });
  const bullets = s.split('\n').filter((l) => l.trim().startsWith('•'));
  assert.equal(bullets.length, 2, `one line for the name, one for the question: ${bullets.join(' / ')}`);
  assert.match(s, /Language proficiency/);
  assert.match(s, /Upper intermediate \(B2\)/);
  assert.match(s, /options: .*c2 - proficient\/native/, 'the choices stay visible');
});

test('an unanswered group still counts once, and shows what can be picked', () => {
  const answers = [
    { field: { kind: 'radio', label: 'yes', group: 'legal', question: 'Do you accept the terms' }, value: '', source: null, needs_confirmation: true },
    { field: { kind: 'radio', label: 'no', group: 'legal', question: 'Do you accept the terms' }, value: '', source: null, needs_confirmation: true },
  ];
  const s = buildReviewSummary({ role: 'R', company: 'C', method: 'm', answers });
  const bullets = s.split('\n').filter((l) => l.trim().startsWith('•'));
  assert.equal(bullets.length, 1);
  assert.match(s, /Do you accept the terms/);
  assert.match(s, /options: yes \| no/);
});

test('parseApproval: explicit approval only', () => {
  assert.equal(parseApproval('').decision, 'pending');
  assert.equal(parseApproval('n').decision, 'pending');
  assert.equal(parseApproval('hey there').decision, 'pending');
  assert.equal(parseApproval('GO').decision, 'submit');
  assert.equal(parseApproval('yes').decision, 'submit');
  assert.equal(parseApproval('abort').decision, 'abort');
});

test('parseApproval edits', () => {
  const d = parseApproval('edit why do you want to work here: I bring X');
  assert.equal(d.decision, 'edit');
  assert.match(d.label, /why do you want/);
  assert.equal(d.value, 'I bring X');
});