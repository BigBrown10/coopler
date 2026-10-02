/**
 * Board resolution.
 *
 * Thin convenience layer over the adapter registry so callers that just want
 * "what board is this?" do not have to reach into the registry themselves.
 * There is exactly one resolution path: URL -> adapter -> BoardContext.
 */

import { createRegistry, resolveBoard } from './registry.mjs';
import { greenhouseAdapter } from './greenhouse/adapter.mjs';
import { ashbyAdapter } from './ashby/adapter.mjs';
import { leverAdapter } from './lever/adapter.mjs';
import { smartRecruitersAdapter } from './smartrecruiters/adapter.mjs';
import { teamtailorAdapter } from './teamtailor/adapter.mjs';
import { recruiteeAdapter } from './recruitee/adapter.mjs';
import { workdayAdapter } from './workday/adapter.mjs';

export class UnsupportedBoardError extends Error {}

/** The adapters this build knows about. */
export const defaultRegistry = createRegistry([
  greenhouseAdapter,
  ashbyAdapter,
  leverAdapter,
  smartRecruitersAdapter,
  teamtailorAdapter,
  recruiteeAdapter,
  workdayAdapter,
]);

/**
 * @returns {{ats: string, host: string, boardToken: string, jobId: string, jobUrl: string, role: string, company: string}}
 */
export function detectAts(url) {
  try {
    return resolveBoard(defaultRegistry, url).board;
  } catch (e) {
    if (e?.name === 'StageFailure') throw new UnsupportedBoardError(e.detail || e.message);
    throw e;
  }
}
