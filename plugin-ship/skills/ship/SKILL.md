---
name: ship
description: Publish the current branch cleanly and open (or update) a GitHub PR with safety preflight, secret scanning, and user confirmation. Use when asked to "/ship", "ship this", or "open a PR".
---

# Cloudroom Ship (`/ship`)

Publish local work safely using `room-cli ship publish`. Never bypass blockers or run raw `git push` / `gh pr create` when Ship stops you.

## Workflow

1. **Preflight dry-run first:**
   Run:
   ```bash
   room-cli ship publish --dry-run --json
   ```
   Review blockers and warnings:
   - If `status === "blocked"`, explain every blocker clearly (detached HEAD, fork repo, steward label collision, secret filename, protected `never-edit` path, secret content in diff, hardlinked file, dirty submodule, or `.git` symlink issue) and stop without pushing.
   - Notice which branch will be used (`createBranch: true` auto-creates a feature branch if currently on the default branch).

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

4. **Report the outcome concisely:**
   - Report the PR URL, PR number, target branch, and confirmed head commit SHA.
   - Never print tokens or `.env` contents.
