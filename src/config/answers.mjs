/**
 * answers.mjs — questions the tool refuses to guess, answered once by the user.
 *
 * A posting asks things no profile can answer honestly: "do you accept the
 * arbitration agreement?", "what is your legal name?", "describe a project that
 * changed how you think". The mapper leaves those blank on purpose. This file is
 * where the user answers them, so the same question is never a surprise twice.
 *
 * `config/answers.yml` maps a question to an answer:
 *
 *   answers:
 *     "legal name": "Osamudiamen Edogun"
 *     "i confirm i have read the above": "Yes"
 *     "describe a project that changed how you think": |
 *       ...
 *
 * Matching is deliberately forgiving about wording (see `questionKey`), because
 * boards phrase the same question differently every time. It is deliberately
 * strict about who may answer: an entry here is a statement by the user, so it
 * may fill a guard field, but it is always shown at the review gate first.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

import { PROJECT_ROOT } from './env.js';

export function defaultAnswersPath() {
  return join(PROJECT_ROOT, 'config', 'answers.yml');
}

/**
 * Normalise a question to a comparable key.
 *
 * Boards add "?", "*", "(Required)", "yes/no" and stray whitespace to the same
 * question, so those are stripped. Capitalisation and word order are kept
 * because "decline to self-identify" and "prefer not to say" must not collide.
 */
export function questionKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\(required\)|\*|\?+/g, ' ')
    .replace(/\s*\(yes\/no\)\s*/g, ' ')
    .replace(/[:\u2013\u2014\u2026]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Load the user's standing answers.
 *
 * A missing file is normal (most postings need nothing from it), so this returns
 * an empty store rather than throwing. A malformed file IS an error: silently
 * ignoring the user's answers would look like the tool forgetting them.
 *
 * @param {string} [path] defaults to config/answers.yml
 * @returns {{ byKey: Map<string, string>, count: number, path: string, exists: boolean }}
 */
export function loadAnswers(path = defaultAnswersPath()) {
  const byKey = new Map();
  if (!existsSync(path)) return { byKey, count: 0, path, exists: false };
  let doc;
  try {
    doc = load(readFileSync(path, 'utf8')) || {};
  } catch (e) {
    throw new Error(`Failed to parse answers YAML ${path}: ${e.message}`);
  }
  const raw = doc.answers && typeof doc.answers === 'object' ? doc.answers : {};
  for (const [q, a] of Object.entries(raw)) {
    const value = typeof a === 'string' ? a.trim() : '';
    // An empty answer is not an answer. Recording it would let a half-finished
    // file look like the user had answered the question.
    if (value) byKey.set(questionKey(q), value);
  }
  return { byKey, count: byKey.size, path, exists: true };
}

/**
 * Look up a standing answer for a field.
 *
 * Tries the full question first, then the field's own label. The second lookup
 * matters for radio groups, where the label is the option ("male") and the
 * question is the fieldset text: a user who answered the question once should
 * not have to answer each option separately.
 *
 * @returns {{ value: string, key: string }|null}
 */
export function lookupAnswer(byKey, field) {
  if (!byKey || byKey.size === 0) return null;
  for (const candidate of [field.question, field.label]) {
    const k = questionKey(candidate);
    if (!k) continue;
    if (byKey.has(k)) return { value: byKey.get(k), key: k };
    // The user may have written the first line of a multi-line question and
    // stopped, or YAML may have truncated a key with an embedded colon.
    // One unambiguous prefix is still a match.
    const prefix = [...byKey.keys()].filter((sk) => sk.length >= 4 && k.startsWith(sk));
    if (prefix.length === 1) return { value: byKey.get(prefix[0]), key: prefix[0] };
  }
  return null;
}

/**
 * Format the user's answers as a YAML block they can paste into answers.yml.
 * Used by the `questions` report so answering is a copy-paste, not a guess at
 * which key the tool will look for.
 */
export function toYamlBlock(entries) {
  const lines = ['answers:'];
  for (const { question, value } of entries) {
    const q = /[:#]/.test(question) ? JSON.stringify(question) : question;
    const v = value.includes('\n') ? JSON.stringify(value) : value;
    lines.push(`  ${q}: ${v}`);
  }
  return lines.join('\n');
}
