# Cloudroom Ship Plugin Implementation Plan (`plugin-ship`)

> **For agentic workers:** Execute each PR in order, keeping every PR under ~400 added non-test lines per subsystem where practical and ensuring `npx tsc --noEmit`, `npx vitest run`, and `room-cli plugin build .` pass before opening/merging each PR.

**Goal:** Build `plugin-ship/` (`bb-plugin-ship`, id `ship`) in `danielcor/cloudroom-plugins` to deliver full parity with Claude Ship (`/ship`, `/steward`, Code Review, PR Steward, Claude Approvals) on Cloudroom v166+ with GitHub-only support, `triad` default review mode (configurable to `sol-loop` or `single`), and dual Author/Bot GitHub identity.

**Spec:** [`docs/superpowers/specs/2026-11-24-ship-plugin-design.md`](../specs/2026-11-24-ship-plugin-design.md)

## Global Constraints

- Plugin id is `ship`; package folder is `plugin-ship/`; package name is `bb-plugin-ship`.
- Forge support is **GitHub only** (`gh` CLI for author mutations + GitHub REST/GraphQL for bot reviews/statuses).
- Never import source across sibling plugin directories (e.g., never import from `../plugin-snippets/`): `room-cli plugin build .` bundles each plugin independently.
- Author credentials (`gh` / git on `bb.host`) perform commits, pushes, PR creation, and Steward branch fixes; `botToken` (`secret: true` setting) posts review comments, Commit Statuses, and real GitHub `APPROVE`/`REQUEST_CHANGES` reviews. Raw secret values never leave `host.ts` or `0600` secret storage.
- Never force-push, rebase pushed history, amend, reset, push tags, edit `never-edit` paths, or auto-merge on non-dev branches.

---

### PR 1: Package Scaffold, Host RPC Bridge, SQLite Schema & Safety Core

**Files:**
- Create: `plugin-ship/package.json`
- Create: `plugin-ship/tsconfig.json`
- Create: `plugin-ship/vitest.config.ts`
- Create: `plugin-ship/icons/ship.svg`
- Create: `plugin-ship/src/contract.ts`
- Create: `plugin-ship/src/db.ts`
- Create: `plugin-ship/src/safety/never-edit.ts`
- Create: `plugin-ship/src/safety/secrets.ts`
- Create: `plugin-ship/src/safety/outbound-text.ts`
- Create: `plugin-ship/src/safety/merge-guard.ts`
- Create: `plugin-ship/src/safety/pins.ts`
- Create: `plugin-ship/host.ts`
- Create: `plugin-ship/server.ts`
- Create: `plugin-ship/test/{never-edit,secrets,outbound-text,merge-guard,pins,host,server}.test.ts`

**Manifest Note:** Keep `"app"` and `"skills"` omitted from `plugin-ship/package.json` in PR 1 so the package compiles and builds cleanly before PR 2 adds `app.tsx` and `skills/`.

- [ ] **Step 1: Scaffold package & install dependencies**
  Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `icons/ship.svg`. Pin `@get-bb/plugin-sdk` at `0.6.189`, `yaml` at `2.9.1`, `zod` at `^4.3.6`, and run `npm install`.

- [ ] **Step 2: Implement & test `src/safety/never-edit.ts`, `src/safety/secrets.ts`, `src/safety/outbound-text.ts`**
  Port `isNeverEditPath`, `isProtectedMergePath`, `isSecretFilename`, strict line + YAML/JSON secret scanning, `collectLocalSecrets`/`findLocalSecretMatch`, `validateCommentText`, `validateCommitMessage`, and `validateGeneratedPrText` (including 8-word n-gram diff-parroting filter). Cover evasion attempts (Unicode confusables, invisible characters, trailing dots, backup suffixes, `.tmp.*`) in unit tests.

- [ ] **Step 3: Implement & test `src/safety/merge-guard.ts` and `src/safety/pins.ts`**
  Run `git merge-tree --write-tree` + `git diff-tree -r -z` in real `/tmp` git repositories to verify `mode: "base"` and `mode: "head"` protection, `expectedTipSha` mismatch rejection, `merge.*.driver` rejection, and tamper-pinning drift detection across git config, hooks, `.claude/settings*.json`, and `.mcp.json`.

- [ ] **Step 4: Implement `src/contract.ts`, `src/db.ts`, `host.ts`, and `server.ts`**
  Wire `hostContract` (`inspectCheckout`, `computePins`, `verifyPins`, `checkMergeSafe`, `scanOutboundForLocalSecrets`), `rpcContract` (`status`, `listRepos`, `upsertRepo`, `listWatches`, `listAudit`), append-only SQLite migrations, `bb.settings.define`, and initial `room-cli ship status|repos|safety-check` CLI subcommands.

- [ ] **Step 5: Verify host & server harnesses and run repository gates**
  Test `host.ts` with `experimental_createHostEntryHarness` (`@get-bb/plugin-sdk/testing/host`) and `server.ts` with `createFakePluginHost` (`@get-bb/plugin-sdk/testing`), confirming `botToken` and raw `.env` secrets never leak across RPC or CLI output. Run `npx tsc --noEmit && npx vitest run`.

---

### PR 2: GitHub Client (Dual Author/Bot Identity) & Deterministic `/ship` Publisher

**Files:**
- Create: `plugin-ship/src/github/{client,comments,bot}.ts`
- Create: `plugin-ship/src/publish/{preflight,pr-texts,publisher}.ts`
- Create: `plugin-ship/app.tsx` (minimal `pendingInteraction` confirmation card)
- Create: `plugin-ship/skills/ship/SKILL.md`
- Modify: `plugin-ship/package.json` (add `"app": "./app.tsx"`, `"skills": ["skills"]`), `src/contract.ts`, `host.ts`, `server.ts`
- Create: `plugin-ship/test/{github-comments,publisher}.test.ts`

**Tasks:**
- [ ] **Step 1:** Implement `host.ts` `gh` author execution (`publishChanges`: branch create if needed, stage named files, commit with repo git hooks ON, `git push --porcelain --no-follow-tags --recurse-submodules=check`, `gh pr create`, head SHA confirmation).
- [ ] **Step 2:** Implement `src/publish/preflight.ts` (detached HEAD, default branch, fork, active merge/rebase, hardlink `nlink > 1`, secret filename, never-edit, `.git/` symlinks, public-repo auto-commit refusal, and `claude-pr-steward-*`/`claude-ship-*` label collision guard).
- [ ] **Step 3:** Implement `src/publish/pr-texts.ts` (conversation synthesis + diff fallback validated via `validateGeneratedPrText`) and `bb.ui.requestInput` confirmation card with 3.5-second Allow dwell check.
- [ ] **Step 4:** Implement `src/github/comments.ts` (GraphQL PR/thread/review reader, collaborator `write`/`admin` permission filter, blockquote stripping, `mayHide` HTML-comment tagging, 4 KB/40 KB/100-item/30-commenter caps) and `src/github/bot.ts` (`botToken` REST client).
- [ ] **Step 5:** Add `room-cli ship publish` + `skills/ship/SKILL.md` and run full fake-git/fake-gh + UI slot tests.

---

### PR 3: Multi-Model Code Review Engine (`triad` default, `sol-loop`, `single`)

**Files:**
- Create: `plugin-ship/src/review/{types,dedup,dispatch,triad,sol-loop,single,runner}.ts`
- Modify: `plugin-ship/src/db.ts`, `src/contract.ts`, `server.ts`, `skills/ship/SKILL.md`
- Create: `plugin-ship/test/{review-dedup,review-runner}.test.ts`

**Tasks:**
- [ ] **Step 1:** Implement `dedup.ts` (check hosted `Claude Code Review` check-run status and prior `<!-- cloudroom-ship reviewed=<40-hex> -->` comments; incremental `SHA..HEAD` scoping when safe).
- [ ] **Step 2:** Implement `dispatch.ts` (query `room-cli dispatch preview <profile> --json` when Dispatch is active; fall back to ordered family list respecting market-hours local/cloud preference and cooldowns).
- [ ] **Step 3:** Implement `triad.ts` (default), `sol-loop.ts`, and `single.ts` runners spawning read-only child threads via `bb.sdk.threads.spawn` pinned to `--baseBranch <HEAD_SHA>` with worktree hook/symlink safety checks and read-only `interaction.pending` gatekeeping.
- [ ] **Step 4:** Implement `runner.ts` persistence (`review_runs`, `review_findings`) and bot review posting (summary comment + sanitized inline findings without leaking uncommitted files).
- [ ] **Step 5:** Add `room-cli ship review` and unit tests covering all three modes, invalid-reply retries, stop-and-split triggers, and child cleanup.

---

### PR 4: Persistent PR Steward Daemon, Fenced Tools & Minimal UI *(v1 Complete)*

**Files:**
- Create: `plugin-ship/src/steward/{poller,state-machine,tools,gatekeeper,prompts}.ts`
- Create: `plugin-ship/src/ui/ShipPage.tsx` (minimal active watches table + Stop/Pause/Resume)
- Create: `plugin-ship/skills/steward/SKILL.md`
- Modify: `plugin-ship/app.tsx`, `server.ts`, `host.ts`, `src/contract.ts`, `src/db.ts`
- Create: `plugin-ship/test/{poller,steward-tools,gatekeeper,lifecycle}.test.ts`

**Tasks:**
- [ ] **Step 1:** Implement `poller.ts` (`bb.background.service("ship-poller")`) ticking every 120s with zero LLM tokens: tamper pins → collision labels → PR/checks/trust-filtered comments → SHA-256 fingerprint diff → wake on change with 10m cooldown, 7d TTL, 3 pushes/cause, 1 rerun/job, 2 `BEHIND` merges.
- [ ] **Step 2:** Register the 8 native fenced tools via `bb.agents.registerTool` + `bb.agents.configure` scoped to `pluginMetadata.shipRole === "steward-worker"`, backed by `host.ts` (`-c core.hooksPath=/dev/null`, `merge-guard`, `never-edit`, live secret checks).
- [ ] **Step 3:** Implement `gatekeeper.ts` on `bb.events.on("interaction.pending")` for worker/reviewer threads, plus repo `.claude/skills/steward/SKILL.md` (and `babysit` fallback) loader.
- [ ] **Step 4:** Add `room-cli ship start|steward|status|stop|pause|resume|terms`, opt-in repo-wide auto-watch discovery, push notifications on `Ready`/`Needs Human`, and minimal `ShipPage`.
- [ ] **Step 5:** Run end-to-end fake lifecycle tests, `room-cli plugin build .`, and live `aipc-ubuntu` install/smoke test against a private test PR.

---

### PR 5: Claude Approvals Engine (`.claude/approvals.yml` + Bot Reviews)

**Files:**
- Create: `plugin-ship/src/approvals/{parser,facts,classifiers,evaluator,reporter}.ts`
- Create: `plugin-ship/skills/ship-approvals/SKILL.md`
- Modify: `plugin-ship/server.ts`, `host.ts`, `src/db.ts`, `src/contract.ts`
- Create: `plugin-ship/test/approvals.test.ts`

**Tasks:**
- [ ] **Step 1:** Parse `.claude/approvals.yml` (`version: 1`) and `.claude/classifiers/<name>/def.yml` strictly from the **default branch** (`git show origin/<default>:...`), never the PR branch.
- [ ] **Step 2:** Evaluate free deterministic facts first, spawn classifier threads only when needed (caching by `(head_sha, classifier_sha)`), and combine strictest matching verdicts.
- [ ] **Step 3:** Post Commit Statuses (`observe` non-blocking vs `enforce` blocking) and bot GitHub `APPROVE` / `COMMENT` / `REQUEST_CHANGES` reviews via `botToken`.
- [ ] **Step 4:** Add opt-in per-repo `dev`-only auto-merge guard (hard-blocked on `main`/`master`/`beta`/`prod`/release branches; requires clean review + green CI + `seats: 0` + matching `headSha`).
- [ ] **Step 5:** Add `room-cli ship approvals check <pr>` and comprehensive policy evaluator tests.

---

### PR 6: Full Ship Dashboard, Thread Header Bar & Optional GitHub Webhook

**Files:**
- Create: `plugin-ship/src/ui/{WatchDetail,RepoSettings,ThreadBar}.tsx`, `plugin-ship/app.css`
- Modify: `plugin-ship/app.tsx`, `src/ui/ShipPage.tsx`, `server.ts`
- Create: `plugin-ship/test/{ui,webhook}.test.ts`

**Tasks:**
- [ ] **Step 1:** Add `WatchDetail` (expandable `audit_log`, review findings, approval verdicts), `RepoSettings` (per-repo review mode, effort, caps, auto-steward, approvals mode), `ThreadBar` (`experimental_threadHeaderRow`), composer `+` menu ("Ship this branch…"), and `experimental_threadAction`.
- [ ] **Step 2:** Add optional HMAC-SHA256-verified `bb.http.route("POST", "webhook/github", ..., { auth: "none" })` for instant poll wakeups when a tunnel URL is configured.
- [ ] **Step 3:** Render UI mockups/screenshots, run `@get-bb/plugin-sdk/testing/app` slot tests, and verify full suite + live plugin reload on `aipc-ubuntu`.
