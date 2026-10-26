# cloudroom-plugins

More agent harnesses for Cloudroom: Gemini 4 Argon (Google Antigravity, `agy`) and Meta Muse
(Muse Code, Muse Wonder Full). Argon is documented first; [Muse](#muse) has its own section below.

- [`acp/`](acp/): **agy-acp**, an Agent Client Protocol agent that wraps the agy CLI's headless
  stream-json mode. Works with any ACP client. Its README has the ACP compliance note.
- [`plugin/`](plugin/): **provider-agy**, a Cloudroom plugin that adds the "Antigravity" provider
  (id `agy`) to local threads. It runs agy-acp through the plugin SDK's ACP bridge.
- [`cli/argon`](cli/argon) and [`skills/argon/`](skills/argon/): **argon**, a command plus a skill that run Argon
  headless in Cloud threads through a cheap relay agent (Cloud threads cannot host a custom harness). See
  [Cloud threads](#cloud-threads-argon).
- [`muse-acp/`](muse-acp/), [`plugin-muse/`](plugin-muse/), [`cli/muse-relay`](cli/muse-relay) and
  [`skills/muse/`](skills/muse/): the same three pieces for Muse. See [Muse](#muse).

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
room-cli plugin list | grep -A1 provider-agy       # provider-agy@0.1.2  running
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
3. Pick the permission mode. **Accept edits** lets agy read and edit files in the thread's workspace but
   auto-denies shell commands and file reads outside the workspace (headless agy cannot ask; the reply names what
   it denied). **Full** runs agy with `--dangerously-skip-permissions`. See [Accept edits and reads](#accept-edits-and-reads).
4. Optional: the reasoning level maps to agy `--effort`, except for models whose id ends in an effort
   (`gemini-4-argon-high`, `-medium`, `-low`): agy rejects a conflicting `--effort` for those, so the id wins and
   the level is ignored. Pick the Low/Medium/High model instead.

Threads resume after a restart: agy-acp keeps each thread's agy conversation id and restarts agy with `--conversation`.

### Accept edits and reads

Headless `agy --mode accept-edits` reads and edits inside the workspace, but **silently denies file reads outside
it** (the tool returns nothing; the turn ends with `denied_actions`). Reproduced on agy 1.4.7: a file next to the
workspace under `$HOME` was denied while `/tmp` paths and the workspace itself read fine. `--mode auto` and
`--mode plan` deny the same reads, so a reviewer that has to read other trees (skills, sibling worktrees) needs one of:

- **Full**: everything allowed, shell included.
- **Extra directories**: `--add-dir DIR` makes `DIR` part of the workspace: reads *and* edits allowed, shell still
  denied (checked with a write and a shell call). Set it in the plugin setting "Extra directories for Accept edits"
  (`:`-separated, every machine), in `AGY_ACP_ADD_DIRS`, with `agy-acp --add-dir DIR`, or per session through ACP's
  `additionalDirectories`.
- **Read-only grants**: `read_file(DIR/**)` entries under `permissions.allow` in
  `~/.gemini/antigravity-cli/settings.json`. agy-acp never edits that file; it names this option in its denial message.

Nothing grants "read anywhere, edit only the workspace, no shell" in one switch: agy has no such flag.

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

Make the script and skill available in sandboxes: add the `danielcor/cloudroom-plugins` repo to the project's Cloud
environment so it appears as `/repos/cloudroom-plugins` (older environments mount it as `/repos/cloudroom-argon`; the skill checks both) (or `room-cli mac pull` a checkout from your desktop).
Nothing else to install: the skill finds `/repos/cloudroom-plugins/cli/argon` (or the old `/repos/cloudroom-argon`) itself.

Then start a **relay thread**: new Cloud thread, Claude Code, `claude-haiku-5-5`, first message:

> Read /repos/cloudroom-plugins/skills/argon/SKILL.md and follow it. From now on relay everything I write to Argon.

Every later message goes to Argon verbatim; Haiku only forwards it and quotes the answer. To use it from any other
thread, say the same thing there, or install the skill: `ln -sfn /repos/cloudroom-plugins/skills/argon ~/.claude/skills/argon`.

Limits:
- The relay agent sees Argon's output as command output, so the user may need to expand it; the skill tells it to quote the answer.
- One turn per call: no mid-turn questions or permission prompts (Argon runs with permissions skipped, in the cwd).
- Sandboxes are separate machines: Argon edits files in that sandbox's checkout, so commit and push to get them out.
- Several sandboxes share one login; if Google ever revokes it, re-run `argon export-token >> .env` from a working machine.
- Argon calls cost the user's Antigravity quota; the relay model costs Cloudroom usage on top.

## Muse

Meta Muse Code for Cloudroom, defaulting to **Muse Wonder Full** (`muse-wonder-full-1.0`, 1M context, needs the
Power plan or higher). Local threads get a **Muse** provider (id `acp-muse`); Cloud threads use the `muse-relay`
command and skill.

- [`muse-acp/`](muse-acp/): **muse-acp**, the community ACP adapter
  [`@bex-co/muse-code-acp`](https://github.com/bex-co/muse-code-acp) (Apache-2.0, built on Meta's `@muse-code/sdk`),
  pinned to an exact version, plus a launcher that keeps Cloudroom sessions clean (below).
- [`plugin-muse/`](plugin-muse/): **provider-muse**, the Cloudroom plugin. It runs muse-acp through the plugin SDK's
  ACP bridge and finds muse-acp, node and muse on machines whose daemon has a bare PATH, like provider-agy.
- [`cli/muse-relay`](cli/muse-relay) and [`skills/muse/`](skills/muse/): run Muse headless from Cloud threads.

### What Cloudroom-started Muse sessions leave out

Every session from the plugin or `muse-relay` runs with:

| Off | How |
| --- | --- |
| Contributor mode (Meta may train on the session) | `--contributor-mode off` and `MUSE_CONTRIBUTOR_MODE=0`. The flag alone is not enough: Muse's server default model is `muse-wonder-1.0-contributor`. So only non-`-contributor` models are listed, the plugin runs the plain twin of any `-contributor` id a thread names and gives a thread without a model Wonder Full, and `muse-relay` refuses `-contributor` ids. |
| Your Claude Code / Codex personal rules (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`) and their skills | `MUSE_EXPERIMENTAL_FOREIGN_PERSONAL_CONTEXT_KILL=1` (`--no-foreign-personal-context` for `muse exec`). The `context.foreign_personal_*` settings did not remove the rules in a `-c` override. |
| Reminder observers (extra `muse-spark` calls on every turn) | `-c run.reminder_roster=[]` (`--disable-reminders` for `muse exec`) |
| Hooks from your settings and `managed_hooks_path` (for example Orca's) | `-c managed_hooks_path=null -c hooks={}` |

Muse's own skills (`~/.agents/skills`, `~/.config/muse/skills`, built-ins) and a trusted project's rules still load.
None of this changes your saved Muse settings.

### Install

Each machine that runs Muse threads needs muse (signed in), Node 22 or newer, and muse-acp. The Cloudroom server
(aipc) needs the plugin once.

1. muse and muse-acp, on every machine (aipc, Mac, WSL):

   ```sh
   curl -fsSL https://dev.meta.ai/install.sh | sh        # skip if `muse --version` works
   muse usage                                             # must show your plan; if "not logged in", run `muse login`
   git clone https://github.com/danielcor/cloudroom-plugins ~/src/cloudroom-plugins
   cd ~/src/cloudroom-plugins/muse-acp && npm ci --omit=dev && npm install -g .   # keep the clone
   muse-acp --list-models                                 # muse-wonder-full-1.0 - Muse Wonder Full 1.0, ...
   ```

   `muse login` is a device-code sign-in: it prints a code to enter at a URL, and it is the login that spends your
   plan. `META_API_KEY` in the Cloudroom daemon's environment also works, but it is pay-per-token API billing with
   no plan allowance (`muse usage` says `No subscription allowance (api_key)`), and it overrides a `muse login`.

2. The plugin, on the Cloudroom server (aipc):

   ```sh
   cd ~/src/cloudroom-plugins/plugin-muse && npm ci
   room-cli plugin build .
   room-cli plugin install path:$HOME/src/cloudroom-plugins/plugin-muse --yes
   room-cli plugin list | grep -A1 provider-muse                 # provider-muse@0.1.0  running
   room-cli provider models acp-muse --machine aipc-ubuntu       # Muse Wonder Full 1.0 (default), ...
   ```

A machine without muse-acp, or with a signed-out muse, shows "No models available" under
`room-cli provider models acp-muse --machine <name>`. Do step 1 there (`muse login` included), then list again.

### Start a Muse thread

Pick the **Muse** provider and a model (Muse Wonder Full 1.0 is the default). The reasoning level is Muse's
effort (low to max; default high). Permission modes:

- **Accept edits**: Muse's defaults. It writes in the workspace, runs shell commands in its OS sandbox (network
  through its proxy), and its own reviewer approves low-risk calls. Anything else becomes a Cloudroom approval.
- **Full**: the bridge approves every request, and muse-acp turns Muse's OS sandbox off (`--full`).

Expect a minute or more per Wonder Full turn: Muse's own system prompt and tools are about 28k input tokens per
model call before your message.

### Cloud threads: `muse-relay`

One dependency-free Node (>= 20) script: `cli/muse-relay`, the same UX as `argon`.

| Command | What it does |
| --- | --- |
| `muse-relay setup` | Idempotent. Installs `muse` (official `install.sh`) if missing and finds the login (below). |
| `muse-relay run [--model M] [--effort L] [--new \| --session ID] [PROMPT]` | One turn in the cwd with approvals and Muse's sandbox off. Streams Muse's text and one line per tool call, then `model: <id> (<n> tokens in, <m> out)` and `session: <id>`. Continues the last session for this cwd unless `--new`. The prompt can come from stdin. Non-zero exit with Muse's error on failure. Default model `muse-wonder-full-1.0`; `-contributor` models are refused. |
| `muse-relay models` | Muse's live model list, without contributor variants. |
| `muse-relay export-login >> .env` | Prints `MUSE_AUTH_B64=...`, your `~/.config/muse/auth.json` (the `muse login` plan login) in base64. Refuses to write to a terminal. |
| `muse-relay export-key >> .env` | Prints `META_API_KEY=...`, the pay-per-token **API** fallback (prints a warning). Refuses to write to a terminal. |

`muse-relay` uses your **plan** login, not an API key. The login, in order: an existing plan login in
`~/.config/muse/auth.json`; env `MUSE_AUTH_B64`; that key in the nearest `.env` (cwd up to the git root); the paired
desktop's `~/.config/muse/auth.json` through `room-cli mac run`. A found login is written to `~/.config/muse/auth.json`
with mode `0600`; only oauth (plan) logins are imported, an API-key `auth.json` is skipped. Only when none of those exist does it fall back to `META_API_KEY` (env or `.env`), with a one-line
warning that this bills the API. While a plan login exists, `META_API_KEY` is removed from muse's environment, because
muse would otherwise prefer it. Values are never printed. `muse` refreshes the login's token itself and writes it
back to that file; a sandbox's copy refreshes on its own, so re-run `export-login` if Meta ever revokes it.

One time, on a machine where `muse` is logged in:

```bash
cd <your project> && git check-ignore .env   # must print ".env"; if not, add it to .gitignore first
muse-relay export-login >> .env              # or from a Cloud thread: muse-relay setup && muse-relay export-login >> .env
```

Treat that `.env` like a password: the login spends your Muse plan. Never `source` it (keys can hold shell
metacharacters such as `|`); `muse-relay` parses it.

Add the `danielcor/cloudroom-plugins` repo to the project's Cloud environment (it appears as
`/repos/cloudroom-plugins`), then start a relay thread: new Cloud thread, Claude Code, `claude-haiku-5-5`, first message:

> Read /repos/cloudroom-plugins/skills/muse/SKILL.md and follow it. From now on relay everything I write to Muse.

The limits are argon's: one turn per call, no mid-turn questions, edits stay in that sandbox until pushed.

### Develop

```sh
npm test                                     # argon + muse-relay (fake muse replaying scrubbed transcripts)
cd muse-acp && npm ci && npm test            # launcher, model list format, the muse-clean flags
cd plugin-muse && npm ci && npx tsc --noEmit && npx vitest run
MUSE_SMOKE=1 npx vitest run test/live-muse.smoke.test.ts    # live: two muse-spark-1.3 turns through the bridge
```

`MUSE_SMOKE_MODEL=muse-wonder-full-1.0` runs the smoke test on Wonder Full. `plugin-muse/src/resolve.ts` is a copy
of provider-agy's; keep them in sync.
