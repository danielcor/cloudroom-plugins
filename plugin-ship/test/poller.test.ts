import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { ShipStore, type WatchFullRecord } from "../src/db.js";
import type { PollPrStateOutput } from "../src/contract.js";
import { hostContract } from "../src/contract.js";
import { StewardPoller } from "../src/steward/poller.js";
import {
  computeWatchStateHash,
  evaluatePollTransition,
  MAX_BEHIND_MERGES,
  WAKE_COOLDOWN_MS,
  type PolledPrSnapshot,
} from "../src/steward/state-machine.js";

const HEAD_A = "a".repeat(40);
const BASE_0 = "0".repeat(40);

function baseWatch(overrides: Partial<WatchFullRecord> = {}): WatchFullRecord {
  return {
    id: "watch_1",
    projectId: "proj_1",
    hostId: "host_1",
    worktreePath: "/tmp/wt",
    repo: "acme/demo",
    prNumber: 10,
    headBranch: "feat/x",
    headRemote: "origin",
    baseBranch: "main",
    baseRemote: "origin",
    authorLogin: "danielcor",
    state: "watching",
    lastHeadSha: HEAD_A,
    lastStateHash: null,
    startedAt: 1_000_000,
    expiresAt: 1_000_000 + 7 * 86_400_000,
    lastWokeAt: null,
    workerThreadId: null,
    pins: { "bin:git": "100" },
    trustedBots: ["coderabbitai"],
    seenCommentIds: [],
    causePushCounts: {},
    rerunJobIds: [],
    behindMergesCount: 0,
    stopReason: null,
    ...overrides,
  };
}

function baseSnapshot(overrides: {
  state?: string;
  headRefOid?: string;
  mergeStateStatus?: string;
  labels?: string[];
  collisionLabels?: string[];
  checkRuns?: PolledPrSnapshot["checkRuns"];
  items?: PolledPrSnapshot["discussion"]["items"];
} = {}): PolledPrSnapshot {
  return {
    discussion: {
      pr: {
        number: 10,
        url: "https://github.com/acme/demo/pull/10",
        title: "Demo PR",
        body: "Summary",
        mayHideBody: false,
        state: overrides.state ?? "OPEN",
        isDraft: false,
        headRefName: "feat/x",
        headRefOid: overrides.headRefOid ?? HEAD_A,
        baseRefName: "main",
        baseRefOid: BASE_0,
        authorLogin: "danielcor",
        labels: overrides.labels ?? [],
        mergeStateStatus: overrides.mergeStateStatus ?? "CLEAN",
      },
      items: overrides.items ?? [],
      excludedCount: 0,
      truncatedCount: 0,
      droppedForBudgetCount: 0,
      collisionLabels: overrides.collisionLabels ?? [],
    },
    checkRuns: overrides.checkRuns ?? [],
  };
}

describe("Steward state-machine & poller", () => {
  it("evaluates hash stability, pin drift, TTL, MERGED/CLOSED, collision labels, cooldown, caps, and ready transitions", () => {
    const snap = baseSnapshot({
      checkRuns: [{ id: 1, name: "CI / test", status: "completed", conclusion: "failure", detailsUrl: null }],
    });
    const hash = computeWatchStateHash(snap);

    // 1) Pin drift stops immediately
    expect(
      evaluatePollTransition({
        watch: baseWatch(),
        snapshot: snap,
        pinsDrifted: ".git/hooks/pre-push changed",
        maxPushesPerCause: 3,
        nowMs: 2_000_000,
      }),
    ).toMatchObject({ type: "stop", terminalState: "stopped", notify: true });

    // 2) TTL expiry stops
    expect(
      evaluatePollTransition({
        watch: baseWatch(),
        snapshot: snap,
        pinsDrifted: null,
        maxPushesPerCause: 3,
        nowMs: baseWatch().expiresAt,
      }),
    ).toMatchObject({ type: "stop", terminalState: "stopped", reason: "watch_ttl_expired" });

    // 3) MERGED / CLOSED stop
    expect(
      evaluatePollTransition({
        watch: baseWatch(),
        snapshot: baseSnapshot({ state: "MERGED" }),
        pinsDrifted: null,
        maxPushesPerCause: 3,
        nowMs: 2_000_000,
      }),
    ).toMatchObject({ type: "stop", terminalState: "merged" });
    expect(
      evaluatePollTransition({
        watch: baseWatch(),
        snapshot: baseSnapshot({ state: "CLOSED" }),
        pinsDrifted: null,
        maxPushesPerCause: 3,
        nowMs: 2_000_000,
      }),
    ).toMatchObject({ type: "stop", terminalState: "closed" });

    // 4) Collision label stops
    expect(
      evaluatePollTransition({
        watch: baseWatch(),
        snapshot: baseSnapshot({ collisionLabels: ["claude-ship-active"] }),
        pinsDrifted: null,
        maxPushesPerCause: 3,
        nowMs: 2_000_000,
      }),
    ).toMatchObject({ type: "stop", terminalState: "stopped", notify: true });

    // 5) Hash unchanged -> noop
    expect(
      evaluatePollTransition({
        watch: baseWatch({ lastStateHash: hash }),
        snapshot: snap,
        pinsDrifted: null,
        maxPushesPerCause: 3,
        nowMs: 2_000_000,
      }),
    ).toMatchObject({ type: "noop", reason: "state_unchanged" });

    // 6) Actionable failure wakes worker when cooldown expired
    expect(
      evaluatePollTransition({
        watch: baseWatch({ lastWokeAt: 1_000_000 }),
        snapshot: snap,
        pinsDrifted: null,
        maxPushesPerCause: 3,
        nowMs: 1_000_000 + WAKE_COOLDOWN_MS,
      }),
    ).toMatchObject({ type: "wake_worker", causeKey: "check:ci / test", nextHash: hash });

    // 7) Within 10m cooldown -> defers cooldown without advancing hash
    expect(
      evaluatePollTransition({
        watch: baseWatch({ lastWokeAt: 1_900_000 }),
        snapshot: snap,
        pinsDrifted: null,
        maxPushesPerCause: 3,
        nowMs: 2_000_000,
      }),
    ).toMatchObject({ type: "defer_cooldown" });

    // 8) Per-cause push cap -> needs_human
    expect(
      evaluatePollTransition({
        watch: baseWatch({ causePushCounts: { "check:ci / test": 3 } }),
        snapshot: snap,
        pinsDrifted: null,
        maxPushesPerCause: 3,
        nowMs: 2_000_000,
      }),
    ).toMatchObject({ type: "needs_human", notify: true });

    // 9) BEHIND merge cap -> needs_human
    expect(
      evaluatePollTransition({
        watch: baseWatch({ behindMergesCount: MAX_BEHIND_MERGES }),
        snapshot: baseSnapshot({ mergeStateStatus: "BEHIND" }),
        pinsDrifted: null,
        maxPushesPerCause: 3,
        nowMs: 2_000_000,
      }),
    ).toMatchObject({ type: "needs_human", notify: true });

    // 10) Green checks -> mark_ready
    expect(
      evaluatePollTransition({
        watch: baseWatch(),
        snapshot: baseSnapshot({
          checkRuns: [{ id: 1, name: "CI / test", status: "completed", conclusion: "success", detailsUrl: null }],
        }),
        pinsDrifted: null,
        maxPushesPerCause: 3,
        nowMs: 2_000_000,
      }),
    ).toMatchObject({ type: "mark_ready", notify: true });
  });

  it("discovers opt-in autoSteward repos, spawns workers, skips unchanged polls, and transitions ready with realtime notices", async () => {
    let now = 5_000_000;
    let pollResponse: PollPrStateOutput = baseSnapshot({
      checkRuns: [{ id: 9, name: "Lint", status: "completed", conclusion: "failure", detailsUrl: null }],
    });
    let pinsOk = true;
    const spawnedPrompts: string[] = [];

    const host = createFakePluginHost({
      pluginId: "ship",
      sdk: {
        threads: {
          spawn: async (args) => {
            spawnedPrompts.push(args.prompt ?? "");
            return makeThreadResponse({ id: `thr_w_${spawnedPrompts.length}`, projectId: args.projectId });
          },
        },
      },
      experimental_callHostRpc: async ({ method }) => {
        if (method === "computePins") return { ok: true, pins: { "bin:git": "123" }, error: null };
        if (method === "verifyPins") {
          return pinsOk ? { ok: true, driftedKey: null, reason: null } : { ok: false, driftedKey: "k", reason: "hook drifted" };
        }
        if (method === "pollPrState") return pollResponse;
        if (method === "readRepoStewardSkill") {
          return { found: true, sourcePath: ".claude/skills/steward/SKILL.md", content: "Run npm test.", truncated: false };
        }
        return {};
      },
    });

    const db = host.bb.storage.database();
    const { MIGRATIONS } = await import("../src/db.js");
    host.bb.storage.migrate(db, MIGRATIONS);
    const store = new ShipStore(db);
    store.upsertRepo(
      { repo: "acme/auto-repo", autoSteward: "auto", trustedBots: ["bot1"] },
      { reviewMode: "triad", reviewEffort: "high", maxPushesPerCause: 3 },
      now,
    );

    const hostClient = host.bb.hosts.experimental_client({ contract: hostContract });
    const poller = new StewardPoller({
      bb: host.bb,
      store,
      hostClient,
      getPollIntervalMs: async () => 120_000,
      getMaxPushesPerCause: async () => 3,
      getWatchMaxDays: async () => 7,
      nowMs: () => now,
      discoverRepoPrs: async () => [
        {
          projectId: "proj_1",
          hostId: "host_1",
          worktreePath: "/tmp/auto-repo",
          repo: "acme/auto-repo",
          prNumber: 55,
          headBranch: "feat/auto",
          headRemote: "origin",
          baseBranch: "main",
          baseRemote: "origin",
          authorLogin: "danielcor",
        },
      ],
    });

    // Tick 1: discovers PR #55 and wakes worker (1 spawn with repo skill embedded)
    const tick1 = await poller.tickOnce(now);
    expect(tick1).toEqual({ checked: 1, woken: 1, stopped: 0, ready: 0 });
    expect(spawnedPrompts[0]).toContain("Run npm test.");

    const watch = store.getActiveWatchByRepoPr("acme/auto-repo", 55)!;
    expect(watch.state).toBe("working");
    expect(watch.workerThreadId).toBe("thr_w_1");

    // Tick 2 while working -> skips without waking
    const tick2 = await poller.tickOnce(now + 60_000);
    expect(tick2).toEqual({ checked: 0, woken: 0, stopped: 0, ready: 0 });

    // Worker settles -> returns to watching; CI goes green -> ready notification published
    poller.handleWorkerSettled("thr_w_1");
    expect(store.getWatch(watch.id)?.state).toBe("watching");

    pollResponse = baseSnapshot({
      checkRuns: [{ id: 9, name: "Lint", status: "completed", conclusion: "success", detailsUrl: null }],
    });
    const tick3 = await poller.tickOnce(now + 120_000);
    expect(tick3).toEqual({ checked: 1, woken: 0, stopped: 0, ready: 1 });
    expect(store.getWatch(watch.id)?.state).toBe("ready");
    expect(host.harness.inspection.realtimeSignals.some((m) => m.channel === "notifications")).toBe(true);

    // Zero LLM wakes when nothing changed on Tick 4
    const tick4 = await poller.tickOnce(now + 180_000);
    expect(tick4).toEqual({ checked: 1, woken: 0, stopped: 0, ready: 0 });
    expect(spawnedPrompts).toHaveLength(1);

    // Pin drift stops watch cleanly
    pinsOk = false;
    const tick5 = await poller.tickOnce(now + 240_000);
    expect(tick5).toEqual({ checked: 1, woken: 0, stopped: 1, ready: 0 });
    expect(store.getWatch(watch.id)?.stopReason).toContain("mark_changed");

    await host.harness.dispose();
  });
});
