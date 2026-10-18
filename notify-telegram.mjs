#!/usr/bin/env node

/**
 * notify-telegram.mjs — Send new pipeline.md entries to a Telegram chat.
 *
 * Reads data/pipeline.md "Pending" section, filters against scan-history.tsv
 * to find entries that haven't been alerted yet, and sends each as a
 * formatted Telegram message via the Bot API.
 *
 * Prerequisites:
 *   TELEGRAM_BOT_TOKEN  — env var or --token flag
 *   TELEGRAM_CHAT_ID    — env var or --chat flag
 *
 * Run: node notify-telegram.mjs [--dry-run] [--token <token>] [--chat <chat_id>]
 *
 * Idempotent: a `data/.telegram-sent.tsv` log prevents duplicate alerts.
 * Only the bot token, not the chat id, is sensitive; the chat id is a
 * destination, not a credential.
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getCareerOpsRoot, canonicalizeTrackerPath } from './path-resolver.mjs';

const ROOT = getCareerOpsRoot();

// ── CLI ────────────────────────────────────────────────────────────────────

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? '';
}

const DRY_RUN = process.argv.includes('--dry-run');
const BOT_TOKEN = argValue('--token') || process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = argValue('--chat') || process.env.TELEGRAM_CHAT_ID || '';

if (!BOT_TOKEN || !CHAT_ID) {
  if (!BOT_TOKEN) console.error('Missing TELEGRAM_BOT_TOKEN (env or --token)');
  if (!CHAT_ID) console.error('Missing TELEGRAM_CHAT_ID (env or --chat)');
  process.exit(1);
}

// ── Paths ──────────────────────────────────────────────────────────────────

const SENT_LOG = join(ROOT, 'data', '.telegram-sent.tsv');
const PIPELINE = existsSync(join(ROOT, 'data', 'pipeline.md'))
  ? join(ROOT, 'data', 'pipeline.md')
  : join(ROOT, 'pipeline.md');
const SCAN_HISTORY = join(ROOT, 'data', 'scan-history.tsv');

// ── Parser — same regex as reconcile-pipeline.mjs + sync-batch-input.mjs ──

const PENDING_RE = /^##\s+(Pendientes|Pending|Offen|En attente)\s*$/i;
const SECTION_RE = /^##\s+/;
const ITEM_RE = /^- \[ \]\s+(.+)/;

function parsePending(md) {
  const lines = md.split(/\r?\n/);
  let inSection = false;
  const entries = [];
  for (const line of lines) {
    if (SECTION_RE.test(line)) {
      inSection = PENDING_RE.test(line);
      continue;
    }
    if (!inSection) continue;
    const m = line.match(ITEM_RE);
    if (!m) continue;
    const body = m[1].trim();
    if (!body) continue;
    const pipe = body.indexOf(' |');
    const url = (pipe >= 0 ? body.slice(0, pipe) : body).trim();
    const company = pipe >= 0
      ? body.slice(pipe + 2).split('|')[1]?.trim() ?? ''
      : '';
    entries.push({ url, company, raw: body });
  }
  return entries;
}

// ── Sent-log ────────────────────────────────────────────────────────────────

function loadSent() {
  if (!existsSync(SENT_LOG)) return new Set();
  const raw = readFileSync(SENT_LOG, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  // Skip header
  return new Set(lines.slice(1).map(l => l.split('\t')[0]));
}

function recordSent(url) {
  if (!existsSync(SENT_LOG)) {
    writeFileSync(SENT_LOG, 'url\tsent_at\n');
  }
  appendFileSync(SENT_LOG, `${url}\t${new Date().toISOString()}\n`);
}

// ── Telegram ────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (DRY_RUN) {
    console.log(`[dry-run] would send:\n${text}`);
    return true;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = JSON.stringify({
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    console.error(`Telegram API error ${res.status}: ${err}`);
    return false;
  }
  return true;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Main ────────────────────────────────────────────────────────────────────

if (!existsSync(PIPELINE)) {
  console.log('No pipeline.md found — nothing to notify.');
  process.exit(0);
}

const md = readFileSync(PIPELINE, 'utf-8');
const pending = parsePending(md);

if (pending.length === 0) {
  console.log('No pending entries in pipeline.md.');
  process.exit(0);
}

const sent = loadSent();
const scanned = new Set();
if (existsSync(SCAN_HISTORY)) {
  const hist = readFileSync(SCAN_HISTORY, 'utf-8');
  for (const line of hist.split(/\r?\n/)) {
    const cols = line.split('\t');
    if (cols[0]) scanned.add(cols[0].trim());
  }
}

const novel = pending.filter(e => !sent.has(e.url) && !scanned.has(e.url));

if (novel.length === 0) {
  console.log(`${pending.length} pending, all already notified or in scan history.`);
  process.exit(0);
}

console.log(`${novel.length} new pending entries to notify.`);

let ok = true;
for (const e of novel) {
  const label = e.company
    ? `<b>${escapeHtml(e.company)}</b> — `
    : '';
  const text = [
    `🔔 <b>New match in pipeline</b>`,
    '',
    `${label}<a href="${escapeHtml(e.url)}">${escapeHtml(e.url)}</a>`,
    '',
    `<i>Run pipeline mode to evaluate.</i>`,
  ].join('\n');

  const sent = await sendTelegram(text);
  if (sent) {
    recordSent(e.url);
  } else {
    ok = false;
  }
}

if (!ok) process.exit(1);