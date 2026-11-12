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
room-cli plugin list | grep -A1 provider-qoder       # expected: provider-qoder@0.1.0  running
room-cli provider models qoder --machine aipc-ubuntu  # expected: Qwen 4 Max Preview, plus Qoder's other models
```

The two `expected:` outputs have not been seen live yet. The plan's Task 4 install confirms them.

`room-cli plugin install` and `room-cli plugin reload` prune dev dependencies. Run `npm ci` again before you run
the tests in an installed plugin directory.

If Qoder lives somewhere else, set the absolute path (it is still launched with `--acp`):

```sh
room-cli plugin config provider-qoder set command /abs/path/to/qoder
```

Until Qoder reports its live model list over ACP, the picker shows a single fallback entry, **Qwen 4 Max
Preview**. So that entry alone does not prove Qoder is signed in. If a thread fails with a login error, sign in
again with `qodercli` and reload the plugin. Do not switch to another provider to hide the failure.

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

One limit to know: the bridge's approval gate only fires when Qoder asks. If Qoder ever wrote a file through
ACP `fs/write_text_file` without asking first, the bridge would serve an in-workspace write in Accept edits.
Qoder's `default` mode is expected to ask before every mutation. The live check that a refused mutation leaves
the file unchanged is plan Task 4, and it is a release gate.

Other behavior:

- **Reasoning.** Low, medium or high (default high). It is set through Qoder's ACP config option
  `reasoning_effort`, mapped to the levels the selected model reports. There is no reasoning CLI flag. On
  resume, Cloudroom re-applies the thread's own level over ACP (`session/set_config_option`) after the
  session loads, so the thread's setting wins over the level Qoder saved.
- **Steering is queued.** A message sent during a turn waits and runs as the next turn. Qoder cannot be steered
  mid-turn.
- **Forks are tip-only.** A fork starts from the thread's latest turn, never from an earlier checkpoint.
- **No usage or quota metrics.** The plugin reports no token usage or plan quota. A context-window figure
  appears only if Qoder itself sends ACP `usage_update` events.
- **Not supported:** thread rename and archive on Qoder's side, manual compaction, native user questions,
  service tiers.

Threads resume across restarts: the bridge reloads the saved Qoder session with ACP `session/load`. If that
fails, or Qoder does not advertise `loadSession`, the bridge starts a fresh session (`session/new`) and shows a
warning: "`<command> --acp` could not restore the previous session; continuing in a fresh session without
in-agent history." Here `<command>` is the configured Qoder command, so by default the
warning begins `/home/danielcor/.qoder/entry/qoder --acp`. The thread continues, but Qoder no longer remembers the earlier turns.

## Develop

```sh
cd plugin-qoder && npm ci && npx tsc --noEmit && npx vitest run   # 3 files, 15 tests
room-cli plugin types plugin-qoder                                 # regenerate SDK types for the running Cloudroom
room-cli plugin build plugin-qoder                                 # dist/server.js and dist/host.js
```

`room-cli plugin types` regenerates the SDK type surface for the running Cloudroom. It does **not** change the
`@get-bb/plugin-sdk` pin (still `0.6.49`), but it rewrites `package.json` to move the SDK from `dependencies` to
`devDependencies`. Revert that hunk and keep the SDK in `dependencies`, as `plugin/` and `plugin-muse/` do. No
gate needs the move.

`room-cli plugin build` stamps its own SDK version into `dist/*.meta.json` (`sdkVersion: 0.6.51` with the
current room-cli), which differs from the `0.6.49` pin. This is informational until the live install (Task 4)
shows whether the server accepts the build.

- `test/server.test.ts`: the declaration, the launch contract and the command setting, plus clean replacement
  and disposal of the registration.
- `test/host.test.ts`: models from ACP (no `modelCli`), `reasoning_effort`, both permission mappings, approval
  forwarding and denial in Accept edits, and `auto` rejected.
- `test/provider-bridge.conformance.test.ts`: the SDK conformance suite (start, resume, tip fork, prompt deltas,
  queued steer, stop).

All three run against `test/fake-qoder-acp.mjs`, a scripted ACP double. None of them start the real Qoder.
