#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTOAPPLY_DIR = resolve(__dirname, '..', 'autoapply');
const DATA_DIR = join(__dirname, 'data');
const LOG_PATH = join(DATA_DIR, 'apply-log.json');

const USAGE = `bridge-apply — Connect career-ops scan output to autoapply

Usage:
  node bridge-apply.mjs                        # scan + apply all new offers
  node bridge-apply.mjs --url <url>            # apply to a single URL
  node bridge-apply.mjs --pipeline <path>      # apply pending URLs from a pipeline.md file
  node bridge-apply.mjs --dry-run              # discover but skip submission
  node bridge-apply.mjs --limit N              # apply to at most N URLs
  node bridge-apply.mjs --headful              # show the browser (default: headless)`;

function parseArgs() {
  const argv = process.argv.slice(2);
  const opts = { dryRun: false, limit: Infinity, headful: false, url: null, pipeline: null };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && argv[i + 1]) { opts.url = argv[++i]; }
    else if (a === '--pipeline' && argv[i + 1]) { opts.pipeline = argv[++i]; }
    else if (a === '--dry-run') { opts.dryRun = true; }
    else if (a === '--headful') { opts.headful = true; }
    else if (a === '--limit' && argv[i + 1]) { opts.limit = parseInt(argv[++i], 10) || Infinity; }
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
  }
  return opts;
}

function loadLog() {
  if (!existsSync(LOG_PATH)) return [];
  try { return JSON.parse(readFileSync(LOG_PATH, 'utf-8')); }
  catch { return []; }
}

function saveLog(entries) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2), 'utf-8');
}

function extractUrls(md) {
  const urls = [];
  const lines = md.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trimStart().startsWith('- [')) continue;
    const m = line.match(/https?:\/\/[^\s|]+/);
    if (m) urls.push(m[0]);
  }
  return urls;
}

function parsePipelineFile(pipelinePath) {
  if (!existsSync(pipelinePath)) {
    console.error(`Pipeline file not found: ${pipelinePath}`);
    return [];
  }
  const content = readFileSync(pipelinePath, 'utf-8');
  return extractUrls(content);
}

function runCommand(exe, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, stdio: ['inherit', 'pipe', 'pipe'], shell: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on('error', reject);
  });
}

async function runScan() {
  console.log('Running career-ops scan...');
  const result = await runCommand('node', ['scan.mjs'], __dirname);
  console.log(result.stdout || '(scan complete)');
  if (result.stderr) console.error(result.stderr);

  const pipelinePath = process.env.CAREER_OPS_PIPELINE || join(__dirname, 'data', 'pipeline.md');
  if (!existsSync(pipelinePath)) {
    console.log('No pipeline.md found after scan — no offers to apply to.');
    return [];
  }
  console.log(`Reading URLs from ${pipelinePath}`);
  return parsePipelineFile(pipelinePath);
}

async function applyToUrl(url, dryRun, headful) {
  const args = ['src/cli.js', 'apply', url, '--submit'];
  if (!headful) args.push('--headless');
  if (dryRun) args.push('--dry-run');

  console.log(`\nApplying to: ${url}`);
  console.log(`  Command: node ${args.join(' ')}`);
  if (dryRun) {
    console.log('  (dry-run — nothing submitted)');
    return { url, dryRun: true, submitted: false };
  }

  const result = await runCommand('node', args, AUTOAPPLY_DIR);
  const submitted = result.stdout.includes('SUBMITTED');
  console.log(`  Result: ${submitted ? 'SUBMITTED' : result.stdout.split('\n').pop() || result.stderr.split('\n').pop() || 'completed'}`);

  return {
    url,
    dryRun: false,
    submitted,
    timestamp: new Date().toISOString(),
    summary: result.stdout.slice(-500),
    exitCode: result.code,
  };
}

async function main() {
  const opts = parseArgs();

  let urls = [];

  if (opts.url) {
    urls = [opts.url];
  } else if (opts.pipeline) {
    const pipelinePath = resolve(opts.pipeline);
    urls = parsePipelineFile(pipelinePath);
  } else {
    urls = await runScan();
  }

  if (urls.length === 0) {
    console.log('No URLs to apply to.');
    return;
  }

  if (opts.limit < urls.length) {
    console.log(`Limiting to ${opts.limit} of ${urls.length} URLs`);
    urls = urls.slice(0, opts.limit);
  }

  console.log(`\nApplying to ${urls.length} URL(s)...`);

  const log = loadLog();
  const results = [];

  for (const url of urls) {
    const entry = await applyToUrl(url, opts.dryRun, opts.headful);
    results.push(entry);
    log.push(entry);
  }

  saveLog(log);

  const submitted = results.filter(r => r.submitted).length;
  console.log(`\nDone. ${submitted}/${results.length} submitted. Log: ${LOG_PATH}`);
}

main().catch((e) => {
  console.error('Bridge failed:', e.message);
  process.exit(1);
});