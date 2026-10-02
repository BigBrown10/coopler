/**
 * gaps.mjs — "what can't this tool answer for me?"
 *
 * A run leaves blanks behind, and blanks are easy to miss and annoying to
 * rediscover. This turns them into an explicit list, sorted by who can resolve
 * each one:
 *
 *   yours        a legal declaration or consent only you can give
 *   standing     you already answered this in config/answers.yml
 *   profile      a fact about you that belongs in profile.yml, not a guess
 *   open         a question the model declined to answer from your CV
 *
 * The point is that every blank comes with a reason and a next step, so "why was
 * this empty?" is never the question you have to ask.
 */

import { isGuardField } from '../ats/guard.mjs';
import { questionKey, toYamlBlock } from '../config/answers.mjs';

/**
 * Classify why a field has no answer.
 *
 * @param {object} answer the plan answer for the field (may be undefined)
 * @param {object} field  the extracted field
 * @param {Map} answered  questionKeys the user has already answered
 * @returns {'open'|'profile'|'yours'|'answered'}
 */
export function classifyGap(answer, field, answered) {
  if (answer && String(answer.value ?? '').trim()) return 'answered';
  const guard = Boolean(field.guard) || isGuardField(field);
  if (guard) return 'yours';
  // A free-text question the model left blank: either it is not in the CV, or it
  // is a judgement call. Either way it is a person's answer, not a derived one.
  if (field.kind === 'textarea' || field.kind === 'text') {
    if (answered && answered.has(questionKey(field.label))) return 'standing';
    return field.kind === 'textarea' ? 'open' : 'profile';
  }
  if (answered && (answered.has(questionKey(field.question)) || answered.has(questionKey(field.label)))) {
    return 'standing';
  }
  return 'profile';
}

const REASONS = {
  yours: 'a legal declaration or consent only you can give',
  profile: 'a fact about you — add it to config/profile.yml so it is not asked again',
  open: 'an open question — answer it once in config/answers.yml and it is reused',
  standing: 'you already answered this',
};

const short = (s, n = 68) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * Build the gap report for one posting.
 *
 * @param {Array} answers plan answers
 * @param {Array} fields  extracted fields
 * @param {{byKey: Map<string,string>}} store loaded standing answers
 * @returns {{total: number, answered: number, gaps: Array, byKind: object, yaml: string}}
 */
export function buildGapReport(answers, fields, store) {
  const answered = store && store.byKey ? store.byKey : new Map();
  const byField = new Map((answers || []).map((a) => [a.field, a]));
  const gaps = [];
  let answeredCount = 0;

  // A group of options is ONE question. Counting each unselected option as a
  // missing question produced 13 items where there were 5 questions, and a YAML
  // block with duplicate keys. Collapse by group first.
  //
  // This covers checkbox groups as well as radios, and it matters most there: on
  // Lever's "which race(s) apply?" the eight unticked boxes look like eight
  // separate questions, when ticking "Black or African American" answers the
  // lot. Leaving "White" alone is not a gap — it is the right answer.
  const groups = new Map();
  for (const field of fields || []) {
    if (field.kind === 'file') continue;
    const g = (field.kind === 'radio' || field.kind === 'checkbox') && field.group ? field.group : null;
    if (!g) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(field);
  }
  const inGroup = new Set();
  for (const [, members] of groups) {
    for (const m of members) inGroup.add(m);
    const chosen = members.find((m) => String((byField.get(m) || {}).value ?? '').trim());
    const first = members[0];
    if (chosen) {
      answeredCount++;
      continue;
    }
    // A group with no question text (a UUID-named survey, say) can still be seen
    // and ticked, but there is no stable key to answer it under in answers.yml,
    // so it is reported without pretending otherwise.
    const named = Boolean(first.question);
    gaps.push({
      kind: classifyGap({ value: '' }, first, answered),
      label: named ? first.question : `${members.length} unnamed options`,
      named,
      option: null,
      fieldKind: first.kind === 'checkbox' ? 'checkbox' : 'radio',
      required: members.some((m) => m.required),
      options: members.map((m) => m.label).slice(0, 8),
      reason: REASONS.yours,
    });
  }

  for (const field of fields || []) {
    // File inputs are not questions: the CV is attached to them automatically.
    if (field.kind === 'file') continue;
    // Radio and checkbox options were handled as one group above.
    if (inGroup.has(field)) continue;
    const answer = byField.get(field);
    const kind = classifyGap(answer, field, answered);
    if (kind === 'answered') { answeredCount++; continue; }
    gaps.push({
      kind,
      label: field.question || field.label,
      option: null,
      fieldKind: field.kind,
      required: Boolean(field.required),
      options: (field.options || []).slice(0, 8),
      reason: REASONS[kind],
    });
  }

  const byKind = gaps.reduce((acc, g) => {
    (acc[g.kind] = acc[g.kind] || []).push(g);
    return acc;
  }, {});

  // Offer a paste-ready block for the questions that a human should answer once.
  // Deduped by question key: duplicate YAML keys are invalid, and two entries for
  // the same question would silently drop one of them.
  const suggested = [];
  const seen = new Set();
  for (const g of [...(byKind.yours || []), ...(byKind.open || [])]) {
    if (!g.label) continue;
    // No question name means no key a future run could match, so offering one
    // would just be a line the user fills in that never gets used.
    if (g.named === false) continue;
    const k = questionKey(g.label);
    if (seen.has(k)) continue;
    seen.add(k);
    suggested.push({ question: g.label, value: '' });
  }

  return {
    // Counted in questions, not in inputs: a radio group is one question however
    // many options it has, so the denominator matches the list below it.
    total: answeredCount + gaps.length,
    answered: answeredCount,
    gaps,
    byKind,
    yaml: suggested.length ? toYamlBlock(suggested) : '',
  };
}

/** Human-readable rendering for the CLI. */
export function formatGapReport(report, { boardName = '', role = '' } = {}) {
  const lines = [];
  const where = [boardName, role].filter(Boolean).join(' — ');
  lines.push(where ? `Questions on ${where}` : 'Questions');
  lines.push(`${report.answered}/${report.total} answered without you.`);
  if (!report.gaps.length) {
    lines.push('Nothing outstanding — every question has an answer.');
    return lines.join('\n');
  }
  const order = ['yours', 'open', 'profile', 'standing'];
  for (const kind of order) {
    const items = report.byKind[kind];
    if (!items || !items.length) continue;
    lines.push('');
    lines.push(`${items.length} need ${kind === 'yours' ? 'you' : kind === 'profile' ? 'your profile' : kind} — ${REASONS[kind]}`);
    for (const g of items) {
      const bits = [`  - ${short(g.label)}`];
      if (g.required) bits.push('[required]');
      if (g.named === false) bits.push('(the board gives this no name — pick it on the page)');
      if (g.fieldKind === 'radio' && g.options && g.options.length) {
        bits.push(`— choose one: ${g.options.map((o) => short(o, 28)).join(' | ')}`);
      } else if (g.fieldKind === 'checkbox' && g.options && g.options.length) {
        bits.push(`— tick any that apply: ${g.options.map((o) => short(o, 28)).join(' | ')}`);
      } else if (g.options && g.options.length) {
        bits.push(`options: ${g.options.map((o) => short(o, 28)).join(' | ')}`);
      }
      lines.push(bits.join(' '));
    }
  }
  if (report.yaml) {
    lines.push('');
    lines.push('Answer them once in config/answers.yml:');
    lines.push(report.yaml);
  }
  return lines.join('\n');
}
