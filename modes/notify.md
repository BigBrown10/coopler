# notify — Telegram job alerts

Sends new `pipeline.md` entries to a Telegram chat so you see matches
without checking the repo.

## Setup

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather):
   - Send `/newbot`, pick a name and username
   - Copy the token it gives you

2. Get your chat ID:
   - Send any message to your bot
   - Visit `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - Copy the `chat.id` from the response

3. Export (or add to your cron/launchd env):

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF1234gh..."
export TELEGRAM_CHAT_ID="123456789"
```

## Usage

```bash
# After a scan, notify on new pipeline entries
node notify-telegram.mjs

# Dry-run — see what would be sent without actually sending
node notify-telegram.mjs --dry-run

# With explicit credentials (overrides env)
node notify-telegram.mjs --token "..." --chat "123456789"
```

## Automation

Wire it into your scheduled scan. On most systems:

```bash
node scan.mjs --quick && node notify-telegram.mjs
```

The script is **idempotent**: each URL is sent once — a `data/.telegram-sent.tsv`
log prevents duplicates across runs.

## Privacy

- Your bot token and chat ID never leave your machine
- `data/.telegram-sent.tsv` contains only posting URLs and timestamps
- No Telegram data is sent to the career-ops repository