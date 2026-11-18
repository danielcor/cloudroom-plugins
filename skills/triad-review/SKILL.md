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
- A family that is down is skipped. Never swap in another model of the same family to fill its seat; the
  only same-family fallbacks are the two named in step 3 (Carbon to Argon, Wonder Full to Wonder).
- Fewer than 3 families up: run with what is up and say so in the report. None up: stop and say why.
- Use the logins already on each machine (their subscription plans). Never add or set an API key for a seat.
- The head must be a commit on a branch. If the change is not committed, or HEAD is detached, stop and ask;
  do not commit or branch on your own.

## 1. Start the run

1. `RUN=$(mktemp -d "${TMPDIR:-/tmp}/triad-XXXXXX")` (private, unique). `RID=$(basename "$RUN")`.
   No dot in the template: request ids must match `^[a-zA-Z0-9_-]{1,64}$` or the spawn fails with HTTP 400.
2. Every spawn (probe, seat or retry) gets its own request id `$RID-<probe|seat>-<family>-<attempt>`.
   Before the spawn, append one JSON line to `$RUN/spawns.jsonl` with its exact parameters: `requestId`,
   `kind`, `family`, `machine`, `provider`, `model`, `level`, `baseBranch` (or `null`), `promptFile`. After
   the reply, append `{"requestId":…,"threadId":…,"environmentId":…}` (`room-cli thread show <id> --json`
   gives `.environment.id`). A spawn rejected with an HTTP 4xx validation error (for example
   `HTTP 400: Invalid string`) created nothing: append `{"requestId":…,"error":"<text>"}`; that record is
   resolved. Any other error or no answer is unconfirmed: replay that exact spawn with the same
   `--request-id`, and Cloudroom returns the thread if it was made instead of a duplicate.
3. Secrets: if the diff holds a key, token or `.env` content, stop and tell the user (a prompt stays in its
   thread log).
4. Worktree files: before any spawn (probes in step 4 and seats in step 6), read `.worktreeinclude` and
   `.bb-env-setup.sh` at the exact ref and machine that spawn checks out: `git show <head branch>:<file>` when
   it passes `--base-branch`. Without it the ref is that machine's `.defaultWorktreeBaseBranch` from
   `room-cli project branches "$ROOM_PROJECT_ID" --host <host id> --json` (it differs per machine); read
   `<that ref>:<file>` in that machine's project checkout (for example over `tailscale ssh`). If either file
   would give the child a credential, or you cannot read the ref on that machine, do not spawn there. On the
   author's machine, stop and ask the user.

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
- Cost: today only Codex logs token counts (`thread/tokenUsage/updated`), so the ledger cannot re-rank yet
  and this order stays. Once 2 or more of families 2 to 5 each have 10+ seat rows
  with `tokens` set, re-rank those: sum `input - cached + output` over their last 20 such rows and divide by
  the sum of `verified` (skip a family whose sum is 0). Lower ranks higher. GPT stays first on High risk.

## 4. Check who is up

Check each candidate on a named machine: the author's first (`--machine <name>`, see `room-cli machine list`).
If `room-cli` fails for every provider (for example HTTP 401), the run is blocked: stop and report it.
A check that fails for one provider means that provider is down on that machine.

1. Cooldown: a model whose last ledger row on that machine is `"ok":false` with a limit, 429 or quota error
   under 6 hours old is down there. Apply this before any probe.
2. `room-cli settings usage --json --machine <name>`: real quota, but only for `codex` and `claude-code`.
   A `status` other than `ok`, or a `windows[].usedPercent` of 90 or more, means down. Skip windows whose
   `model` is set to another model (for example the `Fable` window when the seat runs Opus).
3. `room-cli provider models <provider> --json --machine <name>` must list the model, except Carbon (4.4).
   Muse prints "No models available" when it is logged out on that machine.
4. A listed model is not proof for `agy` or `acp-muse`. Carbon sits under "More Models" in agy's picker, and
   Cloudroom's agy list can show only the three built-in Argon ids where Carbon works (`agy models` has no
   flag for more). Muse lists Wonder Full on accounts that cannot call it. Proof is a ledger row for that
   model and machine with `"ok":true` in the last 7 days. With none, spend one probe child per unproved
   model: write `Probe only. Do not run any tools. Reply with exactly: PROBE-OK` to `$RUN/probe.md` and use
   the step 6 spawn command with `--request-id "$RID-probe-<family>-<attempt>"` and
   `--prompt-file "$RUN/probe.md"` (step 1.4 applies).
   It passes if the reply is `PROBE-OK` and the turn did not fail. Cloudroom logs only the requested model,
   so this proves the id was accepted and ran, not which weights answered. Log the probe (step 8).
5. Gemini, Kimi and Muse have no quota signal in `room-cli`, so 4.2 does not apply to them.

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

One spawn per seat (record it as in step 1.2; check worktree files as in step 1.4):

```sh
room-cli thread spawn --parent-self --project "$ROOM_PROJECT_ID" --json --request-id "$RID-seat-<family>-1" \
  --provider <p> --model <m> --reasoning-level <l> --permission-mode <accept-edits|full> \
  --new-environment worktree [--base-branch <head branch>] [--machine <name>] \
  --title "triad $RID <family>" --prompt-file "$RUN/brief.md"
```

- Same machine: pass `--base-branch <head branch>`. Without it the worktree comes from the project default
  branch. Another machine has no copy of an unpushed branch: omit `--base-branch` there (the seat answers
  `CONTEXT: diff-only`), unless the user allowed a push.
- Cloudroom has no read-only permission mode (`accept-edits`, `auto`, `full`); each seat touches only its
  own throwaway worktree, and the clean-worktree check below catches edits. Use `accept-edits`, except
  `full` for `agy`: headless agy cannot ask, and any denied read or command ends its turn with no review
  (`acp/agy-acp.mjs`, `onEvent`). The brief still says read-only.
- Wait on each seat by id: `room-cli thread wait <id> --event turn/completed --timeout 120`, repeated up to
  20 minutes. Between waits, `room-cli thread interactions list <id>` shows pending approvals: approve
  (`room-cli thread interactions approve <interaction> <id>`) only read-only inspection (`git rev-parse`,
  `status`, `diff`, `show`, `log`; `ls`, `cat`, `grep`, `sed -n`); deny anything else, such as `npm test`.
  Still running after 20 minutes, a `turn/completed` with `status` `failed`, or an empty reply is a failed
  seat, never an APPROVE.
- A valid reply (`room-cli thread output <id>`) has all of:
  - `HEAD: <the head SHA>`.
  - `CONTEXT: checkout` or `CONTEXT: diff-only`; no other value.
  - `VERDICT: APPROVE` with no `F` lines, or `VERDICT: CHANGES` with at least one `F` line.
  - Every `F` line in the form `F<n> [BLOCKER|MAJOR|MINOR|NIT] <file>:<line> <claim>. Evidence: <…> Fix: <…>`.
  - `room-cli environment status <env id> --json` shows `.workspace.workingTree.state` `clean` and, on a
    same-machine seat, `.workspace.checkout.headSha` equal to the head.

  Any miss makes the reply invalid: re-run the seat once (attempt 2), then report it failed.

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
- `secs`: `turn/completed` minus `turn/started` `createdAt` (milliseconds), divided by 1000; `null` if
  either event is missing.
- A failed, limited or logged-out seat or probe: `"ok":false` and the error text in `error`.

Clean up on every exit, early ones included, for each `requestId` in `$RUN/spawns.jsonl`:

1. A resolved 4xx `error` record needs nothing more. No `threadId` and no such error: replay its recorded
   spawn with the same `--request-id` (while its `promptFile` still exists), then get `.environment.id` from
   `room-cli thread show <threadId> --json`.
2. `room-cli thread stop <threadId>`, `room-cli thread archive <threadId>`, then
   `room-cli environment delete <environmentId>`; archive and delete must exit 0.
3. `room-cli environment show <environmentId> --json` must reach `.lifecycle.phase` `destroyed` (teardown runs
   in the background; re-check once at the end of the run).

`rm -r "$RUN"` only when every record passed all three. Otherwise delete only the prompt files (once no replay
needs them), keep `$RUN/spawns.jsonl`, and report its path, the unresolved request ids and any environment not
`destroyed`.

Report: each seat (family, model, level, machine, context), each skipped family and why, a table of items
(id, severity, file:line, claim, shared or single with raisers, verified, rejected or unclear), the verdict,
and tokens and seconds per seat.
