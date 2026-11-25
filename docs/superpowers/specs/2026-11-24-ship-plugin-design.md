# Cloudroom Ship Plugin Design (`plugin-ship`)

Status: approved design; PR 1 implementing. Date: 2026-11-24.

## Intent and why

Anthropic's Claude Ship combines `/ship` + `/steward` (local CLI PR publish, review, and watched-PR fix loop), hosted Code Review, hosted PR Steward, and Claude Approvals (`.claude/approvals.yml`). While effective, the native implementation has structural limits:

1. **Ephemeral session watch:** `/ship` and `/steward` live inside a single interactive Claude Code process, die on session resume/close/Windows, and cannot run unattended in background/remote-control sessions.
2. **Vendor & billing lock-in:** Hosted Code Review, PR Steward, and Claude Approvals run only in Anthropic's cloud against extra-usage token billing (excluded for ZDR/HIPAA/CMEK orgs) and single-family Claude models.
3. **Regex/AST shell firewall:** Native Steward enforces safety by parsing Bash command lines with ~100 KB of regular expressions and AST rules tailored strictly to Claude Code.

`plugin-ship` (`bb-plugin-ship`, plugin id `ship`) brings full workflow parity to Cloudroom—plus persistent multi-repo watching, multi-model blind `triad` / `sol-loop` / `single` review on existing subscription plans via Dispatch, dual author/bot GitHub identity for genuine GitHub `APPROVE` reviews, and a provider-agnostic security fence enforced by typed native tools and host-side checks.

## Locked decisions (Daniel, 2026-11-24)

1. **v1 milestone:** Deliver **PRs 1–4** first (Scaffold, Host RPC, SQLite & Safety Core → GitHub Client & Deterministic Publisher → Multi-Model Review Engine → Persistent Fenced PR Steward & minimal UI). Follow with **PR 5** (Approvals Policy Engine) and **PR 6** (Full Ship Dashboard & optional GitHub Webhook).
2. **Default review engine:** **`triad`** (blind 3-family review matching `skills/triad-review/SKILL.md`), configurable globally, per repo, and per run (`triad` | `sol-loop` | `single`).
3. **GitHub identity split (separate bot account):**
   - **Author identity** (the user's existing `gh` / git login on the host machine) commits, pushes, opens PRs, and pushes Steward fixes so PRs remain authored by Daniel and respect personal git hooks on initial publish.
   - **Bot identity** (`botToken`, a `secret: true` setting stored in a `0600` file under `<dataDir>/plugins/ship/secrets/`, paired with `botLogin`) posts Code Review summaries/inline comments, Commit Statuses (`Cloudroom Ship / Approvals`), and real GitHub `APPROVE` / `REQUEST_CHANGES` reviews—avoiding GitHub's ban on self-approving your own PRs.
4. **Forge scope:** **GitHub only** for now (no GitLab, Bitbucket, Azure DevOps, or bare-git remote adapters).
5. **Repo home:** `plugin-ship/` inside `danielcor/cloudroom-plugins` alongside `plugin/`, `plugin-muse/`, `plugin-qoder/`, and `plugin-snippets/`.

## Verified Cloudroom v166 SDK & host facts

Verified live against `aipc-ubuntu` (`room-cli v166`, `@get-bb/plugin-sdk@0.6.189`, `dispatch@0.1.0` at `/opt/dev/danielcor/apps/ai-management/bb-plugin-dispatch`) and `git 2.56.1`:

- **Persistence & background execution:** `bb.storage.database()` + append-only `bb.storage.migrate()`, `bb.storage.kv`, and `bb.background.service()` are running in production plugins (`workflows`, `connect`, `shared-projects`, `dispatch`).
- **Host-daemon execution (`bb.host`):** `bb.hosts.experimental_client({ contract })` + `experimental_defineHostEntry` (`@get-bb/plugin-sdk/host`) executes git/gh operations on the enrolled machine holding the checkout (`aipc-ubuntu`, `mac`, `aliengaming-wsl-debian`), with `@get-bb/plugin-sdk/testing/host` (`experimental_createHostEntryHarness`) for in-process testing.
- **Settings & secrets:** `bb.settings.define` with `secret: true` stores credentials in `0600` files outside SQLite and never exposes them to frontend bundles or RPC.
- **Native agent tools & conditional config:** `bb.agents.registerTool` (Zod 4 / JSON Schema) + `bb.agents.configure` injects tools and instructions per thread based on `pluginMetadata`, with `bb.events.on("interaction.pending")` + `bb.sdk.interactions.respond` for deterministic approval/denial on worker turns.
- **Blocking composer forms:** `bb.ui.requestInput` paired with `pendingInteraction` slot handles pre-publish confirmation cards.
- **No plugin slash commands:** As established in `2026-11-12-prompt-snippets-plugin-design.md`, Cloudroom's `/` menu lists skills (`bb.skills: ["skills"]`), not plugin slash commands. `/ship`, `/steward`, and `/ship-approvals` ship as bundled skills backed by `room-cli ship ...` (`bb.cli.register`) and UI actions.
- **Dispatch integration:** `dispatch@0.1.0` exposes CLI (`room-cli dispatch preview|run|status|catalog`) with no `bb.rpc` contract today; `plugin-ship` resolves routes via `room-cli dispatch preview <profile> --json` when Dispatch is installed and spawns child threads via `bb.sdk.threads.spawn` with `pluginMetadata` so `plugin-ship` retains lifecycle/tool ownership.

## Architecture: Three-Process Split

```text
┌─────────────────────────── Cloudroom Server (server.ts) ───────────────────────────┐
│  • SQLite data.db (repos, watches, review_runs, approval_runs, audit_log)         │
│  • bb.background.service("ship-poller"): zero-token 120s poller + SHA-256 diff    │
│  • bb.agents.registerTool / configure: 8 fenced Steward tools on worker threads   │
│  • bb.events ("interaction.pending", "thread.idle/failed/archived"): gatekeeper   │
│  • bb.cli ("room-cli ship") + bb.rpc + Bot GitHub REST/GraphQL client             │
└───────────────────────────────┬───────────────────────────────┬────────────────────┘
                                │ bb.hosts.experimental_client  │ bb.rpc / bb.realtime
                                ▼                               ▼
┌─────────── Host Daemon Worker (host.ts) ───────────┐  ┌── Frontend (app.tsx, PR 2/4/6) ──┐
│ • Runs on aipc-ubuntu / mac / aliengaming-wsl      │  │ • Pre-publish confirmation card  │
│ • Executes deterministic git / gh CLI as author    │  │ • Sidebar Ship dashboard         │
│ • git merge-tree --write-tree simulation           │  │ • Thread header status bar       │
│ • Tamper-pinning & local .env/token secret scan    │  │ • Composer + menu action         │
└────────────────────────────────────────────────────┘  └──────────────────────────────────┘
```

### Why `host.ts` owns all local git/secret inspection

Raw secret values (`.env*`, `gh` `hosts.yml`, `~/.git-credentials`, `GH_TOKEN`) never cross RPC to the server or SQLite. `host.ts` collects them on the host machine and checks outbound commit messages / comments locally, returning only `{ ok: false, matchedSource: "API_KEY in .env" }`. Similarly, `git merge-tree --write-tree`, hardlink checks (`lstat().nlink > 1`), `.git/` symlink checks, and tamper-pinning run directly against the real checkout on the target machine.

## Data Model (`src/db.ts`, append-only `MIGRATIONS`)

| Table | Purpose | Key Columns |
|---|---|---|
| `repos` | Per-repo settings | `repo` (PK), `enabled`, `review_mode`, `review_effort`, `auto_steward`, `approvals_mode`, `allow_dev_automerge`, `trusted_bots_json`, `max_pushes_per_cause`, `max_review_rounds`, `updated_at` |
| `watches` | Persistent PR watch state | `id` (PK), `project_id`, `host_id`, `worktree_path`, `repo`, `pr_number`, `head_branch`, `head_remote`, `base_branch`, `base_remote`, `author_login`, `state`, `last_head_sha`, `last_state_hash`, `last_woke_at`, `started_at`, `expires_at`, `worker_thread_id`, `pins_json`, `bots_json`, `seen_comments_json`, `cause_push_counts_json`, `rerun_job_ids_json`, `behind_merges_count`, `stop_reason` |
| `review_runs` | Multi-model review ledger | `id`, `watch_id`, `repo`, `pr_number`, `head_sha`, `mode`, `round`, `seats_json`, `verdict`, `mean_score`, `created_at` |
| `review_findings` | Verified/rejected findings | `id`, `review_run_id`, `severity`, `file`, `line`, `claim`, `raisers_json`, `status`, `resolution_sha` |
| `approval_runs` | Policy evaluation history | `id`, `repo`, `pr_number`, `head_sha`, `policy_sha`, `mode`, `verdict_json`, `classifier_cache_json`, `status_posted`, `review_posted`, `created_at` |
| `audit_log` | Immutable security & action trail | `id`, `watch_id`, `ts`, `actor`, `action`, `outcome`, `detail_json` |

## Security Architecture (Provider-Agnostic Fence)

Because Cloudroom runs agents across Claude, Codex, Gemini, Kimi, and Muse, security cannot rely on Claude Code's private Bash-AST hooks. Instead, `plugin-ship` enforces five deterministic layers across server and host:

1. **Path & Filename Blocklist (`src/safety/never-edit.ts`):**
   - Exact port of Claude Code's `MSt()` with `\` → `/` normalization, Unicode case-folding, invisible/bidi/Unicode-tag stripping, trailing dot/space stripping, and NFC normalization.
   - Blocks CI workflows (`.github/`, `.gitlab-ci*`, `.circleci/`, `Jenkinsfile`, etc.), git/agent config (`.git/`, `.claude/`, `.husky/`, `.githooks/`, `.mcp.json`, `CODEOWNERS`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `REVIEW.md`, `SECURITY.md`), build wrappers (`gradlew`, `mvnw`, `.npmrc`, `bunfig.toml`), and `.env*` (except `.example`/`.sample`/`.template`).
   - Strict `isProtectedMergePath` subset (`.claude/settings*.json`, `.mcp.json`, `.claude/scheduled_tasks.json`, `.claude/loop.md`, `.claude/skills/code-review*`) that unconditionally blocks automated merges.
   - `isSecretFilename` normalizes backup/temp suffixes (`-bak`, `_old`, `.copy`, `.tmp.<hex>`) and detects key/credential files (`gcp-key.json`, `token.json`, `auth.json`, `*.pem`, `*.key`, etc.).
2. **Secret Scanning (`src/safety/secrets.ts`):**
   - Self-contained port of `plugin-snippets`'s strict line + YAML/JSON secret scanner (`yaml: 2.9.1`) covering token patterns (`AKIA`, `ghp_`, `github_pat_`, `sk-`, `xox*`, `AIza`, JWT, bearer, private keys), URL userinfo, HTTP Basic, `curl -u/-H`, and literal values on secret-named keys across code fences, indented blocks, and blockquotes.
   - Combined on `host.ts` with `collectLocalSecrets` (live `.env*`, `gh` `hosts.yml`, `GH_TOKEN`/`GITHUB_TOKEN`, `.git-credentials`, remote URL passwords) without ever returning raw values.
3. **Outbound Text & Prompt-Injection Guard (`src/safety/outbound-text.ts`):**
   - Comments require `<!-- cloudroom-ship -->` (or `reviewed=<40-hex>`), reject nested `<!--`, `@mentions`, `/commands`, bot triggers (`bors`, `atlantis`, `homu`, `retest this please`, `ok to test`), URLs/links/images/HTML attributes, `> 8000` chars, and secrets.
   - Commit messages block `@mentions`, leading `/`, bot words, `fixes #N` / `closes #N` closing keywords, and CI-skip directives (`[skip ci]`, `***NO_CI***`).
   - Generated PR titles/bodies from diffs enforce strict ASCII patterns, reject SHAs/URLs, and apply an 8-word n-gram overlap filter (`hasNgramOverlap`) to stop prompt injections embedded in diff comments.
4. **In-Memory Merge Simulation (`src/safety/merge-guard.ts`):**
   - Rejects `refs/replace`, `.git/info/grafts`, active `MERGE_HEAD`, and dangerous git config (`merge.*.driver`, `merge.renormalize`, `hook.*.command`, local `include.path`).
   - Verifies live `expectedTipSha` before simulating via `git merge-tree --write-tree HEAD <targetSha>` + `git diff-tree -r -z`.
   - `mode: "head"` blocks any `isNeverEditPath` change or `120000` symlink. `mode: "base"` blocks any `isProtectedMergePath` or git-included config file and reports non-protected `never-edit` touches so the watch notifies the user.
5. **Tamper-Pinning (`src/safety/pins.ts`):**
   - Snapshots SHA-256 of `git config --list --show-origin`, `.claude/settings*.json`, `.mcp.json`, `.claude/skills/{steward,babysit}/SKILL.md`, `gh` config/hosts, all non-`.sample` git hook files + file counts (cap 500), and `git`/`gh` binary stats. Any unexpected drift between start and pass immediately stops the watch (`mark_changed`).
6. **Scoped Native Tools & Worker Gatekeeper (PR 4):**
   - Steward workers spawn in `accept-edits` with `pluginMetadata: { shipRole: "steward-worker", watchId }` and receive only the 8 fenced tools via `bb.agents.configure`.
   - `bb.events.on("interaction.pending")` auto-denies direct `gh`/`git`/`glab`/`curl`, credential paths, and `never-edit` edits on Steward and reviewer threads.

## Phased Roadmap

| PR | Scope | Key Deliverable |
|---|---|---|
| **PR 1** | Scaffold, Host RPC Bridge, SQLite Schema & Safety Core | `plugin-ship` builds cleanly; unit + real temp-repo + host/server harness tests pass |
| **PR 2** | GitHub Client (Dual Author/Bot) & Deterministic Publisher | `room-cli ship publish`, `/ship` preflight, 3.5s dwell `requestInput` confirmation card, trust-filtered PR comments |
| **PR 3** | Multi-Model Review Engine (`triad` default, `sol-loop`, `single`) | Deduplication against hosted/prior markers, Dispatch integration, read-only worktrees, bot review comments |
| **PR 4** | Persistent Steward Daemon, Fenced Tools & Minimal UI *(v1 complete)* | 120s zero-token `ship-poller`, 8 native Steward tools, `interaction.pending` gatekeeper, `ShipPage` watches table, `/steward` skill, live `aipc-ubuntu` smoke test |
| **PR 5** | Approvals Policy Engine (`.claude/approvals.yml`) | Default-branch policy + `.claude/classifiers/*` evaluator, observe/enforce commit status + bot `APPROVE` reviews, opt-in `dev`-only auto-merge |
| **PR 6** | Full Ship Dashboard, Thread Header Bar & Optional Webhook | Live realtime PR dashboard, per-watch audit explorer, per-repo settings UI, composer `+` menu, HMAC-verified GitHub webhook |

## Bot Account Setup (Needed Starting PR 2 / PR 5)

1. Create a dedicated GitHub bot user (e.g., `danielcor-ship-bot`) and add it as a collaborator with write/triage access (write/read+status as needed for reviews/statuses) on target repositories.
2. Mint a fine-grained PAT scoped to those repositories with **Pull requests: Read & write**, **Commit statuses: Read & write**, **Checks: Read**, and **Contents: Read**.
3. Configure in Cloudroom:
   - `room-cli plugin config ship set botLogin <bot-username>`
   - `room-cli plugin config ship set botToken <pat>` (stored in `<dataDir>/plugins/ship/secrets/`, `0600`, never synced to browser or DB).
