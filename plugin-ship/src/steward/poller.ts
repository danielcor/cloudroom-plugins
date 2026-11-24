import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ShipHostClient } from "../contract.js";
import { TERMINAL_WATCH_STATES, type ShipStore, type WatchFullRecord } from "../db.js";
import { buildStewardWakePrompt } from "./prompts.js";
import { DEFAULT_WATCH_MAX_DAYS, evaluatePollTransition } from "./state-machine.js";

export interface DiscoveredPrCandidate {
  projectId: string | null;
  hostId: string;
  worktreePath: string;
  repo: string;
  prNumber: number;
  headBranch: string;
  headRemote: string;
  baseBranch: string;
  baseRemote: string;
  authorLogin: string;
}

export interface StewardPollerDeps {
  bb: BbPluginApi;
  store: ShipStore;
  hostClient: ShipHostClient;
  getPollIntervalMs: () => Promise<number>;
  getMaxPushesPerCause: (repo: string) => Promise<number>;
  getWatchMaxDays: () => Promise<number>;
  discoverRepoPrs?: (repo: string) => Promise<DiscoveredPrCandidate[]>;
  nowMs?: () => number;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class StewardPoller {
  private readonly nowMs: () => number;
  private ticking = false;

  constructor(private readonly deps: StewardPollerDeps) {
    this.nowMs = deps.nowMs ?? Date.now;
  }

  async start(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.tickOnce().catch((err) => {
        this.deps.bb.log?.error?.(
          `Steward poller tick failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      if (signal.aborted) break;
      const intervalMs = Math.max(30_000, await this.deps.getPollIntervalMs().catch(() => 120_000));
      await abortableSleep(intervalMs, signal);
    }
  }

  async tickOnce(overrideNowMs?: number): Promise<{ checked: number; woken: number; stopped: number; ready: number }> {
    if (this.ticking) {
      return { checked: 0, woken: 0, stopped: 0, ready: 0 };
    }
    this.ticking = true;
    const now = overrideNowMs ?? this.nowMs();
    let checked = 0;
    let woken = 0;
    let stopped = 0;
    let ready = 0;

    try {
      await this.runAutoDiscovery(now);

      const watches = this.deps.store.listFullWatches({ activeOnly: true, limit: 200 });
      for (const watch of watches) {
        if (watch.state !== "watching" && watch.state !== "ready" && watch.state !== "needs_human") {
          continue;
        }
        checked += 1;

        const pinRes = await this.deps.hostClient
          .call("verifyPins", { root: watch.worktreePath, expectedPins: watch.pins }, { hostId: watch.hostId })
          .catch((err: unknown) => ({
            ok: false,
            driftedKey: "pins:rpc_error",
            reason: err instanceof Error ? err.message : String(err),
          }));

        if (!pinRes.ok) {
          this.deps.store.stopWatch(watch.id, `mark_changed: ${pinRes.reason ?? "pin drift"}`, "stopped");
          this.deps.store.appendAudit({
            watchId: watch.id,
            actor: "poller",
            action: "steward.stopped",
            outcome: "stopped",
            detail: { reason: pinRes.reason },
          });
          this.publishWatches({ type: "watch.updated", watchId: watch.id, state: "stopped" });
          this.publishNotify({
            watchId: watch.id,
            repo: watch.repo,
            prNumber: watch.prNumber,
            state: "stopped",
            message: `PR Steward stopped for ${watch.repo}#${watch.prNumber}: ${pinRes.reason}`,
          });
          stopped += 1;
          continue;
        }

        const snapshot = await this.deps.hostClient
          .call(
            "pollPrState",
            {
              root: watch.worktreePath,
              repo: watch.repo,
              prNumber: watch.prNumber,
              trustedBots: watch.trustedBots,
              authorLogin: watch.authorLogin,
            },
            { hostId: watch.hostId },
          )
          .catch(() => null);

        if (!snapshot) continue;

        const maxPushesPerCause = await this.deps.getMaxPushesPerCause(watch.repo);
        const action = evaluatePollTransition({
          watch,
          snapshot,
          pinsDrifted: null,
          maxPushesPerCause,
          nowMs: now,
        });

        switch (action.type) {
          case "noop":
            break;

          case "stop":
            this.deps.store.stopWatch(watch.id, action.reason, action.terminalState);
            this.deps.store.appendAudit({
              watchId: watch.id,
              actor: "poller",
              action: "steward.stopped",
              outcome: action.terminalState,
              detail: { reason: action.reason },
            });
            this.publishWatches({ type: "watch.updated", watchId: watch.id, state: action.terminalState });
            if (action.notify) {
              this.publishNotify({
                watchId: watch.id,
                repo: watch.repo,
                prNumber: watch.prNumber,
                state: action.terminalState,
                message: `PR Steward stopped for ${watch.repo}#${watch.prNumber}: ${action.reason}`,
              });
            }
            stopped += 1;
            break;

          case "mark_ready":
            this.deps.store.updateWatch(watch.id, {
              state: "ready",
              lastStateHash: action.nextHash,
              lastHeadSha: action.headSha,
              stopReason: null,
            });
            this.deps.store.appendAudit({
              watchId: watch.id,
              actor: "poller",
              action: "steward.ready",
              outcome: "ok",
              detail: { repo: watch.repo, prNumber: watch.prNumber, headSha: action.headSha },
            });
            this.publishWatches({ type: "watch.updated", watchId: watch.id, state: "ready" });
            if (action.notify) {
              this.publishNotify({
                watchId: watch.id,
                repo: watch.repo,
                prNumber: watch.prNumber,
                state: "ready",
                message: `PR ${watch.repo}#${watch.prNumber} is green and ready.`,
              });
            }
            ready += 1;
            break;

          case "update_hash_only":
            this.deps.store.updateWatch(watch.id, {
              lastStateHash: action.nextHash,
              lastHeadSha: action.headSha,
            });
            break;

          case "needs_human":
            this.deps.store.updateWatch(watch.id, {
              state: "needs_human",
              lastStateHash: action.nextHash,
              lastHeadSha: action.headSha,
              stopReason: action.reason,
            });
            this.deps.store.appendAudit({
              watchId: watch.id,
              actor: "poller",
              action: "steward.needs_human",
              outcome: "needs_human",
              detail: { causeKey: action.causeKey, reason: action.reason },
            });
            this.publishWatches({ type: "watch.updated", watchId: watch.id, state: "needs_human" });
            this.publishNotify({
              watchId: watch.id,
              repo: watch.repo,
              prNumber: watch.prNumber,
              state: "needs_human",
              message: `PR ${watch.repo}#${watch.prNumber} needs human attention: ${action.reason}`,
            });
            break;

          case "defer_cooldown":
            this.deps.store.appendAudit({
              watchId: watch.id,
              actor: "poller",
              action: "steward.cooldown_deferred",
              outcome: "deferred",
              detail: { causeKey: action.causeKey, retryAfterMs: action.retryAfterMs },
            });
            break;

          case "wake_worker": {
            const spawnedOk = await this.wakeWorker(watch, action, maxPushesPerCause, now);
            if (spawnedOk) woken += 1;
            break;
          }
        }
      }
    } finally {
      this.ticking = false;
    }

    return { checked, woken, stopped, ready };
  }

  handleWorkerSettled(threadId: string): void {
    const watch = this.deps.store.getWatchByWorkerThreadId(threadId);
    if (!watch) return;
    if (TERMINAL_WATCH_STATES.has(watch.state)) return;

    const nextState =
      watch.state === "working" || watch.state === "waking" ? "watching" : watch.state;
    this.deps.store.updateWatch(watch.id, {
      state: nextState,
      workerThreadId: null,
    });
    this.publishWatches({ type: "watch.updated", watchId: watch.id, state: nextState });
  }

  private async runAutoDiscovery(nowMs: number): Promise<void> {
    if (!this.deps.discoverRepoPrs) return;
    const repos = this.deps.store.listRepos().filter((r) => r.enabled && r.autoSteward === "auto");
    if (repos.length === 0) return;

    const maxDays = (await this.deps.getWatchMaxDays().catch(() => DEFAULT_WATCH_MAX_DAYS)) || DEFAULT_WATCH_MAX_DAYS;
    for (const repoCfg of repos) {
      const prs = await this.deps.discoverRepoPrs(repoCfg.repo).catch(() => [] as DiscoveredPrCandidate[]);
      for (const pr of prs) {
        if (this.deps.store.getActiveWatchByRepoPr(pr.repo, pr.prNumber)) continue;
        const pinSnap = await this.deps.hostClient
          .call("computePins", { root: pr.worktreePath }, { hostId: pr.hostId })
          .catch(() => ({ ok: false, pins: {}, error: "pin snapshot failed" }));
        if (!pinSnap.ok) continue;

        const watchId = `watch_${randomUUID()}`;
        this.deps.store.createWatch({
          id: watchId,
          projectId: pr.projectId,
          hostId: pr.hostId,
          worktreePath: pr.worktreePath,
          repo: pr.repo,
          prNumber: pr.prNumber,
          headBranch: pr.headBranch,
          headRemote: pr.headRemote,
          baseBranch: pr.baseBranch,
          baseRemote: pr.baseRemote,
          authorLogin: pr.authorLogin,
          state: "watching",
          lastHeadSha: null,
          lastStateHash: null,
          startedAt: nowMs,
          expiresAt: nowMs + maxDays * 24 * 60 * 60 * 1000,
          lastWokeAt: null,
          workerThreadId: null,
          pins: pinSnap.pins,
          trustedBots: repoCfg.trustedBots,
          seenCommentIds: [],
          causePushCounts: {},
          rerunJobIds: [],
          behindMergesCount: 0,
          stopReason: null,
        });
        this.deps.store.appendAudit({
          watchId,
          actor: "poller",
          action: "steward.auto_discovered",
          outcome: "ok",
          detail: { repo: pr.repo, prNumber: pr.prNumber },
        });
        this.publishWatches({ type: "watch.created", watchId, state: "watching" });
      }
    }
  }

  private async wakeWorker(
    watch: WatchFullRecord,
    action: Extract<ReturnType<typeof evaluatePollTransition>, { type: "wake_worker" }>,
    maxPushesPerCause: number,
    nowMs: number,
  ): Promise<boolean> {
    if (!watch.projectId) {
      this.deps.store.updateWatch(watch.id, {
        state: "needs_human",
        lastStateHash: action.nextHash,
        lastHeadSha: action.headSha,
        stopReason: "Missing Cloudroom projectId for spawning Steward worker.",
      });
      this.publishWatches({ type: "watch.updated", watchId: watch.id, state: "needs_human" });
      return false;
    }

    // Reserve waking state & cooldown timestamp before async skill read/spawn.
    this.deps.store.updateWatch(watch.id, {
      state: "waking",
      lastWokeAt: nowMs,
      lastHeadSha: action.headSha,
    });

    const repoSkill = await this.deps.hostClient
      .call("readRepoStewardSkill", { root: watch.worktreePath }, { hostId: watch.hostId })
      .catch(() => null);

    const prompt = buildStewardWakePrompt({
      watch,
      transition: action,
      repoSkill,
      maxPushesPerCause,
    });

    try {
      const spawned = await this.deps.bb.sdk.threads.spawn({
        projectId: watch.projectId,
        title: `steward ${watch.repo}#${watch.prNumber}`,
        permissionMode: "accept-edits",
        environment: {
          type: "host",
          hostId: watch.hostId,
          workspace: {
            type: "unmanaged",
            path: watch.worktreePath,
          },
        },
        pluginMetadata: {
          shipRole: "steward-worker",
          watchId: watch.id,
        },
        prompt,
      });

      this.deps.store.updateWatch(watch.id, {
        state: "working",
        workerThreadId: spawned.id,
        lastStateHash: action.nextHash,
        lastWokeAt: nowMs,
        lastHeadSha: action.headSha,
      });
      this.deps.store.appendAudit({
        watchId: watch.id,
        actor: "poller",
        action: "steward.worker_woken",
        outcome: "ok",
        detail: { threadId: spawned.id, causeKey: action.causeKey, headSha: action.headSha },
      });
      this.publishWatches({ type: "watch.updated", watchId: watch.id, state: "working" });
      return true;
    } catch (err) {
      // Revert waking -> watching without saving lastStateHash so next poll can retry.
      this.deps.store.updateWatch(watch.id, { state: "watching" });
      this.deps.store.appendAudit({
        watchId: watch.id,
        actor: "poller",
        action: "steward.worker_spawn_failed",
        outcome: "error",
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
      return false;
    }
  }

  private publishWatches(payload: Record<string, unknown>): void {
    try {
      this.deps.bb.realtime.publish("watches", payload);
    } catch {
      // Ignore realtime errors in detached harnesses.
    }
  }

  private publishNotify(payload: Record<string, unknown>): void {
    try {
      this.deps.bb.realtime.publish("notifications", payload);
    } catch {
      // Ignore realtime errors in detached harnesses.
    }
  }
}
