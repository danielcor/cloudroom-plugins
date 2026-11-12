# Task 1 report: Provider declaration and registration

**Status:** DONE_WITH_CONCERNS

## What was built

- `plugin-qoder/package.json`: `bb-plugin-provider-qoder`. The manifest has `bb.server` and `bb.host` (`./src/host.ts`, which Task 2 creates) and no `bb.app`.
- `plugin-qoder/package-lock.json`: copied from `plugin-muse` with the package renamed. Same dependency set; `npm ci` passes.
- `plugin-qoder/tsconfig.json`: same as `plugin-muse`.
- `plugin-qoder/src/declaration.ts`: exports `QODER_PROVIDER_ID` (`qoder`), `DEFAULT_QODER_COMMAND` (`/home/danielcor/.qoder/entry/qoder`), `qoderLaunchSpec(command)`, and `qoderProviderDeclaration(command)`.
  - The launch spec matches the plan exactly: args `--acp`, `nativeReasoning` set to `reasoning_effort` with low/medium/high and default high, and `permissionCli` mapping workspaceWrite to `--permission-mode default` and full to `--permission-mode bypass_permissions`. There is no `modelCli` and no `reasoningCli`.
  - The declaration uses the generic dialect and host-scoped models, with one default fallback: `qwen4-max-preview` / `Qwen 4 Max Preview`.
  - Capabilities: `fork: "tip"`, no compaction, usage off, installation off, and `["accept-edits","full"]` only.
- `plugin-qoder/server.ts`: defines one non-secret string setting, `command`, whose default is the absolute wrapper. It replaces the registration when the setting changes and disposes it on plugin disposal.
- `plugin-qoder/icons/qoder.svg`: a monochrome `currentColor` icon.
- `plugin-qoder/test/server.test.ts`: 4 tests.

## TDD evidence

- RED: `npx vitest run test/server.test.ts` failed with `Failed to load ../server.js` (the module did not exist yet).
- GREEN: `npx vitest run` gave 4 passed (4). `npx tsc --noEmit` exited 0.
- Mutation checks:
  - Removing the old-registration dispose in `register()` fails the replace test, so it is caught.
  - Removing the explicit `onDispose` dispose still passes. The SDK fake host removes a plugin's provider registrations on dispose, so the no-leak test proves the outcome but cannot distinguish the explicit hook. The hook stays because the plan requires it and `plugin-muse` uses the same pattern.

## Test summary

| Test | Result |
|---|---|
| registers Qoder through generic ACP with the exact launch contract | pass |
| declares only a non-secret command setting and no frontend or installer | pass |
| uses the command setting and an empty one falls back to the absolute Qoder wrapper | pass |
| replaces and disposes the registration without leaking resources | pass |

## Concerns

1. **No SDD task-brief script exists.** The installed superpowers SDD skill (`~/.codex/.tmp/plugins/plugins/superpowers/skills/subagent-driven-development`) has only prompt templates. I extracted the brief verbatim with `awk` into `task-1-brief.md`.
2. **`accept-edits` safety gap for Task 2 and Task 4.** In SDK 0.6.49, the generic bridge forwards `session/request_permission` in `accept-edits` and auto-approves only in `full`, which is good. However, its `fs/write_text_file` client handler writes in-workspace files directly in `accept-edits`, with no approval. If Qoder's `default` mode writes through ACP fs without first sending `request_permission`, an edit would not be approval-gated.
   - Task 2's fake double and Task 4's live check must exercise this path.
   - If the gap is real, the fix is an SDK or launch-spec decision, not something to patch in the plugin.
3. **No `primaryModels`.** I left this option out on purpose. With it set to Qwen only, the SDK's `splitPrimaryModels` would demote every other live ACP model to selected-only. Qwen is default only in the cold-cache fallback, and the live default comes from ACP. If the director wants Qwen pinned as the live default, add `primaryModels: ["<live qwen id>"]` once Task 4 confirms the real id.
4. **Declaration fields for steering and permission interactions.** "Queued steering" and "native permission interactions" have no field in `PluginProviderCapabilities` for SDK 0.6.49. The bridge reports them at handshake time (Task 2). `supportsThreadRename` and `supportsThreadArchive` are false because Qoder keeps no archive or name of its own, so Cloudroom tracks both itself.
5. **Build blocked until Task 2.** The manifest's `bb.host` points to `src/host.ts`, which Task 2 creates, so `room-cli plugin build plugin-qoder` cannot pass until then. Vitest and tsc are unaffected.
6. **Not verified (later tasks):** live model id and login, live reasoning-effort support, and `room-cli plugin types` / `room-cli plugin build`.
