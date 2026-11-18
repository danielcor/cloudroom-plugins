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
- Use your own family (the family of the model running you) only when fewer than 3 others are up.
- Every seat is a Cloudroom child thread (`room-cli thread spawn --parent-self`). Never start an agent CLI
  (`claude`, `codex`, `agy`, `muse`, `kimi`) from a shell. Never use built-in Agent/Task subagents.
- Every seat gets the same brief file and the same head SHA. No seat sees another seat's reply.
- A family that is down is skipped. Never swap in another model of the same family to fill its seat.
- Fewer than 3 families up: run with what is up and say so in the report. None up: stop and say why.
- Use the logins already on each machine (their subscription plans). Never add or set an API key for a seat.
- The head must be a commit. If the change is not committed, stop and ask; do not commit on your own.

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
fast with fewer deep catches. Muse's own prompt is about 28k input tokens per call (README, Muse section).

- Gemini: Carbon first. If Carbon is down on every machine, use Argon with the same suffix
  (`gemini-4-argon-high` etc.). The agy model suffix and `--reasoning-level` must match.
- Muse High: Wonder Full only with access proof (step 3); else `muse-wonder-1.0` / `high`.
- Re-rank families 2 to 5 by the ledger once each has 10+ rows with `verified` of 1 or more and the same
  usage kind (`tokens` or `ctx`): fewer tokens per verified finding ranks higher. Without that, keep this order.
  GPT stays first on High risk.

## 3. Check who is up

Check each candidate on a named machine: the author's first (`--machine <name>`, see `room-cli machine list`).
A command that errors (for example HTTP 401) means "unknown", which counts as down on that machine.

1. `room-cli settings usage --json --machine <name>`: real quota, but only for `codex` and `claude-code`.
   Any `windows[].usedPercent` of 90 or more, or a `status` other than `ok`, means down.
2. `room-cli provider models <provider> --json --machine <name>` must list the model, except Carbon (3).
   Muse prints "No models available" when it is logged out on that machine.
3. A listed model is not proof for `agy` or `acp-muse`. Carbon sits under "More Models" in agy's picker, and
   Cloudroom's agy list can show only the three built-in Argon ids where Carbon works (`agy models` has no
   flag for more). Muse lists Wonder Full on accounts that cannot call it. Proof is a ledger row
   for that model and machine with `"ok":true` in the last 7 days. With none, spend one probe child (the
   only model call before the review): prompt `Probe only. Do not run any tools. Reply with one line:
   PROBE-OK <your model id>.` It passes only if the reply is `PROBE-OK` and the log's
   `client/turn/requested` `.data.execution.model` is the model you asked for. Log the probe (step 7).
4. Gemini, Kimi and Muse have no quota signal in `room-cli`. Use step 4's ledger checks for them.

## 4. Pick the seats

1. Start from the step 2 order with your own family last.
2. Drop each family that step 3 marked down on every machine.
3. Drop a family on a machine whose last ledger row there is `"ok":false` with a limit, 429 or quota error
   under 6 hours old.
4. Rotation: a family that sat in each of the last 3 runs moves below the next family that did not.
   Exception: GPT on High risk.
5. Take the first 3. Machine: the author's first; another machine only when the family is down here.

## 5. Brief and launch

Scan the diff for secrets (keys, tokens, `.env` content) first. If it has one, stop and tell the user:
a seat's prompt stays in its thread log. Then make one private brief per run:
`BRIEF=$(mktemp /tmp/triad-XXXXXX.md)` (mode 0600). Keep it small and byte-identical for every seat,
so prompt caching can help:

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

One spawn per seat. Right after each, append its thread id and `.environment.id` (from
`room-cli thread show <id> --json`) to `"$BRIEF.ids"`, so clean-up finds them on every exit:

```sh
room-cli thread spawn --parent-self --project "$ROOM_PROJECT_ID" --json --request-id "triad-<head7>-<family>" \
  --provider <p> --model <m> --reasoning-level <l> --permission-mode accept-edits \
  --new-environment worktree [--base-branch <head branch>] [--machine <name>] \
  --title "triad <family> <head7>" --prompt-file "$BRIEF"
```

- Same machine: pass `--base-branch <head branch>`. Without it the worktree comes from the project default
  branch. Another machine has no copy of an unpushed branch: omit `--base-branch` there (the seat answers
  `CONTEXT: diff-only`), unless the user allowed a push.
- Cloudroom has no read-only permission mode (`accept-edits`, `auto`, `full`). Use `accept-edits`; each seat
  edits only its own throwaway worktree. agy then denies shell commands, so it reviews the inline diff.
  After the reply, `room-cli environment diff-files <env id>` must be empty; if not, say so in the report.
- Wait with `room-cli thread wait --children --timeout 540` and read only this run's seat lines. Read each
  reply with `room-cli thread output <id>`. A seat that is `needs input`, or not done after 2 waits, is failed.
  A timeout, error or empty reply is failed, never an APPROVE.
- A reply whose `HEAD:` is not the head SHA does not count. Re-run that seat once (new `--request-id`), then
  report it failed.

## 6. Merge and verify

1. Dedupe: one item per underlying defect. Keep the highest severity and every seat that raised it.
2. Mark each item **shared** (2+ seats) or **single** (1 seat). Singles count the same.
3. Check every item against the code yourself (read the line, run the test). Mark it `verified`,
   `rejected: <evidence>` or `unclear: <what is missing>`. Check Gemini-only items hardest.
4. Verdict **CHANGES** if any `verified` or `unclear` item is left, NITs included. **APPROVE** only when no
   item is left and every picked seat replied. With fewer replies than picked seats it is **INCOMPLETE**.

## 7. Ledger, clean up, report

Append one JSON line per seat and per probe to `~/.local/state/triad-review/ledger.jsonl`
(`mkdir -p` the directory; `"kind":"probe"` rows leave `verdict`, `raised` and `verified` `null`):

```json
{"ts":"2026-11-18T09:00:00Z","run":"<head7>-<unix secs>","kind":"seat","repo":"<name>","head":"<sha>","risk":"normal","family":"gpt","provider":"codex","model":"gpt-6.1-sol","level":"medium","machine":"aipc-ubuntu","thread":"thr_x","ok":true,"error":null,"verdict":"CHANGES","raised":3,"verified":2,"tokens":{"input":0,"cached":0,"output":0,"reasoning":0},"ctx":null,"secs":0}
```

- Read usage from `room-cli thread log <id> --json --all`. `tokens`: the last `thread/tokenUsage/updated`
  event's `tokenUsage.total` (`inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`);
  only Codex sends it today. Otherwise `tokens` is `null` and `ctx` is the last
  `thread/contextWindowUsage/updated` `usedTokens`. Never guess a number.
- `secs`: `turn/completed` minus `turn/started` `createdAt` (milliseconds), divided by 1000.
- A failed, limited or logged-out seat or probe: `"ok":false` and the error text in `error`.
- Tokens per verified finding, per family, over its last 20 seat rows with `verified` of 1 or more:
  `(input - cached + output)`, or `ctx` where `tokens` is `null`, divided by `verified`. Compare `ctx`
  only with `ctx`.

Clean up on every exit, early ones included: `room-cli thread archive` every thread in `"$BRIEF.ids"`, then
`room-cli environment delete` each environment there, then `rm "$BRIEF" "$BRIEF.ids"`.

Report: each seat (family, model, level, machine, context), each skipped family and why, a table of items
(id, severity, file:line, claim, shared or single with raisers, verified, rejected or unclear), the verdict,
and tokens and seconds per seat.
