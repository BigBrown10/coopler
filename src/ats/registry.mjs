/**
 * Adapter registry.
 *
 * Resolves a job URL to the adapter that owns it, and validates every adapter
 * at registration. Adding a board means registering an adapter; no other file
 * changes.
 */

import { assertAdapter, assertEndpoints } from './contract.mjs';
import { StageFailure, REASON } from '../core/errors.mjs';
import { UnsupportedBoardError } from './detect.mjs';

export function createRegistry(adapters = []) {
  const list = [];
  for (const a of adapters) register(list, a);
  return list;
}

/** Register one adapter. Throws immediately if it breaks the contract. */
export function register(registry, adapter) {
  assertAdapter(adapter);
  if (registry.some((a) => a.name === adapter.name)) {
    throw new Error(`Adapter "${adapter.name}" is already registered`);
  }
  registry.push(Object.freeze(adapter));
  return registry;
}

/**
 * Find the adapter for a URL.
 * @throws {StageFailure} with reason unsupported_board when nothing matches
 */
export function resolveAdapter(registry, url) {
  const u = url instanceof URL ? url : new URL(url);
  const host = u.hostname.replace(/^www\./, '');
  const found = registry.find((a) => {
    try { return a.matches(host); } catch { return false; }
  });
  if (!found) {
    const supported = [...registry.map((a) => a.name)].join(', ') || 'none';
    throw new StageFailure(
      'resolve',
      REASON.UNSUPPORTED_BOARD,
      `no adapter for host "${u.hostname}" (registered: ${supported})`,
    );
  }
  return found;
}

/** Resolve URL -> adapter -> BoardContext. */
export function resolveBoard(registry, url) {
  const adapter = resolveAdapter(registry, url);
  let ctx;
  try {
    ctx = adapter.resolve(url);
  } catch (e) {
    // Preserve the legacy error type for callers that still catch it.
    if (e instanceof UnsupportedBoardError) throw e;
    throw new StageFailure('resolve', REASON.UNSUPPORTED_BOARD, e?.message || String(e), { cause: e });
  }
  if (!ctx || !ctx.jobId) {
    throw new StageFailure('resolve', REASON.UNSUPPORTED_BOARD, `${adapter.name} could not read a job id from the URL`);
  }
  // Endpoints are per-board, so validate them now that we have a real board.
  assertEndpoints(adapter, ctx);
  return { adapter, board: ctx };
}
