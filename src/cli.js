#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildConfigFromEnv, loadEnvFile, PROJECT_ROOT } from './config/env.js';
import { runApplication, renderTrace } from './run.mjs';
import { formatGapReport } from './gate/gaps.mjs';

function defaultResumePath() {
  const p = join(PROJECT_ROOT, 'cv.pdf');
  return existsSync(p) ? p : null;
}

const USAGE = `autoapply — agentic ATS autofill with a final-review submit gate.

Usage:
  node src/cli.js apply <apply-url> [flags]
  node src/cli.js questions <apply-url> [flags]
  node src/cli.js doctor            # print config status (no browser)

Flags:
  --dry-run     Fill nothing, submit nothing; just show the plan.
  --inspect     Fill + attach + screenshot, print the review summary, never wait for input, never submit.
  --handover    Fill + attach, then leave the browser open for you to press Submit. Never submits.
  --submit      Send without an interactive gate. Explicit opt-in; still reports honestly.
  --set L: V    Set one answer before review. Repeatable. e.g. --set "us tax resident: No"
  --trace       Print the stage-by-stage pipeline trace.
  --headless    Run the browser headless (default: headed Chrome window).
  --profile P   Path to profile.yml (default config/profile.yml).
  --cv C        Path to cv.md (default cv.md).
  --resume R    Path to resume file attached to file inputs (default cv.pdf if present).

Commands:
  questions <url>  List every question the posting asks that nothing can answer
                   yet, sorted by who can resolve it. Fills nothing, uploads
                   nothing, submits nothing. Answer them once in
                   config/answers.yml and they are reused on every later run.
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE);
    process.exit(0);
  }
  const cmd = argv[0];

  if (cmd === 'doctor') {
    loadEnvFile();
    const cfg = buildConfigFromEnv();
    console.log('config:', cfg.llm.baseUrl, '| model:', cfg.llm.model);
    console.log('vision:', cfg.vision.baseUrl || '(unset — level-2 captchas use fallback)', '| model:', cfg.vision.model || '(unset)');
    console.log('browser channel:', cfg.browser.channel, '| profile:', cfg.browser.profileDir);
    console.log('captcha vision attempts:', cfg.limits.captchaVisionAttempts, '| daily submit cap:', cfg.limits.dailySubmitCap);
    const solvers = (cfg.captcha.order || [])
      .map((n) => `${n}${cfg.captcha.keys[n] ? ' (key set)' : ' (key unset)'}`)
      .join(', ');
    console.log('captcha solvers:', solvers || '(none)');
    console.log('api key set:', Boolean(cfg.llm.apiKey));
    const ready = Boolean(cfg.telegram.botToken) && Boolean(cfg.telegram.chatId);
    console.log('telegram review:', ready
      ? `ready (chat ${cfg.telegram.chatId}, timeout ${Math.round(cfg.telegram.timeoutMs / 60000)}min)`
      : (cfg.telegram.botToken
        ? 'token set but TELEGRAM_CHAT_ID missing — falls back to the terminal gate'
        : 'not configured — review happens in this terminal'));
    console.log('voice notes:', cfg.audio.baseUrl && cfg.audio.apiKey
      ? `ready (${cfg.audio.model})`
      : 'not configured — voice replies unavailable');
    return;
  }

  if (cmd !== 'apply' && cmd !== 'questions') {
    console.error(`Unknown command "${cmd}".`);
    console.error(USAGE);
    process.exit(1);
  }

  const questionsOnly = cmd === 'questions';

  const url = argv.find((a) => a.startsWith('http'));
  if (!url) {
    console.error(`Missing apply URL. Example: node src/cli.js ${cmd} https://boards.greenhouse.io/acme/jobs/1234`);
    process.exit(1);
  }
  const dryRun = argv.includes('--dry-run');
  const headless = argv.includes('--headless');
  const inspect = argv.includes('--inspect');
  // Non-interactive equivalents of the review-gate commands, for scripted runs
  // where stdin is not a TTY. `--submit` is the explicit opt-in to send.
  const approveSubmit = argv.includes('--submit');
  // Fill + keep the browser open so a human can press Submit themselves.
  const handover = argv.includes('--handover');
  const showTrace = argv.includes('--trace');
  const preEdits = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--set' && argv[i + 1]) preEdits.push(argv[++i]);
  }
  const profilePath = flagValue(argv, '--profile');
  const cvPath = flagValue(argv, '--cv');
  const resumePath = flagValue(argv, '--resume') || defaultResumePath();

  const cfg = buildConfigFromEnv();
  if (!cfg.llm.apiKey && !questionsOnly) {
    console.error('LLM_API_KEY missing. Copy .env.example to .env and set LLM_API_KEY (Groq or OpenRouter).');
    if (!dryRun) process.exit(1);
  }

  try {
    const res = await runApplication({
      url, profilePath, cvPath, resumePath, cfg, dryRun, headless,
      autoApprove: inspect, approveSubmit, preEdits, handover, questionsOnly,
    });

    if (questionsOnly) {
      if (res.error) {
        console.error('WARNING:', res.error);
        if (res.remediation) console.error('NEXT:', res.remediation);
        process.exit(1);
      }
      if (!res.gaps) {
        console.error('Could not read the questions on this posting.');
        process.exit(1);
      }
      console.log('\n' + formatGapReport(res.gaps, {
        boardName: res.board?.name,
        role: res.roleTitle,
      }));
      console.log('\n(nothing was filled, uploaded, or submitted)');
      if (showTrace && res.trace) console.log('\nPipeline trace:\n' + renderTrace(res.trace));
      return;
    }

    if ((inspect || approveSubmit || handover) && res.summary) console.log('\n' + res.summary);
    if (showTrace && res.trace) console.log('\nPipeline trace:\n' + renderTrace(res.trace));
    const status = res.submitted
      ? 'SUBMITTED ✔'
      : res.boardError
        ? 'REJECTED BY BOARD ⚠ — see the reason below'
        : res.unconfirmed
          ? 'UNCONFIRMED ⚠ — submit was clicked but no confirmation was seen; check the board yourself'
          : res.approved
            ? 'NOT submitted — see warning below'
            : dryRun ? '(dry-run — nothing filled or submitted)'
              : inspect ? '(inspect — filled + screenshotted, NOT submitted)'
                : handover ? '(handover — form filled, browser left open for you to submit)'
                  : 'NOT submitted — no approval given.';
    console.log('\n' + status);
    if (res.evidenceDir) console.log('Evidence:', res.evidenceDir);
    if (res.error) console.error('WARNING:', res.error);
    if (res.remediation) console.error('NEXT:', res.remediation);
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
}

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

main();