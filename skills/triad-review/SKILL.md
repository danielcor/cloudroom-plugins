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
- Skip your own family (the family of the model running you) unless fewer than 3 others are up.
- Every seat is a Cloudroom child thread (`room-cli thread spawn --parent-self`). Never start an agent CLI
  (`claude`, `codex`, `agy`, `muse`, `kimi`) from a shell. Never use built-in Agent/Task subagents.
- Every seat gets the same brief file and the same head SHA. No seat sees another seat's reply.
- A family that is down is skipped. Never swap in another model of the same family to fill its seat.
- Fewer than 3 families up: run with what is up and say so in the report. None up: stop and say why.
- Prepaid plans only. Never route a seat through a metered API key.

## 1. Size the risk

- **High**: trade path (order, close, stop, copy-trading), auth, secrets, DB guards, migrations, data loss.
- **Low**: under ~100 changed lines of docs, tests or config, and nothing High.
- **Normal**: everything else.

## 2. The families (default order, best reviewer first)

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
fast with fewer deep catches. Muse adds about 28k tokens of its own prompt to every call.

- Gemini: Carbon first. If Carbon is down or out of quota, use the same suffix on Argon
  (`gemini-4-argon-high` etc.). The agy model suffix and `--reasoning-level` must match.
- Muse High: Wonder Full only if a ledger row proves access (step 3); else `muse-wonder-1.0` / `high`.
- Re-rank 2 to 5 by the ledger once each has 10+ rows: fewer tokens per verified finding ranks higher.
  GPT stays first on High risk.

## 3. Check who is up (no model calls)

Use the author's machine first; `--machine <name>` checks another (`room-cli machine list`).

1. `room-cli settings usage --json`: real quota, but only for `codex` and `claude-code`. Any
   `windows[].usedPercent` of 90 or more, or a `status` other than `ok`, means down.
2. `room-cli provider models <provider> --json` must list the model. Muse prints "No models available"
   when it is logged out on that machine.
3. A listed model is not proof for `agy` or `acp-muse`. The agy list can show only the three built-in Argon
   ids where Carbon works, and Muse lists Wonder Full on accounts that cannot call it. Proof is a ledger row
   for that model and machine with `"ok":true` in the last 7 days. With none, spend one probe child:
   prompt `Probe only. Do not run any tools. Reply with one line: PROBE-OK <your model id>.`
4. Gemini, Kimi and Muse have no quota signal in `room-cli`. Use step 4's ledger checks for them.

## 4. Pick the seats

1. Start from the step 2 order. Drop your own family.
2. Drop each family that step 3 marked down.
3. Drop a family whose last ledger row is `"ok":false` with a limit, 429 or quota error under 6 hours old.
4. Rotation: a family that sat in each of the last 3 runs moves below the next family that did not.
   Exception: GPT on High risk.
5. Take the first 3. Machine: the author's first; another machine only when the family is down here.

## 5. Brief and launch

Commit first. Write the brief once to `/tmp/triad-<head7>.md`. Keep it small and byte-identical for every
seat, so prompt caching can help:

```
Review only. Do not edit, write, commit, push, comment on PRs, or start subagents or threads.
Repo: <abs path>  Base: <sha>  Head: <sha>  Intent: <1-2 sentences>  Out of scope: <scope>
Checks: <test / typecheck / lint results>
Diff (git diff <base>..<head>):
<the diff; no whole files>
You may read surrounding code in your checkout. First check that git rev-parse HEAD equals Head.
If you cannot, review the diff alone and add the line CONTEXT: diff-only.
Find bugs, broken callers, mismatch with intent, missing tests, security, data loss, concurrency.
Skip style unless it hides a bug.
BLOCKER = intended case wrong, or a security or data-loss bug. MAJOR = a real bug callers will hit.
MINOR = a narrow real defect, or doc wording people act on that could misdirect. NIT = cosmetic.
Reply in at most 40 lines, this format only:
HEAD: <sha>
VERDICT: APPROVE (zero findings) or CHANGES
F1 [BLOCKER|MAJOR|MINOR|NIT] <file>:<line> <claim>. Evidence: <quote or reason>. Fix: <one line>
```

One spawn per seat:

```sh
room-cli thread spawn --parent-self --project "$ROOM_PROJECT_ID" --json \
  --provider <p> --model <m> --reasoning-level <l> --permission-mode accept-edits \
  --new-environment worktree --base-branch <head branch> [--machine <name>] \
  --title "triad <family> <head7>" --prompt-file /tmp/triad-<head7>.md
```

- `--base-branch` is required. Without it the seat's worktree comes from the project default branch.
- `accept-edits` for every seat. agy then denies shell commands, so it cannot run `git`; the inline diff
  covers that. Use `--permission-mode full` only if the user asks; the brief still says read-only.
- A seat on another machine has no copy of an unpushed head. Push only if the user allowed it; otherwise
  that seat answers with `CONTEXT: diff-only`.
- Wait with `room-cli thread wait --children --timeout 540`; repeat until every seat is done or failed.
  Read replies with `room-cli thread output <id>`. A timeout, error or empty reply is not an APPROVE.
- A reply whose `HEAD:` is not the head SHA does not count. Re-run that seat once, then report it failed.

## 6. Merge and verify

1. Dedupe: one item per underlying defect. Keep the highest severity and every seat that raised it.
2. Mark each item **shared** (2+ seats) or **single** (1 seat). Singles count the same.
3. Check every item against the code yourself (read the line, run the test). Mark it `verified`,
   `rejected: <evidence>` or `unclear`. Check Gemini-only items hardest.
4. Verdict **CHANGES** if any `verified` or `unclear` item is left, NITs included. Otherwise **APPROVE**.
   A failed seat is reported as failed, never counted as an APPROVE.

## 7. Ledger, clean up, report

Append one JSON line per seat to `~/.local/state/triad-review/ledger.jsonl` (`mkdir -p` the directory):

```json
{"ts":"2026-11-18T09:00:00Z","run":"<head7>-<unix secs>","repo":"<name>","head":"<sha>","risk":"normal","family":"gpt","provider":"codex","model":"gpt-6.1-sol","level":"medium","machine":"aipc-ubuntu","thread":"thr_x","ok":true,"error":null,"verdict":"CHANGES","raised":3,"verified":2,"tokens":{"input":0,"cached":0,"output":0,"reasoning":0},"ctx":null,"secs":0}
```

- Read usage from `room-cli thread log <id> --json --all`. `tokens`: the last `thread/tokenUsage/updated`
  event's `tokenUsage.total` (`inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`);
  only Codex sends it today. Otherwise `tokens` is `null` and `ctx` is the last
  `thread/contextWindowUsage/updated` `usedTokens`. Never guess a number.
- `secs`: `turn/completed` minus `turn/started` `createdAt` (milliseconds), divided by 1000.
- A failed, limited or logged-out seat (probes too): `"ok":false` and the error text in `error`.
- Tokens per verified finding, per family, over its last 20 rows: `(input - cached + output)`, or `ctx`
  where `tokens` is `null`, divided by `verified`. Compare `ctx` only with `ctx`.

Clean up: note each seat's `.environment.id` (`room-cli thread show <id> --json`), then
`room-cli thread archive <seat ids>`, then `room-cli environment delete <env id>` for each, then
`rm /tmp/triad-<head7>.md`.

Report: each seat (family, model, level, machine), each skipped family and why, a table of items (id,
severity, file:line, claim, shared or single with raisers, verified or rejected), the verdict, and tokens
and seconds per seat.
