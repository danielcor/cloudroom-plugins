# cloudroom-argon

Gemini 4 Argon (Google Antigravity, `agy`) for Cloudroom.

- [`acp/`](acp/): **agy-acp**, an Agent Client Protocol agent that wraps the agy CLI's headless
  stream-json mode. Works with any ACP client. Its README has the ACP compliance note.
- [`plugin/`](plugin/): **provider-agy**, a Cloudroom plugin that adds the "Antigravity" provider
  (id `agy`) to local threads. It runs agy-acp through the plugin SDK's ACP bridge.
- [`cli/`](cli/) and [`skills/argon/`](skills/argon/): **argon**, a command plus a skill that run Argon
  headless in Cloud threads through a cheap relay agent (Cloud threads cannot host a custom harness). See
  [Cloud threads](#cloud-threads-argon).

For local threads, agy keeps its own Google login on each machine and the plugin never reads, copies or logs
credentials. The `argon` command copies that login into Cloud sandboxes (below).

## Install

Each machine that runs Antigravity threads needs agy (signed in) and agy-acp. The Cloudroom
server needs the plugin once. Today aipc-ubuntu runs the server, and the Mac and
aliengaming-wsl-debian join it as machines, so the plugin goes on aipc only.

### 1. agy and agy-acp (on every machine: aipc, Mac, WSL)

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash   # skip if `agy --version` works
agy models                                                   # must list gemini-4-argon-*; if not, run `agy` and sign in
mkdir -p ~/src && git clone https://github.com/danielcor/cloudroom-plugins ~/src/cloudroom-argon
npm install -g ~/src/cloudroom-argon/acp                     # links agy-acp into npm's global bin; keep the clone
agy-acp --version
```

The plugin finds `agy-acp` on each machine's host daemon even when that daemon has a bare PATH (SSH
machines): it looks on PATH, then `~/.local/bin`, `~/.npm-global/bin`, `/opt/homebrew/bin` and
`/usr/local/bin`, and launches it with those existing dirs added to PATH so `node` and `agy` resolve too.
The `command` setting still accepts an absolute path. agy-acp itself finds agy on PATH or in
`~/.local/bin`.

### 2. The plugin (on the Cloudroom server, aipc)

```sh
cd ~/src/cloudroom-argon/plugin && npm ci
room-cli plugin build .
room-cli plugin install path:$HOME/src/cloudroom-argon/plugin --yes
room-cli plugin list | grep -A1 provider-agy       # provider-agy@0.1.1  running
room-cli provider models agy --machine aipc-ubuntu # Gemini 4 Argon High (default), Medium, Low
```

`room-cli` here is the desktop app's CLI. On aipc it lives inside the mounted AppImage:
`/tmp/.mount_Cloudr*/resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/room-cli`.

A machine without agy-acp shows only "Agent default" under `room-cli provider models agy --machine <name>`.
Install step 1 there, then run `room-cli provider models agy --machine <name> --restart`.

## Start an Argon thread

1. In Cloudroom, start a new thread on a project and pick the machine (aipc-ubuntu, mac or
   aliengaming-wsl-debian).
2. Pick the **Antigravity** provider and a model: Gemini 4 Argon High (default), Medium or Low.
3. Pick the permission mode. **Accept edits** lets agy edit files but auto-denies shell commands
   (headless agy cannot ask; the reply names what it denied). **Full** runs agy with
   `--dangerously-skip-permissions`.
4. Optional: the reasoning level maps to agy `--effort`.

Threads resume after a restart: agy-acp keeps each thread's agy conversation id and restarts agy with `--conversation`.

## Develop

```sh
cd acp && npm test                          # agy-acp unit tests (fake agy replaying recorded transcripts)
cd plugin && npm ci && npx tsc --noEmit && npx vitest run   # registration + SDK bridge conformance
AGY_SMOKE=1 npx vitest run test/live-agy.smoke.test.ts      # live: two gemini-4-argon-low turns through the bridge
```

`room-cli plugin install` and `plugin reload` prune the plugin's dev dependencies; run `npm ci`
again before running the tests in an installed plugin directory.

## Notes

- Cloud threads cannot use this plugin: the cloud core has a fixed harness list. agy-acp is the
  piece a cloud harness could launch, as it speaks the same ACP methods the cloud core already uses.
- Google also ships an official ACP server, `antigravity-acp` (`agy_acp_server`, listed in the
  ACP registry). It needs its own Google sign-in per
  machine (browser OAuth) and is a ~0.9 GB download. agy-acp reuses the agy CLI login instead.

## Cloud threads: `argon`

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

### Using Argon in a Cloud thread

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
