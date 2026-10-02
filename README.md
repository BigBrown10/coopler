# autoapply

Agentic ATS autofill with a **final-review submit gate**. The agent fills a real
job application (Greenhouse first), drafts grounded answers, presents everything
for your review, and submits **only when you explicitly approve**.

> Design principle: automation up to the submit click, humans at the gate.
> Guard fields (legal / visa / salary / demographic) are **never** submitted
> unattended. They are either left blank for you, or pre-filled from your own
> profile and clearly marked `[PROPOSED â€” confirm]` for you to check.

## How it works

An application is a **named pipeline**, not a 400-line function. Each stage
returns a patch, every stage result lands in a trace, and a failure carries a
machine-readable reason plus the advice to fix it.

```
apply URL
  â”‚
  â”œâ”€ resolve   URL safety (SSRF) â†’ ATS adapter + endpoints from the registry
  â”œâ”€ guard     what protections does this board enforce, declared up front
  â”œâ”€ open      launch a browser, load the application form
  â”œâ”€ extract   read the form's fields through the adapter
  â”œâ”€ plan      deterministic profile match â†’ grounded LLM fallback â†’ tailor the CV
  â”œâ”€ fill      write values (location last), bounded captcha handling, screenshot
  â”œâ”€ attach    upload the tailored CV
  â”œâ”€ review    print every answer; wait for approval unless a flag says otherwise
  â”œâ”€ submit    press the board's control â€” skipped if the board blocks it
  â”œâ”€ confirm   decide *honestly* whether it was actually submitted
  â””â”€ archive   evidence manifest + screenshots
```

Add an ATS by adding an adapter, not an `if`. Add a step by adding a stage.

### Architecture

| Layer | Path | Responsibility |
|-------|------|----------------|
| Composition root | `src/run.mjs` | resolve config, build deps, delegate. No board knowledge. |
| Workflow | `src/workflow/apply.mjs` | the stage sequence |
| ATS contract | `src/ats/contract.mjs` | required adapter shape, validated before any browser work |
| Registry | `src/ats/registry.mjs` | URL host â†’ adapter; refuses unknown boards |
| Adapters | `src/ats/<board>/` | everything a specific board knows |
| Pipeline core | `src/core/pipeline.mjs` | named stages, trace, skip and failure semantics |
| Errors | `src/core/errors.mjs` | typed reasons + remediation text |

### Declared capabilities

An adapter declares what its board enforces, so protections are known *before*
a field is touched rather than discovered during a submit.

```js
capabilities: {
  fileUpload: true,
  botCheck: 'recaptcha',
  botCheckBlocksSubmit: true,   // submit needs a solved token or a human
  securityCodeStep: true,       // board emails a code to confirm
  eoiQuestions: true,
}
```

`botCheckBlocksSubmit: true` means the board verifies a bot check
server-side on its POST, so an automated click is refused with HTTP 428
regardless of how correct the answers are. The submit stage honours that flag:
with no solving service configured it hands the final click to a human
(`--handover`); with a solver key set (`CAPSOLVER_API_KEY` /
`TWOCAPTCHA_API_KEY`) it buys a token, injects it, and clicks. See "Captcha
policy" below.

The LLM is any **OpenAI-compatible** endpoint. Groq's free tier and OpenRouter
free models both work with zero code changes.

## Quick start

```bash
npm install

# 1. copy and fill your identity / experience + CV
copy config\profile.example.yml config\profile.yml   # Windows
cp config/profile.example.yml config/profile.yml      # macOS/Linux
cp cv.example.md cv.md

# 2. configure the LLM
copy .env.example .env   # set LLM_API_KEY (Groq) or OPENROUTER_KEY-style values

# 3. verify the install
node src/cli.js doctor

# 4. dry-run plan against a real Greenhouse posting (nothing is filled)
node src/cli.js apply "https://boards.greenhouse.io/acme/jobs/1234" --dry-run

# 5. real run â€” fill, then review, then approve
node src/cli.js apply "https://boards.greenhouse.io/acme/jobs/1234"
```

At the review gate:

```
Type 'go'  to submit
Type 'no'  to abort
Type 'edit <label>: <new value>' to change an answer first
```

### Reviewing from your phone (Telegram)

Set `TELEGRAM_BOT_TOKEN` (from [@BotFather](https://t.me/BotFather)) and
`TELEGRAM_CHAT_ID` (message the bot once, then read it from `getUpdates`). The
run then sends the review summary to Telegram and waits for you there â€” a shift,
a bus, a queue, anywhere with a phone. Without both values it falls back to the
terminal gate above, unchanged.

What lands in the chat:

| Message | Meaning |
|---------|---------|
| The full answer summary + âœ…/âŒ buttons | Approve with one tap |
| One â“ message per answer not in your profile | Reply to *that* message to answer it |
| `set <label>: <value>` | Lands **exactly** as typed â€” your wording, no rewriting |
| `develop <label>: <your thoughts>` | Rewrites your own words into a polished STAR answer |
| A **voice note** reply | Transcribed, then reworded in your own words |
| `go` / `no` | Submit / abort |

Replying to a question message is how a voice note knows which field it is about,
so you never type a label. Nothing is submitted without an explicit `go` or the
button; a timeout says so and aborts. Voice notes need `AUDIO_API_KEY` (falls
back to `LLM_API_KEY`) and run on `whisper-large-v3`; without them voice replies
are refused and text still works.

## Supported boards

| Board | Status |
|-------|--------|
| Greenhouse (boards.greenhouse.io) | **Works end-to-end (M1)** — including the emailed security-code step and server-side reCAPTCHA |
| Ashby (jobs.ashbyhq.com, company subdomains) | **Extracts and fills** on a live posting (24 fields and 15 guard fields; 9/12 questions answered, the remaining 3 are legal declarations only the user can give). The form lives on `/application`, not the posting page, so the adapter reveals it first. A real reCAPTCHA checkbox still needs a human |
| Lever (jobs.lever.co) | **Extracts and fills** on a live posting (~50 fields extracted, 36 after dedupe; 21 profile-matched, 16/21 questions answered). Checkbox groups (pronouns, race) and unnamed survey radios are identified from their option texts where the board names them with UUIDs |
| Teamtailor ({company}.teamtailor.com) | **Extracts and fills** on a live posting (9 fields, 4 filled; 5/7 questions answered). "Apply for this job" opens the form in place, so the adapter reveals it first |
| Recruitee ({company}.recruitee.com) | **Extracts and fills** on a live posting (17 fields, 6 filled; 6/11 questions answered). Talent-pool placeholders are rejected; localized `/l/en/o/...` paths are supported; parsed CV tailoring runs clean after a previous JSON-bailout fix. Six-minute CV-tailoring phase (LLM call) is still being investigated |
| SmartRecruiters (jobs.smartrecruiters.com, careers.smartrecruiters.com) | **Blocked by DataDome.** Verified live: the apply flow answers an automated profile with "Access is temporarily restricted" and never renders a form, so there is nothing to fill. Declared `botCheck: 'datadome'` to stop the run early instead of failing mysteriously. No bypass is attempted |
| Workday ({company}.wd*.myworkdayjobs.com) | **Not automatable yet.** Verified live: a cookie-consent wall sits in front of the form, and Apply opens a dialog whose fields mount lazily outside the document. Declared `needsConsentWall` and `applyIsModal`; consent is left to you, and a half-filled application is refused |

"Declared" means the board resolves from a real posting URL, declares its
endpoints, and passes the adapter contract — but has not yet been proven against
a live posting. Each board's declared capabilities say what it enforces, and the
guard stage prints them before a browser opens, so a board known not to be
fillable is visible as such. Adding a board is one adapter plus a registry entry;
nothing else changes.

Every live status above was checked with `--inspect`, which fills and attaches
but never submits. Two findings that were not obvious from the source:

- A radio group is one question with several options, so exactly one option may
  carry an answer. A radio's label is the *option*, not the question, so the
  enclosing question is captured too — otherwise "female" and "male" both came
  back holding "Man".
- Boards word the same protected characteristic differently ("race" vs
  "ethnicity"), and a legal right to work differently again ("Temporary visa"
  vs "Temporary right to work"). Both are matched, but never across into a
  neighbouring answer.

Not targeted: LinkedIn (ToS and anti-bot posture), and government portals
(Civil Service Jobs, Find a Job, Trac) — not yet supported.

## Configuration

### Standing answers (`config/answers.yml`)

Postings ask the same questions across boards — salary expectations, "are you
currently studying?", "were you referred?" — and answering them once keeps the
agent from asking again. `config/answers.yml` holds the answers you have
already given:

```yaml
answers:
  legal name: Osamudiamen Edogun
  # Only add consent / declaration lines you read and accept:
  # arbitration acknowledgment: I acknowledge that I have read the above
```

Run `node src/cli.js questions <url>` to see exactly which gaps remain, and the
command prints a paste-ready block. **Legal declarations and consent (including
Veteran Status and arbitration) must never be pre-filled: you must add them
yourself.**

### Environment

| Env var | Default | Purpose |
|---------|---------|---------|
| `LLM_BASE_URL` | `https://api.groq.com/openai/v1` | OpenAI-compatible fill endpoint |
| `LLM_API_KEY` | â€” | API key for the fill model |
| `LLM_MODEL` | `llama-3.3-70b-versatile` | Fill model |
| `VISION_BASE_URL` / `VISION_API_KEY` / `VISION_MODEL` | unset | Vision model used only for bounded level-2 image captchas |
| `BROWSER_CHANNEL` | `chrome` | Headed browser channel (falls back to bundled chromium) |
| `BROWSER_PROFILE_DIR` | `./profiles/default` | Persistent profile, keeps logins warm |
| `CAPTCHA_VISION_ATTEMPTS` | `3` | Max vision tries before human handoff |
| `CAPTCHA_SOLVER` | `capsolver,2captcha` | Paid solver order; only providers with a key are used |
| `CAPSOLVER_API_KEY` / `TWOCAPTCHA_API_KEY` | â€” | Per-provider keys |
| `CAPTCHA_POLL_MS` / `CAPTCHA_TIMEOUT_MS` | `5000` / `240000` | Poll interval and per-solve timeout |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | â€” | Phone review; both set switches the gate to Telegram |
| `TELEGRAM_GATE_TIMEOUT_MS` | `21600000` (6h) | How long the gate waits for your `go` |
| `AUDIO_BASE_URL` / `AUDIO_API_KEY` / `AUDIO_MODEL` | Groq / `LLM_API_KEY` / `whisper-large-v3` | Voice-note transcription |
| `DAILY_SUBMIT_CAP` | `5` | Sanity throttle per day |

`config/profile.yml` holds identity, education, experience, skills. An answer is
only ever grounded in `profile.yml` + `cv.md` â€” never invented.

## Captcha policy (bounded, agent-first)

| Level | Kind | Agent behaviour |
|-------|------|-----------------|
| 1 | reCAPTCHA v2 checkbox, hCaptcha checkbox | clicks the checkbox (warm profile is the real test) |
| 2 | image-grid challenge | < `CAPTCHA_VISION_ATTEMPTS` vision-model attempts, then human handoff |
| 3 | Cloudflare / Datadome / Radware | immediate human handoff (no service, no brute force) |

Some boards verify the captcha **server-side on the submit POST**
(Greenhouse answers an automated click with HTTP 428 `captcha-failed`). For
those, two honest options:

- **No solving service configured** (default): the submit stage is skipped and
  the final click is handed to a human (`--handover`).
- **Solving service configured**: the submit stage buys a `g-recaptcha-response`
  token, injects it into the form, and clicks. The board can still reject the
  token â€” the outcome is reported with the board's own reason either way.

Two providers are supported, tried in the order `CAPTCHA_SOLVER` lists
(default `capsolver,2captcha`); only ones with a key set are used:

| Provider | reCAPTCHA Enterprise/1000 | Notes |
|----------|---------------------------|-------|
| **CapSolver** (`CAPSOLVER_API_KEY`) | ~$0.55â€“1.20 | Cheaper, typically stronger on the Enterprise invisible variant Greenhouse uses; tried first |
| **2Captcha** (`TWOCAPTCHA_API_KEY`) | ~$1.00â€“2.99 | Long-standing fallback; human workers for hard cases |

If one rejects the job or times out (~2 min each), the next gets it, and the
trace records which one solved. `CAPTCHA_API_KEY` still works as a
single-provider shorthand when `CAPTCHA_SOLVER` names exactly one provider.

There is deliberately **no** anonymous headless farm and no proxy rotation:
one real browser profile, one genuine application, and either your click or a
token you paid for.

## Safety

- **Never-submit is the default.** Without the review-gate approval the pipeline
  never clicks a submit control. There is no flag that submits unattended.
- **It never claims a submission it cannot see.** Clicking a button is not
  proof. If the board shows no confirmation, the result is reported as
  `UNCONFIRMED âš ` â€” not `SUBMITTED`. Only a real confirmation marker on the page
  (or a clean retry after an emailed security code) counts as submitted. The
  evidence manifest mirrors this: `submitted: false` and `submittedAt: null`
  until a submission is actually confirmed.
- **Security codes are never guessed.** The emailed code is read from email via
  `GMAIL_USER` / `GMAIL_APP_PASSWORD`, or you enter it. Nothing is scraped off
  the page â€” a captcha is not treated as a security-code challenge.
- **Guard fields never auto-submit.** Legal, visa/work-authorization, salary,
  compensation, and demographic/EOI fields always require your confirmation. A
  known answer from your profile may be *suggested* (see below) but is never sent
  without an explicit `go`.
- **Consent boxes are ticked only in-scope.** A consent box is auto-ticked only
  when it is consent to process the EOI data you just supplied *and* such data is
  actually being submitted. Marketing opt-in, T&Cs, liability, and third-party
  sharing carry independent legal meaning and are never ticked for you. Both
  halves are pinned by tests.
- **No guessing at protected characteristics.** EOI values you leave `null` in
  `profile.yml` (e.g. disability, neurodivergence) are never inferred â€” that
  field is left blank and asked for on that specific application.
- **Fabrication guard.** Every LLM answer is required to trace to `profile.yml` /
  `cv.md`; unanswerable fields are left empty and flagged, not invented.
- **Evidence archive.** Before submit, `evidence/<company>-<role>-<timestamp>/`
  records the JD URL, the method, every answer, and screenshots â€” so you have the
  record of exactly what was sent.

### Equality-monitoring (EOI) answers

Voluntary demographic questions (gender identity, transgender status, sexual
orientation, ethnicity, and optionally disability / neurodivergence / pronouns)
live under `equality:` in `config/profile.yml`:

```yaml
equality:
  gender_identity: "Man"
  transgender: "No"
  sexual_orientation: "Heterosexual"
  ethnicity: "Black or African"
  disability: null          # left null -> asked per application, never guessed
  neurodivergent: null
  pronouns: null
  auto_propose: true
```

With `auto_propose: true` these are matched against the options the board
actually offers (so the employer sees *their* wording â€” e.g. `Black or African`
resolves to Monzo's `Black or Black British: African`, and `Yes` right-to-work
resolves to `I'm a citizen or have permanent residency`) and shown at the review
gate as `[PROPOSED from your profile â€” confirm this is correct]`. Set
`auto_propose: false` to have them all left blank instead.

The extractor opens each dropdown to snapshot its real option list, because
react-select options do not exist in the DOM until the menu is opened. If no
option matches your stored answer, the field is left **blank** rather than
guessed â€” a wrong ethnicity or transgender answer is worse than an empty one.

## Project layout

```
autoapply/
â”œâ”€ src/
â”‚  â”œâ”€ cli.js             entry point (apply / doctor)
â”‚  â”œâ”€ run.mjs            composition root: config, deps, delegate to the pipeline
â”‚  â”œâ”€ core/              pipeline engine, typed errors, structured logger
â”‚  â”œâ”€ workflow/          apply pipeline + human handover
â”‚  â”œâ”€ ats/
â”‚  â”‚  â”œâ”€ contract.mjs    the shape every adapter must satisfy
â”‚  â”‚  â”œâ”€ registry.mjs    URL â†’ adapter resolution
â”‚  â”‚  â”œâ”€ urlguard.mjs    SSRF guard
â”‚  â”‚  â”œâ”€ guard.mjs       shared sensitive/guard field policy (GUARD_RE)
â”‚  â”‚  â”œâ”€ detect.mjs      builds the default registry
â”‚  â”‚  â””â”€ greenhouse/     endpoints.mjs + adapter.mjs
â”‚  â”œâ”€ config/            env + profile + cv loading
â”‚  â”œâ”€ mapper/            deterministic matching + LLM answer fallback
â”‚  â”œâ”€ llm/               OpenAI-compatible client (chat + vision)
â”‚  â”œâ”€ captcha/           pure captcha classifier
â”‚  â”œâ”€ gate/              review summary, approval parsing, submit interpretation
â”‚  â”œâ”€ drive/             Playwright driver (fill, captcha click, verify)
â”‚  â””â”€ evidence/          submission evidence archive
â”œâ”€ tests/                node:test suite
â”œâ”€ scripts/              lint (tree-wide parse check) + live diagnostics
â”œâ”€ config/profile.example.yml
â””â”€ cv.example.md
```

### Useful flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Plan only â€” nothing is typed into the page |
| `--inspect` | Fill, screenshot, write evidence, then **never** submit |
| `--handover` | Fill, attach, then leave the browser open for **you** to press Submit |
| `--submit` | Explicit opt-in to send without the interactive gate |
| `--set "<label>: <value>"` | Set one answer before review. Repeatable. |
| `--trace` | Print the stage-by-stage trace |
| `--headless` | Run the browser headless instead of a visible window |

`--inspect` implies the non-interactive gate (`autoApprove` internally) and
still never submits.

`--submit` exists, and it is a deliberate exception rather than an oversight:
you are the applicant, and only you can consent to sending your answers to an
employer. It still reports honestly â€” a click is not a submission, and a
rejected POST is surfaced with the board's own reason.

On a board that declares `botCheckBlocksSubmit`, `--submit` alone is not
enough: the check is verified server-side, so the click goes through only when
a solving service is configured â€” otherwise the stage is skipped and control
goes to a human.

## Known limitations

- **Lever "Custom" pronoun checkbox:** Lever renders each pronoun option in its
  own table row, with `name="pronouns"` on most options but none on the
  "Custom" checkbox. With no shared name or container, it cannot be grouped
  with the other pronoun boxes, so it appears as a separate unanswered gap even
  though picking "he/him" already answers the pronouns question.
- **The CV-tailoring LLM call regularly takes 4-7 minutes.** The log shows a
  silent gap between `plan.withheld` and `fill.begin`; `cv.tailoring` /
  `cv.tailored` log lines have been added. The delay is inside the LLM provider
  (gpt-oss-120b) processing a full CV plus a job description and has not yet
  been profiled.
- **Lever /apply route is flaky:** the form sometimes lives on the base posting
  page, sometimes only on `/apply`. The form-search fallback handles both, but
  extraction can fail briefly when the page is being rate-limited or A/B tested.
- **Guard fields (Veteran Status, arbitration, legal agreements, consent) and
  open questions (salary expectation, availability) must be filled by you.**
  The `questions` command and `config/answers.yml` make this explicit and
  repeatable.

## Tests

```bash
npm test    # 182 unit tests
npm run lint # parses every file in src/ and tests/
```

Coverage includes the mapper contract, guard fields, EOI value-driven option
matching, consent scope, work-auth polarity, honest submit reporting, captcha
classification, the review gate, the SSRF guard, ATS resolution, the adapter
contract, declared capabilities, endpoint resolution, stage order, skip and
failure semantics, the composition root's dependency wiring, both captcha
solver clients (submit â†’ poll â†’ token, every failure mode, provider fallback,
sitekey extraction), the security-code step, the Telegram client and gate
(message splitting, buttons, voice transcription, `go`/`no`/`set`/`develop`,
question replies, timeout), STAR rewording, and every declared board adapter
(URL shapes, lookalike-host rejection, job-id extraction, no-guessed-job-id).

## Roadmap

- M1 âœ… Greenhouse + review gate + guard-field rules
- M2 âœ… OpenRouter/Groq vision path for level-2 captchas (config-driven)
- M3 âœ… Adapter contract, registry, declared capabilities, named pipeline
- M4 âœ… Telegram review gate â€” buttons, per-question prompts, text edits, voice
  notes, STAR rewording
- M5 âœ… Ashby/Lever/SmartRecruiters/Teamtailor/Recruitee/Workday adapters
  (declared and contract-tested; live proof still owed)
- M6 âœ… Paid captcha solving (CapSolver/2Captcha) with fallback, plus Greenhouse's
  emailed security-code step â€” proven on a live submission
- M7 â€” done: every declared board checked against a live posting with
  `--inspect` or `--questions`. Ashby/Lever/Teamtailor/Recruitee fill;
  SmartRecruiters is a declared DataDome block; Workday needs a consent click
  and a modal the extractor cannot see, so it is declared not automatable.
  See the board-status table above for specific live outcomes.
- M7b âœ… `node src/cli.js questions <url>` â€” read-only command that reports
  which posting questions have no answer in the profile or standing-answer store,
  without filling, uploading, or submitting anything. Grouped by question (one
  line per radio/checkbox group, not per option), with paste-ready YAML for the
  gaps the human should answer in `config/answers.yml`.
- M8 ðŸ“‹ pacing/backoff + per-board daily caps
- M9 ðŸ“‹ government portals (Civil Service Jobs, Find a Job, Trac)
- M10 ðŸ“‹ direct ATS API POST where a board documents one. Greenhouse's
  `POST /{board}/jobs/{jobId}` is the board's own form endpoint, not a public
  API â€” it is declared as such in `src/ats/greenhouse/endpoints.mjs` and is
  bot-checked, so it is not a supported automation target.

## Disclaimer

Use responsibly and honestly. Automating applications against an employer's
stated terms may violate their ToS; the tool targets your own applications and
keeps a human at the final review for a reason. You are responsible for how you
use it.