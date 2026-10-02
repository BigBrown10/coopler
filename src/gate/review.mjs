/**
 * Final-review gate. Produces the human-facing summary and decides approval.
 *
 * The agent presents:
 *   - what it did and how (method)
 *   - every question and the drafted answer (or an explicit note that a guard
 *     field was left empty)
 *   - captcha status
 *   - then waits: the submission click happens ONLY on explicit approval.
 */
export function buildReviewSummary({ role, company, method, answers, captcha, jdUrl, workAuth, boardSalaries } = {}) {
  const lines = [];
  lines.push(`Application ready for review — ${role ? `${role} at ` : ''}${company}`);
  lines.push(`JD: ${jdUrl}`);
  lines.push('');
  lines.push('Method:');
  lines.push(`  ${method || 'Deterministic profile matching first; grounded LLM fallback for open questions.'}`);
  lines.push('');
  lines.push(`Captcha: ${captcha ? captcha.prompt : 'none present'}`);
  lines.push('');
  lines.push('Questions and answers:');
  for (const row of collapseForDisplay(answers)) {
    const a = row.answer;
    const label = row.label;
    const flag = a.source === 'user'
      ? ' [set by you]'
      : a.needs_confirmation
        ? a.value
          ? ' [PROPOSED from your profile — confirm this is correct]'
          : ' [NEEDS YOUR INPUT — guard/unknown field, not auto-filled]'
        : a.source === 'profile'
          ? ` [from profile${a.value ? '' : ' — empty, auto-skipped'}]`
          : ' [drafted by LLM — verify]';
    lines.push(`  • ${label}${flag}`);
    lines.push(`      ${a.value || '(left empty)'}`);
    if (row.options && row.options.length) {
      lines.push(`      options: ${row.options.join(' | ')}`);
    }
    // For guard fields left empty, suggest an answer from profile.work_authorization.
    if (a.needs_confirmation && !a.value && workAuth) {
      const suggestion = suggestWorkAuth(label, workAuth);
      if (suggestion) lines.push(`      SUGGESTED (from your profile — confirm before submitting): ${suggestion}`);
    }
    // When salary is left empty and the posting text mentions a range, surface
    // it so the user can compare against industry rates.
    if (a.needs_confirmation && !a.value && /\b(salary|compensation|pay)\b/i.test(label)) {
      if (boardSalaries?.length) lines.push(`      BOARD SAYS: ${boardSalaries.join(' | ')}`);
      else lines.push('      BOARD SAYS (no salary range found on page — check industry rate)');
    }
    // When salary IS answered from standing answers, still show the board context
    // so the user can decide whether to change it.
    if (a.needs_confirmation && a.value && /\b(salary|compensation|pay)\b/i.test(label) && boardSalaries?.length) {
      lines.push(`      BOARD SAYS: ${boardSalaries.join(' | ')}`);
    }
  }
  lines.push('');
  lines.push(APPROVAL_HINT);
  return lines.join('\n');
}

/**
 * One line per QUESTION, not per option.
 *
 * A radio or checkbox group is a single question with several inputs, so listing
 * every option separately showed six lines for one language-proficiency question
 * — five of them "(left empty)" — on the very screen the user approves from. The
 * answers themselves are untouched, so `edit <label>: <value>` still works.
 */
function collapseForDisplay(answers) {
  const rows = [];
  const groups = new Map();
  for (const a of answers || []) {
    const g = (a.field && (a.field.kind === 'radio' || a.field.kind === 'checkbox')) ? a.field.group : null;
    if (!g) {
      rows.push({ answer: a, label: a.field.label || a.field.key });
      continue;
    }
    // Keep the position of the group's FIRST option, so the summary still reads
    // in the order the board asks the questions.
    if (groups.has(g)) { groups.get(g).members.push(a); continue; }
    const entry = { members: [a], label: null, options: null };
    groups.set(g, entry);
    rows.push(entry);
  }
  for (const entry of groups.values()) {
    const { members } = entry;
    const chosen = members.find((m) => String(m.value || '').trim());
    // The answered option speaks for the group; otherwise the first one does, and
    // the options are listed so the choice is still visible.
    const shown = chosen || members[0];
    entry.answer = chosen || members[0];
    entry.label = shown.field.question || shown.field.label || `${members.length} options`;
    entry.options = members.map((m) => m.field.label).filter(Boolean).slice(0, 10);
  }
  return rows;
}

/** Map an authorization/sponsorship guard-field label to the user's profile stance. */
function suggestWorkAuth(label, wa) {
  const l = label.toLowerCase();
  if (/sponsor/.test(l)) return wa.requires_sponsorship ? 'Yes — I require sponsorship' : 'No — I do not require sponsorship';
  if (/authori[sz]e|legally|eligible|eligib|right to work/.test(l)) return wa.legally_authorized_uk ? 'Yes — I am legally authorized to work in the UK' : 'No';
  return null;
}

export const APPROVAL_HINT = `Type 'go' to submit, 'no' to abort, or 'edit <label>: <value>' to change an answer first.`;

export function parseApproval(input) {
  const raw = (input || '').trim();
  const s = raw.toLowerCase();
  if (!s) return { decision: 'pending' };
  if (/^(go|yes|submit|approve|do it)$/.test(s)) return { decision: 'submit' };
  if (/^(no|abort)$/.test(s) || /^abort /.test(s)) return { decision: 'abort' };
  const edit = raw.match(/^edit\s+(.+?)\s*:\s*([\s\S]+)$/);
  if (edit) return { decision: 'edit', label: edit[1].trim(), value: edit[2].trim() };
  return { decision: 'pending' };
}