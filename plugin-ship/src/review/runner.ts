import { randomUUID } from "node:crypto";
import type { BbPluginApi, PluginThreadSettledEvent } from "@get-bb/plugin-sdk";
import type { InspectReviewContextOutput } from "../contract.js";
import type { ReviewFindingRecord, ReviewRunRecord, ShipStore } from "../db.js";
import { GitHubBotClient, type ReviewInlineCommentInput } from "../github/bot.js";
import { fetchPrDiscussion, type FilteredPrDiscussion } from "../github/comments.js";
import { normalizePathForCheck } from "../safety/never-edit.js";
import { validateCommentText } from "../safety/outbound-text.js";
import { evaluateReviewDedup, extractLastReviewedSha, type ReviewDedupResult } from "./dedup.js";
import { resolveReviewSeats, type CooldownEntry, type DispatchExec } from "./dispatch.js";
import { runSingleReview } from "./single.js";
import { runSolLoopReview } from "./sol-loop.js";
import { runTriadReview } from "./triad.js";
import {
  classifyRiskTier,
  type MergedReviewFinding,
  type ReviewEffort,
  type ReviewMode,
  type ReviewSeatRoute,
  type ReviewVerdict,
  type ReviewerGatekeeper,
  type RiskTier,
  type SeatExecutionInput,
  type SeatExecutionResult,
  type SeatExecutor,
  type SeatOutcome,
  type StopSplitTrigger,
} from "./types.js";

export type SettledThreadWaiter = {
  resolve: (event: PluginThreadSettledEvent) => void;
};

function sanitizeOutboundMarkdown(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<!--/gu, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/giu, "[link-removed]")
    .replace(/\bwww\.[^\s)]+/giu, "[link-removed]")
    .replace(/(^|[^A-Za-z0-9_])@([A-Za-z0-9])/gu, "$1at-$2")
    .replace(/\\$/gmu, "")
    .replace(/^\s*\//gmu, "./")
    .replace(/\r?\n/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function formatReviewCommentBody(input: {
  headSha: string;
  mode: ReviewMode;
  round: number;
  verdict: ReviewVerdict;
  riskTier: RiskTier;
  validSeats: number;
  targetSeats: number;
  meanScore: number | null;
  findings: readonly MergedReviewFinding[];
  stopReason?: string | null;
}): string {
  const lines = [
    `<!-- cloudroom-ship reviewed=${input.headSha.toLowerCase()} -->`,
    `**Cloudroom Ship Review** (${input.mode}, round ${input.round}) — Verdict: **${input.verdict}**`,
    `Risk: ${input.riskTier} | Valid seats: ${input.validSeats}/${input.targetSeats} | Mean score: ${input.meanScore ?? "n/a"}`,
  ];

  if (input.stopReason) {
    lines.push(`Notice: ${sanitizeOutboundMarkdown(input.stopReason)}`);
  }

  if (input.findings.length === 0) {
    lines.push("No findings.");
  } else {
    lines.push("");
    lines.push("Findings:");
    for (const f of input.findings.slice(0, 20)) {
      const safeFile = sanitizeOutboundMarkdown(f.file).slice(0, 120);
      const loc = f.line ? `${safeFile}:${f.line}` : safeFile;
      const scopeTag = f.shared ? `shared: ${f.raisers.join("+")}` : `single: ${f.raisers.join("+")}`;
      const safeClaim = sanitizeOutboundMarkdown(f.claim).slice(0, 240);
      const safeFix = sanitizeOutboundMarkdown(f.fix).slice(0, 180);
      const line = `- ${f.id} [${f.severity}] (${scopeTag}) \`${loc}\`: ${safeClaim}${safeFix ? ` Fix: ${safeFix}` : ""}`;
      if (lines.join("\n").length + line.length + 1 > 7500) break;
      lines.push(line);
    }
  }

  return lines.join("\n");
}

export function buildSanitizedInlineComments(
  findings: readonly MergedReviewFinding[],
  committedFiles: readonly string[],
): ReviewInlineCommentInput[] {
  const committedSet = new Set(committedFiles.map(normalizePathForCheck));
  const out: ReviewInlineCommentInput[] = [];

  for (const f of findings) {
    if (f.line === null || !Number.isInteger(f.line) || f.line <= 0) continue;
    if (!committedSet.has(normalizePathForCheck(f.file))) continue;
    const claim = sanitizeOutboundMarkdown(f.claim).slice(0, 400);
    const fix = sanitizeOutboundMarkdown(f.fix).slice(0, 250);
    const body = `[${f.severity}] ${claim}${fix ? ` Fix: ${fix}` : ""}`.trim();
    const check = validateCommentText(body, { requireMarker: false });
    if (!check.ok) continue;
    out.push({
      path: f.file,
      line: f.line,
      side: "RIGHT",
      body,
    });
  }

  return out;
}

function classifySeatError(errorText: string): SeatExecutionResult["errorCategory"] {
  const lower = errorText.toLowerCase();
  if (lower.includes("429") || lower.includes("quota") || lower.includes("rate limit")) return "quota";
  if (lower.includes("auth") || lower.includes("login") || lower.includes("401") || lower.includes("expired")) return "auth";
  if (lower.includes("entitlement") || lower.includes("access")) return "entitlement";
  if (lower.includes("unknown model") || lower.includes("invalid model")) return "unknown_model";
  if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
  return "other";
}

export function createCloudroomSeatExecutor(opts: {
  bb: BbPluginApi;
  projectId: string;
  parentThreadId?: string | null;
  headSha: string;
  gatekeeper: ReviewerGatekeeper;
  settledWaiters: Map<string, SettledThreadWaiter>;
  seatTimeoutMs?: number;
}): SeatExecutor {
  const timeoutMs = opts.seatTimeoutMs ?? 20 * 60 * 1000;

  return async (input: SeatExecutionInput): Promise<SeatExecutionResult> => {
    const useHostWorktree = !input.route.isCloud && Boolean(input.route.hostId);
    const spawned = await opts.bb.sdk.threads.spawn({
      projectId: opts.projectId,
      ...(opts.parentThreadId ? { parentThreadId: opts.parentThreadId } : {}),
      title: `ship review ${input.reviewRunId.slice(0, 8)} ${input.seatName} #${input.attempt}`,
      providerId: input.route.providerId,
      model: input.route.model,
      reasoningLevel: input.route.reasoningLevel,
      permissionMode: "accept-edits",
      environment: useHostWorktree
        ? {
            type: "host",
            hostId: input.route.hostId!,
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "named", name: opts.headSha },
            },
          }
        : { type: "project-default" },
      pluginMetadata: {
        shipRole: "reviewer",
        reviewRunId: input.reviewRunId,
        seatName: input.seatName,
        attempt: input.attempt,
        contextMode: input.contextMode,
      },
      prompt: input.prompt,
    });

    const threadId = spawned.id;
    const environmentId = spawned.environmentId ?? null;

    // Register both gatekeeper and settlement waiter synchronously BEFORE any await.
    opts.gatekeeper.register(threadId, {
      mode: input.contextMode,
      worktreePath: null,
      reviewRunId: input.reviewRunId,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const settledPromise = new Promise<PluginThreadSettledEvent | "timeout">((resolve) => {
      opts.settledWaiters.set(threadId, { resolve });
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    if (input.contextMode === "checkout" && environmentId) {
      void opts.bb.sdk.environments
        .get({ environmentId })
        .then((env) => {
          const cur = opts.gatekeeper.get(threadId);
          if (cur && env.path) {
            opts.gatekeeper.register(threadId, { ...cur, worktreePath: env.path });
          }
        })
        .catch(() => undefined);
    }

    try {
      const event = await settledPromise;
      if (event === "timeout") {
        return {
          ok: false,
          replyText: null,
          error: `Seat timed out after ${timeoutMs}ms`,
          errorCategory: "timeout",
          threadId,
          environmentId,
        };
      }
      if (event.outcome === "completed") {
        let replyText = event.lastAssistantText;
        if (!replyText) {
          const out = await opts.bb.sdk.threads.output({ threadId }).catch(() => null);
          replyText = out?.output ?? null;
        }
        return {
          ok: Boolean(replyText),
          replyText,
          error: replyText ? null : "Reviewer thread finished with empty output",
          threadId,
          environmentId,
        };
      }
      const errMsg =
        event.outcome === "failed"
          ? event.error || "Reviewer turn failed"
          : `Reviewer thread ended with outcome: ${event.outcome}`;
      return {
        ok: false,
        replyText: null,
        error: errMsg,
        errorCategory: classifySeatError(errMsg),
        threadId,
        environmentId,
      };
    } finally {
      if (timer) clearTimeout(timer);
      opts.settledWaiters.delete(threadId);
      opts.gatekeeper.unregister(threadId);
      await opts.bb.sdk.threads.stop({ threadId }).catch(() => undefined);
      await opts.bb.sdk.threads.archive({ threadId }).catch(() => undefined);
      if (environmentId) {
        await opts.bb.sdk.environments.delete({ environmentId }).catch(() => undefined);
      }
    }
  };
}

export interface RunShipReviewOptions {
  hostId: string | null;
  root: string;
  repo?: string;
  prNumber?: number | null;
  baseRef?: string;
  mode?: ReviewMode;
  effort?: ReviewEffort;
  defaultMode?: ReviewMode;
  defaultEffort?: ReviewEffort;
  intent?: string;
  outOfScope?: string;
  checks?: string;
  round?: number;
  maxRounds?: number;
  force?: boolean;
  post?: boolean;
  dryRun?: boolean;
  allowCloud?: boolean;
  authorFamily?: string | null;
  overrideProvider?: string;
  overrideModel?: string;
  watchId?: string | null;
  priorSameAreaChurnCount?: number;
  nowMs?: () => number;
}

export type ShipReviewResult =
  | {
      status: "blocked";
      reason: string;
      headSha: string;
    }
  | {
      status: "skipped";
      reason: string;
      headSha: string;
      dedup: ReviewDedupResult;
    }
  | {
      status: "dry_run";
      reviewRunId: string;
      repoSlug: string | null;
      headSha: string;
      baseSha: string;
      mode: ReviewMode;
      effort: ReviewEffort;
      riskTier: RiskTier;
      allowCheckout: boolean;
      seats: ReviewSeatRoute[];
      skippedReasons: string[];
      dedup: ReviewDedupResult | null;
    }
  | {
      status: "completed";
      reviewRunId: string;
      repoSlug: string | null;
      prNumber: number | null;
      headSha: string;
      baseSha: string;
      mode: ReviewMode;
      effort: ReviewEffort;
      round: number;
      riskTier: RiskTier;
      verdict: ReviewVerdict;
      validSeats: number;
      targetSeats: number;
      meanScore: number | null;
      seatOutcomes: SeatOutcome[];
      findings: MergedReviewFinding[];
      stopTrigger: StopSplitTrigger | null;
      stopReason: string | null;
      postedReviewId: number | null;
      postError: string | null;
      dedup: ReviewDedupResult | null;
    };

export interface ShipReviewDeps {
  store: ShipStore;
  inspectReviewContext: (input: {
    root: string;
    baseRef?: string;
    priorReviewedSha?: string;
  }) => Promise<InspectReviewContextOutput>;
  scanOutboundForLocalSecrets: (input: { root: string; text: string }) => Promise<{
    ok: boolean;
    matchedSource: string | null;
  }>;
  readPrDiscussion?: (input: {
    root: string;
    repo: string;
    prNumber: number;
    trustedBots: string[];
  }) => Promise<FilteredPrDiscussion>;
  botClient?: GitHubBotClient | null;
  executor: SeatExecutor;
  execDispatch?: DispatchExec;
  cooldowns?: readonly CooldownEntry[];
}

function findingsFromStoredRows(rows: readonly ReviewFindingRecord[]): MergedReviewFinding[] {
  return rows.map((r) => {
    let raisers: string[] = [];
    try {
      const parsed = JSON.parse(r.raisersJson);
      if (Array.isArray(parsed)) raisers = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      raisers = [];
    }
    return {
      id: r.id.split(":").at(-1) || r.id,
      severity: r.severity as MergedReviewFinding["severity"],
      file: r.file,
      line: r.line,
      claim: r.claim,
      evidence: "",
      fix: "",
      raisers,
      shared: raisers.length >= 2,
      status: r.status as MergedReviewFinding["status"],
    };
  });
}

export async function runShipReview(
  opts: RunShipReviewOptions,
  deps: ShipReviewDeps,
): Promise<ShipReviewResult> {
  const nowMs = opts.nowMs ?? Date.now;
  const reviewRunId = `rev_${randomUUID()}`;

  let reviewCtx = await deps.inspectReviewContext({
    root: opts.root,
    ...(opts.baseRef ? { baseRef: opts.baseRef } : {}),
  });

  if (reviewCtx.secretBlockedReason) {
    deps.store.appendAudit({
      watchId: opts.watchId ?? null,
      actor: "review",
      action: "review.blocked_secret",
      outcome: "blocked",
      detail: { headSha: reviewCtx.headSha, reason: reviewCtx.secretBlockedReason },
    });
    return {
      status: "blocked",
      reason: reviewCtx.secretBlockedReason,
      headSha: reviewCtx.headSha,
    };
  }

  const repoSlug = opts.repo ?? reviewCtx.repoSlug;
  const repoCfg = repoSlug ? deps.store.getRepo(repoSlug) : null;
  const mode: ReviewMode = opts.mode ?? repoCfg?.reviewMode ?? opts.defaultMode ?? "triad";
  const effort: ReviewEffort = opts.effort ?? repoCfg?.reviewEffort ?? opts.defaultEffort ?? "high";
  const maxRounds = opts.maxRounds ?? repoCfg?.maxReviewRounds ?? 4;

  let dedup: ReviewDedupResult | null = null;
  if (opts.prNumber && repoSlug) {
    const checkRuns = deps.botClient
      ? await deps.botClient.getCheckRuns(repoSlug, reviewCtx.headSha).catch(() => [])
      : [];
    const discussion = deps.readPrDiscussion
      ? await deps
          .readPrDiscussion({
            root: opts.root,
            repo: repoSlug,
            prNumber: opts.prNumber,
            trustedBots: repoCfg?.trustedBots ?? [],
          })
          .catch(() => null)
      : deps.botClient
        ? await fetchPrDiscussion({
            repo: repoSlug,
            prNumber: opts.prNumber,
            trustedBots: repoCfg?.trustedBots ?? [],
            runGraphql: (q, v) => deps.botClient!.graphql(q, v),
            fetchCollaboratorPermission: (r, u) => deps.botClient!.getCollaboratorPermission(r, u),
          }).catch(() => null)
        : null;

    const comments = discussion ? discussion.items : [];
    const lastSha = extractLastReviewedSha(comments);

    dedup = await evaluateReviewDedup({
      headSha: reviewCtx.headSha,
      baseSha: reviewCtx.baseSha,
      checkRuns,
      comments,
      force: opts.force,
      isAncestor: async (ancSha) => {
        const probe = await deps.inspectReviewContext({
          root: opts.root,
          baseRef: ancSha,
          priorReviewedSha: ancSha,
        });
        return probe.priorReviewedIsAncestor;
      },
    });

    if (dedup.skip) {
      deps.store.appendAudit({
        watchId: opts.watchId ?? null,
        actor: "review",
        action: "review.skipped",
        outcome: "skipped",
        detail: { repo: repoSlug, prNumber: opts.prNumber, headSha: reviewCtx.headSha, reason: dedup.reason },
      });
      return {
        status: "skipped",
        reason: dedup.reason ?? "Skipped duplicate review.",
        headSha: reviewCtx.headSha,
        dedup,
      };
    }

    if (dedup.mode === "incremental" && lastSha && lastSha !== reviewCtx.baseSha) {
      reviewCtx = await deps.inspectReviewContext({
        root: opts.root,
        baseRef: dedup.reviewBaseSha,
        priorReviewedSha: dedup.reviewBaseSha,
      });
      if (reviewCtx.secretBlockedReason) {
        deps.store.appendAudit({
          watchId: opts.watchId ?? null,
          actor: "review",
          action: "review.blocked_secret",
          outcome: "blocked",
          detail: { headSha: reviewCtx.headSha, reason: reviewCtx.secretBlockedReason },
        });
        return {
          status: "blocked",
          reason: reviewCtx.secretBlockedReason,
          headSha: reviewCtx.headSha,
        };
      }
    }
  }

  const riskTier = classifyRiskTier(reviewCtx.changedFiles, reviewCtx.diffText);
  const allowCheckout = !reviewCtx.unsafeWorktreeHooks && !reviewCtx.hasEscapingSymlinks;

  const resolved = await resolveReviewSeats({
    mode,
    effort,
    hostId: opts.hostId,
    authorFamily: opts.authorFamily,
    allowCloud: opts.allowCloud,
    now: new Date(nowMs()),
    cooldowns: deps.cooldowns,
    overrideProvider: opts.overrideProvider,
    overrideModel: opts.overrideModel,
    execDispatch: deps.execDispatch,
  });

  if (opts.dryRun) {
    return {
      status: "dry_run",
      reviewRunId,
      repoSlug,
      headSha: reviewCtx.headSha,
      baseSha: reviewCtx.baseSha,
      mode,
      effort,
      riskTier,
      allowCheckout,
      seats: resolved.seats,
      skippedReasons: resolved.skippedReasons,
      dedup,
    };
  }

  const prevRun = repoSlug && opts.prNumber ? deps.store.getLastReviewRun(repoSlug, opts.prNumber) : null;
  const round = opts.round ?? (prevRun && prevRun.headSha !== reviewCtx.headSha ? prevRun.round + 1 : 1);
  const priorFindings = prevRun ? findingsFromStoredRows(deps.store.listReviewFindings(prevRun.id)) : [];
  const previousRoundFiles = priorFindings.map((f) => f.file);
  const previousRoundCount = prevRun ? priorFindings.length : null;

  const intent =
    opts.intent?.trim() ||
    `Review ${reviewCtx.changedFiles.length} changed file(s) on branch ${reviewCtx.branch ?? reviewCtx.headSha.slice(0, 8)}`;

  let verdict: ReviewVerdict;
  let validSeats: number;
  let targetSeats: number;
  let meanScore: number | null;
  let seatOutcomes: SeatOutcome[];
  let findings: MergedReviewFinding[];
  let stopTrigger: StopSplitTrigger | null = null;
  let stopReason: string | null = null;

  if (mode === "triad") {
    const out = await runTriadReview(
      {
        reviewRunId,
        repoSlug: repoSlug ?? "local/repo",
        baseSha: reviewCtx.baseSha,
        headSha: reviewCtx.headSha,
        intent,
        outOfScope: opts.outOfScope,
        checks: opts.checks,
        diffText: reviewCtx.diffText,
        seats: resolved.seats,
        fallbackPool: resolved.fallbackPool,
        allowCheckout,
      },
      deps.executor,
    );
    verdict = out.verdict;
    validSeats = out.validSeats;
    targetSeats = out.targetSeats;
    meanScore = out.meanScore;
    seatOutcomes = out.seatOutcomes;
    findings = out.findings;
  } else if (mode === "sol-loop") {
    const out = await runSolLoopReview(
      {
        reviewRunId,
        repoSlug: repoSlug ?? "local/repo",
        baseSha: reviewCtx.baseSha,
        headSha: reviewCtx.headSha,
        intent,
        outOfScope: opts.outOfScope,
        checks: opts.checks,
        diffText: reviewCtx.diffText,
        round,
        maxRounds,
        seats: resolved.seats,
        allowCheckout,
        priorFindings,
        previousRoundCount,
        previousRoundFiles,
        priorSameAreaChurnCount: opts.priorSameAreaChurnCount ?? 0,
      },
      deps.executor,
    );
    verdict = out.verdict;
    validSeats = out.validSeats;
    targetSeats = out.targetSeats;
    meanScore = out.meanScore;
    seatOutcomes = out.seatOutcomes;
    findings = out.findings;
    stopTrigger = out.stopTrigger;
    stopReason = out.stopReason;
  } else {
    const out = await runSingleReview(
      {
        reviewRunId,
        repoSlug: repoSlug ?? "local/repo",
        baseSha: reviewCtx.baseSha,
        headSha: reviewCtx.headSha,
        intent,
        outOfScope: opts.outOfScope,
        checks: opts.checks,
        diffText: reviewCtx.diffText,
        seats: resolved.seats,
        fallbackPool: resolved.fallbackPool,
        allowCheckout,
      },
      deps.executor,
    );
    verdict = out.verdict;
    validSeats = out.validSeats;
    targetSeats = out.targetSeats;
    meanScore = out.meanScore;
    seatOutcomes = out.seatOutcomes;
    findings = out.findings;
  }

  const runRecord: ReviewRunRecord = {
    id: reviewRunId,
    watchId: opts.watchId ?? null,
    repo: repoSlug ?? "local/repo",
    prNumber: opts.prNumber ?? 0,
    headSha: reviewCtx.headSha,
    mode,
    round,
    seatsJson: JSON.stringify(
      seatOutcomes.map((s) => ({
        seatName: s.seatName,
        family: s.family,
        providerId: s.providerId,
        model: s.model,
        ok: s.ok,
        attempts: s.attempts,
        verdict: s.verdict,
        score: s.score,
        error: s.error,
      })),
    ),
    verdict,
    meanScore,
    createdAt: nowMs(),
  };

  const findingRecords: ReviewFindingRecord[] = findings.map((f) => ({
    id: `${reviewRunId}:${f.id}`,
    reviewRunId,
    severity: f.severity,
    file: f.file,
    line: f.line,
    claim: f.claim,
    raisersJson: JSON.stringify(f.raisers),
    status: f.status,
    resolutionSha: null,
  }));

  deps.store.insertReviewRun(runRecord, findingRecords);

  let postedReviewId: number | null = null;
  let postError: string | null = null;

  if (opts.post) {
    if (!opts.prNumber || !repoSlug) {
      postError = "Cannot post review without repository slug and PR number.";
    } else if (!deps.botClient) {
      postError = "GitHub bot token is not configured.";
    } else {
      const summaryBody = formatReviewCommentBody({
        headSha: reviewCtx.headSha,
        mode,
        round,
        verdict,
        riskTier,
        validSeats,
        targetSeats,
        meanScore,
        findings,
        stopReason,
      });
      const textCheck = validateCommentText(summaryBody, { requireReviewedSha: true });
      if (!textCheck.ok) {
        postError = `Outbound review summary blocked: ${textCheck.reason}`;
      } else {
        const localSecretCheck = await deps.scanOutboundForLocalSecrets({
          root: opts.root,
          text: summaryBody,
        });
        if (!localSecretCheck.ok) {
          postError = `Outbound review summary matched local secret (${localSecretCheck.matchedSource}).`;
        } else {
          let inlineComments = buildSanitizedInlineComments(findings, reviewCtx.committedFiles);
          if (inlineComments.length > 0) {
            const inlineSecretCheck = await deps.scanOutboundForLocalSecrets({
              root: opts.root,
              text: inlineComments.map((c) => c.body).join("\n"),
            });
            if (!inlineSecretCheck.ok) {
              inlineComments = [];
            }
          }
          try {
            const posted = await deps.botClient.submitReview(repoSlug, opts.prNumber, {
              commitId: reviewCtx.headSha,
              event: verdict === "CHANGES" ? "REQUEST_CHANGES" : "COMMENT",
              body: summaryBody,
              comments: inlineComments,
            });
            postedReviewId = posted.id;
          } catch (err) {
            postError = err instanceof Error ? err.message : "Failed to submit GitHub bot review.";
          }
        }
      }
    }
  }

  deps.store.appendAudit({
    watchId: opts.watchId ?? null,
    actor: "review",
    action: "review.completed",
    outcome: verdict === "INCOMPLETE" ? "incomplete" : "ok",
    detail: {
      reviewRunId,
      repo: repoSlug,
      prNumber: opts.prNumber ?? null,
      headSha: reviewCtx.headSha,
      mode,
      round,
      verdict,
      validSeats,
      targetSeats,
      findingCount: findings.length,
      stopTrigger,
      postedReviewId,
      postError,
    },
  });

  return {
    status: "completed",
    reviewRunId,
    repoSlug,
    prNumber: opts.prNumber ?? null,
    headSha: reviewCtx.headSha,
    baseSha: reviewCtx.baseSha,
    mode,
    effort,
    round,
    riskTier,
    verdict,
    validSeats,
    targetSeats,
    meanScore,
    seatOutcomes,
    findings,
    stopTrigger,
    stopReason,
    postedReviewId,
    postError,
    dedup,
  };
}
