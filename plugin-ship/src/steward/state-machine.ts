import { createHash } from "node:crypto";
import type { WatchFullRecord } from "../db.js";
import type { FilteredPrDiscussion, TrustedPrComment } from "../github/comments.js";
import { SHIP_MARKER_PREFIX } from "../safety/outbound-text.js";

export const WAKE_COOLDOWN_MS = 10 * 60 * 1000;
export const MAX_RERUNS_PER_JOB = 1;
export const MAX_BEHIND_MERGES = 2;
export const DEFAULT_MAX_PUSHES_PER_CAUSE = 3;
export const DEFAULT_WATCH_MAX_DAYS = 7;

export interface PolledCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
}

export interface PolledPrSnapshot {
  discussion: FilteredPrDiscussion;
  checkRuns: PolledCheckRun[];
}

const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

export function computeWatchStateHash(snapshot: PolledPrSnapshot): string {
  const canonical = {
    state: snapshot.discussion.pr.state,
    headSha: snapshot.discussion.pr.headRefOid,
    baseSha: snapshot.discussion.pr.baseRefOid,
    mergeStateStatus: snapshot.discussion.pr.mergeStateStatus,
    labels: [...snapshot.discussion.pr.labels].sort(),
    checkRuns: [...snapshot.checkRuns]
      .map((c) => ({ id: c.id, name: c.name, status: c.status, conclusion: c.conclusion }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
    comments: snapshot.discussion.items.map((c) => ({
      id: c.id,
      createdAt: c.createdAt,
      body: c.body,
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export type PollTransitionAction =
  | {
      type: "stop";
      terminalState: "stopped" | "merged" | "closed";
      reason: string;
      notify: boolean;
    }
  | {
      type: "noop";
      reason: string;
    }
  | {
      type: "mark_ready";
      nextHash: string;
      headSha: string;
      notify: boolean;
    }
  | {
      type: "update_hash_only";
      nextHash: string;
      headSha: string;
      reason: string;
    }
  | {
      type: "needs_human";
      reason: string;
      causeKey: string;
      nextHash: string;
      headSha: string;
      notify: boolean;
    }
  | {
      type: "defer_cooldown";
      reason: string;
      retryAfterMs: number;
      causeKey: string;
    }
  | {
      type: "wake_worker";
      causeKey: string;
      nextHash: string;
      headSha: string;
      failingChecks: PolledCheckRun[];
      pendingChecks: PolledCheckRun[];
      unseenComments: TrustedPrComment[];
      isDirty: boolean;
      isBehind: boolean;
    };

export function evaluatePollTransition(input: {
  watch: WatchFullRecord;
  snapshot: PolledPrSnapshot;
  pinsDrifted: string | null;
  maxPushesPerCause: number;
  nowMs: number;
}): PollTransitionAction {
  const { watch, snapshot, pinsDrifted, maxPushesPerCause, nowMs } = input;
  const pr = snapshot.discussion.pr;

  if (pinsDrifted) {
    return {
      type: "stop",
      terminalState: "stopped",
      reason: `mark_changed: ${pinsDrifted}`,
      notify: true,
    };
  }

  if (nowMs >= watch.expiresAt) {
    return {
      type: "stop",
      terminalState: "stopped",
      reason: "watch_ttl_expired",
      notify: true,
    };
  }

  const prStateUpper = pr.state.toUpperCase();
  if (prStateUpper === "MERGED") {
    return {
      type: "stop",
      terminalState: "merged",
      reason: "pr_merged",
      notify: false,
    };
  }
  if (prStateUpper === "CLOSED") {
    return {
      type: "stop",
      terminalState: "closed",
      reason: "pr_closed",
      notify: false,
    };
  }

  if (snapshot.discussion.collisionLabels.length > 0) {
    return {
      type: "stop",
      terminalState: "stopped",
      reason: `collision_label: ${snapshot.discussion.collisionLabels.join(", ")}`,
      notify: true,
    };
  }

  if (watch.state === "working" || watch.state === "waking" || watch.state === "paused") {
    return { type: "noop", reason: `watch_state_${watch.state}` };
  }

  const nextHash = computeWatchStateHash(snapshot);
  if (watch.lastStateHash === nextHash) {
    return { type: "noop", reason: "state_unchanged" };
  }

  const failingChecks = snapshot.checkRuns.filter(
    (c) => c.conclusion !== null && FAILING_CONCLUSIONS.has(c.conclusion.toLowerCase()),
  );
  const pendingChecks = snapshot.checkRuns.filter(
    (c) => c.conclusion === null || c.status.toLowerCase() !== "completed",
  );
  const seenSet = new Set(watch.seenCommentIds);
  const unseenComments = snapshot.discussion.items.filter(
    (c) => !seenSet.has(c.id) && !c.body.startsWith(SHIP_MARKER_PREFIX),
  );

  const mergeUpper = pr.mergeStateStatus.toUpperCase();
  const isDirty = mergeUpper === "DIRTY";
  const isBehind = mergeUpper === "BEHIND";

  if (
    failingChecks.length === 0 &&
    unseenComments.length === 0 &&
    !isDirty &&
    !isBehind &&
    pendingChecks.length === 0
  ) {
    return {
      type: "mark_ready",
      nextHash,
      headSha: pr.headRefOid,
      notify: watch.state !== "ready",
    };
  }

  if (failingChecks.length === 0 && unseenComments.length === 0 && !isDirty && !isBehind && pendingChecks.length > 0) {
    return {
      type: "update_hash_only",
      nextHash,
      headSha: pr.headRefOid,
      reason: "pending_checks",
    };
  }

  let causeKey: string;
  if (failingChecks.length > 0) {
    causeKey = `check:${failingChecks[0]!.name.toLowerCase()}`;
  } else if (isDirty) {
    causeKey = "conflict";
  } else if (unseenComments.length > 0) {
    causeKey = `comment:${unseenComments[0]!.id}`;
  } else {
    causeKey = "behind";
  }

  if (
    isBehind &&
    failingChecks.length === 0 &&
    unseenComments.length === 0 &&
    !isDirty &&
    watch.behindMergesCount >= MAX_BEHIND_MERGES
  ) {
    return {
      type: "needs_human",
      reason: `Reached max automated base-branch merges (${MAX_BEHIND_MERGES}).`,
      causeKey,
      nextHash,
      headSha: pr.headRefOid,
      notify: true,
    };
  }

  const pushesForCause = watch.causePushCounts[causeKey] ?? 0;
  if (pushesForCause >= maxPushesPerCause) {
    return {
      type: "needs_human",
      reason: `Reached max push cap (${maxPushesPerCause}) for cause "${causeKey}".`,
      causeKey,
      nextHash,
      headSha: pr.headRefOid,
      notify: true,
    };
  }

  if (watch.lastWokeAt !== null && nowMs - watch.lastWokeAt < WAKE_COOLDOWN_MS) {
    return {
      type: "defer_cooldown",
      reason: "wake_cooldown_active",
      retryAfterMs: WAKE_COOLDOWN_MS - (nowMs - watch.lastWokeAt),
      causeKey,
    };
  }

  return {
    type: "wake_worker",
    causeKey,
    nextHash,
    headSha: pr.headRefOid,
    failingChecks,
    pendingChecks,
    unseenComments,
    isDirty,
    isBehind,
  };
}
