# Qoder Cloudroom provider plugin design

## Intent and why

Make the installed Qoder CLI available as a first-class Cloudroom provider so Qwen 4 Max Preview can run visible review threads. The immediate use is proposal review alongside Sol 6.1, with no hidden shell-launched agent and no credentials copied into the plugin.

## Goals

- Register provider id `qoder` with Qoder's ACP mode and the existing generic ACP bridge.
- Discover models through ACP, with Qwen 4 Max Preview as the cold-cache fallback.
- Preserve Qoder sessions across turns and support resume, tip fork, queued steering, stop, rename, and archive where the SDK supports them.
- Make review safety explicit: `accept-edits` requires approval for mutations; `full` is the only bypass mode.
- Build, conformance-test, install, and verify the provider through an actual Cloudroom thread.

## Non-goals and anti-goals

- No native stream-json bridge and no use of Qoder's private `--sdk` protocol.
- No new Cloudroom SDK public API, frontend bundle, provider installer, or Cloud-thread support.
- No credentials read, copied, logged, or stored by the plugin.
- No edits to existing providers or threads, and no changes to AiTradingBot proposals as part of this plugin task.
- No claims of usage metrics, true mid-turn steering, checkpoint forks, or a built-in read-only permission mode.
- Initial release is aipc-only. Mac/WSL support is out of scope unless separately requested.

## Constraints and verified facts

- Qoder 1.1.88 has hidden `qodercli --acp` support with `loadSession`, resume, fork, prompt, cancel, and interactive permission requests.
- The `~/.qoder/entry/qoder` wrapper forwards all flags to the real CLI and finds the binary on a minimal PATH.
- Cloudroom's generic ACP bridge maps its provider protocol to ACP session operations. It must not use `modelCli`: Qoder's `DisplayName (key)` model-list output is incompatible with the SDK parser. Models come from ACP. (Task 4, live Qoder 1.1.88: `session/new` returns both `models.availableModels` and `configOptions`; the bridge uses the `model` config option.)
- Qoder usage metrics are unavailable. A steer cancels the running prompt and is sent in the same turn (the bridge's queue steer mode), and forking is tip-only.
- The generic ACP bridge rejects Cloudroom `auto`; only `accept-edits` and `full` will be offered.
- Qoder accepts `--permission-mode default|accept_edits|bypass_permissions|dont_ask|auto`, and those flags work with `--acp`.
- Qoder exposes ACP config option `reasoning_effort` with category `thought_level`. The generic bridge can map Cloudroom levels to the values the selected model reports supporting. A command-line reasoning flag is not used because it overrides resumed-session values and is not model-aware.
- The existing `plugin-muse` package demonstrates the desired registration, launch-spec, and conformance-test shape. Follow its structure, not another provider's behavior.

## Approaches

### Chosen: generic ACP wrapper

Create `plugin-qoder` as a small headless package modeled on `plugin-muse`. It launches `qodercli --acp` through the SDK's generic ACP bridge.

Advantages: maintained protocol mapping, less code, conformance harness, model discovery, resume/fork/stop behavior, and no private protocol dependency.

Tradeoffs: queued steering, no usage data, tip-only forks, and permission behavior that must be tested explicitly.

### Rejected: native print-protocol bridge

Hand-map Qoder's `system/init`, `stream_event`, `result`, and permission messages into Cloudroom's protocol.

This could provide custom tool filtering but requires substantially more lifecycle code and depends on a private, unstable output format. It is not justified now that ACP is available.

## Package and provider contract

- Package: `plugin-qoder`, package name `bb-plugin-provider-qoder`, provider id `qoder`.
- Headless `bb.server` registration plus `bb.host` bridge. No `bb.app`.
- Default command: absolute path `/home/danielcor/.qoder/entry/qoder`, with `--acp` in the launch arguments. A string setting permits an alternative absolute command.
- Provider declaration:
  - display name `Qoder`;
  - models from ACP, with one default fallback model: id `qmodel_latest`, display name `Qwen4-Max-Preview` (the live ACP id and name; Task 4 corrected the original `qwen4-max-preview`);
  - no `nativeReasoning` hint (removed in Task 4): the bridge reads each model's live `reasoning_effort` option (Qwen4-Max-Preview: none/low/high/xhigh, default xhigh), and Qoder's `auto`, `fast` and `efficient` have no reasoning option and reject `reasoning_effort`, so a hint would invent levels for them;
  - tip forking, steering that cancels and resends in the same turn, native permission interactions, and no manual compaction or usage reporting;
  - permission modes `accept-edits` and `full` only.
- No `modelCli`, usage probe, installer declaration, or reasoning CLI flag.
- Static launch options contain only non-secret launch facts. Per-turn options derive model, reasoning, and permission mode without reading Qoder credential files.

## Permission and review-safety design

Map modes deliberately:

- `accept-edits` -> CLI arguments `--permission-mode default`: Qoder asks before mutations, and every `session/request_permission` is forwarded to Cloudroom. There is no bridge auto-approval in this mode. Review threads use this mode. The gate depends on Qoder asking: the bridge serves an in-workspace ACP `fs/write_text_file` without approval, so a mutation Qoder made through that call without first sending `session/request_permission` would not be gated (characterized in `test/host.test.ts`). In the Task 4 live check, Qoder 1.1.88 asked before both requested writes, and denying them left the workspace unchanged.
- `full` -> CLI arguments `--permission-mode bypass_permissions`: the bridge may approve every request. This is the only unrestricted mode and is not used for review threads.

The provider documentation must say explicitly that Cloudroom's `accept-edits` label is approval-gated here: it asks before every edit and is not Qoder's own `acceptEdits` mode. Qoder's own `acceptEdits` mode is not offered.

Tests must prove that a write-like permission request reaches Cloudroom in `accept-edits` and is not auto-approved. No plugin code will infer tool safety from a tool's display name.

## Lifecycle, credentials, and cleanup

- The generic ACP bridge handles `session/new`, resume/load, tip fork, prompt/cancel, and steering (cancel the running prompt, then resend in the same turn). The plugin adds no second session store.
- Qoder owns its existing login and configuration. The plugin neither reads nor redacts credential files because it never opens them.
- The plugin adds no environment values of its own (`env: {}` in the launch spec). Qoder still inherits the host daemon's environment, because the SDK bridge builds the child environment from the daemon's `process.env` (minus the bridge's own runtime variables) plus the thread's resolved environment. The plugin never reads, logs or dumps that environment, Qoder configuration or authorization headers.
- Registrations and provider resources are disposed on settings reload and plugin disposal. Changing the command replaces the old registration before starting the new one.
- No background services, schedules, frontend assets, or persistent plugin database are needed.

## Tests and verification

1. Declaration/unit tests:
   - provider registration and replacement on command change;
   - exact fallback model and capability declarations;
   - no `modelCli`, usage probe, frontend, reasoning CLI flag, or secret setting;
   - registration disposal.
2. Generic ACP conformance using a scripted Qoder double:
   - initialize, model discovery, start, resume, tip fork, prompt deltas, queued steer, and stop;
   - unknown methods and invalid parameters return the SDK-defined errors;
   - `accept-edits` forwards a mutation permission request without auto-approval;
   - `full` uses the bypass mapping;
   - reasoning uses `reasoning_effort`, not a CLI override;
   - no credentials appear in captured logs.
3. Repository gates:
   - `npm ci`, `npx tsc --noEmit`, `npx vitest run`;
   - `room-cli plugin types`, `room-cli plugin build`, and the SDK public-import scanner.
4. Live verification after install:
   - `room-cli plugin list` is healthy and `room-cli provider models qoder` includes Qwen 4 Max Preview;
   - verify which reasoning efforts the live model supports and remove the reasoning declaration if it supports none;
   - start a Cloudroom Qoder thread in `accept-edits` with a harmless read/report prompt and confirm visible output, a second-turn resume, and clean stop;
   - request a mutation and confirm Cloudroom receives an approval request rather than an automatic edit;
   - remove temporary sessions/files and leave other providers and threads unchanged.

If Qwen 4 Max Preview is absent or Qoder authentication fails, stop and report the Settings → Agents login/model issue. Do not switch providers or hide the failure behind the fallback list.

## Documentation

- Add `plugin-qoder/skills/qoder/SKILL.md` documenting installation, model selection, the approval-gated `accept-edits` label, `full` bypass semantics, reasoning support, queued steering, tip-only forks, missing usage data, and review-only operating constraints.
- Update the plugin README with install and verification commands.
- No new Cloudroom SDK public surface is introduced, so no new experimental SDK API or API-audit entry is required.

## Implementation sequence

1. Copy only the useful `plugin-muse` structure into `plugin-qoder` and update declaration, launch, branding, and documentation.
2. Add unit/conformance tests and run the repository gates.
3. Build and path-install the plugin, then run the live Cloudroom checks.
4. Run Sol 6.1 review of the implementation and fix all findings before reporting completion.

## Director decisions from the builder check

- Review threads use `accept-edits` with Qoder `default`; Cloudroom `auto` is dropped rather than rewriting the SDK.
- Initial release is aipc-only, with an absolute default command so minimal-PATH resolution works.
- Qoder's own `acceptEdits` mode is not offered; the documentation calls out the label difference explicitly.
- Reasoning uses ACP `reasoning_effort`, not a command-line override.

## Open items

- Exact Qwen model availability, login state, and supported reasoning efforts must be verified live. Do not infer them from cached files.
- Any Qoder behavior not exposed by ACP remains unclaimed until the live checks prove it.
