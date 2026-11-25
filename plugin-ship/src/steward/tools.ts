import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ShipHostClient } from "../contract.js";
import type { ShipStore, WatchFullRecord } from "../db.js";
import type { GitHubBotClient } from "../github/bot.js";
import { isNeverEditPath, isSecretFilename } from "../safety/never-edit.js";
import { SHIP_MARKER_PREFIX, validateCommentText, validateCommitMessage } from "../safety/outbound-text.js";
import { buildStewardSystemInstructions } from "./prompts.js";
import { DEFAULT_MAX_PUSHES_PER_CAUSE, MAX_BEHIND_MERGES, MAX_RERUNS_PER_JOB } from "./state-machine.js";

export const STEWARD_TOOL_NAMES = [
  "ship_steward_status",
  "ship_steward_check_logs",
  "ship_steward_fetch_base",
  "ship_steward_merge_base",
  "ship_steward_commit_push",
  "ship_steward_rerun_job",
  "ship_steward_reply_comment",
  "ship_steward_escalate",
] as const;

export interface StewardToolsDeps {
  store: ShipStore;
  hostClient: ShipHostClient;
  getBotClient: () => Promise<GitHubBotClient | null>;
  getMaxPushesPerCause: (repo: string) => Promise<number>;
  publishWatchUpdate: (watchId: string) => void;
  publishNotification: (payload: {
    watchId: string;
    repo: string;
    prNumber: number;
    state: string;
    message: string;
  }) => void;
}

function jsonTextResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function registerStewardTools(bb: BbPluginApi, deps: StewardToolsDeps): void {
  function requireWorkerWatch(threadId: string): WatchFullRecord | { error: ReturnType<typeof jsonTextResult> } {
    const watch = deps.store.getWatchByWorkerThreadId(threadId);
    if (!watch) {
      return {
        error: jsonTextResult(
          { ok: false, error: `Thread ${threadId} is not an active Ship Steward worker.` },
          true,
        ),
      };
    }
    return watch;
  }

  bb.agents.registerTool({
    name: "ship_steward_status",
    description: "Inspect current watched PR state, remaining push/merge/rerun budgets, and seen comments.",
    parameters: z.object({}).strict(),
    async execute(_params, ctx) {
      const w = requireWorkerWatch(ctx.threadId);
      if ("error" in w) return w.error;
      const maxPushes = await deps.getMaxPushesPerCause(w.repo);
      return jsonTextResult({
        ok: true,
        watchId: w.id,
        repo: w.repo,
        prNumber: w.prNumber,
        headBranch: w.headBranch,
        baseBranch: w.baseBranch,
        state: w.state,
        lastHeadSha: w.lastHeadSha,
        behindMergesCount: w.behindMergesCount,
        maxBehindMerges: MAX_BEHIND_MERGES,
        causePushCounts: w.causePushCounts,
        maxPushesPerCause: maxPushes || DEFAULT_MAX_PUSHES_PER_CAUSE,
        rerunJobIds: w.rerunJobIds,
        maxRerunsPerJob: MAX_RERUNS_PER_JOB,
        seenCommentCount: w.seenCommentIds.length,
      });
    },
  });

  bb.agents.registerTool({
    name: "ship_steward_check_logs",
    description: "Fetch bounded, secret-redacted failed CI job logs for the watched PR via host gh.",
    parameters: z
      .object({
        jobId: z.number().int().positive(),
        maxBytes: z.number().int().min(512).max(65_536).optional(),
      })
      .strict(),
    async execute(params, ctx) {
      const w = requireWorkerWatch(ctx.threadId);
      if ("error" in w) return w.error;
      const res = await deps.hostClient.call(
        "stewardFetchJobLogs",
        {
          root: w.worktreePath,
          repo: w.repo,
          jobId: params.jobId,
          ...(params.maxBytes ? { maxBytes: params.maxBytes } : {}),
        },
        { hostId: w.hostId },
      );
      deps.store.appendAudit({
        watchId: w.id,
        actor: "steward-worker",
        action: "steward.check_logs",
        outcome: res.ok ? "ok" : "error",
        detail: { jobId: params.jobId, truncated: res.truncated, redactedCount: res.redactedCount },
      });
      return jsonTextResult(res, !res.ok);
    },
  });

  bb.agents.registerTool({
    name: "ship_steward_fetch_base",
    description: "Verify checkout pins, fetch the PR base branch with hooks disabled, and simulate merge safety.",
    parameters: z.object({}).strict(),
    async execute(_params, ctx) {
      const w = requireWorkerWatch(ctx.threadId);
      if ("error" in w) return w.error;
      const res = await deps.hostClient.call(
        "stewardFetchAndCheckBase",
        {
          root: w.worktreePath,
          baseRemote: w.baseRemote,
          baseBranch: w.baseBranch,
          expectedPins: w.pins,
        },
        { hostId: w.hostId },
      );
      if (!res.pinsOk) {
        deps.store.stopWatch(w.id, `mark_changed: ${res.driftReason ?? "pin drift"}`, "stopped");
        deps.publishWatchUpdate(w.id);
        deps.publishNotification({
          watchId: w.id,
          repo: w.repo,
          prNumber: w.prNumber,
          state: "stopped",
          message: `Steward stopped due to checkout tamper drift: ${res.driftReason ?? "unknown"}`,
        });
      }
      deps.store.appendAudit({
        watchId: w.id,
        actor: "steward-worker",
        action: "steward.fetch_base",
        outcome: res.ok ? "ok" : "blocked",
        detail: { fetchedSha: res.fetchedSha, safe: res.safe, blockedPaths: res.blockedPaths, reason: res.reason },
      });
      return jsonTextResult(res, !res.ok);
    },
  });

  bb.agents.registerTool({
    name: "ship_steward_merge_base",
    description: "Merge a previously fetched & verified base commit SHA into the PR branch (max 2 merges/watch).",
    parameters: z
      .object({
        expectedBaseSha: z.string().regex(/^[0-9a-f]{40}$/u),
      })
      .strict(),
    async execute(params, ctx) {
      const w = requireWorkerWatch(ctx.threadId);
      if ("error" in w) return w.error;
      if (w.behindMergesCount >= MAX_BEHIND_MERGES) {
        return jsonTextResult(
          { ok: false, error: `Behind merge cap reached (${w.behindMergesCount}/${MAX_BEHIND_MERGES}). Call ship_steward_escalate.` },
          true,
        );
      }

      const res = await deps.hostClient.call(
        "stewardMergeBase",
        {
          root: w.worktreePath,
          baseRemote: w.baseRemote,
          baseBranch: w.baseBranch,
          headRemote: w.headRemote,
          headBranch: w.headBranch,
          expectedBaseSha: params.expectedBaseSha,
          expectedPins: w.pins,
        },
        { hostId: w.hostId },
      );

      if (res.ok) {
        deps.store.updateWatch(w.id, {
          behindMergesCount: w.behindMergesCount + 1,
          ...(res.headSha ? { lastHeadSha: res.headSha } : {}),
        });
        deps.publishWatchUpdate(w.id);
      }
      deps.store.appendAudit({
        watchId: w.id,
        actor: "steward-worker",
        action: "steward.merge_base",
        outcome: res.ok ? "ok" : "error",
        detail: {
          expectedBaseSha: params.expectedBaseSha,
          headSha: res.headSha,
          pushed: res.pushed,
          reason: res.reason,
        },
      });
      return jsonTextResult(res, !res.ok);
    },
  });

  bb.agents.registerTool({
    name: "ship_steward_commit_push",
    description:
      "Stage explicit safe files, commit with git hooks disabled, and push to the watched PR branch within per-cause budget.",
    parameters: z
      .object({
        files: z.array(z.string().min(1).max(1024)).min(1).max(50),
        commitMessage: z.string().min(1).max(4000),
        causeKey: z.string().min(1).max(160),
      })
      .strict(),
    async execute(params, ctx) {
      const w = requireWorkerWatch(ctx.threadId);
      if ("error" in w) return w.error;

      const maxPushes = await deps.getMaxPushesPerCause(w.repo);
      const currentCount = w.causePushCounts[params.causeKey] ?? 0;
      if (currentCount >= maxPushes) {
        return jsonTextResult(
          {
            ok: false,
            error: `Push cap reached for cause "${params.causeKey}" (${currentCount}/${maxPushes}). Call ship_steward_escalate.`,
          },
          true,
        );
      }

      const blockedPaths = params.files.filter((f) => isNeverEditPath(f) || isSecretFilename(f));
      if (blockedPaths.length > 0) {
        return jsonTextResult(
          { ok: false, error: `Refused protected or secret path(s): ${blockedPaths.join(", ")}` },
          true,
        );
      }

      const msgCheck = validateCommitMessage(params.commitMessage);
      if (!msgCheck.ok) {
        return jsonTextResult({ ok: false, error: `Invalid commit message: ${msgCheck.reason}` }, true);
      }

      const res = await deps.hostClient.call(
        "stewardCommitAndPush",
        {
          root: w.worktreePath,
          headRemote: w.headRemote,
          headBranch: w.headBranch,
          files: params.files,
          commitMessage: params.commitMessage,
          expectedPins: w.pins,
        },
        { hostId: w.hostId },
      );

      if (res.ok) {
        deps.store.updateWatch(w.id, {
          causePushCounts: { ...w.causePushCounts, [params.causeKey]: currentCount + 1 },
          ...(res.headSha ? { lastHeadSha: res.headSha } : {}),
        });
        deps.publishWatchUpdate(w.id);
      }
      deps.store.appendAudit({
        watchId: w.id,
        actor: "steward-worker",
        action: "steward.commit_push",
        outcome: res.ok ? "ok" : "error",
        detail: {
          causeKey: params.causeKey,
          fileCount: params.files.length,
          headSha: res.headSha,
          error: res.error,
        },
      });
      return jsonTextResult(res, !res.ok);
    },
  });

  bb.agents.registerTool({
    name: "ship_steward_rerun_job",
    description: "Rerun a single failed GitHub Actions CI job once per job ID.",
    parameters: z
      .object({
        jobId: z.number().int().positive(),
      })
      .strict(),
    async execute(params, ctx) {
      const w = requireWorkerWatch(ctx.threadId);
      if ("error" in w) return w.error;
      if (w.rerunJobIds.includes(params.jobId)) {
        return jsonTextResult(
          { ok: false, error: `Job ${params.jobId} was already rerun once (${MAX_RERUNS_PER_JOB} rerun/job limit).` },
          true,
        );
      }

      const res = await deps.hostClient.call(
        "stewardRerunJob",
        {
          root: w.worktreePath,
          repo: w.repo,
          jobId: params.jobId,
          expectedPins: w.pins,
        },
        { hostId: w.hostId },
      );

      if (res.ok) {
        deps.store.updateWatch(w.id, {
          rerunJobIds: [...w.rerunJobIds, params.jobId],
        });
        deps.publishWatchUpdate(w.id);
      }
      deps.store.appendAudit({
        watchId: w.id,
        actor: "steward-worker",
        action: "steward.rerun_job",
        outcome: res.ok ? "ok" : "error",
        detail: { jobId: params.jobId, error: res.error },
      });
      return jsonTextResult(res, !res.ok);
    },
  });

  bb.agents.registerTool({
    name: "ship_steward_reply_comment",
    description:
      "Post a sanitized, marked status or review reply to the watched PR via the Ship bot (no URLs, @mentions, or secrets).",
    parameters: z
      .object({
        body: z.string().min(1).max(7500),
        commentId: z.string().optional(),
        inReplyToId: z.number().int().positive().optional(),
      })
      .strict(),
    async execute(params, ctx) {
      const w = requireWorkerWatch(ctx.threadId);
      if ("error" in w) return w.error;

      const bot = await deps.getBotClient();
      if (!bot) {
        return jsonTextResult({ ok: false, error: "GitHub bot token is not configured." }, true);
      }

      const normalizedBody = params.body.startsWith(SHIP_MARKER_PREFIX)
        ? params.body
        : `${SHIP_MARKER_PREFIX} -->\n${params.body}`;

      const valid = validateCommentText(normalizedBody);
      if (!valid.ok) {
        return jsonTextResult({ ok: false, error: `Comment rejected: ${valid.reason}` }, true);
      }

      const secretScan = await deps.hostClient.call(
        "scanOutboundForLocalSecrets",
        { root: w.worktreePath, text: normalizedBody },
        { hostId: w.hostId },
      );
      if (!secretScan.ok) {
        return jsonTextResult(
          { ok: false, error: `Comment matched local secret (${secretScan.matchedSource}).` },
          true,
        );
      }

      const posted = params.inReplyToId
        ? await bot.postReviewReply(w.repo, w.prNumber, params.inReplyToId, normalizedBody)
        : await bot.postIssueComment(w.repo, w.prNumber, normalizedBody);

      if (params.commentId && !w.seenCommentIds.includes(params.commentId)) {
        deps.store.updateWatch(w.id, {
          seenCommentIds: [...w.seenCommentIds, params.commentId],
        });
      }
      deps.store.appendAudit({
        watchId: w.id,
        actor: "steward-worker",
        action: "steward.reply_comment",
        outcome: "ok",
        detail: { postedId: posted.id, commentId: params.commentId ?? null },
      });
      return jsonTextResult({ ok: true, id: posted.id, url: posted.url });
    },
  });

  bb.agents.registerTool({
    name: "ship_steward_escalate",
    description: "Mark the watched PR as needs_human and notify the user when automated fixes cannot proceed safely.",
    parameters: z
      .object({
        reason: z.string().min(1).max(1000),
      })
      .strict(),
    async execute(params, ctx) {
      const w = requireWorkerWatch(ctx.threadId);
      if ("error" in w) return w.error;
      deps.store.updateWatch(w.id, {
        state: "needs_human",
        stopReason: params.reason,
      });
      deps.store.appendAudit({
        watchId: w.id,
        actor: "steward-worker",
        action: "steward.escalate",
        outcome: "needs_human",
        detail: { reason: params.reason },
      });
      deps.publishWatchUpdate(w.id);
      deps.publishNotification({
        watchId: w.id,
        repo: w.repo,
        prNumber: w.prNumber,
        state: "needs_human",
        message: `PR ${w.repo}#${w.prNumber} needs human attention: ${params.reason}`,
      });
      return jsonTextResult({ ok: true, state: "needs_human", reason: params.reason });
    },
  });

  bb.agents.configure((context) => {
    try {
      const role = typeof context.pluginMetadata?.shipRole === "string" ? context.pluginMetadata.shipRole : "";
      if (role === "steward-worker") {
        const watchId =
          typeof context.pluginMetadata?.watchId === "string" ? context.pluginMetadata.watchId : "unknown";
        return {
          tools: [...STEWARD_TOOL_NAMES],
          skills: [],
          instructions: buildStewardSystemInstructions(watchId),
        };
      }
      if (role === "reviewer") {
        return { tools: [], skills: [] };
      }
      return {
        tools: [],
        skills: ["ship", "steward", "ship-approvals"],
      };
    } catch {
      return { tools: [], skills: [] };
    }
  });
}
