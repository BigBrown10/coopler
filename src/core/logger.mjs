/**
 * Structured logging.
 *
 * Every log line is a record with a fixed shape (level, run, stage, event, and
 * arbitrary fields) so a run can be traced as data rather than scraped from
 * console text. `AUTOAPPLY_DEBUG=1` raises the level to debug.
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

function threshold() {
  const raw = String(process.env.AUTOAPPLY_LOG || '').toLowerCase();
  if (LEVELS[raw] !== undefined) return LEVELS[raw];
  if (process.env.AUTOAPPLY_DEBUG) return LEVELS.debug;
  return LEVELS.info;
}

export function createLogger({ run = 'run', sink = console } = {}) {
  const min = threshold();

  const emit = (level, event, fields = {}) => {
    if (LEVELS[level] > min) return;
    const record = { t: new Date().toISOString(), level, run, event, ...fields };
    const line = format(record);
    if (level === 'error') sink.error(line);
    else if (level === 'warn') sink.warn(line);
    else sink.log(line);
  };

  return {
    run,
    child(extra) {
      return createLogger({ run, sink, ...extra });
    },
    error: (event, fields) => emit('error', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    info: (event, fields) => emit('info', event, fields),
    debug: (event, fields) => emit('debug', event, fields),
    /** Always prints, regardless of level — for the human-facing review. */
    plain: (text) => sink.log(text),
  };
}

function format(r) {
  const { t, level, run, event, ...rest } = r;
  const extras = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(' ');
  return `[${t} ${level.toUpperCase()} run=${run}] ${event}${extras ? ' ' + extras : ''}`;
}

function formatValue(v) {
  if (typeof v === 'string') return /\s/.test(v) ? JSON.stringify(v) : v;
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
