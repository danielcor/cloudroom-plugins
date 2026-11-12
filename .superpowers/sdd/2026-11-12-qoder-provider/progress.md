# SDD progress: Qoder provider (2026-11-12)

- Spec: `docs/superpowers/specs/2026-11-12-qoder-provider-design.md`
- Plan: `docs/superpowers/plans/2026-11-12-qoder-provider.md`
- Branch: `feat/qoder-provider` from `origin/main` @ `840a3fa` (upstream unset so nothing pushes to `main` by accident)
- Task brief: `task-1-brief.md`, extracted with `awk '/^### Task 1:/{p=1} /^### Task 2:/{p=0} p'`. The installed superpowers SDD skill (`~/.codex/.tmp/plugins/plugins/superpowers/skills/subagent-driven-development`) has no task-brief script.

## Task status

| Task | Status | Commit | Notes |
|---|---|---|---|
| 1. Provider declaration and registration | done | `feat(qoder): declare ACP provider and registration` | 4/4 tests, tsc clean. Report: `task-1-report.md` |
| 2. Generic bridge and permission/conformance tests | pending | — | |
| 3. Documentation and repository gates | pending | — | |
| 4. Install, live verification, Sol review | pending | — | |

## Preflight conflict table

### Shared files and interfaces

| Item | Owner | Other users | Conflict or risk | Resolution |
|---|---|---|---|---|
| `plugin-qoder/package.json` `bb.host: ./src/host.ts` | Task 1 | Task 2 creates `src/host.ts` | The manifest names a host entry that does not exist until Task 2, so `room-cli plugin build` fails between Tasks 1 and 2. Vitest and `tsc` are unaffected. | Keep the entry, because the spec requires a `bb.host` bridge. The build gate runs in Task 3. |
| `qoderLaunchSpec(command)`, `qoderProviderDeclaration(command)`, `QODER_PROVIDER_ID`, `DEFAULT_QODER_COMMAND` in `src/declaration.ts` | Task 1 | Task 2 host and conformance tests | Task 2 depends on these exact names and shapes. | Export the exact names from the plan. Task 2 must not change them without updating `test/server.test.ts`. |
| `permissionCli` arg placement | Task 1 | Task 2 bridge | The SDK (`permissionCliArgsForMode`) maps `accept-edits` to `workspaceWrite` and inserts args at index 0 by default, so the argv is `--permission-mode default --acp`. | Order-independent CLI flags. No `insertAfterArgs`, as specified. Task 4 confirms it live. |
| `accept-edits` approval path | Tasks 1–2 | Spec review-safety goal | The SDK forwards `session/request_permission` in `accept-edits` and auto-approves only in `full`. However, the bridge's `fs/write_text_file` client handler writes in-workspace files directly in `accept-edits`. If Qoder writes through ACP fs without first sending `request_permission`, a mutation is not approval-gated. | Task 1 cannot change this. Task 2 must test it, and Task 4 must check live whether Qoder `default` sends `request_permission` before writing. |
| Root `README.md` | Task 3 | — | None in Task 1. | Not touched. |
| `test/` directory | Tasks 1, 2, 4 | — | Separate files per task (`server.test.ts`, `host.test.ts`, conformance, live smoke). | No overlap. |
| `package-lock.json` | Task 1 | Tasks 2–4 | Copied from `plugin-muse`, renamed. Same dependency set. | `npm ci` passes. Do not add dependencies. |

### Task-internal test/code consistency (Task 1)

| Plan or spec requirement | Test assertion | Code | Note |
|---|---|---|---|
| Provider id `qoder`, display name `Qoder` | `decl.id`, `decl.displayName` | `QODER_PROVIDER_ID` | Not `acp-` prefixed, so the hosted Cloud picker will not list it. This is intended, because the release is aipc-only. |
| Exact launch spec, including `--acp`, `env: {}`, `nativeReasoning`, both `permissionCli` arrays | `toEqual` on the whole spec | `qoderLaunchSpec` | `toEqual` also proves there is no `modelCli` and no `reasoningCli`. |
| Generic dialect | `acpDialect: "generic"` | bridge options | — |
| Single default fallback `qwen4-max-preview` / `Qwen 4 Max Preview` | `decl.models.fallback` | `models.fallback` | The SDK's fallback type requires `description`, `supportedReasoningEfforts`, `defaultReasoningEffort`, and `isDefault`. Effort fallback is low/medium/high with default high. |
| Host-scoped dynamic models | `decl.models.scope === "host"` | `models.scope` | — |
| No `primaryModels` | not present in bridge options | omitted | The SDK's `splitPrimaryModels` would demote every non-listed live model to selected-only. The spec lists models "from ACP", so ordering is left to ACP. |
| `fork: "tip"`, no manual compaction, no usage | capabilities and `maintenance.usage === false` | declaration | "Queued steering" and "native permission interactions" have no declaration field in SDK 0.6.49. The bridge reports them at handshake time (Task 2). |
| Permission modes `accept-edits` and `full` only | `toEqual(["accept-edits","full"])` | declaration | `auto` is never offered, and the bridge rejects it anyway. |
| `supportsThreadRename` / `supportsThreadArchive` | false | declaration | The spec says "rename and archive where the SDK supports them". These flags mean the provider keeps its own archive or name. Qoder's ACP does not, so both are false and Cloudroom tracks them itself. |
| No frontend (`bb.app`), no installer, no secret setting | manifest and settings descriptor assertions | `package.json`, `server.ts` | — |
| Command setting, where an empty value falls back to `/home/danielcor/.qoder/entry/qoder` | custom and blank command | `server.ts` | — |
| Registration is replaced on reload and removed on dispose | `setSettings` leaves one registration with the new command; `dispose()` leaves zero | `server.ts` | — |
