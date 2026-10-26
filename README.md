# cloudroom-argon

Gemini Argon (Google Antigravity `agy`) for Cloudroom: a local provider plugin (`plugin/`) and, for Cloud threads, an
`argon` command plus a skill.

Cloud threads cannot host a custom harness, so `cli/argon` runs Argon headless through the official `agy` CLI and a
cheap relay agent shows the answer.

## `argon`

One dependency-free Node (>= 20) script: `cli/argon`.

| Command | What it does |
| --- | --- |
| `argon setup` | Idempotent. Installs `agy` (official `install.sh`) if missing, gets the login (below), checks `agy models` lists an argon model. |
| `argon run [--model M] [--effort L] [--new \| --conversation ID] [PROMPT]` | One turn in the cwd, permissions skipped. Streams Argon's text and one line per tool call, ends with `conversation: <id>`. Continues the last conversation for this cwd unless `--new`. The prompt can come from stdin. Non-zero exit with agy's error on failure. Default model `gemini-4-argon-high`. |
| `argon models` | `agy models`. |
| `argon export-token >> .env` | Prints `ARGON_AGY_TOKEN_B64=...`. Refuses to write to a terminal. |

Where `setup` gets the login, in order: the existing `~/.gemini/antigravity-cli/antigravity-oauth-token`,
env `ARGON_AGY_TOKEN_B64`, that key in the nearest `.env` (cwd up to the git root), then the paired desktop through
`room-cli mac run` (file, macOS keychain, `secret-tool`, or the gnome keyring over D-Bus). The file is written `0600`;
values are never printed. `agy` refreshes the token by itself and writes it back.

Tests: `npm test` (parsing and event rendering against scrubbed real `agy` transcripts, plus a fake-`agy` end-to-end run).

## Using Argon in a Cloud thread

One time, on a machine where `agy` is logged in (run `agy` once to sign in):

```bash
cd <your project> && git check-ignore .env   # must print ".env"; if not, add it to .gitignore first
argon export-token >> .env                   # or from a Cloud thread: argon setup && argon export-token >> .env
```

Project `.env` files are copied into every Cloud sandbox, so Argon then works with your machines off.
Treat that `.env` like a password: it holds a refresh token for your Google account's Antigravity login.
Always append with `>>`; never run `export-token` where its output is captured into a chat or log.

Make the script and skill available in sandboxes: add the `danielcor/cloudroom-argon` repo to the project's Cloud
environment so it appears as `/repos/cloudroom-argon` (or `room-cli mac pull` a checkout from your desktop).
Nothing else to install: the skill finds `/repos/cloudroom-argon/cli/argon` itself.

Then start a **relay thread**: new Cloud thread, Claude Code, `claude-haiku-5-5`, first message:

> Read /repos/cloudroom-argon/skills/argon/SKILL.md and follow it. From now on relay everything I write to Argon.

Every later message goes to Argon verbatim; Haiku only forwards it and quotes the answer. To use it from any other
thread, say the same thing there, or install the skill: `ln -sfn /repos/cloudroom-argon/skills/argon ~/.claude/skills/argon`.

Limits:
- The relay agent sees Argon's output as command output, so the user may need to expand it; the skill tells it to quote the answer.
- One turn per call: no mid-turn questions or permission prompts (Argon runs with permissions skipped, in the cwd).
- Sandboxes are separate machines: Argon edits files in that sandbox's checkout, so commit and push to get them out.
- Several sandboxes share one login; if Google ever revokes it, re-run `argon export-token >> .env` from a working machine.
- Argon calls cost the user's Antigravity quota; the relay model costs Cloudroom usage on top.
