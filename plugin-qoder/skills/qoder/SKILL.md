---
name: qoder
description: Use when the user wants Qoder or Qwen 4 Max Preview to do work or review something (for example "ask Qoder", "have Qwen review this"). Starts a visible Cloudroom thread on the `qoder` provider. Never launches Qoder from a shell.
---

# Qoder threads

Qoder runs only as a Cloudroom thread on the `qoder` provider (plugin `provider-qoder`). That keeps the agent
visible, approval-gated and stoppable.

**How agents get this skill.** Cloudroom loads it from the installed plugin's `skills/` directory on its own.
After the live install on 2026-11-12, Cloudroom agents listed it as the skill `cloudroom:qoder`, with no
manifest entry and no manual linking.

## Hard rules

- **Never start Qoder from a shell.** Do not run `qoder`, `qodercli`, `~/.qoder/entry/qoder` or `--acp` from
  Bash, a script, a loop or another agent CLI. Use `room-cli thread spawn` only.
- **aipc-ubuntu only, local threads only.** No Cloud threads (`--machine cloud` will not work), no Mac or WSL.
- **Never read Qoder's login or config files**, and never print or copy them.
- **Review work uses `accept-edits`.** Use `full` only when the user asks for unrestricted Qoder.

## Check it is installed

```bash
room-cli plugin list | grep -A1 provider-qoder        # provider-qoder@0.1.0  running
room-cli provider models qoder --machine aipc-ubuntu   # qmodel_latest  Qwen4-Max-Preview  * , plus others
```

Qwen 4 Max Preview's model id is `qmodel_latest`. If the plugin is missing, install it as
`plugin-qoder/README.md` describes. Until Qoder reports its live models, only the fallback entry
`qmodel_latest` appears, so a listed model does not prove a login. If the thread then fails on login or the
model is missing, stop and tell the user to sign Qoder in: a person runs `qodercli` once on aipc, then reloads
the plugin. Settings → Agents may also offer the sign-in, but that path has not been verified. Do not switch
providers.

## Start a thread

```bash
room-cli thread spawn --parent-self --project "$ROOM_PROJECT_ID" --machine aipc-ubuntu \
  --provider qoder --model qmodel_latest --permission-mode accept-edits \
  --reasoning-level high --title "qoder: <topic>" --prompt-file "$ROOM_THREAD_STORAGE/qoder-prompt.md"
```

Cloudroom messages you when the thread finishes. Read its answer from that thread. Delete the prompt file
when you are done.

## What the options mean

- `--permission-mode accept-edits` maps to Qoder's `--permission-mode default`. It is **approval-gated**:
  every permission request Qoder sends reaches Cloudroom as an approval, and nothing is auto-approved.
  Despite the label, it does not let edits through on its own. The gate depends on Qoder asking: the bridge
  serves an in-workspace ACP `fs/write_text_file` without approval, so a write Qoder made that way without
  asking would not be gated. Live, Qoder 1.1.88 asked before every requested write. Qoder also asks before MCP
  tool calls and shell commands, even read-only ones, so a review thread waits on approvals for its reads.
- `--permission-mode full` maps to `--permission-mode bypass_permissions`. Every request is approved. This is
  the only unrestricted mode.
- Qoder's own `acceptEdits` mode (`accept_edits`) is **not offered**, and neither are `dont_ask` and `auto`.
  Cloudroom's `auto` fails, because the generic ACP bridge rejects it.
- `--reasoning-level`: one of the selected model's own levels. For `qmodel_latest` that is `none`, `low`,
  `high` or `xhigh` (default `xhigh`). Qoder's `auto`, `fast` and `efficient` have no reasoning option, so no
  level is sent for them. It is set over ACP (`reasoning_effort`), never as a CLI flag. On resume, only when the
  thread has a level set, Cloudroom re-applies it over ACP after the session loads.

## Limits

- **Steering interrupts.** A message sent during a turn cancels Qoder's running prompt, then runs in the same
  turn.
- **Forks are tip-only.** You can fork only from the latest turn.
- **No usage or quota metrics.** A context-window figure appears only if Qoder sends ACP `usage_update`.
- **Resume can lose history.** If `session/load` fails, the bridge starts a fresh Qoder session and shows a
  warning. Qoder then has no memory of earlier turns, so restate the context.
- No thread rename or archive on Qoder's side, no manual compaction, no native user questions.
