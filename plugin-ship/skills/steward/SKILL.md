---
name: steward
description: Start, pause, resume, inspect, or stop persistent PR Steward watches for GitHub pull requests using Cloudroom Ship (`room-cli ship steward|watches|pause|resume|stop`).
---

# Cloudroom PR Steward (`/steward`)

PR Steward runs a persistent, zero-token server poller (`ship-poller`) every 120 seconds on watched pull requests and spawns fenced worker threads only when PR state changes cleanly require action.

## Commands

1. **Accept Steward Terms (one-time per server):**
   ```bash
   room-cli ship terms --accept
   ```
   Or pass `--accept-terms` directly when starting a watch.

2. **Start Watching a Pull Request:**
   ```bash
   room-cli ship steward --json
   ```
   Or target a specific PR explicitly:
   ```bash
   room-cli ship steward --repo owner/repo --pr 123 --base main --json
   ```
   - Snapshots checkout tamper pins (git config, hooks, `.claude/settings*.json`, `.mcp.json`, `gh` config).
   - Refuses PRs carrying `claude-pr-steward-*` / `claude-ship-*` collision labels.
   - Polls CI check runs, merge status, and write-collaborator / allowlisted-bot comments without burning LLM tokens while idle.

3. **Monitor & Control Active Watches:**
   ```bash
   room-cli ship watches
   room-cli ship pause <watchId>
   room-cli ship resume <watchId>
   room-cli ship stop <watchId>
   ```

## Security & Budget Boundaries

- Steward workers run with `-c core.hooksPath=/dev/null`, tamper-pin verification before every mutation, `merge-guard` simulation before merging base branches, and a strict 8-tool native fence (`ship_steward_*`).
- Default budgets: 10-minute wake cooldown, 7-day watch TTL, 3 pushes per cause, 1 CI job rerun per job ID, and at most 2 automated `BEHIND` base merges before escalating to `needs_human`.
