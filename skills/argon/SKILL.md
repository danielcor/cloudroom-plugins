---
name: argon
description: Use when the user wants Gemini Argon, Gemini or Google Antigravity (agy) to do the work, or asks you to "relay", "hand off" or "ask Argon". Runs Argon headless through the `argon` command and shows its answer.
---

# Argon relay

Argon does the work. You are a thin relay: pass the user's message to Argon, show what comes back.

## Setup (once per sandbox)

```bash
ARGON=$(command -v argon || ls /repos/cloudroom-argon/cli/argon "$HOME"/cloudroom-argon/cli/argon 2>/dev/null | head -1)
"$ARGON" setup
```

`setup` installs `agy` if missing and gets the login from `ARGON_AGY_TOKEN_B64` (env or the nearest `.env`),
else from the paired desktop. It ends with `ok: ... argon models`. If it fails, show the error and stop.
Never print, cat or log the login file or the `ARGON_AGY_TOKEN_B64` value.

## Relay

For each user message, run it verbatim, in the project directory:

```bash
"$ARGON" run "<the user's message, unchanged>"
```

- Multi-line or quote-heavy messages: pipe them in instead: `printf '%s' "$MSG" | "$ARGON" run`.
- It continues the last Argon conversation for this directory. Use `--new` only when the user asks for a fresh start,
  `--conversation ID` to resume a specific one (the id is printed on the last line of every run).
- Defaults to `gemini-4-argon-high`. Pass `--model` / `--effort low|medium|high|xhigh|max` only if the user asks.
  `argon models` lists the choices.
- Argon runs with permissions skipped, in the cwd. It edits files and runs commands there itself.
- Runs can take minutes. Give the command a long timeout, or run it in the background and read the output when it ends.

## Rules

- Show Argon's answer in your reply (the command output may be collapsed for the user). Quote it; do not paraphrase.
- Do not redo, verify or "improve" Argon's work unless the user asks. Do not run your own tools on the task.
- Keep your own commentary to a line at most. If Argon asks the user a question, pass it on as is.
- A non-zero exit means Argon failed: show its error verbatim.

## Relay thread recipe

A cheap Cloud thread that only forwards messages:

1. Make sure the project's Cloud environment includes the `danielcor/cloudroom-argon` repo (it appears under `/repos`)
   and that the project's `.env` has `ARGON_AGY_TOKEN_B64` (see the README: `argon export-token >> .env`).
2. New Cloud thread, provider Claude Code, model `claude-haiku-5-5`.
3. First message: `Read /repos/cloudroom-argon/skills/argon/SKILL.md and follow it. From now on relay everything I write to Argon.`
