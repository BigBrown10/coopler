/**
 * The submit gate.
 *
 * Everything about deciding *whether* to send lives here, apart from the
 * mechanics of clicking. The rule is the same one the rest of the tool follows:
 * a click is not proof, and a "success" we did not observe is not a success.
 */

import readline from 'node:readline';
import { APPROVAL_HINT, parseApproval } from './review.mjs';

/**
 * Map a submit outcome to an honest result.
 *
 * The rule: only report a submission we can see evidence of. Clicking a button
 * is not proof. A board's own API rejection is the most specific signal
 * available and is reported as such rather than degraded to "unconfirmed".
 *
 * @param {object} res the driver's SubmitOutcome
 * @returns {{submitted: boolean, unconfirmed?: boolean, boardError?: object, error?: string, approved: true}}
 */
export function interpretSubmitResult(res, { evidenceDir = null, summary = null } = {}) {
  const ctx = { approved: true, evidenceDir, summary };
  if (typeof res === 'object' && res.boardError) {
    const b = res.boardError;
    const what = b.code ? `${b.code}: ${b.message || 'rejected by the board'}` : (b.message || 'rejected by the board');
    return { ...ctx, submitted: false, boardError: b, error: `The board rejected the submission (HTTP ${b.status}) — ${what}` };
  }
  if (typeof res === 'object' && res.errors && res.errors.length > 0) {
    return { ...ctx, submitted: false, error: `Form rejected with validation errors: ${res.errors.join(' | ')}` };
  }
  if (typeof res === 'object' && res.success) {
    return { ...ctx, submitted: true };
  }
  return {
    ...ctx, submitted: false, unconfirmed: true,
    error: 'Submit was clicked but no confirmation was detected. Check the board directly before assuming it went through.',
  };
}

/**
 * Find the answer whose field matches a user-supplied label. Exact label match
 * wins; otherwise a case-insensitive substring of the field's label or key.
 * Pure so the matching rules can be tested without a browser.
 */
export function findAnswerByLabel(answers, label) {
  const want = String(label || '').trim().toLowerCase();
  if (!want) return null;
  const labelOf = (a) => (a.field.label || a.field.key || '').toLowerCase();
  return answers.find((a) => labelOf(a) === want)
    || answers.find((a) => labelOf(a).includes(want))
    || answers.find((a) => want.includes(labelOf(a)) && labelOf(a).length > 3)
    || null;
}

/**
 * CLI approval loop: `go` submits, `no` aborts, `edit <label>: <value>`
 * changes an answer and re-renders. Returns true only on an explicit submit.
 *
 * Never submits on EOF or on unrecognised input — a closed pipe is not consent.
 *
 * @param {string} summary  the review to print
 * @param {{onEdit?: Function, render?: () => string}} hooks
 */
export function askApproval(summary, { onEdit, render } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.on('close', () => { closed = true; });
  const ask = (text) => new Promise((resolve) => {
    if (closed) return resolve(null);
    try {
      rl.question(text, resolve);
      rl.once('close', () => resolve(null));
    } catch { resolve(null); }
  });

  return (async () => {
    let current = summary;
    for (;;) {
      console.log('\n============================================================');
      console.log(current);
      console.log('============================================================');
      const input = await ask(APPROVAL_HINT + '\n> ');
      if (input === null) {
        console.log('\nInput ended without a decision. Nothing was submitted.');
        if (!closed) rl.close();
        return false;
      }
      const d = parseApproval(input);
      if (d.decision === 'submit') { rl.close(); return true; }
      if (d.decision === 'abort') { rl.close(); return false; }
      if (d.decision === 'edit') {
        if (!onEdit) {
          console.log('Editing is not available in this mode. Nothing was submitted.');
          rl.close();
          return false;
        }
        await onEdit(d.label, d.value);
        current = render ? render() : current;
        continue;
      }
      console.log('Did not understand that. Type "go", "no", or "edit <label>: <value>".');
    }
  })();
}
