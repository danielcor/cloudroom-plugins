# Qoder Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tested Cloudroom provider that runs Qwen 4 Max Preview through the installed Qoder CLI's ACP mode.

**Architecture:** A headless `plugin-qoder` package registers provider id `qoder` and launches `/home/danielcor/.qoder/entry/qoder --acp` through the SDK's generic ACP bridge. Models and reasoning come from ACP; permission modes map to explicit Qoder CLI flags, with no custom protocol or credential handling.

**Tech Stack:** TypeScript, Node 22, Cloudroom Plugin SDK generic ACP bridge, Vitest, Qoder CLI 1.1.88.

**Spec:** `docs/superpowers/specs/2026-11-12-qoder-provider-design.md`

## Global Constraints

- Provider id is `qoder`; package is `plugin-qoder` / `bb-plugin-provider-qoder`.
- Default command is exactly `/home/danielcor/.qoder/entry/qoder`, launched with `--acp`.
- Models come from ACP `availableModels`, never `modelCli`. Fallback model is `qwen4-max-preview` / `Qwen 4 Max Preview`.
- Permission modes are only `accept-edits` and `full`, mapped respectively to `--permission-mode default` and `--permission-mode bypass_permissions`.
- Reasoning uses `nativeReasoning.configId = "reasoning_effort"`, supported levels `low`, `medium`, `high`, default `high`; remove it if the live model supports none.
- aipc-only; no Cloud threads, frontend, usage metrics, installer, native stream-json protocol, or private `--sdk` protocol.
- Do not read, copy, print, or store credentials. Do not start Qoder directly from a shell; live agents must start through Cloudroom.
- Create branch `feat/qoder-provider` from `origin/main`, carrying only this design/plan documentation. Stop if other uncommitted work would be carried or overwritten; never include the existing `fix/relay-login-and-agy` work.

## Review Focus

- Cloudroom `auto` must never reach the generic ACP bridge, which rejects it; `accept-edits` must forward mutation approvals instead of auto-approving. Covered by Tasks 1 and 2.
- Qoder's `DisplayName (key)` model-list output must not enter the SDK's incompatible `modelCli` parser. Covered by Task 1.
- A resumed session must not have its saved reasoning overridden by a CLI flag; only model-aware ACP `reasoning_effort` is allowed. Covered by Tasks 1 and 2.
- A settings reload or plugin disposal must not leak the old provider registration or process resources. Covered by Task 1.
- Missing Qwen availability, login, or reasoning support must fail visibly rather than being hidden by fallback metadata. Covered by Task 4.

---

### Task 1: Provider declaration and registration

**Files:**
- Create: `plugin-qoder/package.json`
- Create: `plugin-qoder/tsconfig.json`
- Create: `plugin-qoder/src/declaration.ts`
- Create: `plugin-qoder/server.ts`
- Create: `plugin-qoder/icons/qoder.svg`
- Create: `plugin-qoder/test/server.test.ts`

**Interfaces:**
- Consumes: `bb.providers.register` and `bb.settings.define` from the existing Plugin SDK, following `plugin-muse/server.ts`.
- Produces: `QODER_PROVIDER_ID`, `DEFAULT_QODER_COMMAND`, `qoderLaunchSpec(command: string): AcpLaunchSpec`, `qoderProviderDeclaration(command: string): PluginProviderDeclaration`, and default async `qoderProviderPlugin(bb: BbPluginApi): Promise<void>`.

- [ ] **Step 1: Create the branch and write the failing registration tests**

Create `feat/qoder-provider` from `origin/main`, carrying only the design/plan documents. In `test/server.test.ts`, add tests named:
- `registers Qoder through generic ACP with the exact launch contract`: assert provider id, display name, both permission modes, native reasoning, generic dialect, fallback model, `maintenance.usage === false`, and the exact launch spec including `--acp`, no `modelCli`, and both permission flag arrays.
- `uses the command setting and an empty one falls back to the absolute Qoder wrapper`: assert custom command and `/home/danielcor/.qoder/entry/qoder`.
- `replaces and disposes the registration without leaking resources`: assert reload leaves one current registration and disposal removes it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd plugin-qoder && npm ci && npx vitest run test/server.test.ts`
Expected: FAIL because `server.ts` and `src/declaration.ts` do not exist.

- [ ] **Step 3: Implement the package, declaration, registration, and icon**

Use `plugin-muse` only as the structural template. `qoderLaunchSpec` returns `{ displayName: "Qoder", command: command.trim() || DEFAULT_QODER_COMMAND, args: ["--acp"], env: {}, nativeReasoning: { configId: "reasoning_effort", supportedLevels: ["low", "medium", "high"], defaultLevel: "high" }, permissionCli: { workspaceWrite: ["--permission-mode", "default"], full: ["--permission-mode", "bypass_permissions"] } }`.
`qoderProviderDeclaration` sets generic ACP options, host-scoped dynamic models with the single Qwen fallback, and only the documented capabilities. `qoderProviderPlugin` defines the command setting, replaces registration on change, and disposes it on plugin disposal. Use a monochrome SVG icon and no frontend manifest entry.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd plugin-qoder && npx vitest run test/server.test.ts`
Expected: all registration tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin-qoder docs/superpowers
 git commit -m "feat(qoder): declare ACP provider and registration"
```

### Task 2: Generic bridge and permission/conformance tests

**Files:**
- Create: `plugin-qoder/src/host.ts`
- Create: `plugin-qoder/test/host.test.ts`
- Create: `plugin-qoder/test/fake-qoder-acp.mjs`
- Create: `plugin-qoder/test/provider-bridge.conformance.test.ts`

**Interfaces:**
- Consumes: Task 1's `qoderLaunchSpec` and `qoderProviderDeclaration`.
- Produces: named `experimental_providerBridge` re-exported from `@get-bb/plugin-sdk/provider-bridge/acp`, with no custom protocol wrapper.

- [ ] **Step 1: Write the failing bridge tests**

In `test/host.test.ts`, cover model discovery through ACP, no use of `modelCli`, and exact reasoning/permission mappings. In `test/provider-bridge.conformance.test.ts`, wire `experimental_runBridgeConformance` to the exported bridge for start, resume, tip fork, prompt deltas, queued steer, and stop. In `fake-qoder-acp.mjs`, implement only the ACP methods needed by the tests, including `availableModels`, `reasoning_effort`, and `session/request_permission`. Add `accept-edits forwards mutation approval without auto-approval` and `full uses bypass permissions` tests.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd plugin-qoder && npx vitest run test/host.test.ts test/provider-bridge.conformance.test.ts`
Expected: FAIL because `src/host.ts` and the fake ACP double are missing or incomplete.

- [ ] **Step 3: Implement the bridge export and ACP double**

Re-export `experimental_acpProviderBridge` unchanged as `experimental_providerBridge`. Keep the fake double minimal and deterministic, returning Qwen 4 Max Preview and only supported reasoning values. Do not add a second session store or custom lifecycle code.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd plugin-qoder && npx vitest run test/host.test.ts test/provider-bridge.conformance.test.ts`
Expected: all bridge and permission tests PASS, including approval forwarding and clean stop.

- [ ] **Step 5: Commit**

```bash
git add plugin-qoder/src/host.ts plugin-qoder/test
 git commit -m "test(qoder): cover ACP lifecycle and permission mapping"
```

### Task 3: Documentation and repository gates

**Files:**
- Create: `plugin-qoder/skills/qoder/SKILL.md`
- Create: `plugin-qoder/README.md`
- Modify: `README.md` (add a short Qoder section)

**Interfaces:**
- Consumes: Tasks 1–2's provider declaration and verified permission/reasoning behavior.
- Produces: install/build/test commands and operator-facing Qoder permission semantics.

- [ ] **Step 1: Write operator documentation**

Document installation, model selection, the approval-gated meaning of `accept-edits`, unrestricted `full`, ACP reasoning, queued steering, tip-only forks, missing usage data, aipc-only scope, and the prohibition on launching Qoder directly from a shell. State that Qoder's own `acceptEdits` mode is not offered.

- [ ] **Step 2: Run all repository gates**

Run:
```bash
cd plugin-qoder
npm ci
npx tsc --noEmit
npx vitest run
cd ..
room-cli plugin types plugin-qoder
room-cli plugin build plugin-qoder
```
Expected: typecheck, all tests, SDK type sync, and backend/host builds PASS with Qoder metadata present. Run the SDK public-import scanner used by the repo's existing tests and expect no private dependency violations.

- [ ] **Step 3: Commit**

```bash
git add plugin-qoder README.md
 git commit -m "docs(qoder): add provider installation and permission guide"
```

### Task 4: Install, live Cloudroom verification, and Sol review

**Files:**
- Create: `plugin-qoder/test/live-qoder.smoke.test.ts`
- Modify only if verification exposes a defect: the relevant Task 1–3 files.

**Interfaces:**
- Consumes: the built `plugin-qoder` package and Cloudroom's provider/thread commands.
- Produces: a healthy installed provider and an evidence-backed final verdict; no shell-launched Qoder agent.

- [ ] **Step 1: Install and verify provider/model health**

Run: `room-cli plugin install path:/home/danielcor/src/cloudroom-plugins/plugin-qoder --yes`, `room-cli plugin list`, and `room-cli provider models qoder --machine aipc-ubuntu`.
Expected: plugin healthy and Qwen 4 Max Preview available. If the model or login is missing, stop and report Settings → Agents; do not substitute a provider. Remove reasoning declarations if ACP reports no supported levels and rerun Tasks 1–2.

- [ ] **Step 2: Verify a real Cloudroom thread and approval behavior**

Start a Qoder thread through `room-cli thread spawn` in `accept-edits` with a harmless read/report prompt. Confirm visible output, a second-turn resume, and clean stop. Ask for a mutation and verify Cloudroom receives an approval request; deny it and verify no file changed. Use a temporary session/workspace and remove every temporary artifact afterward.

- [ ] **Step 3: Run Sol 6.1 review and resolve findings**

Dispatch a read-only Codex `gpt-6.1-sol` high reviewer over `origin/main...HEAD` with the design, exact head, test receipts, and permission focus. Fix every finding including nits and re-review until zero findings, within four rounds. Rerun `npx tsc --noEmit`, `npx vitest run`, and `room-cli plugin build plugin-qoder` after each fix.

- [ ] **Step 4: Commit the verified implementation and report**

Commit any verification fixes with `feat(qoder): verify live provider workflow`, then report exact head, changed files, test counts, live thread evidence, Sol rounds/findings, install status, and anything not verified. Do not push, merge, alter other providers, or resume the separate Qwen proposal review until the user asks.
