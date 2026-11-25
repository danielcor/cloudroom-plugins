---
name: ship-approvals
description: Evaluate default-branch `.claude/approvals.yml` rules and `.claude/classifiers/<name>/def.yml` checks on GitHub pull requests, post bot statuses/reviews (`observe` vs `enforce`), and guard opt-in `dev`-only auto-merge.
---

# Cloudroom Ship Approvals (`/ship-approvals`)

Use `room-cli ship approvals check <pr>` to evaluate repository approval policies safely.

## Security & Trust Model
1. **Default-branch policy source:** `.claude/approvals.yml` (`version: 1`) and `.claude/classifiers/<name>/def.yml` are always fetched and read from `origin/<defaultBranch>` (`FETCH_HEAD`), **never** from the PR branch or working tree. Symlinks are rejected.
2. **Free facts first:** Deterministic predicates (`all_paths_match`, `any_path_matches`, `no_path_matches`, `max_changed_files`, `max_changed_lines`, `base_branches`, `authors`, `author_associations`, `labels_include`, `labels_exclude`, `is_draft`, `ci_green`, `gate_receipt_pass`, `no_never_edit_paths`) run before any LLM classifier. If any deterministic predicate fails, zero classifier threads are spawned.
   - **Container Gate Receipts:** When GitHub-hosted check runs are billing-blocked or absent (zero failing/pending checks), an exact-SHA trusted `Gate receipt` (`result: PASS`, `failed=0`) in the PR body or an author/collaborator comment satisfies `ci_green` and `gate_receipt_pass` without ever overriding a real failing check.
3. **Cached, read-only classifiers:** Matching classifier rules spawn isolated `diff-only` threads (tool-free) and cache results in SQLite by `(head_sha, classifier_sha)`. Malformed/failed replies fail closed (`fail_closed: true`).
4. **Strictest combination:** Among matched rules, `request_changes` > `comment` > `approve`, and `requiredSeats` takes the maximum required seat count.
5. **Dual-identity GitHub reporting:** Commit Statuses (`status_context`, default `Cloudroom Ship / Approvals`) and GitHub reviews (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`) are posted solely by the configured `botToken` after secret scanning.
   - `observe` mode posts non-blocking `success` Commit Statuses + `COMMENT` reviews.
   - `enforce` mode posts blocking `success` / `pending` / `failure` Commit Statuses and real `APPROVE` / `REQUEST_CHANGES` / `COMMENT` reviews.
6. **`dev`-only auto-merge guard:** `--automerge` is hard-blocked on `main`, `master`, `beta`, `prod`, `release/*`, drafts, stale reviews, failing CI, collision labels, protected/secret paths, `seats > 0`, or repos without `allowDevAutomerge: true`.

## Commands
- Evaluate dry-run:
  ```bash
  room-cli ship approvals check <pr> --dry-run --json
  ```
- Evaluate and post Commit Status + bot review using the configured repo mode (`observe` or `enforce`):
  ```bash
  room-cli ship approvals check <pr> --post --json
  ```
- Enable `enforce` + `dev`-only auto-merge for a repo:
  ```bash
  room-cli ship repos set owner/repo --approvals enforce --dev-automerge --json
  ```
