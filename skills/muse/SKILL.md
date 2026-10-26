---
name: muse
description: Use when the user wants Meta Muse, Muse Code, Muse Wonder (Full) or Muse Spark to do the work, or asks you to "relay", "hand off" or "ask Muse". Runs Muse headless through the `muse-relay` command and shows its answer.
---

# Muse relay

Muse does the work. You are a thin relay: pass the user's message to Muse, show what comes back.

## Setup (once per sandbox)

```bash
MUSE_RELAY=$(command -v muse-relay || ls /repos/cloudroom-plugins/cli/muse-relay "$HOME"/cloudroom-plugins/cli/muse-relay 2>/dev/null | head -1)
"$MUSE_RELAY" setup
```

`setup` installs `muse` if missing and finds the login: `META_API_KEY` (env or the nearest `.env`), an existing
`muse` login, else the paired desktop's. It ends with `ok: ...`. If it fails, show the error and stop.
Never print, cat or log `META_API_KEY`, `.env` or `~/.config/muse/auth.json`, and never `source` a `.env`.

## Relay

For each user message, run it verbatim, in the project directory:

```bash
"$MUSE_RELAY" run "<the user's message, unchanged>"
```

- Multi-line or quote-heavy messages: pipe them in instead: `printf '%s' "$MSG" | "$MUSE_RELAY" run`.
- It continues the last Muse session for this directory. Use `--new` only when the user asks for a fresh start,
  `--session ID` to resume a specific one (the id is printed on the last line of every run).
- Defaults to `muse-wonder-full-1.0` at Muse's default effort (high). Pass `--model` / `--effort minimal|low|medium|high|xhigh|max`
  only if the user asks. `"$MUSE_RELAY" models` lists the choices. Contributor models are refused.
- Muse runs with approvals and its sandbox off, in the cwd. It edits files and runs commands there itself.
- Runs take a while (a Wonder Full turn can take 1-3 minutes). Give the command a long timeout (10 minutes),
  or run it in the background and read the output when it ends.

## Rules

- Show Muse's answer in your reply (the command output may be collapsed for the user). Quote it; do not paraphrase.
- Do not redo, verify or "improve" Muse's work unless the user asks. Do not run your own tools on the task.
- Keep your own commentary to a line at most. If Muse asks the user a question, pass it on as is.
- A non-zero exit means Muse failed: show its error verbatim.

## Relay thread recipe

A cheap Cloud thread that only forwards messages:

1. Make sure the project's Cloud environment includes the `danielcor/cloudroom-plugins` repo (it appears under `/repos`)
   and that the project's `.env` has `META_API_KEY` (see the README: `muse-relay export-key >> .env`).
2. New Cloud thread, provider Claude Code, model `claude-haiku-5-5`.
3. First message: `Read /repos/cloudroom-plugins/skills/muse/SKILL.md and follow it. From now on relay everything I write to Muse.`
