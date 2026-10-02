/**
 * The apply pipeline.
 *
 * One application, expressed as a fixed sequence of named stages. Each stage
 * is a function of the run context and returns a patch that is merged back in.
 * Nothing else in the codebase needs to know the order, and every stage result
 * lands in a trace.
 *
 *   resolve  -> url safety, adapter resolution, profile load
 *   guard    -> what protections does this board enforce, and what do they mean
 *   open     -> launch a browser and load the application form
 *   extract  -> read the form's fields through the adapter
 *   plan     -> match the profile, LLM fallback, tailor the CV
 *   fill     -> write the values, handle captcha, screenshot
 *   attach   -> upload the CV
 *   review   -> present everything and wait for a decision
 *   submit   -> press the board's submit control
 *   confirm  -> decide, honestly, whether it was actually submitted
 *   archive  -> write the evidence manifest
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

import { STAGE, definePipeline, runPipeline, skip } from '../core/pipeline.mjs';
import { StageFailure, REASON } from '../core/errors.mjs';
import { resolveBoard } from '../ats/registry.mjs';
import { assertPublicHttpsUrl } from '../ats/urlguard.mjs';
import { deterministicMatch, llmMatch, isDraftableField, oneAnswerPerGroup } from '../mapper/mapper.mjs';
import { buildReviewSummary } from '../gate/review.mjs';
import { interpretSubmitResult, findAnswerByLabel, askApproval } from '../gate/submit.mjs';
import { makeTelegramGate } from '../gate/telegram-gate.mjs';
import { archiveEvidence } from '../evidence/archive.mjs';
import { fetchGreenhouseCode } from '../gmail-code.mjs';
import { solveRecaptchaWithFallback } from '../captcha/solver.mjs';
import { handOverToHuman } from './handover.mjs';
import { PROJECT_ROOT, ensureDir } from '../config/env.js';
import { lookupAnswer } from '../config/answers.mjs';

/**
 * @param {object} deps
 * @param {object} deps.registry        adapter registry
 * @param {Function} deps.driverFactory (opts) => driver
 * @param {object} deps.profile         loaded profile
 * @param {object} deps.cfg             resolved config
 * @param {string} deps.resumePath      fallback CV to attach
 * @param {boolean} deps.dryRun
 * @param {boolean} deps.approveSubmit  explicit opt-in to send
 * @param {boolean} deps.autoApprove    instrumented inspection; never submits
 * @param {boolean} deps.handover       fill and leave the browser open
 * @param {string[]} deps.preEdits      "<label>: <value>" overrides
 * @param {string|null} deps.archiveDir
 */
export function buildApplyPipeline(deps) {
  return definePipeline([
    { name: STAGE.RESOLVE, run: resolveStage(deps) },
    { name: STAGE.GUARD, run: guardStage(deps) },
    { name: STAGE.OPEN, run: openStage(deps) },
    { name: STAGE.EXTRACT, run: extractStage(deps) },
    { name: STAGE.PLAN, run: planStage(deps) },
    { name: STAGE.FILL, run: fillStage(deps) },
    { name: STAGE.ATTACH, run: attachStage(deps) },
    { name: STAGE.REVIEW, run: reviewStage(deps) },
    { name: STAGE.SUBMIT, run: submitStage(deps) },
    { name: STAGE.CONFIRM, run: confirmStage(deps) },
    { name: STAGE.ARCHIVE, run: archiveStage(deps) },
  ]);
}

/** Run the pipeline. Returns { ctx, trace, result }. */
export async function applyJob(deps) {
  const pipeline = buildApplyPipeline(deps);
  const { ctx, trace } = await runPipeline({ pipeline, ctx: { deps }, log: deps.log });
  return { ctx, trace, result: ctx.result };
}

/* ------------------------------------------------------------------ stages */

function resolveStage({ registry, profile }) {
  return async function resolve(ctx) {
    const { deps } = ctx;
    // SSRF guard runs before any browser work, let alone any network egress.
    const u = await assertPublicHttpsUrl(deps.url);
    const { adapter, board } = resolveBoard(registry, u.toString());
    const endpoints = adapter.endpoints(board);
    deps.log?.info('board.resolved', { ats: adapter.name, host: board.host, jobId: board.jobId });
    return { adapter, board, endpoints, url: u, profile: profile };
  };
}

/**
 * Report the protections this board enforces before a single field is touched.
 * The point is that these are known and declared, not discovered by accident
 * halfway through a submit.
 */
function guardStage({ log }) {
  return async function guard(ctx) {
    const { adapter } = ctx;
    const caps = adapter.capabilities;
    const protections = [];
    if (caps.botCheck) protections.push(`${caps.botCheck}${caps.botCheckBlocksSubmit ? ' (enforced on submit)' : ''}`);
    if (caps.securityCodeStep) protections.push('emailed security code');
    if (caps.eoiQuestions) protections.push('equality/demographic questions');
    if (caps.needsConsentWall) protections.push('cookie-consent wall (yours to accept)');
    if (caps.applyIsModal) protections.push('apply form opens in a modal');
    log?.info('board.protections', { protections: protections.join(', ') || 'none' });
    // A board that is known not to be fillable end-to-end should say so now,
    // not after a run has spent minutes and a tailored CV on it.
    if (caps.needsConsentWall || caps.applyIsModal) {
      log?.warn('board.not_automatable', {
        board: adapter.name,
        why: 'the apply form needs a consent click and/or a modal the extractor cannot see',
        next: 'open the posting yourself, or run with --inspect to see how far it gets',
      });
    }
    return { protections };
  };
}

function openStage({ driverFactory, cfg, headless, log, driverRef }) {
  return async function open(ctx) {
    const { endpoints, board } = ctx;
    const driver = await driverFactory({
      browser: undefined,
      channel: cfg.browser.channel,
      profileDir: cfg.browser.profileDir,
      headless,
    });
    // Publish immediately so a later failure still closes the browser.
    if (driverRef) driverRef.current = driver;
    const target = endpoints.application(ctx.board);
    try {
      await driver.goto(target);
    } catch (e) {
      throw new StageFailure('open', REASON.NAVIGATION, `could not load ${target}: ${e?.message || e}`, { cause: e });
    }
    log?.debug('form.opened', { url: target, board: board.boardToken });
    return { driver, applicationUrl: target };
  };
}

function extractStage({ log }) {
  return async function extract(ctx) {
    let fields;
    try {
      fields = await ctx.adapter.extractFields(ctx.driver);
    } catch (e) {
      throw new StageFailure('extract', REASON.EXTRACTION, e?.message || String(e), { cause: e });
    }
    if (!Array.isArray(fields) || fields.length === 0) {
      // Boards disagree about where the form lives: some render it on the
      // posting page, some on a separate apply route, some only after you press
      // their apply control. Work down that list before giving up, and record
      // what worked, so the adapter can be corrected from evidence.
      const posting = ctx.endpoints.jobPage(ctx.board);
      if (posting && posting !== ctx.applicationUrl) {
        log?.info('form.search', { tried: ctx.applicationUrl, next: posting });
        await ctx.driver.goto(posting);
        const alt = await ctx.adapter.extractFields(ctx.driver).catch(() => []);
        if (Array.isArray(alt) && alt.length) {
          log?.info('form.found', { url: posting, total: alt.length });
          fields = alt;
        }
      }
    }
    if ((!Array.isArray(fields) || fields.length === 0) && typeof ctx.adapter.revealForm === 'function') {
      log?.info('form.reveal', { board: ctx.adapter.name });
      await ctx.adapter.revealForm(ctx.driver).catch((e) => {
        log?.warn('form.reveal_failed', { error: e?.message || String(e) });
      });
      const revealed = await ctx.adapter.extractFields(ctx.driver).catch(() => []);
      if (Array.isArray(revealed) && revealed.length) {
        log?.info('form.found', { how: 'revealForm', total: revealed.length });
        fields = revealed;
      }
    }
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new StageFailure('extract', REASON.EXTRACTION, 'the form exposed no fields - the extractor does not match this board');
    }
    const guards = fields.filter((f) => f.guard).length;
    log?.info('fields.extracted', { total: fields.length, guard: guards });
    // The URL only carries a job id; the human-readable title comes from the page.
    const roleTitle = await readRoleTitle(ctx.driver).catch(() => '');
    return { fields, roleTitle };
  };
}

/**
 * Stamp the user's standing answers onto a plan.
 *
 * Two things this has to get right:
 *   1. A standing answer may land on a field the mapper never emitted — a guard
 *      field with no profile value still appears in `answers` as a blank, but a
 *      field that fell out of the plan entirely needs adding from `fields`.
 *   2. The user answered the QUESTION, so a radio group is filled on the option
 *      that matches. Writing the answer onto whichever option the mapper picked
 *      would be a guess about which button the user meant.
 *
 * @param {Array} answers plan answers, mutated in place where possible
 * @param {Array} fields  every extracted field
 * @param {{byKey: Map<string,string>}} store loaded answers
 * @returns {{answers: Array, applied: number}}
 */
function applyStandingAnswers(answers, fields, store) {
  if (!store || !store.byKey || store.byKey.size === 0) return { answers, applied: 0 };
  let applied = 0;
  const byFieldKey = new Map(answers.map((a) => [a.field, a]));
  for (const field of fields) {
    const hit = lookupAnswer(store.byKey, field);
    if (!hit) continue;
    const value = String(hit.value).trim();
    if (!value) continue;
    let answer = byFieldKey.get(field);
    if (!answer) {
      answer = { field, value: '', source: null, needs_confirmation: true };
      answers.push(answer);
      byFieldKey.set(field, answer);
    }
    // Only count it as the user's answer if the option is actually the one they
    // named. On a radio group that means matching the option text.
    if (field.kind === 'radio') {
      if (!optionMatches(field.label, value)) continue;
      // The user named this option, so the group is settled: clear the others
      // here rather than letting the profile's choice survive alongside it and
      // win on field order at the dedupe step.
      for (const other of answers) {
        if (other === answer || other.field === field) continue;
        if (other.field.group !== field.group || !other.field.group) continue;
        if (String(other.value ?? '').trim()) {
          other.withheld = `your standing answer names "${value}" for this question`;
        }
        other.value = '';
        other.source = null;
        other.needs_confirmation = true;
      }
    }
    answer.value = value;
    answer.source = 'user';
    answer.needs_confirmation = true;
    answer.from_answers = true;
    applied++;
  }
  return { answers, applied };
}

/**
 * Does this option correspond to the user's answer?
 *
 * Case and punctuation aside, the answer has to be recognisably the option. A
 * standing answer of "Yes" must not light up a "No" radio, and one question's
 * answer must not spill onto a different question's options.
 */
function optionMatches(optionLabel, value) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const o = norm(optionLabel);
  const v = norm(value);
  if (!o || !v) return false;
  return o === v || o.startsWith(v) || o.includes(v);
}

function planStage(deps) {
  return async function plan(ctx) {
    const { cfg, resumePath, log, chatCompletion: chat } = deps;
    const { profile } = ctx;
    const { answers, unmatched } = deterministicMatch(ctx.fields, profile);
    log?.info('plan.matched', { matched: answers.length, unmatched: unmatched.length });

    let llmAnswers = [];
    let jdText = '';
    if (unmatched.length > 0 && !cfg.dryRun) {
      // Guard fields, file inputs and unlabelled boxes are never drafted: they
      // are the user's to answer, and the count is logged so a skipped field is
      // visible rather than silently missing from the review.
      const draftable = unmatched.filter(isDraftableField);
      const withheld = unmatched.length - draftable.length;
      if (withheld) log?.info('plan.withheld', { from_llm: withheld, total: unmatched.length });
      if (draftable.length) {
        jdText = await fetchJdText(ctx.driver.page);
        llmAnswers = await llmMatch(draftable, profile, jdText, buildFillChatFn(cfg, chat));
      }
    }
    // The user's own standing answers have the final say, including on guard
    // fields: an entry in answers.yml is the user answering in their own words.
    // They still go to the review gate, because "the user said so" is not the
    // same as "this is safe to send without reading".
    //
    // Applied BEFORE the group dedupe below, never after: a standing answer that
    // lands on a different radio option than the mapper chose would otherwise
    // leave the group holding two answers.
    const stamped = applyStandingAnswers([...answers, ...llmAnswers], ctx.fields, deps.answers);
    if (stamped.applied) {
      log?.info('plan.standing_answers', { applied: stamped.applied, store: deps.answers?.path || '(none)' });
    }

    // One question, one answer: a radio group must never end up with several
    // options filled, whatever produced them.
    const grouped = oneAnswerPerGroup(stamped.answers);
    const collided = grouped.filter((a) => a.withheld).length;
    if (collided) log?.warn('plan.radio_group_collision', { withheld: collided });
    const all = grouped;

    // When the posting names a salary and we must leave it for the user anyway,
    // surface the range so the review screen shows "50-60k" next to the gap.
    const boardSalaries = extractSalaryMentions(jdText);
    if (boardSalaries.length) log?.info('plan.salary_mentions', { boardSalaries });

    // Build a clean, ATS-friendly CV PDF from the profile. No LLM — just
    // structured data rendered through Playwright. This produces a browser-grade
    // PDF that Lever/Ashby parsers can read, unlike the ReportLab cv.pdf.
    let tailoredResumePath = resumePath;
    try {
      if (!cfg.dryRun && !cfg.questionsOnly) {
        const outDir = join(PROJECT_ROOT, 'evidence', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
        ensureDir(outDir);
        const pdf = join(outDir, 'cv.pdf');
        await ctx.driver.buildCvPdf(ctx.profile, pdf);
        tailoredResumePath = pdf;
        log?.info('cv.built', { path: pdf });
      }
    } catch (e) {
      log?.warn('cv.build_failed', { error: e?.message || String(e) });
    }
    return { answers: all, tailoredResumePath, boardSalaries };
  };
}

function fillStage({ cfg, log }) {
  return async function fill(ctx) {
    const { driver, fields, answers, profile } = ctx;
    const { dryRun } = cfg;

    // "What can't you answer?" is a read-only question: no typing, no uploading,
    // no CV tailoring, and above all no submit.
    if (cfg.questionsOnly) return skip('questions-only run: nothing is written to the page');

    // Location autocomplete is committed last: filling other fields wipes its
    // React state.
    const city = (profile.identity?.location || '').split(',')[0].trim();
    const locationAnswers = [];
    const restAnswers = [];
    for (const a of answers) {
      const lbl = `${a.field.label} ${a.field.name} ${a.field.key}`.toLowerCase().replace(/_/g, ' ');
      const isLocation = /(^|\s)(location|city)(\s|$)|location \(city\)|candidate location/.test(lbl);
      (isLocation && a.field.kind === 'text' && !a.needs_confirmation && a.value ? locationAnswers : restAnswers).push(a);
    }

    const fillable = restAnswers.filter((a) => a.value && (!a.needs_confirmation || a.guard_autofilled));
    log?.info('fill.begin', { count: fillable.length });
    const fillStart = Date.now();
    await driver.fillFields(fillable);
    log?.info('fill.fields_done', { ms: Date.now() - fillStart });

    if (!dryRun) {
      for (const a of locationAnswers) {
        await driver.setAutocomplete(a.field, a.value, city);
      }
      // Comboboxes with ids but no names are invisible to the extractor.
      await driver.fillCombos(profile);
    }
    log?.debug('fill.combos_done', { ms: Date.now() - fillStart });
    const captcha = await handleCaptcha(driver, { cfg, dryRun });
    const screenshots = [await driver.screenshot('filled-form')];
    log?.info('form.filled', { filled: fillable.length, location: locationAnswers.length, captchaLevel: captcha.level, ms: Date.now() - fillStart });
    return { captcha, screenshots };
  };
}

function attachStage({ cfg, log }) {
  return async function attach(ctx) {
    if (cfg.questionsOnly) return skip('questions-only run: nothing is uploaded');
    const { driver, fields, answers, tailoredResumePath } = ctx;
    if (!tailoredResumePath || !existsSync(tailoredResumePath) || cfg.dryRun) {
      return skip('no CV to attach');
    }
    const fileFields = fields.filter((f) => f.kind === 'file' && /resume|cv|curriculum/i.test(`${f.label} ${f.name} ${f.key}`));
    let resumeAttached = false;
    for (const ff of fileFields) {
      const ok = await driver.uploadFile(ff, tailoredResumePath);
      if (!ok) continue;
      resumeAttached = true;
      // Keep the review honest: a field satisfied by the tool is not "empty".
      const a = answers.find((x) => x.field.key === ff.key);
      if (a) {
        a.value = basename(tailoredResumePath);
        a.source = 'tool';
        a.needs_confirmation = false;
      }
    }
    log?.info('cv.attached', { attached: resumeAttached, fields: fileFields.length });
    return { resumeAttached };
  };
}

/**
 * When required fields are empty at the review gate, ask the LLM to reason
 * from the profile. The options themselves often name the question: "no /
 * yes - intern / yes - full time employment" says "studying status" clearer
 * than any label could, and a profile that says the candidate has 7+ years
 * of experience answers it without guessing.
 *
 * Only fields whose options carry enough signal to decide are answered;
 * ambiguous or truly unknown fields are left for the human.
 */
async function reasonAboutRequired(required, profile, chatCompletion, cfg, log) {
  const chatFn = async (userContent) => {
    const { llm } = cfg;
    return chatCompletion({
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: llm.model,
      messages: [
        { role: 'system', content: `You are an agent that reads a job-application form and determines the correct answer from the candidate's profile. Return ONLY valid JSON. Never guess or invent facts not in the profile.` },
        { role: 'user', content: userContent },
      ],
      maxTokens: 1000,
      temperature: 0,
    });
  };
  const fieldsDesc = required.map((a) => ({
    label: a.field.label || a.field.key,
    kind: a.field.kind,
    required: Boolean(a.field.required),
    question: a.field.question || null,
    options: (a.field.options || []).slice(0, 12),
    name: a.field.name || null,
  }));
  const prompt = [
    'A job application form has these required fields that the candidate left empty:',
    JSON.stringify(fieldsDesc, null, 2),
    '',
    'Candidate profile summary:',
    `Name: ${profile.identity?.first_name || ''} ${profile.identity?.last_name || ''}`,
    `Location: ${profile.identity?.location || ''}`,
    `Current role: ${(profile.experience || [])[0]?.title || 'unknown'}`,
    `Years of experience: ${((profile.experience || []).length || 0)}+`,
    '',
    'For EACH field, determine the correct value from the profile. Return JSON:',
    '[{"key": "<field label or key>", "value": "<the correct answer>"}]',
    '',
    'Rules:',
    '- A field with options "no / yes - intern / yes - full time employment" asks about student status. A candidate with professional experience is NOT a student → answer "no".',
    '- A field asking for location/country → use the candidate\'s country (from their location).',
    '- Gender/ethnicity/disability/veteran/pronouns questions → use the candidate\'s stated identity.',
    '- If a field is truly ambiguous, OMIT it from the array.',
    '- Never invent. If unsure, omit.',
  ].join('\n');
  try {
    const res = await chatFn(prompt);
    const raw = (res?.choices?.[0]?.message?.content || res?.content || res?.text || '');
    // Use the same robust parser the rest of the codebase trusts.
    const { parseJsonLoose } = await import('../llm/provider.mjs');
    const parsed = parseJsonLoose(raw, { kind: 'array', what: 'required-field reasoning' });
    const arr = Array.isArray(parsed) ? parsed : (parsed?.answers || parsed?.fields || []);
    const solved = [];
    for (const item of arr) {
      const key = (item.key || item.label || '').toLowerCase().replace(/\s+/g, '_');
      const match = required.find((a) => {
        const lk = (a.field.label || a.field.key || '').toLowerCase().replace(/\s+/g, '_');
        return lk === key || lk.includes(key) || key.includes(lk);
      });
      if (match && item.value && String(item.value).trim()) {
        solved.push({ field: match.field, value: String(item.value).trim() });
      }
    }
    log?.info('review.reasoning_result', { asked: fieldsDesc.length, solved: solved.length });
    return solved;
  } catch (e) {
    log?.warn('review.reasoning_failed', { error: e?.message || String(e) });
    // Deterministic fallback: when options name the question ("no / yes - intern
    // / yes - full time" = studying), infer the answer from profile facts.
    return deterministicRequiredReasoning(required, profile);
  }
}

/**
 * When the LLM can't reason about required fields, fall back to what the
 * options themselves say. A checkbox group with "no / yes - intern / yes - full
 * time employment" is a studying-status question, and a profile with work
 * experience says the candidate is not a student.
 */
function deterministicRequiredReasoning(required, profile) {
  const solved = [];
  const hasExperience = (profile.experience || []).length > 0;
  // For checkbox/radio groups, the options live across sibling fields sharing
  // the same group key, not on any single field's options array.
  const byGroup = new Map();
  for (const a of required) {
    const g = (a.field.kind === 'radio' || a.field.kind === 'checkbox') ? a.field.group : null;
    if (!g) continue;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(a);
  }
  const seenGroup = new Set();
  for (const a of required) {
    const g = (a.field.kind === 'radio' || a.field.kind === 'checkbox') ? a.field.group : null;
    if (g) {
      if (seenGroup.has(g)) continue;
      seenGroup.add(g);
      const members = byGroup.get(g) || [a];
      const opts = members.map((m) => String(m.field.label || '').toLowerCase().trim());
      const joined = opts.join(' | ');
      // Student/studying/internship status
      if (/\b(no|yes|yes.*intern|yes.*full.time|yes.*part.time)\b/i.test(joined) && hasExperience) {
        const noMember = members.find((m) => /^no\b/i.test(String(m.field.label || '')));
        if (noMember) solved.push({ field: noMember.field, value: String(noMember.field.label || 'no') });
      }
      continue;
    }
    const opts = (a.field.options || []).map((o) => String(o).toLowerCase().trim());
    if (opts.length === 0) continue;
    const joined = opts.join(' | ');
    if (/\b(no|yes|yes.*intern|yes.*full.time|yes.*part.time)\b/i.test(joined) && hasExperience) {
      const noOpt = opts.find((o) => /^no\b/i.test(o));
      if (noOpt) solved.push({ field: a.field, value: noOpt });
    }
  }
  return solved;
}

function reviewStage(deps) {
    const { cfg, log } = deps;
    return async function review(ctx) {
      if (cfg.questionsOnly) return skip('questions-only run: there is nothing to approve yet');
      const { driver, answers, board, fields, captcha, resumeAttached, profile, boardSalaries } = ctx;
    const role = ctx.roleTitle || board.role;

    const method = [
      `Deterministic profile matching first (${fields.length} fields)`,
      `grounded LLM fallback via ${cfg.llm.model} for open questions`,
      resumeAttached ? 'Resume PDF attached.' : 'No resume attached.',
      captcha.level ? `Captcha level ${captcha.level}: ${captcha.prompt}` : '',
    ].filter(Boolean).join('; ');

    const buildSummary = () => buildReviewSummary({
      role,
      company: board.company || board.host,
      method,
      answers,
      captcha: captcha.level ? { prompt: captcha.prompt } : null,
      jdUrl: board.jobUrl,
      workAuth: profile.work_authorization || null,
      boardSalaries: boardSalaries || [],
    });

    const applyEdit = async (label, value, { quiet = false } = {}) => {
      const target = findAnswerByLabel(answers, label);
      if (!target) {
        if (!quiet) console.log(`No field matches "${label}". Answer left unchanged.`);
        return false;
      }
      target.value = value;
      target.source = 'user';
      target.needs_confirmation = false;
      target.user_edited = true;
      if (!cfg.dryRun) await driver.setField(target.field, value);
      if (!quiet) console.log(`Updated: ${target.field.label || target.field.key} -> ${value}`);
      return true;
    };

    // Scripted overrides land before the review, so the summary shows them.
    for (const spec of cfg.preEdits) {
      const m = String(spec).match(/^\s*(.+?)\s*:\s*([\s\S]+?)\s*$/);
      if (!m) { console.error(`Ignoring malformed --set "${spec}" (expected "<label>: <value>").`); continue; }
      const ok = await applyEdit(m[1], m[2], { quiet: true });
      console.log(`${ok ? 'Set' : 'No field matched for'} "${m[1]}" -> ${m[2]}`);
    }

    // The approval gate is where the user happens to be: the terminal by
    // default, Telegram when a bot is configured. Both have the same contract
    // — nothing submits without an explicit yes.
    let gate = askApproval;
    if (deps.telegram) {
      const jdText = await fetchJdText(driver.page).catch(() => '');
      gate = makeTelegramGate({
        telegram: deps.telegram,
        audio: cfg.audio || {},
        chat: (messages) => deps.chatCompletion({
          baseUrl: cfg.llm.baseUrl, apiKey: cfg.llm.apiKey, model: cfg.llm.model,
          messages, maxTokens: 2000, temperature: 0.4,
        }),
        profile,
        jdText,
        log,
        timeoutMs: cfg.telegram?.timeoutMs,
      });
    }

    // Required fields left empty are never safe to send. Before giving up,
    // ask the LLM to reason about each one — the options often carry enough
    // signal ("yes - intern" / "yes - full time" / "no" = studying-status)
    // to answer it from the profile without fabricating.
    //
    // A withheld field in an answered group is intentionally blank: "yes -
    // intern" left empty while "no" is ticked is the correct answer, not a gap.
    const answeredGroups = new Set();
    for (const a of answers) {
      if (a.field.group && String(a.value ?? '').trim()) answeredGroups.add(a.field.group);
    }
    const requiredButEmpty = answers.filter((a) =>
      a.field.required &&
      !String(a.value ?? '').trim() &&
      !(a.field.group && answeredGroups.has(a.field.group)),
    );
    if (requiredButEmpty.length && deps.chatCompletion) {
      log?.info('review.reasoning_required', { count: requiredButEmpty.length });
      const solved = await reasonAboutRequired(requiredButEmpty, profile, deps.chatCompletion, cfg, log);
      if (solved.length) {
        for (const s of solved) {
          const target = answers.find((a) => a.field === s.field);
          if (target) {
            target.value = s.value;
            target.source = 'llm';
            target.needs_confirmation = true;
            target.guard_autofilled = true; // allow fill despite needs_confirmation
          }
        }
        // Re-check: the LLM may have solved some but not all. A group with
        // any answered member counts the whole group as resolved.
        const answeredG = new Set();
        for (const a of answers) {
          if (a.field.group && String(a.value ?? '').trim()) answeredG.add(a.field.group);
        }
        const stillEmpty = answers.filter((a) =>
          a.field.required &&
          !String(a.value ?? '').trim() &&
          !(a.field.group && answeredG.has(a.field.group)),
        );
        if (stillEmpty.length === 0) {
          log?.info('review.reasoning_resolved', { solved: solved.length });
        } else {
          log?.warn('review.reasoning_partial', {
            solved: solved.length,
            remaining: stillEmpty.map((a) => a.field.label || a.field.key).slice(0, 6),
          });
          console.error(
            `\nBLOCKED: ${stillEmpty.length} required field(s) still empty after reasoning:\n` +
            stillEmpty.map((a) => `  - ${a.field.label || a.field.key}`).join('\n') +
            `\n\nAdd answers to config/answers.yml or config/profile.yml.\n`,
          );
          return { approved: false, summary: buildSummary(), method, blocked: true, requiredButEmpty: stillEmpty };
        }
      } else {
        console.error(
          `\nBLOCKED: ${requiredButEmpty.length} required field(s) left empty:\n` +
          requiredButEmpty.map((a) => `  - ${a.field.label || a.field.key}`).join('\n') +
          `\n\nThese must be filled before submitting. Add them to config/answers.yml or config/profile.yml.\n`,
        );
        return { approved: false, summary: buildSummary(), method, blocked: true, requiredButEmpty };
      }
    } else if (requiredButEmpty.length) {
      // No LLM available — hard stop.
      console.error(
        `\nBLOCKED: ${requiredButEmpty.length} required field(s) left empty:\n` +
        requiredButEmpty.map((a) => `  - ${a.field.label || a.field.key}`).join('\n') +
        `\n\nThese must be filled before submitting. Add them to config/answers.yml or config/profile.yml.\n`,
      );
      return { approved: false, summary: buildSummary(), method, blocked: true, requiredButEmpty };
    }

    const willSubmit = !(cfg.dryRun || cfg.autoApprove || cfg.handover)
      && (cfg.approveSubmit || await gate(buildSummary(), {
        onEdit: applyEdit,
        render: buildSummary,
        // Answers the profile could not supply: one question each, so the
        // user can answer from their phone — by text, or by voice note that
        // gets reworded into a polished answer.
        questions: answers
          .filter((a) => !a.value || (a.needs_confirmation && (a.guard || a.source === 'llm')))
          .map((a) => ({ label: a.field.label || a.field.key, options: a.field.options || [] })),
      }));

    const summary = buildSummary();
    if (!willSubmit) {
      log?.info('review.no_approval', {});
      if (cfg.handover) await handOverToHuman(driver, { summary });
      // method is recorded either way: evidence must explain how the answers
      // were produced even for a run that stopped short of submitting.
      return { approved: false, summary, method };
    }
    log?.info('review.approved', {});
    return { approved: true, summary, method };
  };
}

function submitStage({ cfg, log }) {
  return async function submit(ctx) {
    if (!ctx.approved) return skip('no approval given');
    const caps = ctx.adapter.capabilities;
    // The bot check is verified server-side on this board's POST, so passing
    // the checkbox is not enough: the form needs a solved token. With a
    // solving service configured the token is bought and injected; without
    // one, the automated click is refused and a human finishes the job.
    if (caps.botCheckBlocksSubmit) {
      const order = cfg.captcha?.order || [];
      const keys = cfg.captcha?.keys || {};
      const available = order.filter((n) => keys[n]).map((n) => ({ name: n, apiKey: keys[n] }));
      if (caps.botCheck === 'recaptcha' && available.length > 0) {
        try {
          const { sitekey, enterprise: domEnterprise } = await ctx.driver.getRecaptchaInfo();
          if (!sitekey) throw new Error('no reCAPTCHA sitekey found on the form');
          // Some boards (OpenAI Ashby) use Enterprise reCAPTCHA even when the
          // DOM doesn't advertise it. The adapter capability overrides detection.
          const enterprise = domEnterprise || Boolean(caps.botCheckEnterprise);
          const { token, provider } = await solveRecaptchaWithFallback({
            providers: available,
            sitekey,
            pageUrl: ctx.applicationUrl || ctx.board.jobUrl,
            enterprise,
            pollMs: cfg.captcha?.pollMs,
            timeoutMs: cfg.captcha?.timeoutMs,
            log,
          });
          const injected = await ctx.driver.injectRecaptchaToken(token);
          if (!injected) throw new Error('no g-recaptcha-response field found on the form');
          log?.info('captcha.token_injected', {
            fields: injected, enterprise, provider,
            tokenPrefix: `${token.slice(0, 24)}... (${token.length} chars)`,
          });
        } catch (e) {
          throw new StageFailure('submit', REASON.BOT_CHECK, `captcha solving failed: ${e?.message || e}`);
        }
      } else {
        return skip(`${caps.botCheck} is enforced on submit; a human must press the final control`);
      }
    }
    log?.info('submit.start', { endpoint: ctx.endpoints.submit(ctx.board) });
    const outcome = await ctx.adapter.submit(ctx.driver);
    log?.info('submit.clicked', {
      clicked: Boolean(outcome?.clicked),
      boardError: outcome?.boardError?.code || null,
    });
    return { outcome };
  };
}

function confirmStage(deps) {
  const { log, fetchSecurityCode = readSecurityCode } = deps;
  return async function confirm(ctx) {
    if (!ctx.approved) return { result: { submitted: false, approved: false, summary: ctx.summary } };
    if (!ctx.outcome) {
      return { result: { submitted: false, approved: true, summary: ctx.summary, error: 'Approved but the submit stage did not run.' } };
    }
    const outcome = ctx.outcome;

    // The emailed security code is the final verification, reached either way:
    // the page shows the code input directly, or the board answers the submit
    // with a 428 captcha-failed that names a recipient — that response is the
    // code step announcing itself, not a rejection.
    const codeStep = outcome.securityCode
      || (outcome.boardError?.code === 'captcha-failed' && outcome.boardError.securityCodeRecipient);
    if (codeStep) {
      // Only a code emailed for THIS attempt completes this application; a
      // code from an earlier attempt must not be reused.
      const code = await fetchSecurityCode({
        since: new Date(Date.now() - 45 * 1000),
        log,
        gmail: deps.cfg?.gmail,
      });
      if (!code) {
        const to = outcome.boardError?.securityCodeRecipient;
        return { result: { submitted: false, approved: true, summary: ctx.summary, error: `Security code required${to ? ` (sent to ${to})` : ''}. Check your email.` } };
      }
      // The board's own instruction: enter the code in the form's security
      // code field, then resubmit. The field can render only after the board
      // knows the application needs verification, so reload once and look
      // again before declaring it missing.
      let filled = await ctx.driver.fillSecurityCode(code).catch(() => false);
      if (!filled) {
        await ctx.driver.goto(ctx.applicationUrl || ctx.board.jobUrl).catch(() => {});
        await ctx.driver.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        filled = await ctx.driver.fillSecurityCode(code).catch(() => false);
      }
      if (!filled) {
        return { result: { submitted: false, approved: true, summary: ctx.summary, error: `Security code ${code} was read from email, but no code field was found on the page.` } };
      }
      log?.info('security_code.entered', {});
      const retry = await ctx.adapter.submit(ctx.driver);
      // The retry is the whole point of the code step; its raw outcome must be
      // in the log, not just the interpreted verdict.
      log?.info('security_code.retry', {
        clicked: Boolean(retry?.clicked),
        boardError: retry?.boardError ? `${retry.boardError.status} ${retry.boardError.code}` : null,
        success: Boolean(retry?.success),
        url: retry?.url || null,
        stillOnForm: retry?.stillOnForm !== false,
        text: (retry?.text || '').slice(0, 150),
      });
      return { result: interpretSubmitResult(retry, { summary: ctx.summary }) };
    }

    if (!outcome.clicked) {
      return { result: { submitted: false, approved: true, summary: ctx.summary, error: 'Approved but no submit control was found.' } };
    }

    const result = ctx.adapter.isConfirmed(outcome)
      ? { submitted: true, approved: true, summary: ctx.summary }
      : interpretSubmitResult(outcome, { summary: ctx.summary });
    log?.info('confirm.result', { submitted: result.submitted, unconfirmed: Boolean(result.unconfirmed) });
    return { result };
  };
}

function archiveStage({ archiveDir, log }) {
  return async function archive(ctx) {
    if (ctx.deps.cfg?.questionsOnly) return skip('questions-only run: no evidence to archive');
    if (!archiveDir) return skip('no archive dir configured');
    ensureDir(archiveDir);
    const screenshots = ctx.outcome
      ? [...ctx.screenshots, await ctx.driver.screenshot('post-submit').catch(() => null)].filter(Boolean)
      : ctx.screenshots;
    const evidenceDir = archiveEvidence({
      baseDir: archiveDir,
      company: ctx.board.company || ctx.board.boardToken || ctx.board.host,
      role: ctx.roleTitle || ctx.board.role,
      jdUrl: ctx.board.jobUrl,
      method: ctx.method || '',
      answers: ctx.answers,
      captchaPrompt: ctx.captcha?.level ? ctx.captcha.prompt : null,
      screenshots,
      submitted: Boolean(ctx.result?.submitted),
      submittedAt: ctx.result?.submitted ? new Date().toISOString() : null,
      blocked: ctx.blocked || false,
      blockedFields: ctx.requiredButEmpty?.map((a) => a.field.label || a.field.key) || [],
    });
    log?.info('evidence.archived', { dir: evidenceDir, submitted: Boolean(ctx.result?.submitted) });
    // The result is the run's answer; evidenceDir is just where it is recorded.
    return { result: { ...(ctx.result || {}), evidenceDir } };
  };
}

/* ----------------------------------------------------------------- helpers */

/** Read the job's own title from the page, for the review header and evidence. */
async function readRoleTitle(driver) {
    const title = await driver.page.title?.();
  if (!title) return '';
  // Greenhouse titles are "Job Application for X at Y" / "X at Y | Y".
  const cleaned = String(title)
    .replace(/^job application for\s+/i, '')
    .replace(/\s*[-|–|]\s*[^-|–|]*$/, '')
    .trim();
  return cleaned || String(title).trim();
}

async function fetchJdText(page) {
  try {
    return await page.evaluate(() => document.body.innerText.slice(0, 6000));
  } catch { return ''; }
}

/**
 * Scan the posting body for salary mentions so a "what is your salary
 * expectation?" question is never answered cold. Returns an array of strings
 * like ["50-60k GBP", "USD 120k-150k"]. Empty when nothing is found — the
 * review gate will still ask, but without the hint.
 */
function extractSalaryMentions(jdText) {
  const t = String(jdText || '');
  const out = [];
  // UK £ range patterns
  for (const m of t.matchAll(/£\s*\d[\d,.]*\s*k?\s*[-–—to]+\s*[£]?\s*\d[\d,.]*\s*k?\b/gi)) out.push(m[0].replace(/\s+/g, ' ').trim());
  // USD range patterns
  for (const m of t.matchAll(/\$\s*\d[\d,.]*\s*k?\s*[-–—to]+\s*[$,]?\s*\d[\d,.]*\s*k?\b/gi)) out.push(m[0].replace(/\s+/g, ' ').trim());
  // EUR range patterns
  for (const m of t.matchAll(/€\s*\d[\d,.]*\s*k?\s*[-–—to]+\s*[€\s]?\s*\d[\d,.]*\s*k?\b/gi)) out.push(m[0].replace(/\s+/g, ' ').trim());
  // "salary: $X" style lines
  for (const m of t.matchAll(/(?:salary|compensation|paying|range)[:\s]+\$?\s*\d[\d,.]*\s*k?\s*[-–—to]+\s*\$?\s*\d[\d,.]*\s*k?\b/gi)) {
    const s = m[0].trim();
    if (!out.some((o) => s.includes(o) || o.includes(s))) out.push(s);
  }
  // Per-annum hints — "£ per annum", "/yr", "/year"
  const withPeriod = out.map((o) => {
    const idx = t.indexOf(o);
    if (idx < 0) return o;
    const after = t.slice(idx + o.length, idx + o.length + 30).replace(/\n/g, ' ').trim();
    const m2 = after.match(/(per\s*(annum|year)|p\.?a\.?|\/yr|\/year)/i);
    return m2 ? `${o} ${m2[0]}` : o;
  });
  return [...new Set(withPeriod)].slice(0, 3);
}

function buildFillChatFn(cfg, chat) {
  const { llm } = cfg;
  // OpenRouter's llama-3.3-70b is preferred for form filling; Groq is kept for
  // captcha vision via cfg.vision.
  const openRouterKey = cfg.vision.apiKey || process.env.OPENROUTER_API_KEY || '';
  return async (sys, user) => {
    const useOpenRouter = Boolean(openRouterKey);
    return chat({
      baseUrl: useOpenRouter ? 'https://openrouter.ai/api/v1' : llm.baseUrl,
      apiKey: useOpenRouter ? openRouterKey : llm.apiKey,
      model: useOpenRouter ? 'meta-llama/llama-3.3-70b-instruct' : llm.model,
      messages: [
        { role: 'system', content: sys.content },
        { role: 'user', content: user },
      ],
      maxTokens: 4000,
    });
  };
}

async function tailorResume(ctx, deps, current) {
  const { cfg, log, tailorForRole, saveTailored } = deps;
  try {
    const jdText = await fetchJdText(ctx.driver.page);
    const tailored = await tailorForRole({
      jdText, cvText: ctx.profile.cvText, profile: ctx.profile,
      openRouterKey: cfg.vision.apiKey || process.env.OPENROUTER_API_KEY || '',
    });
    const outDir = join(PROJECT_ROOT, 'evidence', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
    ensureDir(outDir);
    const tailoredHtml = saveTailored({
      summary: tailored.summary, email: tailored.email, profile: ctx.profile, outDir,
      keywords: tailored.keywords || [],
    });
    const pdf = join(outDir, 'cv-tailored.pdf');
    try {
      await ctx.driver.renderPdf(readFileSync(tailoredHtml, 'utf8'), pdf);
      return pdf;
    } catch {
      return tailoredHtml;
    }
  } catch (e) {
    log?.warn('tailor.failed', { error: e?.message || String(e) });
  }
  // Fall back to the static CV so the application still carries a resume.
  const fallback = join(PROJECT_ROOT, 'cv.pdf');
  return current || (existsSync(fallback) ? fallback : null);
}

async function readSecurityCode({ since, log, gmail = {} } = {}) {
  const user = gmail.user || process.env.GMAIL_USER || '';
  const pass = gmail.appPassword || process.env.GMAIL_APP_PASSWORD || '';
  if (!user || !pass) return null;
  // The code email can lag the 428 by a few seconds, so poll rather than
  // declaring failure on the first empty inbox.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const code = await fetchGreenhouseCode({ user, password: pass, since });
      if (code) {
        log?.info('security_code.read', {});
        return code;
      }
    } catch (e) {
      log?.warn('security_code.fetch_failed', { error: e?.message || String(e) });
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

async function handleCaptcha(driver, { cfg, dryRun }) {
  const captcha = await driver.captchaDetection();
  if (captcha.level === 1) {
    await driver.clickCheckboxCaptcha();
  } else if (captcha.level === 2 && !dryRun) {
    let ok = false;
    for (let i = 0; i < cfg.limits.captchaVisionAttempts; i++) {
      try {
        if (await yieldTiles(driver, await driver.runVisionCaptcha(cfg.vision))) { ok = true; break; }
      } catch { /* retry */ }
    }
    if (!ok) captcha.prompt = `Image-grid captcha unsolved after ${cfg.limits.captchaVisionAttempts} attempts; human must finish.`;
  }
  captcha.prompt = captcha.promptFor ? captcha.promptFor : promptFor(captcha.level);
  return captcha;
}

function promptFor(level) {
  switch (level) {
    case 1: return 'Checkbox captcha: agent clicked it; verify on the review screen.';
    case 2: return 'Image-grid captcha: bounded vision attempts done; check before submit.';
    case 3: return 'Managed challenge present: human must complete in the open browser.';
    default: return '';
  }
}

async function yieldTiles(driver, out) {
  const m = String(out || '').match(/\[([0-9,\s]+)\]/);
  if (!m) return false;
  const tiles = m[1].split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
  if (tiles.length === 0) return false;
  return driver.page.evaluate((idxs) => {
    const cells = Array.from(document.querySelectorAll('table.captcha-display tr td, .rc-imageselect-desc-no-canonical + .rc-imageselect-table td, td.rc-imageselect-target-1'));
    idxs.forEach((i) => { if (cells[i]) cells[i].click(); });
    return true;
  }, tiles).catch(() => false);
}
