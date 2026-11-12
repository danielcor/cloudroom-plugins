# provider-qoder

A Cloudroom plugin that adds the **Qoder** provider (id `qoder`). It runs the Qoder CLI in its ACP mode
(`qoder --acp`) through the plugin SDK's generic ACP bridge, so local threads can use Qwen 4 Max Preview and
the other models Qoder offers. The plugin adds no protocol code of its own: `src/host.ts` re-exports the SDK
bridge unchanged, and `src/declaration.ts` holds the whole provider contract.

The plugin never reads, copies or logs Qoder's login. Qoder keeps its own sign-in on the machine.

## Scope

- **aipc only.** The default command is the absolute path `/home/danielcor/.qoder/entry/qoder`, which exists on
  aipc-ubuntu. Mac and WSL are out of scope.
- **Local threads only.** Cloud threads cannot use it: the cloud core has a fixed harness list. The provider id
  has no `acp-` prefix, so it stays out of the hosted Cloud picker.
- **No shell-launched Qoder.** Agents must not start `qoder` or `qodercli` from a shell, script or loop. Every
  Qoder agent runs as a Cloudroom thread, where the user can see it, approve it and stop it.

## Install (on aipc)

Qoder CLI 1.1.88 or newer must be installed at `~/.qoder/entry/qoder` and signed in. A person signs in once
by running `qodercli` in a terminal; agents never do this.

```sh
cd ~/src/cloudroom-plugins/plugin-qoder && npm ci
room-cli plugin build .
room-cli plugin install path:$HOME/src/cloudroom-plugins/plugin-qoder --yes
room-cli plugin list | grep -A1 provider-qoder       # provider-qoder@0.1.0  running
room-cli provider models qoder --machine aipc-ubuntu  # qmodel_latest  Qwen4-Max-Preview  * , plus 15 more
```

Both outputs were seen live on 2026-11-12 with Qoder CLI 1.1.88. Qwen 4 Max Preview has the ACP id
`qmodel_latest`; pass that id to `--model`.

`room-cli plugin install` and `room-cli plugin reload` prune dev dependencies. Run `npm ci` again before you run
the tests in an installed plugin directory.

If Qoder lives somewhere else, set the absolute path (it is still launched with `--acp`):

```sh
room-cli plugin config provider-qoder set command /abs/path/to/qoder
```

Until Qoder reports its live model list over ACP, the picker shows a single fallback entry,
**Qwen4-Max-Preview** (`qmodel_latest`). So that entry alone does not prove Qoder is signed in. If a thread
fails with a login error, sign in again with `qodercli` and reload the plugin. Do not switch to another
provider to hide the failure.

## Use it

Start a local thread on aipc-ubuntu, pick **Qoder** and a model, then pick a permission mode:

| Cloudroom mode | Qoder flag | What it means |
| --- | --- | --- |
| **Accept edits** (default for review work) | `--permission-mode default` | Approval-gated. Qoder asks before each mutation, and the bridge forwards every `session/request_permission` to Cloudroom as an approval request. Nothing is auto-approved. |
| **Full** | `--permission-mode bypass_permissions` | Unrestricted. Qoder skips its own prompts and the bridge approves every request. Never use it for review threads. |

Cloudroom's "Accept edits" label means something different here: it does **not** let edits through on its
own. It asks before every edit. Qoder's own `acceptEdits` mode (`--permission-mode accept_edits`) is **not
offered**, and neither are Qoder's `dont_ask` and `auto` modes. Cloudroom's `auto` mode is not offered either,
because the generic ACP bridge rejects it.

Checked live on 2026-11-12 (Qoder CLI 1.1.88, Accept edits): asked to create one file and append to another,
Qoder sent an approval request for each write before touching anything. Both were denied in Cloudroom, Qoder
reported the denial, and the workspace stayed byte-identical. Qoder's `default` mode also asks before MCP tool
calls and shell commands, even read-only ones, so expect approval requests for reads too.

One limit remains: the bridge's approval gate only fires when Qoder asks. If a future Qoder wrote a file
through ACP `fs/write_text_file` without asking first, the bridge would serve an in-workspace write in Accept
edits.

Other behavior:

- **Reasoning.** Each model has its own levels, read from Qoder's ACP config option `reasoning_effort`.
  Qwen4-Max-Preview offers none, low, high and extra high (default extra high). Qoder's `auto`, `fast` and
  `efficient` models have no reasoning option, so Cloudroom shows them as agent-managed and sends no level.
  There is no reasoning CLI flag. On resume, only when the thread has a level set, Cloudroom re-applies it
  over ACP (`session/set_config_option`) after the session loads. This matters, because `session/load` resets
  Qoder to the model's default level.
- **Steering interrupts.** A message sent during a turn cancels Qoder's running prompt, and the bridge then
  sends the message in the same Cloudroom turn. Qoder never runs two prompts at once.
- **Forks are tip-only.** A fork starts from the thread's latest turn, never from an earlier checkpoint.
- **No usage or quota metrics.** The plugin reports no token usage or plan quota. A context-window figure
  appears only if Qoder itself sends ACP `usage_update` events.
- **Not supported:** thread rename and archive on Qoder's side, manual compaction, native user questions,
  service tiers.

Threads resume across restarts: the bridge reloads the saved Qoder session with ACP `session/load`. If that
fails, or Qoder does not advertise `loadSession`, the bridge starts a fresh session (`session/new`) and shows a
warning: "`<command> --acp` could not restore the previous session; continuing in a fresh session without
in-agent history." Here `<command>` is the configured Qoder command, so by default the
warning begins `/home/danielcor/.qoder/entry/qoder --acp`. The thread continues, but Qoder no longer
remembers the earlier turns. In the live check, a thread archived (which stops Qoder) and then unarchived
loaded its session without this warning and still remembered the earlier turns.

## Develop

```sh
cd plugin-qoder && npm ci && npx tsc --noEmit && npx vitest run   # 3 files, 17 tests
room-cli plugin types .                                            # regenerate SDK types for the running Cloudroom
room-cli plugin build .                                            # dist/server.js and dist/host.js
```

`room-cli plugin types` regenerates the SDK type surface for the running Cloudroom. It does **not** change the
`@get-bb/plugin-sdk` pin (still `0.6.49`), but it rewrites `package.json` to move the SDK from `dependencies` to
`devDependencies`. Revert that hunk and keep the SDK in `dependencies`, as `plugin/` and `plugin-muse/` do. No
gate needs the move.

`room-cli plugin build` stamps its own SDK version into `dist/*.meta.json` (`sdkVersion: 0.6.51` with the
current room-cli), which differs from the `0.6.49` pin. The running Cloudroom accepted that build: the live
install loaded it as `provider-qoder@0.1.0  running`.

- `test/server.test.ts`: the declaration, the launch contract and the command setting, plus clean replacement
  and disposal of the registration. It runs the plugin in the SDK's fake plugin host and launches no agent.
- `test/host.test.ts`: models and per-model levels from ACP config options (no `modelCli`), `reasoning_effort`
  on start and resume, and none when no level is set or the model has no reasoning option; both permission
  mappings, approval forwarding and denial in Accept edits, `auto` rejected, and a steer that cancels the
  running prompt and resends in the same turn.
- `test/provider-bridge.conformance.test.ts`: the SDK conformance suite (start, resume, tip fork, prompt deltas,
  zero-work turns, independent threads, interrupt and stop).

`host.test.ts` and the conformance suite run against `test/fake-qoder-acp.mjs`, a scripted ACP double that
copies the model and reasoning shapes real Qoder 1.1.88 reports. No test starts the real Qoder.
