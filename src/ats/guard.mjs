/**
 * Guard-field policy.
 *
 * A "guard" field is one where a wrong answer is a legal, financial, or
 * protected-characteristic mistake: work authorisation, sponsorship,
 * compensation, tax residency, and equality/demographic data.
 *
 * This policy is board-independent, so it does not live inside a board adapter.
 * It is imported by the mapper and by every adapter's field classifier, so
 * there is exactly one definition and it cannot drift.
 */

/**
 * Fields matching this are never auto-filled unattended: legal, visa,
 * sponsorship, work authorisation, compensation, tax residency, and
 * demographic/EOI questions. They may be *proposed* from the user's profile,
 * but the human confirms them.
 *
 * Consent and acknowledgement boxes belong here too: agreeing to an arbitration
 * agreement or certifying that you read something is a legal act, not a
 * preference, and nobody but the applicant should tick it.
 */
export const GUARD_RE = /legal|visa|sponsor|work.?auth|right\s+to\s+work|authoriz|authoris|eligib|tax\s+residen|salary|compensation|demographic|race|ethnic|gender|pronouns?\b|sexual\s+orientation|transgender|neurodiv|disabilit|nationalit|religion|equal.opportunit|diversit|veteran|citizen|birth|marital|privacy|consent|acknowledg|arbitration|i\s+agree|terms\s+(?:of|and)|i\s+confirm|i\s+certify|certif|attest|declare|liable|penalt|hold\s+harmless|nda|non.?disclos/i;

/** Pure: tag each field with whether it is guarded. */
/**
 * Infer the question a group of options belongs to, for boards that give no
 * question text at all.
 *
 * Lever's survey questions are named `surveysResponses[8dfb36ea-...]`, so there
 * is no question to read — but the OPTIONS say what is being asked, and "male /
 * female / non-binary" is unambiguously a gender question. Guessing from a fixed
 * vocabulary is safe in a way that guessing from a profile is not: it only ever
 * names the question, never the answer.
 *
 * @param {string[]} options the option texts of one group
 * @returns {string|null} a question name, or null if nothing is recognisable
 */
export function inferQuestionFromOptions(options) {
  const opts = (Array.isArray(options) ? options : []).map((o) => String(o).toLowerCase()).join(' | ');
  if (!opts.trim()) return null;
  const rules = [
    [/transgender|\btrans\b/, 'transgender'],
    [/\b(male|female|man|woman|non-?binary)\b/, 'gender identity'],
    [/hispanic|latino|\bwhite\b|\bblack\b|asian|pacific islander|american indian|\btwo or more\b/, 'race'],
    [/heterosexual|\bstraight\b|\bgay\b|lesbian|bisexual|pansexual/, 'sexual orientation'],
    [/\b(neurodiverg|neurodivergent|autis)/, 'neurodivergence'],
    [/disabilit|\bdisabled\b/, 'disability'],
    [/\b(veteran|served in the armed forces)\b/, 'veteran status'],
    [/\b(\d{1,3}\s*(or (older|younger)|-\d{2,3}))\b/, 'age'],
  ];
  for (const [re, name] of rules) if (re.test(opts)) return name;
  return null;
}

/** The question text for a field, falling back to what its options imply. */
export function questionScopeOf(field) {
  return field.question || (Array.isArray(field.options) ? inferQuestionFromOptions(field.options) : null) || '';
}

export function classifyFields(fields) {
  // Deliberately routed through isGuardField so `field.guard` can never disagree
  // with a direct isGuardField() call. Two copies of this rule drifted apart once
  // already: the extractor flagged "legal name" as a declaration while the mapper
  // correctly treated it as identity data.
  return fields.map((f) => ({ ...f, guard: isGuardField(f) }));
}

/**
 * True when a single field is guarded — a declaration, a legal right, protected
 * characteristic data, or anything else the user must answer in their own words.
 *
 * This is the ONE implementation. The question text counts, because boards name
 * EOI radio inputs things like "answer_1" and rely on a fieldset for the meaning.
 */
export function isGuardField(field) {
  if (!field) return false;
  // "Legal name" asks WHO YOU ARE, not for a declaration. The guard regex is
  // about statements and rights (legal authorisation, liability, arbitration),
  // and blocking an identity field on the word "legal" just left a blank that
  // the user had to retype on every single posting.
  const label = String(field.label || '').trim();
  if (/^legal\s*(first|last|full|given|family|sur)?\s*names?$/i.test(
    label.replace(/\((?:required|optional|if applicable)\)|[*]/gi, '').trim(),
  )) {
    return false;
  }
  const scope = `${field.label} ${field.name} ${field.kindRef || ''} ${field.question || ''} ${questionScopeOf(field)}`;
  if (GUARD_RE.test(scope.slice(0, 200))) return true;
  // Greenhouse renders some guard dropdowns with a blank label, so the option
  // text is all there is to go on.
  if (field.kind === 'select' && Array.isArray(field.options)) {
    if (GUARD_RE.test(field.options.join(' ').slice(0, 300))) return true;
  }
  return false;
}
