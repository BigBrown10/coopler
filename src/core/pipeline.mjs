/**
 * The application pipeline.
 *
 * The run is a fixed, named sequence of stages. Every stage is declared up
 * front, every stage result is recorded in a trace, and a stage failure is
 * typed rather than thrown as a bare Error. That gives three properties the
 * old 400-line function did not have:
 *
 *   1. You can see exactly which step broke, and when.
 *   2. Adding an ATS or a step means adding a declaration, not an `if`.
 *   3. A stage can be skipped with a recorded reason instead of vanishing.
 */

import { StageFailure } from './errors.mjs';

/** Canonical stage names. Order here is the order they run in. */
export const STAGE = Object.freeze({
  RESOLVE: 'resolve',
  GUARD: 'guard',
  OPEN: 'open',
  EXTRACT: 'extract',
  PLAN: 'plan',
  FILL: 'fill',
  ATTACH: 'attach',
  REVIEW: 'review',
  SUBMIT: 'submit',
  CONFIRM: 'confirm',
  ARCHIVE: 'archive',
});

export const STAGE_ORDER = Object.freeze([
  STAGE.RESOLVE,
  STAGE.GUARD,
  STAGE.OPEN,
  STAGE.EXTRACT,
  STAGE.PLAN,
  STAGE.FILL,
  STAGE.ATTACH,
  STAGE.REVIEW,
  STAGE.SUBMIT,
  STAGE.CONFIRM,
  STAGE.ARCHIVE,
]);

/**
 * Build a pipeline from stage definitions.
 * @param {Array<{name: string, run: Function, optional?: boolean}>} stages
 */
export function definePipeline(stages) {
  // An empty pipeline is a declaration bug that would otherwise present as a
  // successful run that did nothing.
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error('A pipeline needs at least one stage.');
  }
  const seen = new Set();
  for (const s of stages) {
    if (!STAGE_ORDER.includes(s.name)) {
      throw new Error(`Unknown stage "${s.name}". Known: ${STAGE_ORDER.join(', ')}`);
    }
    if (seen.has(s.name)) throw new Error(`Duplicate stage "${s.name}" in pipeline`);
    if (typeof s.run !== 'function') throw new Error(`Stage "${s.name}" has no run()`);
    seen.add(s.name);
  }
  return { stages: Object.freeze([...stages]) };
}

/**
 * Run a pipeline, accumulating a trace.
 *
 * A stage may:
 *   - return an object  -> shallow-merged into the context
 *   - return `skip(reason)` -> recorded as skipped, context untouched
 *   - throw a StageFailure -> recorded as failed and rethrown, unless optional
 *
 * @returns {Promise<{ctx: object, trace: Array}>}
 */
export async function runPipeline({ pipeline, ctx, log }) {
  const trace = [];
  let current = { ...ctx };

  for (const stage of pipeline.stages) {
    const startedAt = Date.now();
    const step = (status, extra = {}) => {
      const record = {
        stage: stage.name,
        status,
        ms: Date.now() - startedAt,
        ...extra,
      };
      trace.push(record);
      log?.debug('stage.finished', { stage: stage.name, status, ms: record.ms, ...extra });
      return record;
    };

    let outcome;
    try {
      outcome = await stage.run(current, log);
    } catch (e) {
      if (e instanceof StageFailure) {
        step('failed', { reason: e.reason, detail: e.detail });
        if (!stage.optional) throw attachTrace(e, trace);
        continue;
      }
      step('failed', { reason: 'error', detail: e?.message || String(e) });
      if (!stage.optional) {
        throw attachTrace(
          new StageFailure(stage.name, 'error', e?.message || String(e), { cause: e }),
          trace,
        );
      }
      continue;
    }

    if (outcome && outcome.__skipped) {
      step('skipped', { reason: outcome.reason });
      continue;
    }
    if (outcome && typeof outcome === 'object') {
      current = { ...current, ...outcome };
    }
    step('ok');
  }

  return { ctx: current, trace };
}

/** Return this from a stage to record it as intentionally skipped. */
export function skip(reason) {
  return { __skipped: true, reason };
}

/**
 * Preserve the partial trace on the failure.
 *
 * A run that dies in `extract` is far more useful when it reports that
 * `resolve`, `guard` and `open` succeeded first, so the trace travels with
 * the error instead of being thrown away.
 */
function attachTrace(failure, trace) {
  failure.trace = trace;
  return failure;
}

/** Human-readable one-line-per-stage rendering of a trace. */
export function formatTrace(trace) {
  return trace
    .map((t) => {
      const mark = { ok: '✔', skipped: '–', failed: '✖' }[t.status] || '?';
      const why = t.reason ? ` (${t.reason}${t.detail ? `: ${t.detail}` : ''})` : '';
      return `  ${mark} ${t.stage.padEnd(8)} ${String(t.ms).padStart(6)}ms${why}`;
    })
    .join('\n');
}
