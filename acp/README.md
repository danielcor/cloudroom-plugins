# agy-acp

An [Agent Client Protocol](https://agentclientprotocol.com) (ACP) agent on stdio for the
Google Antigravity CLI (`agy`). Any ACP client (Cloudroom/BB, Zed, ...) can run Gemini 4 Argon
and the other `agy models` through it.

It runs one long-lived `agy -p= --input-format stream-json --output-format stream-json` process
per ACP session, started on the session's first prompt, so clients that open sessions only to read
the model list leave no empty agy conversations behind. agy-acp saves each session's agy
conversation id, so `session/load` and `session/resume` become `agy --conversation <id>`. agy keeps its own login: agy-acp never reads,
copies or logs credentials. It has no dependencies and needs Node 20 or newer.

## Install

```sh
curl -fsSL https://antigravity.google/cli/install.sh | bash   # agy, then run `agy` once and sign in
git clone https://github.com/danielcor/cloudroom-plugins && npm install -g ./cloudroom-plugins/acp
agy-acp --version
```

## Usage

```
agy-acp [--agy PATH] [--model ID] [--effort default|low|medium|high|xhigh|max]
        [--mode accept-edits|auto|plan|bypass] [--dangerously-skip-permissions] [--state-dir DIR]
```

- `--agy`: agy binary (default: `$AGY_PATH`, then `agy` on `PATH`, then `~/.local/bin/agy`).
- `--model`: default model (default `gemini-4-argon-high`).
- `--mode`: default session mode (default `accept-edits`). `--dangerously-skip-permissions` is the
  same as `--mode bypass`.
- `--state-dir`: where each session's agy conversation id and its transcript for `session/load`
  replay go (default `$XDG_STATE_HOME/agy-acp/sessions`, files are 0600).

## ACP compliance

Protocol version 1. Methods:

| Method | Support |
| --- | --- |
| `initialize` | `loadSession: true`, `sessionCapabilities.resume`, prompt: text + embedded text resources, no auth methods (agy signs in by itself) |
| `session/new` | Returns an `agyacp-<uuid>` session id, `models`, `modes`, `configOptions`; agy starts on the first prompt |
| `session/load` | `agy --conversation <saved id>`; replays this machine's saved transcript as `session/update`s before replying. Any id that is not `agyacp-…` is taken as an agy conversation id |
| `session/resume` | Same, without replay |
| `session/prompt` | Streams `agent_message_chunk`, `agent_thought_chunk` (agy `thinking_delta`), `tool_call` / `tool_call_update`; ends with `stopReason` `end_turn` or `cancelled` and per-turn `usage` |
| `session/cancel` | SIGINT to agy (it ends the turn as interrupted and exits); the next prompt restarts agy on the same conversation |
| `session/set_model`, `session/set_mode`, `session/set_config_option` | `model` (category `model`), `effort` (category `thought_level`, agy `--effort`), `mode` (category `mode`). agy takes these as launch flags, so the next prompt restarts agy with `--conversation` |

Modes: `accept-edits` (agy `--mode accept-edits`), `auto` (`--mode auto`), `plan` (`--mode plan`),
`bypass` (`--dangerously-skip-permissions`).

Known gaps, all from what agy's headless mode offers today:

- **No permission prompts.** Headless agy cannot ask; it auto-denies tools its mode does not allow
  (in `accept-edits`, shell commands). agy-acp reports each denial in the reply and never sends
  `session/request_permission`. Use `bypass`, or allow rules in
  `~/.gemini/antigravity-cli/settings.json` (`permissions.allow`).
- **Client MCP servers are ignored** (`mcpCapabilities` false). agy uses its own `agy mcp` config.
- **No client fs/terminal.** agy reads, writes and runs commands itself in `cwd`.
- **Images and audio** are refused; prompts are text, resource links (`@path`) and embedded text resources.
- **Tool output** is agy's summary (for example `1 lines, 19 bytes`), not the file content or diff.
- `session/load` replays only sessions this machine's agy-acp saw. agy still resumes any
  conversation it has, without replay.
- No `session/list`, no `authenticate` flow, no plans or slash commands.

Google also publishes its own ACP server, `antigravity-acp` (`agy_acp_server`, in the ACP
registry). It is a ~0.9 GB download per platform with its own Google sign-in (a browser OAuth flow
per machine, stored in `~/.gemini/antigravity-acp/`), separate from the agy CLI login. agy-acp is
the small option that reuses agy's login.

## Test

```sh
npm test   # node:test against a fake agy that replays recorded agy transcripts (test/fixtures)
```
