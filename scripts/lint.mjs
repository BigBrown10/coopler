#!/usr/bin/env node
/**
 * Syntax check every source file, not a hand-picked few.
 *
 * The previous lint script named three files, which meant a broken module in
 * `src/ats/` or `src/workflow/` was only discovered at run time. This walks
 * the tree instead, so the list of files cannot drift out of date.
 */

import { readdir } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SKIP_DIRS = new Set(['node_modules', '.git', 'evidence', '.playwright-mcp']);

async function collect(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...await collect(full));
    } else if (['.js', '.mjs'].includes(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

const files = [...await collect(join(ROOT, 'src')), ...await collect(join(ROOT, 'tests'))];
const failures = [];

for (const file of files) {
  try {
    await run(process.execPath, ['--check', file]);
  } catch (e) {
    failures.push({ file: relative(ROOT, file), detail: String(e.stderr || e).trim() });
  }
}

if (failures.length > 0) {
  for (const f of failures) {
    process.stderr.write(`\n${f.file}\n${f.detail}\n`);
  }
  process.stderr.write(`\n${failures.length} of ${files.length} file(s) failed to parse.\n`);
  process.exit(1);
}

process.stdout.write(`${files.length} file(s) parsed cleanly.\n`);
