/**
 * Public entry point for one application.
 *
 * This module is only the composition root: it resolves config, builds the
 * dependency set, and hands off to the pipeline. All the work lives in
 * `workflow/apply.mjs` as named stages, and all board knowledge lives in
 * `ats/*` adapters.
 *
 * Re-exports are kept here because they are the tool's public surface.
 */

import { join } from 'node:path';

import { buildConfigFromEnv, PROJECT_ROOT } from './config/env.js';
import { loadProfile } from './config/profile.js';
import { loadAnswers } from './config/answers.mjs';
import { defaultRegistry } from './ats/detect.mjs';
import { chatCompletion } from './llm/provider.mjs';
import { tailorForRole, saveTailored } from './tailor.mjs';
import { AtsDriver } from './drive/driver.mjs';
import { createLogger } from './core/logger.mjs';
import { formatTrace, STAGE_ORDER } from './core/pipeline.mjs';
import { REASON, REMEDIATION, remediationFor, StageFailure } from './core/errors.mjs';
import { applyJob } from './workflow/apply.mjs';
import { createTelegram } from './notify/telegram.mjs';
import { buildGapReport } from './gate/gaps.mjs';
export { applyJob, buildApplyPipeline } from './workflow/apply.mjs';
export { interpretSubmitResult, findAnswerByLabel, askApproval } from './gate/submit.mjs';
export { STAGE, STAGE_ORDER, runPipeline, definePipeline, skip, formatTrace } from './core/pipeline.mjs';
export { StageFailure, REASON, REMEDIATION, remediationFor } from './core/errors.mjs';
export { resolveAdapter, resolveBoard, createRegistry, register } from './ats/registry.mjs';
export { assertAdapter, assertEndpoints } from './ats/contract.mjs';
export { greenhouseAdapter } from './ats/greenhouse/adapter.mjs';
export { GREENHOUSE } from './ats/greenhouse/endpoints.mjs';

/**
 * Run one application end to end.
 *
 * @returns {Promise<{submitted: boolean, approved: boolean, evidenceDir: ?string,
 *                    summary: ?string, trace: Array, error: ?string}>}
 */
export async function runApplication({
  url,
  profilePath,
  cvPath,
  resumePath,
  cfg = buildConfigFromEnv(),
  dryRun = false,
  headless = false,
  autoApprove = false,
  approveSubmit = false,
  preEdits = [],
  handover = false,
  questionsOnly = false,
  driverFactory = AtsDriver.launch,
  registry = defaultRegistry,
  archiveDir = join(PROJECT_ROOT, 'evidence'),
  log = createLogger({ run: 'apply' }),
}) {
  const profile = loadProfile(
    profilePath || join(PROJECT_ROOT, 'config', 'profile.yml'),
    cvPath || join(PROJECT_ROOT, 'cv.md'),
  );

  // The driver is created inside the OPEN stage, so it is published through a
  // holder: a later stage may throw, and the browser must still be closed.
  const driverRef = { current: null };

  const deps = {
    url,
    registry,
    profile,
    cfg: { ...cfg, dryRun, autoApprove, approveSubmit, handover, preEdits, questionsOnly },
    resumePath,
    headless,
    driverFactory,
    archiveDir,
    log,
    driverRef,
    chatCompletion,
    tailorForRole,
    saveTailored,
    // Questions the user has answered once, reused across postings. Loaded here
    // (not at module scope) so a bad answers.yml is reported on the run that
    // needed it rather than at import time.
    answers: loadAnswers(),
    // The Telegram review gate, when the user has a bot configured. Its
    // presence is what moves the review from the terminal to the user's phone.
    telegram: cfg.telegram?.botToken && cfg.telegram?.chatId
      ? createTelegram({ token: cfg.telegram.botToken, chatId: cfg.telegram.chatId })
      : null,
  };

  try {
    const { ctx, trace, result } = await applyJob(deps);
    const out = { ...result, trace };
    // A questions-only run has no result to report, so hand back the gap report
    // itself: which questions this posting asks that nothing can answer yet.
    if (questionsOnly && Array.isArray(ctx.fields)) {
      out.gaps = buildGapReport(ctx.answers, ctx.fields, deps.answers);
      out.board = ctx.board;
      out.roleTitle = ctx.roleTitle;
    }
    return out;
  } catch (e) {
    if (e instanceof StageFailure) {
      log.error('run.failed', { stage: e.stage, reason: e.reason, detail: e.detail });
      return {
        submitted: false,
        approved: false,
        summary: null,
        // The stages that did run are the useful part of a failure.
        trace: e.trace || [],
        error: e.detail || e.message,
        reason: e.reason,
        remediation: remediationFor(e.reason),
        ...(questionsOnly ? { gaps: null } : {}),
      };
    }
    log.error('run.failed', { reason: REASON.ERROR, detail: e?.message || String(e) });
    throw e;
  } finally {
    if (driverRef.current) await driverRef.current.close().catch(() => {});
  }
}

export { formatTrace as renderTrace };
