import { profileFieldMap, currentRoleContext } from '../config/profile.js';
import { parseJsonLoose } from '../llm/provider.mjs';
import { GUARD_RE, isGuardField, questionScopeOf } from '../ats/guard.mjs';

/**
 * Answer mapper.
 *
 * Strategy:
 *   1. Deterministic: match fields against profileFieldMap by label/key tokens.
 *   2. Guard fields (legal/visa/salary/demographic) are NEVER auto-filled.
 *   3. Remaining unmatched, non-guard fields go to the LLM fallback grounded in
 *      cv.md + profile, with strict refusal rules.
 *
 * Output: Array<{ field, value, source: 'profile'|'llm'|null, needs_confirmation: boolean }>
 */

export function tokenize(s) {
  return (s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const PROFILE_KEYS = {
  'full name': (m) => m['full name'] || '',
  'name': (m) => m['full name'] || '',
  // Ashby and others ask for a "legal name" explicitly. It is an identity field,
  // not a declaration, so it resolves like any other name field.
  'legal name': (m) => m['full name'] || '',
  'legal first name': (m) => m['first name'] || '',
  'legal last name': (m) => m['last name'] || '',
  'first name': (m) => m['first name'] || '',
  'given name': (m) => m['first name'] || '',
  'last name': (m) => m['last name'] || '',
  'family name': (m) => m['last name'] || '',
  'surname': (m) => m['last name'] || '',
  'email': (m) => m.email || '',
  'e-mail': (m) => m.email || '',
  'phone': (m) => m.phone || '',
  'telephone': (m) => m.phone || '',
  'mobile': (m) => m.phone || '',
  'cell': (m) => m.phone || '',
'location': (m) => m['current location'] || m.city || '',
  'current city': (m) => m.city || m['current location'] || '',
  'city': (m) => m.city || '',
  'what is your location': (m) => m['current location'] || m.city || '',
'linkedin': (m) => m.linkedin || '',
  'github': (m) => m.github || '',
  'website': (m) => m.website || m.portfolio || m.linkedin || '',
  'other website': (m) => m.website || m.portfolio || m.linkedin || '',
  'other website url': (m) => m.website || m.portfolio || m.linkedin || '',
  'portfolio url': (m) => m.portfolio || m.website || m.linkedin || '',
  'portfolio': (m) => m.portfolio || m.website || '',
  'personal website': (m) => m.website || m.portfolio || '',
  'responses/notes': null, // free text, LLM
};

/**
 * Score a field against the candidate keys. Generic single-word keys ("name",
 * "city", "location") must only win when the field label is exactly that word;
 * otherwise a field labeled "first name" must match "first name", never "name".
 * Among full matches we prefer the longest candidate (most specific).
 */
function scoreField(field, map) {
  const hayTokens = new Set(tokenize(`${field.label} ${field.key} ${field.name}`));
  let best = null;
  let bestLen = -1;
  for (const [candidateKey, getter] of Object.entries(PROFILE_KEYS)) {
    if (typeof getter !== 'function') continue;
    const candTokens = tokenize(candidateKey);
    if (candTokens.length === 0) continue;
    if (!candTokens.every((t) => hayTokens.has(t))) continue;
    const generic = GENERIC_KEYS.has(candidateKey);
    if (generic && candTokens.length < hayTokens.size) continue; // generic only on exact label
    if (candTokens.length > bestLen) {
      best = candidateKey;
      bestLen = candTokens.length;
    }
  }
  return best;
}

// Generic single-token keys: match only when the field is exactly about that token.
const GENERIC_KEYS = new Set(['name', 'city', 'location']);

// Guard detection lives in ats/guard.mjs and is re-exported here, because this
// module is where it is used most and several callers already import it from
// here. There is deliberately only ONE implementation: two copies drifted apart
// once, and the extractor and the mapper disagreed about what a guard field was.
export { isGuardField };

/**
 * Precise right-to-work statuses, which are legally distinct claims. The board
 * offers citizen/PR, a permanent visa right, a temporary visa right, and
 * "needs sponsorship" - so the tool only picks one the user has stated.
 */
const RIGHT_TO_WORK_MATCHERS = {
  // Boards word the same status a dozen ways. "citizen" must not swallow
  // "Permanent resident" and "temporary" must not swallow "permanent", so each
  // pattern is written to exclude the neighbouring status explicitly.
  citizen_pr: /\b(citizen|uk national| british national|naturalis[ed]|naturaliz(ed|ation))\b|permanent residen|unlimited|indefinite (leave|residen)/i,
  permanent_license: /permanent (right to work|visa|residen|licen)|unrestricted|open work visa/i,
  temporary_license: /temporary (right to work|visa|permission|licen)|limited[- ]time|fixed[- ]term/i,
};

/**
 * Resolve a work-authorization / sponsorship guard field to an answer from the
 * user's profile stance (only called when profile.work_authorization.auto_answer).
 * Picks the best-matching option from select/radio option lists; falls back to
 * Yes/No text for free inputs. Returns '' if the question isn't auth-related.
 */
export function workAuthAnswer(field, wa) {
  const l = `${field.question || ''} ${field.label} ${field.name}`.toLowerCase();
  const opts = field.options || [];
  const pick = (wantNo) => {
    if (!opts.length) return wantNo ? 'No' : 'Yes';
    const noish = opts.find((o) => /^no\b|do not|don't|not require|without sponsorship/i.test(o.trim()));
    const yesish = opts.find((o) => /^yes\b|i (will )?(require|need)|authorized|authorised/i.test(o.trim()));
    return (wantNo ? (noish || opts[0]) : (yesish || opts[0])) || '';
  };
  // pick() takes wantNo, so negate the user's positive stance.
  // "will you now or in the future require sponsorship?" -> stance
  if (/sponsor/.test(l)) return pick(!wa.requires_sponsorship);
  // "are you legally authorized / eligible / right to work" -> authorized
  if (/authori[sz]e|eligible|eligib|right to work|legally/.test(l)) {
    // Boards that split this into distinct legal statuses (citizen/PR, visa
    // rights, sponsorship) get a precise match or nothing at all. Boards that
    // just offer Yes/No are answered from the flag, which claims nothing more
    // than "legally authorized".
    const offersStatuses = opts.some((o) => /citizen|permanent residency|permanent right to work|temporary right to work|sponsor/i.test(o));
    if (opts.length && offersStatuses) {
      const st = wa.right_to_work_status;
      if (st && RIGHT_TO_WORK_MATCHERS[st]) {
        const hit = opts.find((o) => RIGHT_TO_WORK_MATCHERS[st].test(o));
        if (hit) return hit;
      } else if (wa.requires_sponsorship) {
        const sponsor = opts.find((o) => /sponsor/i.test(o));
        if (sponsor) return sponsor;
      }
      // The precise legal status is not on file, so we decline to assert one
      // (e.g. never claim citizenship from "legally authorized" alone). Leaving
      // it blank for the review gate is the correct answer, not a failure.
      return '';
    }
    return pick(!wa.legally_authorized_uk);
  }
  return '';
}

/**
 * A consent checkbox is auto-ticked ONLY when it is consent to process the very
 * data the user just supplied, and only when such data is actually being
 * submitted. Out of scope: marketing, T&Cs, liability, third-party sharing â€”
 * those carry independent legal meaning and are never ticked for you.
 */
const NEVER_AUTO_CONSENT_RE = /marketing|newsletter|terms (and|of) (service|use)|liability|waiver|arbitration|opt.?in to (receive|be contacted)|third part|share (my|your) (data|information)/i;

export function isConsentField(field) {
  if (field.kind !== 'checkbox') return false;
  return /\bconsent\b/i.test(`${field.label} ${field.name}`);
}

export function consentAnswer(field, eoiCount) {
  const l = `${field.label} ${field.name}`;
  if (NEVER_AUTO_CONSENT_RE.test(l)) return '';
  // Nothing to consent to processing -> the box stays for a human.
  if (eoiCount < 1) return '';
  return 'Yes';
}

/**
 * Resolve an equality-monitoring (EOI) question from profile.equality.
 *
 * These are protected-characteristic answers, so the caller must treat every
 * non-empty result as a SUGGESTION requiring confirmation, never as a final
 * answer. Returns '' when the value is unset or the field is a legal consent
 * checkbox (which we refuse to fill at all).
 */
export function equalityAnswer(field, eq) {
  if (!eq) return '';
  // Dispatch on the QUESTION, not just the field label: for a radio or a checkbox
  // the label is the option, and "female" says nothing about which EOI question
  // it is for. Falls back to what the options imply, for boards that name
  // nothing at all.
  const l = `${field.question || ''} ${questionScopeOf(field)} ${field.label} ${field.name}`.toLowerCase();
  // A <select> carries the board's options. A radio or checkbox does not: each
  // input IS one option, and its own label is the only answer the board will
  // accept. Getting this wrong once put "Man" on both the "male" and the
  // "female" radio â€” and left a checkbox question unanswerable altogether.
  const isOwnOption = field.kind === 'radio' || field.kind === 'checkbox';
  const opts = (field.options && field.options.length
    ? field.options
    : isOwnOption ? [field.label] : []
  ).map((o) => String(o).trim()).filter(Boolean);
  // Choose the board's own option text, but let the STORED VALUE drive the
  // choice. Matching on "which test is first" would answer every yes/no question
  // "Yes" regardless of what the user actually said.
  const boolPick = (value) => {
    const v = String(value ?? '').trim();
    if (!v) return '';
    if (!opts.length) return isOwnOption ? '' : v;
    const want = /^(yes|true|y)$/i.test(v) ? /^yes\b|^y$/i
      : /^(no|false|n)$/i.test(v) ? /^no\b|^n$/i
        : null;
    return want ? (opts.find((o) => want.test(o.trim())) || '') : '';
  };
  // Map the stored value to the board's option pattern via [valueMatch, optionMatch].
  const aliasPick = (value, groups) => {
    const v = String(value ?? '').trim();
    if (!v) return '';
    if (!opts.length) return isOwnOption ? '' : v;
    const lv = v.toLowerCase();
    for (const [match, pat] of groups) {
      if (!match.test(lv)) continue;
      const hit = opts.find((o) => pat.test(o));
      if (hit) return hit;
    }
    return '';
  };
  // Order matters: "transgender" contains "gender", so test it first.
  if (/transgender|trans\b/.test(l)) {
    return boolPick(eq.transgender);
  }
  if (/gender/.test(l)) {
    return aliasPick(eq.gender_identity, [
      [/^(man|male)$/i, /^man\b|^male\b|\bmale\b/i],
      [/^(woman|female)$/i, /^woman|^female/i],
      [/non.?binary/i, /non-?binary/i],
      [/self.?describe/i, /self-?describe/i],
      [/prefer not/i, /prefer not/i],
    ]);
  }
  if (/sexual orientation/.test(l)) {
    return aliasPick(eq.sexual_orientation, [
      [/heterosexual|straight/i, /heterosexual|straight/i],
      [/\bgay\b|lesbian|\bhomosexual/i, /gay|lesbian|homosexual/i],
      [/bisexual|^bi$/i, /bisexual/i],
      [/pansexual/i, /pansexual/i],
    ]);
  }
  // Boards say "race" as often as "ethnicity" (Ashby's EOI block does), and it
  // is the same protected characteristic with the same answers.
  if (/ethnicity|ethnic|race/.test(l)) {
    // Boards list granular sub-groups, e.g. "Black or Black British: African".
    // Match the specific pair first so "Black/African" never lands on Caribbean.
    return aliasPick(eq.ethnicity, [
      [/black.*african|african/i, /black.*african|african.*black/i],
      [/black.*caribbean|caribbean/i, /black.*caribbean|caribbean.*black/i],
      [/black/i, /black/i],
      [/white/i, /white/i],
      [/asian/i, /asian/i],
      [/mixed|multiple/i, /mixed|multiple/i],
      [/hispanic|latino/i, /hispanic|latino/i],
    ]);
  }
  if (/neurodiverg/.test(l)) {
    return boolPick(eq.neurodivergent);
  }
  if (/disabilit/.test(l)) {
    return boolPick(eq.disability);
  }
  if (/pronoun/.test(l)) return eq.pronouns || '';
  return '';
}

/**
 * Deterministic pass. Returns answers + the list of unmatched fillable fields.
 */
export function deterministicMatch(fields, profile) {
  const map = profileFieldMap(profile);
  const answers = [];
  const unmatched = [];
  let eoiCount = 0;
  const consentFields = [];
  for (const field of fields) {
    if (isConsentField(field)) { consentFields.push(field); continue; }
    if (isGuardField(field)) {
      // If the user opted into auto-answering work-auth/sponsorship fields from
      // their profile stance, fill them; otherwise leave blank for the gate.
      const wa = profile.work_authorization;
      const ans = wa && wa.auto_answer ? workAuthAnswer(field, wa) : '';
      if (ans) {
        // Filled from the user's stated stance, but still surfaced at the gate.
        answers.push({ field, value: ans, source: 'profile', needs_confirmation: true, guard_autofilled: true });
      } else if (profile.equality && profile.equality.auto_propose) {
        // Equality-monitoring (EOI) suggestion. Still a guard field, so it is
        // always surfaced at the review gate and never submitted unattended.
        const eqAns = equalityAnswer(field, profile.equality);
        if (eqAns) eoiCount++;
        answers.push({
          field, value: eqAns, source: eqAns ? 'profile' : null,
          needs_confirmation: true, guard_autofilled: Boolean(eqAns),
        });
      } else {
        answers.push({ field, value: '', source: null, needs_confirmation: true });
      }
      continue;
    }
    const key = scoreField(field, map);
    if (key) {
      // The getter resolves the value (e.g. 'name' -> fullName from map).
      const getter = PROFILE_KEYS[key];
      const value = typeof getter === 'function' ? (getter(map) || '') : '';
      if (value.trim()) {
        answers.push({ field, value: value.trim(), source: 'profile', needs_confirmation: false });
      } else if (field.required) {
        // Matched a known field but profile has no value -> surface for review.
        answers.push({ field, value: '', source: 'profile-empty', needs_confirmation: true });
      } else {
        unmatched.push(field);
      }
    } else {
      unmatched.push(field);
    }
  }
  // Consent boxes resolved last: only tickable if EOI data is actually going out.
  for (const f of consentFields) {
    const val = consentAnswer(f, eoiCount);
    answers.push({
      field: f, value: val, source: val ? 'profile' : null,
      needs_confirmation: true, guard_autofilled: Boolean(val),
    });
  }
  return { answers, unmatched };
}

/**
 * A group of options is one question, so at most ONE option may carry an answer.
 * Seen live on Ashby: "male", "female" and "decline to self-identify" all came
 * back holding the same value. Lever asks the same question with checkboxes
 * rather than radios, and the same rule holds: ticking the boxes we did not mean
 * to tick is worse than ticking none.
 *
 * Where several options in a group are answered, keep the one whose own label
 * best matches the value it was given, and blank the rest. An option with no
 * answer is still listed (so the review gate shows the question as outstanding)
 * but is never filled.
 *
 * @param {Array<{field: object, value: string}>} answers
 * @returns {Array} answers with at most one filled option per group
 */
export function oneAnswerPerGroup(answers) {
  const groups = new Map();
  for (const a of answers) {
    const g = a.field && a.field.group;
    if (!g) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(a);
  }
  for (const members of groups.values()) {
    const filled = members.filter((a) => String(a.value ?? '').trim());
    if (filled.length <= 1) continue;
    // Prefer the option the value actually names; fall back to the first.
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    const winner = filled.find((a) => {
      const v = norm(a.value);
      return v && norm(a.field.label).includes(v) || norm(a.field.label).includes(v);
    }) || filled[0];
    for (const a of members) {
      if (a === winner) continue;
      a.value = '';
      a.source = null;
      a.withheld = 'another option in the same question was answered';
      a.needs_confirmation = true;
    }
  }
  return answers;
}

const LLM_RULES = `
Rules (non-negotiable):
- Ground EVERY answer in the candidate's cv.md and profile below. Never invent facts, metrics, employers, or dates not present there.
- If a field labeled "work authorization / sponsorship / legal / salary / demographic" appears, do NOT answer it: return value "" and needs_confirmation true.
- If you cannot answer grounded in the candidate data, return value "" and needs_confirmation true.
- For open-ended questions: NEVER describe the role back to them. NEVER use these phrases: "I'm excited", "I'm passionate", "I can leverage", "I believe I can", "this role involves". INSTEAD, state what you've done: "At Inscribable, I scaled a platform to 30,000 users..." or "I shipped agentic workflows that cut processing by 35%..." End with a confident statement about your value, not a hope.
- Keep answers concise (1-4 sentences for dropdowns/fields, 2-5 sentences for essay questions).
- Respond with ONLY a JSON array. For each field, copy its key EXACTLY as given in "key=\"...\"": [{"key":"<exact field key>","value":"<answer|string>","needs_confirmation":true|false}]`;

/**
 * LLM fallback for unmatched fields. `chatFn(baseUrl, apiKey, model, sysHint)` is injected so
 * tests can stub it; production wires chatCompletion().
 */

// A react-select box often exposes only a placeholder, and some boards name
// their fields with a UUID. Neither is a question a model can answer honestly.
const PLACEHOLDERISH = /\.\.\.|^type here$|^start typing|^pick |^select$|^choose$|^search$/i;
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this string a real question rather than a placeholder or a field id? */
export function isRealLabel(label) {
  const s = String(label || '').trim();
  return Boolean(s) && !PLACEHOLDERISH.test(s) && !UUIDISH.test(s);
}

/**
 * May the model draft this field at all?
 *
 * No for guard fields (legal, EOI, eligibility, consent): the user answers those
 * in their own words, and a model that "answers" an arbitration-agreement
 * acknowledgement on someone's behalf is worse than no automation at all. No for
 * file inputs. No for fields with no real label to answer.
 */
export function isDraftableField(f) {
  if (!f) return false;
  if (f.guard) return false;
  if (f.kind === 'file') return false;
  return isRealLabel(f.label);
}

export async function llmMatch(unmatched, profile, jdText, chatFn) {
  // Filter first, so a drafted guard answer is not even possible.
  const draftable = unmatched.filter(isDraftableField);
  if (draftable.length === 0) return [];
  const context = currentRoleContext(profile);
  const qlist = draftable
    .map((f, i) => `[${i}] key="${f.key}" label="${f.label}" kind=${f.kind}${f.options ? ' options=' + JSON.stringify(f.options.slice(0, 8)) : ''}`)
    .join('\n');
  const userPrompt = `Candidate profile/cv:\n${profile.cvText || '(no cv)'}\n\nCurrent role: ${context || 'n/a'}\n\nJob description:\n${(jdText || '').slice(0, 5000)}\n\nFields to answer:\n${qlist}\n\n${LLM_RULES}`;
  const content = await chatFn({
    role: 'system', content: 'You fill job application fields truthfully and only from the given candidate data, never inventing facts.'
  }, userPrompt);
  if (process.env.AUTOAPPLY_DEBUG) console.error(`[debug] llmMatch raw (${content.length} chars): ${content.slice(0, 500)}`);
  const parsed = extractJson(content);
  if (process.env.AUTOAPPLY_DEBUG) console.error(`[debug] llmMatch parsed ${parsed.length} items; keys wanted: ${draftable.map((f) => f.key).slice(0, 10).join(',')}...`);
  if (!Array.isArray(parsed)) throw new Error('LLM answer mapper did not return a JSON array.');
  const byKey = new Map(draftable.map((f) => [f.key, f]));
  const byIndex = new Map(draftable.map((f, i) => [String(i), f]));
  const resolve = (a) => byKey.get(a.key) || byIndex.get(String(a.key)) || null;
  const kept = parsed.filter((a) => resolve(a));
  if (process.env.AUTOAPPLY_DEBUG) console.error(`[debug] llmMatch kept ${kept.length}/${parsed.length} after key resolution`);
  return kept
    .map((a) => ({
      field: resolve(a),
      value: String(a.value ?? ''),
      source: 'llm',
      needs_confirmation: Boolean(a.needs_confirmation),
    }))
    // Strip fluff sentences from LLM-drafted free-text answers.
    .map((a) => {
      if (a.source === 'llm' && a.field.kind === 'textarea') {
        const fluffRe = /\b(?:I'm excited|I'm passionate|I'm confident|I believe I can|I can leverage|this role involves)\b[^.]*\.?\s*/gi;
        a.value = a.value.replace(fluffRe, '').replace(/\s{2,}/g, ' ').trim();
      }
      return a;
    });
}

function extractJson(s) {
  return parseJsonLoose(s, { kind: 'array', what: 'field answers' });
}
