---
name: qoder
description: Use when the user wants Qoder or Qwen 4 Max Preview to do work or review something (for example "ask Qoder", "have Qwen review this"). Starts a visible Cloudroom thread on the `qoder` provider. Never launches Qoder from a shell.
---

# Qoder threads

Qoder runs only as a Cloudroom thread on the `qoder` provider (plugin `provider-qoder`). That keeps the agent
visible, approval-gated and stoppable.

**How agents get this skill.** The plugin manifest declares no skills, and the SDK has no field for shipping a
skill to other providers. So this file is not known to load automatically when the plugin is installed. Task 4
checks that live. Until then, distribute it by hand: tell the agent to read
`~/src/cloudroom-plugins/plugin-qoder/skills/qoder/SKILL.md`, or link that `skills/qoder` directory into the
agent CLI's skill directory.

## Hard rules

- **Never start Qoder from a shell.** Do not run `qoder`, `qodercli`, `~/.qoder/entry/qoder` or `--acp` from
  Bash, a script, a loop or another agent CLI. Use `room-cli thread spawn` only.
- **aipc-ubuntu only, local threads only.** No Cloud threads (`--machine cloud` will not work), no Mac or WSL.
- **Never read Qoder's login or config files**, and never print or copy them.
- **Review work uses `accept-edits`.** Use `full` only when the user asks for unrestricted Qoder.

## Check it is installed

```bash
room-cli plugin list | grep -A1 provider-qoder        # expected: provider-qoder@0.1.0  running
room-cli provider models qoder --machine aipc-ubuntu   # expected: lists qwen4-max-preview
```

Both `expected:` outputs are still unconfirmed live (Task 4). If the plugin is missing, install it as
`plugin-qoder/README.md` describes. Until Qoder reports its live models, only the fallback entry
`qwen4-max-preview` appears, so a listed model does not prove a login. If the thread then fails on login or the
model is missing, stop and tell the user to sign Qoder in: a person runs `qodercli` once on aipc, then reloads
the plugin. Settings → Agents may also offer the sign-in, but that path is unconfirmed until Task 4. Do not
switch providers.

## Start a thread

```bash
room-cli thread spawn --parent-self --project "$ROOM_PROJECT_ID" --machine aipc-ubuntu \
  --provider qoder --model qwen4-max-preview --permission-mode accept-edits \
  --reasoning-level high --title "qoder: <topic>" --prompt-file "$ROOM_THREAD_STORAGE/qoder-prompt.md"
```

Cloudroom messages you when the thread finishes. Read its answer from that thread. Delete the prompt file
when you are done.

## What the options mean

- `--permission-mode accept-edits` maps to Qoder's `--permission-mode default`. It is **approval-gated**:
  Qoder asks before each mutation, and every request reaches Cloudroom as an approval. Nothing is
  auto-approved. Despite the label, it does not let edits through on its own.
- `--permission-mode full` maps to `--permission-mode bypass_permissions`. Every request is approved. This is
  the only unrestricted mode.
- Qoder's own `acceptEdits` mode (`accept_edits`) is **not offered**, and neither are `dont_ask` and `auto`.
  Cloudroom's `auto` fails, because the generic ACP bridge rejects it.
- `--reasoning-level`: `low`, `medium` or `high` (default `high`). It is set over ACP (`reasoning_effort`)
  for the selected model, never as a CLI flag. On resume, Cloudroom re-applies the thread's level over ACP
  after the session loads.

## Limits

- **Steering is queued.** A message sent during a turn runs as the next turn, not mid-turn.
- **Forks are tip-only.** You can fork only from the latest turn.
- **No usage or quota metrics.** A context-window figure appears only if Qoder sends ACP `usage_update`.
- **Resume can lose history.** If `session/load` fails, the bridge starts a fresh Qoder session and shows a
  warning. Qoder then has no memory of earlier turns, so restate the context.
- No thread rename or archive on Qoder's side, no manual compaction, no native user questions.
