import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function defaultCfgPath() {
  return join(PROJECT_ROOT, 'config', 'profile.yml');
}

export function defaultCvPath() {
  return join(PROJECT_ROOT, 'cv.md');
}

/** Load a dotenv-style .env file (no dependencies). Later keys win. */
export function loadEnvFile(path = join(PROJECT_ROOT, '.env')) {
  if (!existsSync(path)) return {};
  const out = {};
  const raw = readFileSync(path, 'utf8');
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // expand ${VAR} references
    value = value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => process.env[name] ?? out[name] ?? '');
    out[key] = value;
  }
  return out;
}

/** Resolve a path relative to PROJECT_ROOT unless it is absolute. */
export function resolvePath(p, root = PROJECT_ROOT) {
  if (!p) return null;
  return isAbsolute(p) ? normalize(p) : join(root, p);
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}

export function buildConfigFromEnv() {
  const file = loadEnvFile();
  const env = { ...process.env, ...file };
  const cfg = {
    llm: {
      baseUrl: env.LLM_BASE_URL || 'https://api.groq.com/openai/v1',
      apiKey: env.LLM_API_KEY || '',
      model: env.LLM_MODEL || 'llama-3.3-70b-versatile',
    },
    vision: {
      baseUrl: env.VISION_BASE_URL || '',
      apiKey: env.VISION_API_KEY || '',
      model: env.VISION_MODEL || '',
    },
    browser: {
      channel: env.BROWSER_CHANNEL || 'chrome',
      profileDir: env.BROWSER_PROFILE_DIR
        ? resolvePath(env.BROWSER_PROFILE_DIR)
        : join(PROJECT_ROOT, 'profiles', 'default'),
    },
    limits: {
      captchaVisionAttempts: Number(env.CAPTCHA_VISION_ATTEMPTS || 3),
      dailySubmitCap: Number(env.DAILY_SUBMIT_CAP || 5),
    },
    gmail: {
      user: env.GMAIL_USER || '',
      appPassword: env.GMAIL_APP_PASSWORD || '',
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN || '',
      chatId: env.TELEGRAM_CHAT_ID || '',
      // How long the review gate waits for the user's reply before giving up.
      // A shift is long; the default reflects that.
      timeoutMs: Number(env.TELEGRAM_GATE_TIMEOUT_MS || 6 * 3600 * 1000),
    },
    audio: {
      // Voice-note transcription. Groq's free tier serves whisper-large-v3 on
      // the OpenAI-compatible audio endpoint.
      baseUrl: env.AUDIO_BASE_URL || 'https://api.groq.com/openai/v1',
      apiKey: env.AUDIO_API_KEY || env.GROQ_API_KEY || '',
      model: env.AUDIO_MODEL || 'whisper-large-v3',
    },
    captcha: (() => {
      // Providers are tried in this order; only ones with a key present run.
      // CapSolver first: cheaper and typically stronger on the Enterprise
      // invisible variant Greenhouse uses. 2Captcha is the fallback.
      const order = (env.CAPTCHA_SOLVER || 'capsolver,2captcha')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      // CAPTCHA_API_KEY is the single-provider shorthand: it applies to the
      // one named provider only, so a fallback chain never reuses one key
      // against the wrong service.
      const legacy = env.CAPTCHA_API_KEY || '';
      const legacyFor = (name) => (order.length === 1 && order[0] === name ? legacy : '');
      return {
        order,
        keys: {
          capsolver: env.CAPSOLVER_API_KEY || legacyFor('capsolver'),
          '2captcha': env.TWOCAPTCHA_API_KEY || legacyFor('2captcha'),
        },
        pollMs: Number(env.CAPTCHA_POLL_MS || 5000),
        // Enterprise invisible solves can be slow; a short deadline turns a
        // slow solve into a false failure.
        timeoutMs: Number(env.CAPTCHA_TIMEOUT_MS || 240000),
      };
    })(),
  };
  return cfg;
}