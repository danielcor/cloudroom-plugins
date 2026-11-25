---
name: ship
description: Publish the current branch cleanly and open (or update) a GitHub PR with safety preflight, secret scanning, and user confirmation. Use when asked to "/ship", "ship this", or "open a PR".
---

# Cloudroom Ship (`/ship`)

Publish local work safely using `room-cli ship publish`. Never bypass blockers or run raw `git push` / `gh pr create` when Ship stops you.

## Workflow

1. **Preflight dry-run & container gate check first:**
   Run:
   ```bash
   room-cli ship publish --dry-run --json
   room-cli ship gate inspect --json
   ```
   Review blockers, container gates, and warnings:
   - If `status === "blocked"`, explain every blocker clearly (detached HEAD, fork repo, steward label collision, secret filename, protected `never-edit` path, secret content in diff, hardlinked file, dirty submodule, or `.git` symlink issue) and stop without pushing.
   - Notice which branch will be used (`createBranch: true` auto-creates a feature branch if currently on the default branch).
   - **Container Merge-Guard Gate:** If `hasBootstrapCloudroom === true` and `supportedForBase === true`:
     - Notice repo constraints (e.g. `pmzbot` sandbox bootstrap supports base branch `dev` only, NEVER `beta`/`master`; `/var/tmp` is `noexec` so `PMZBOT_UNIT_TMP_ROOT=/tmp`; `/dev/shm` is 256 MiB; 8 GiB RAM cgroup).
     - Inside a Cloudroom Cloud sandbox (`inCloudSandbox === true`), run the container merge-guard gate and post or capture its canonical `Gate receipt`:
       ```bash
       room-cli ship gate run --mode smoke --json
       ```
     - On a non-container host (`inCloudSandbox === false`), never run `bootstrap-cloudroom.sh` locally — push the branch first or delegate to an ephemeral Cloudroom Cloud sandbox child thread with `room-cli ship gate run --cloud --json`.
     - If an open PR is behind its base branch and `hasMergeEligibilityScript === true`, run `room-cli ship gate eligibility <pr> --json` before merging base.

2. **Prepare clean commit & PR text:**
   - Synthesize a clear commit message, PR title, and concise PR description from the task context.
   - Avoid raw diff snippets (8+ copied words are rejected), URLs or commit SHAs in auto-generated titles/bullets, closing keywords (`fixes #...`) inside Steward commits, and any secret/token strings.

3. **Run publish with confirmation:**
   - Inside a Cloudroom thread, omit `--confirm` so the user gets the interactive 3.5-second confirmation card (`PublishConfirmCard`) where they can inspect staged files, repo visibility, and edit the commit message/PR title/body before approving:
     ```bash
     room-cli ship publish --title "<title>" --body "<body>" --json
     ```
     Pass `--commit-message "<msg>"` when uncommitted changes will be staged, `--base <branch>` to target a non-default base branch, or `--draft` to open a draft PR.
   - Only pass `--confirm` or `--allow-public-commit` when running headless outside a thread with explicit user approval.

4. **Run multi-model code review (`room-cli ship review`):**
   Before or right after opening a PR, run Cloudroom Ship's read-only multi-model review on the committed branch head (`triad` default, or `--mode sol-loop` / `--mode single`):
   ```bash
   room-cli ship review --dry-run --json
   room-cli ship review --repo owner/repo --pr <number> --post --json
   ```
   - `review` deduplicates against existing hosted Claude Code Review checks and prior `<!-- cloudroom-ship reviewed=<sha> -->` markers, using incremental `priorSha..HEAD` diffs when safe.
   - Use `--post` to publish the bot review summary and committed-file inline findings via the configured `botToken`.

5. **Report the outcome concisely:**
   - Report the PR URL, PR number, target branch, confirmed head commit SHA, and review verdict / finding count.
   - Never print tokens or `.env` contents.
