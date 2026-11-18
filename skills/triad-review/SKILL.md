---
name: triad-review
description: Use when the user asks for a "triad review", a "3-model review" or "review with three models". Runs one blind, read-only review round on 3 model families picked from Claude, GPT, Gemini, Kimi and Muse by review quality, quota, recent load and token cost, as visible Cloudroom child threads, then verifies and merges the findings. Not review-council ("council") and not sol-loop.
---

# triad-review

You are the **author**. Three reviewers from three model families review the same head, blind. You pick
them, launch them, check what they find and report. One run is one review round. Fixing and re-reviewing
is the caller's loop (sol-loop, review-council or the user).

## Rules

- Exactly 3 seats from 3 different families. Never 2 seats from one family.
- Use your own family (the family of the model running you) only to fill a seat no other family can.
- Every seat and probe is a Cloudroom child thread (`room-cli thread spawn --parent-self`). Never start an
  agent CLI (`claude`, `codex`, `agy`, `muse`, `kimi`) from a shell. Never use built-in Agent/Task subagents.
- Every seat gets the same brief file and the same head SHA. No seat sees another seat's reply.
- A family that is down is skipped. Never swap in another model of the same family to fill its seat.
- Fewer than 3 families up: run with what is up and say so in the report. None up: stop and say why.
- Use the logins already on each machine (their subscription plans). Never add or set an API key for a seat.
- The head must be a commit. If the change is not committed, stop and ask; do not commit on your own.

## 1. Start the run

1. `RUN=$(mktemp -d "${TMPDIR:-/tmp}/triad.XXXXXX")` (private, unique). `RID=<head7>-$(date +%s)`.
2. Before every spawn (probe, seat or retry) append `<request id> pending pending` to `$RUN/ids`; right after,
   replace `pending pending` with the thread id and its `.environment.id` (`room-cli thread show <id> --json`).
   Request id: `triad-$RID-<family>-<attempt>`. Reuse one only to recover that same unanswered spawn.
3. Secrets: scan the diff for keys, tokens or `.env` content. If the repo root has `.worktreeinclude` or
   `.bb-env-setup.sh`, read them: a seat worktree gets those copied or created files. If either would give a
   seat a credential, stop and ask the user.

## 2. Size the risk

- **High**: trade path (order, close, stop, copy-trading), auth, secrets, DB guards, migrations, data loss.
- **Low**: under ~100 changed lines of docs, tests or config, and nothing High.
- **Normal**: everything else.

## 3. The families (default order, best reviewer first)

Each cell is `--model` / `--reasoning-level`.

| # | Family | `--provider` | High | Normal | Low |
| - | --- | --- | --- | --- | --- |
| 1 | GPT | `codex` | `gpt-6.1-sol` / `high` | `gpt-6.1-sol` / `medium` | `gpt-6.1-sol` / `low` |
| 2 | Claude | `claude-code` | `claude-opus-5-5` / `high` | `claude-opus-5-5` / `medium` | `claude-sonnet-5-5` / `medium` |
| 3 | Gemini | `agy` | `gemini-4-carbon-high` / `high` | `gemini-4-carbon-medium` / `medium` | `gemini-4-carbon-low` / `low` |
| 4 | Kimi | `acp-kimi` | `kimi-code/k3.1-pro` / `high` | `kimi-code/k3.1-pro` / `high` | `kimi-code/k3.1-pro` / `low` |
| 5 | Muse | `acp-muse` | `muse-wonder-full-1.0` / `high` | `muse-wonder-1.0` / `high` | `muse-wonder-1.0` / `medium` |

Why this order: GPT is the most thorough on intended-case bugs and missing tests. Claude finds odd,
dangerous edge cases. Gemini is a strong second opinion but raises more false findings. Kimi is cheap and
fast with fewer deep catches. Muse Wonder Full's own prompt is about 28k input tokens per call (README).

- Gemini: Carbon first. If Carbon is down on every machine, use Argon with the same suffix
  (`gemini-4-argon-high` etc.). The agy model suffix and `--reasoning-level` must match.
- Muse High: Wonder Full only with access proof (step 4); else `muse-wonder-1.0` / `high`.
- Re-rank families 2 to 5 by cost: over each family's last 20 seat rows with `tokens` set, sum
  `input - cached + output` and divide by the sum of `verified`. Lower ranks higher. A family with fewer than
  10 such rows, or a zero sum of `verified`, keeps its default place. GPT stays first on High risk.

## 4. Check who is up

Check each candidate on a named machine: the author's first (`--machine <name>`, see `room-cli machine list`).
If `room-cli` fails for every provider (for example HTTP 401), the run is blocked: stop and report it.
A check that fails for one provider means that provider is down on that machine.

1. Cooldown: a family whose last ledger row on that machine is `"ok":false` with a limit, 429 or quota error
   under 6 hours old is down there. Apply this before any probe.
2. `room-cli settings usage --json --machine <name>`: real quota, but only for `codex` and `claude-code`.
   Any `windows[].usedPercent` of 90 or more, or a `status` other than `ok`, means down.
3. `room-cli provider models <provider> --json --machine <name>` must list the model, except Carbon (4.4).
   Muse prints "No models available" when it is logged out on that machine.
4. A listed model is not proof for `agy` or `acp-muse`. Carbon sits under "More Models" in agy's picker, and
   Cloudroom's agy list can show only the three built-in Argon ids where Carbon works (`agy models` has no
   flag for more). Muse lists Wonder Full on accounts that cannot call it. Proof is a ledger row for that
   model and machine with `"ok":true` in the last 7 days. With none, spend one probe child (the only model
   call before the review): prompt `Probe only. Do not run any tools. Reply with exactly: PROBE-OK`.
   It passes if the reply is `PROBE-OK` and the turn did not fail. Cloudroom logs only the requested model,
   so this proves the id was accepted and ran, not which weights answered. Log the probe (step 8).
5. Gemini, Kimi and Muse have no quota signal in `room-cli`; 4.1 and 4.4 are their only checks.

## 5. Pick the seats

1. Drop each family that step 4 marked down on every machine. Set your own family aside.
2. Rotation: a family that sat in each of the last 3 runs moves below the next family that did not.
   Exception: GPT on High risk.
3. Take the first 3. If fewer than 3, fill from your own family. Machine: the author's first; another
   machine only when the family is down here.

## 6. Brief and launch

Write the brief to `$RUN/brief.md`. Keep it small and byte-identical for every seat, so caching can help:

```
Review only. Do not edit, write, commit, push, comment on PRs, or start subagents or threads.
Do not open .env or credential files.
Repo: <abs path>  Base: <sha>  Head: <sha>  Intent: <1-2 sentences>  Out of scope: <scope>
Checks: <test / typecheck / lint results>
Diff (git diff <base>..<head>):
<the diff; no whole files>
You may read surrounding code in your checkout if git rev-parse HEAD equals Head.
If it does not, or you cannot run git, review the diff alone and add the line CONTEXT: diff-only.
Find bugs, broken callers, mismatch with intent, missing tests, security, data loss, concurrency.
Skip style unless it hides a bug.
BLOCKER = intended case wrong, or a security or data-loss bug. MAJOR = a real bug callers will hit.
MINOR = a narrow real defect, or doc wording people act on that could misdirect. NIT = cosmetic.
Reply in at most 40 lines, this format only:
HEAD: <Head from this brief>
CONTEXT: checkout or diff-only
VERDICT: APPROVE (zero findings) or CHANGES
F1 [BLOCKER|MAJOR|MINOR|NIT] <file>:<line> <claim>. Evidence: <quote or reason>. Fix: <one line>
```

One spawn per seat (record it in `$RUN/ids` as in step 1):

```sh
room-cli thread spawn --parent-self --project "$ROOM_PROJECT_ID" --json --request-id "triad-$RID-<family>-1" \
  --provider <p> --model <m> --reasoning-level <l> --permission-mode accept-edits \
  --new-environment worktree [--base-branch <head branch>] [--machine <name>] \
  --title "triad <family> <head7>" --prompt-file "$RUN/brief.md"
```

- Same machine: pass `--base-branch <head branch>`. Without it the worktree comes from the project default
  branch. Another machine has no copy of an unpushed branch: omit `--base-branch` there (the seat answers
  `CONTEXT: diff-only`), unless the user allowed a push.
- Cloudroom has no read-only permission mode (`accept-edits`, `auto`, `full`). Use `accept-edits`; each seat
  edits only its own throwaway worktree. agy then denies shell commands, so it reviews the inline diff.
- Wait on each seat by id: `room-cli thread wait <id> --event turn/completed --timeout 1200`. A timeout, a
  `turn/completed` with `status` `failed`, or an empty reply is a failed seat, never an APPROVE.
- A valid reply has `HEAD:` equal to the head SHA, and `room-cli environment status <env id> --json` shows
  `.workspace.workingTree.state` `clean` and, on a same-machine seat, `.workspace.checkout.headSha` equal to
  the head. Otherwise the seat is invalid: re-run it once (attempt 2), then report it failed.

## 7. Merge and verify

1. Dedupe: one item per underlying defect. Keep the highest severity and every seat that raised it.
2. Mark each item **shared** (2+ seats) or **single** (1 seat). Singles count the same.
3. Check every item against the code yourself (read the line, run the test). Mark it `verified`,
   `rejected: <evidence>` or `unclear: <what is missing>`. Check Gemini-only items hardest.
4. Verdict, first match wins: **CHANGES** if any `verified` or `unclear` item is left, NITs included.
   **INCOMPLETE** if any picked seat has no valid reply. Else **APPROVE**.

## 8. Ledger, clean up, report

Append one JSON line per seat and per probe to `~/.local/state/triad-review/ledger.jsonl`
(`mkdir -p` the directory; `"kind":"probe"` rows leave `verdict`, `raised` and `verified` `null`):

```json
{"ts":"2026-11-18T09:00:00Z","run":"<RID>","kind":"seat","repo":"<name>","head":"<sha>","risk":"normal","family":"gpt","provider":"codex","model":"gpt-6.1-sol","level":"medium","machine":"aipc-ubuntu","thread":"thr_x","ok":true,"error":null,"verdict":"CHANGES","raised":3,"verified":2,"tokens":{"input":0,"cached":0,"output":0,"reasoning":0},"ctx":null,"secs":0}
```

- Read usage from `room-cli thread log <id> --json --all`. `tokens`: the last `thread/tokenUsage/updated`
  event's `tokenUsage.total` (`inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`);
  only Codex sends it today. Otherwise `tokens` is `null`, and `ctx` records the last
  `thread/contextWindowUsage/updated` `usedTokens` for reference only (context size, not spend). Never guess.
- `secs`: `turn/completed` minus `turn/started` `createdAt` (milliseconds), divided by 1000.
- A failed, limited or logged-out seat or probe: `"ok":false` and the error text in `error`.

Clean up on every exit, early ones included. For each line in `$RUN/ids`: `room-cli thread archive <thread>`,
then `room-cli environment delete <env>`; drop the line once that prints `Lifecycle: teardown`. A `pending`
line: find its thread with `room-cli thread list --json` by title. Then `rm -r "$RUN"` if `$RUN/ids` is
empty; otherwise keep it and list the leftovers in the report.

Report: each seat (family, model, level, machine, context), each skipped family and why, a table of items
(id, severity, file:line, claim, shared or single with raisers, verified, rejected or unclear), the verdict,
and tokens and seconds per seat.
