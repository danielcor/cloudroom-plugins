---
name: gemini
description: Use when the user wants Gemini 4 Carbon, Gemini or Google Antigravity (agy) to do the work, or asks you to "relay", "hand off" or "ask Gemini". Runs Gemini headless through the `gemini-relay` command and shows its answer.
---

# Gemini relay

Gemini does the work. You are a thin relay: pass the user's message to Gemini, show what comes back.

## Setup (once per sandbox)

```bash
GEMINI=$(command -v gemini-relay); for f in /repos/cloudroom-plugins /repos/cloudroom-gemini /repos/cloudroom-argon "$HOME/cloudroom-plugins" "$HOME/cloudroom-gemini" "$HOME/cloudroom-argon"; do [ -n "$GEMINI" ] || { [ -x "$f/cli/gemini-relay" ] && GEMINI="$f/cli/gemini-relay"; }; done
"$GEMINI" setup
```

`setup` installs `agy` if missing and gets the login from `GEMINI_AGY_TOKEN_B64` (env or the nearest `.env`; the older `ARGON_AGY_TOKEN_B64` still works),
else from the paired desktop. It ends with `ok: ... carbon models`. If it fails, show the error and stop.
Never print, cat or log the login file or the `GEMINI_AGY_TOKEN_B64` / `ARGON_AGY_TOKEN_B64` value.

## Relay

For each user message, run it verbatim, in the project directory:

```bash
"$GEMINI" run "<the user's message, unchanged>"
```

- Multi-line or quote-heavy messages: pipe them in instead: `printf '%s' "$MSG" | "$GEMINI" run`.
- It continues the last Gemini conversation for this directory. Use `--new` only when the user asks for a fresh start,
  `--conversation ID` to resume a specific one (the id is printed on the last line of every run).
- Defaults to `gemini-4-carbon-high`. Pass `--model` / `--effort low|medium|high|xhigh|max` only if the user asks.
  `gemini-relay models` lists the choices.
- Gemini runs with permissions skipped, in the cwd. It edits files and runs commands there itself.
- Runs can take minutes. Give the command a long timeout, or run it in the background and read the output when it ends.

## Rules

- Show Gemini's answer in your reply (the command output may be collapsed for the user). Quote it; do not paraphrase.
- Do not redo, verify or "improve" Gemini's work unless the user asks. Do not run your own tools on the task.
- Keep your own commentary to a line at most. If Gemini asks the user a question, pass it on as is.
- A non-zero exit means Gemini failed: show its error verbatim.

## Relay thread recipe

A cheap Cloud thread that only forwards messages:

1. Make sure the project's Cloud environment includes the `danielcor/cloudroom-plugins` repo (it appears as `/repos/cloudroom-plugins`; older sandboxes mount it as `/repos/cloudroom-gemini` or `/repos/cloudroom-argon`)
   and that the project's `.env` has `GEMINI_AGY_TOKEN_B64` (see the README: `gemini-relay export-token >> .env`).
   An existing `ARGON_AGY_TOKEN_B64` in `.env` still works; new exports use `GEMINI_AGY_TOKEN_B64`.
2. New Cloud thread, provider Claude Code, model `claude-haiku-5-5`.
3. First message (substitute your actual mount path): `Read /repos/cloudroom-plugins/skills/gemini/SKILL.md and follow it. From now on relay everything I write to Gemini.`
