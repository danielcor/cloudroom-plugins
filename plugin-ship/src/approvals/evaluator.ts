import type { CachedClassifierEntry, ReviewRunRecord, ShipStore } from "../db.js";
import { runClassifierWithCache, type ClassifierEvalResult, type ClassifierExecutor } from "./classifiers.js";
import {
  buildApprovalFacts,
  evaluateDeterministicWhen,
  type ApprovalFacts,
  type ApprovalPrInfo,
} from "./facts.js";
import type { ApprovalAction, ApprovalsPolicy, LoadedClassifier } from "./parser.js";
import type { PolledCheckRunOutput } from "../contract.js";

const ACTION_SEVERITY: Record<ApprovalAction, number> = {
  approve: 1,
  comment: 2,
  request_changes: 3,
};

export interface EvaluatedApprovalRuleResult {
  ruleId: string;
  action: ApprovalAction;
  seats: number;
  deterministicMatched: boolean;
  failedReasons: string[];
  classifierResult: ClassifierEvalResult | null;
  matched: boolean;
}

export interface ApprovalDecision {
  repo: string;
  prNumber: number;
  headSha: string;
  policySha: string;
  statusContext: string;
  verdict: ApprovalAction;
  requiredSeats: number;
  usedFallbackDefault: boolean;
  matchedRuleIds: string[];
  classifierErrors: string[];
  classifierCallCount: number;
  classifierCacheHits: number;
  ruleResults: EvaluatedApprovalRuleResult[];
  classifierCache: Record<string, CachedClassifierEntry>;
  facts: ApprovalFacts;
}

export interface DevAutoMergeGuardResult {
  eligible: boolean;
  blockedReasons: string[];
}

function strictestAction(a: ApprovalAction, b: ApprovalAction): ApprovalAction {
  return ACTION_SEVERITY[a] >= ACTION_SEVERITY[b] ? a : b;
}

/**
 * Evaluate default-branch `.claude/approvals.yml` rules:
 * 1) free deterministic facts first,
 * 2) cached `(head_sha, classifier_sha)` LLM classifiers only for eligible rules,
 * 3) strictest verdict combination with fail-closed error handling.
 */
export async function evaluateApprovalsPolicy(input: {
  repo: string;
  policy: ApprovalsPolicy;
  policySha: string;
  classifiers: Map<string, LoadedClassifier>;
  pr: ApprovalPrInfo;
  checkRuns: readonly PolledCheckRunOutput[];
  diffText: string;
  store: ShipStore;
  executor: ClassifierExecutor | null;
  inRunCache?: Map<string, CachedClassifierEntry>;
  nowMs?: number;
}): Promise<ApprovalDecision> {
  const nowMs = input.nowMs ?? Date.now();
  const inRunCache = input.inRunCache ?? new Map<string, CachedClassifierEntry>();
  const facts = buildApprovalFacts(input.pr, input.checkRuns);

  // Step 1: evaluate ALL deterministic predicates first (zero LLM calls).
  const detResults = input.policy.rules.map((rule) => ({
    rule,
    det: evaluateDeterministicWhen(rule.when, facts),
  }));

  const ruleResults: EvaluatedApprovalRuleResult[] = [];
  const classifierErrors: string[] = [];
  let classifierCallCount = 0;
  let classifierCacheHits = 0;

  // Step 2: only invoke classifiers on rules whose free facts passed.
  for (const { rule, det } of detResults) {
    if (!det.matched) {
      ruleResults.push({
        ruleId: rule.id,
        action: rule.action,
        seats: rule.seats,
        deterministicMatched: false,
        failedReasons: det.failedReasons,
        classifierResult: null,
        matched: false,
      });
      continue;
    }

    if (!rule.classifier) {
      ruleResults.push({
        ruleId: rule.id,
        action: rule.action,
        seats: rule.seats,
        deterministicMatched: true,
        failedReasons: [],
        classifierResult: null,
        matched: true,
      });
      continue;
    }

    const clsDef = input.classifiers.get(rule.classifier.name);
    if (!clsDef) {
      const err = `Missing classifier definition "${rule.classifier.name}" for rule "${rule.id}".`;
      classifierErrors.push(err);
      ruleResults.push({
        ruleId: rule.id,
        action: rule.action,
        seats: rule.seats,
        deterministicMatched: true,
        failedReasons: [err],
        classifierResult: {
          name: rule.classifier.name,
          classifierSha: "",
          outcome: "error",
          passed: false,
          reason: err,
          cached: false,
          error: err,
        },
        matched: false,
      });
      continue;
    }

    const clsResult = await runClassifierWithCache({
      classifier: clsDef,
      expectedOutcome: rule.classifier.expect,
      repo: input.repo,
      pr: input.pr,
      diffText: input.diffText,
      store: input.store,
      executor: input.executor,
      inRunCache,
      nowMs,
    });
    if (clsResult.cached) classifierCacheHits += 1;
    else if (!clsResult.error) classifierCallCount += 1;
    else if (input.executor) classifierCallCount += 1;

    if (clsResult.error) {
      classifierErrors.push(`${rule.id} (${clsDef.name}): ${clsResult.error}`);
    }

    const matched = !clsResult.error && clsResult.passed;
    ruleResults.push({
      ruleId: rule.id,
      action: rule.action,
      seats: rule.seats,
      deterministicMatched: true,
      failedReasons: matched ? [] : [`classifier "${clsDef.name}": ${clsResult.reason}`],
      classifierResult: clsResult,
      matched,
    });
  }

  // Step 3: strictest matching verdict combination.
  const matchedRules = ruleResults.filter((r) => r.matched);
  let verdict: ApprovalAction;
  let requiredSeats: number;
  let usedFallbackDefault = false;

  if (matchedRules.length === 0) {
    verdict = input.policy.default_action;
    requiredSeats = verdict === "approve" ? 0 : 1;
    usedFallbackDefault = true;
  } else {
    verdict = "approve";
    requiredSeats = 0;
    for (const mr of matchedRules) {
      verdict = strictestAction(verdict, mr.action);
      if (mr.seats > requiredSeats) requiredSeats = mr.seats;
    }
    if (verdict === "request_changes" && requiredSeats < 1) {
      requiredSeats = 1;
    }
  }

  // Fail-closed: classifier errors must never yield an unconditional approval.
  if (classifierErrors.length > 0) {
    if (verdict === "approve") verdict = "comment";
    if (requiredSeats < 1) requiredSeats = 1;
  }

  const classifierCache: Record<string, CachedClassifierEntry> = {};
  for (const [k, v] of inRunCache.entries()) {
    classifierCache[k] = v;
  }

  return {
    repo: input.repo,
    prNumber: input.pr.number,
    headSha: input.pr.headSha,
    policySha: input.policySha,
    statusContext: input.policy.status_context,
    verdict,
    requiredSeats,
    usedFallbackDefault,
    matchedRuleIds: matchedRules.map((r) => r.ruleId),
    classifierErrors,
    classifierCallCount,
    classifierCacheHits,
    ruleResults,
    classifierCache,
    facts,
  };
}

/**
 * Enforce all 8 hard invariants before permitting opt-in `dev`-only auto-merge.
 */
export function evaluateDevAutoMergeGuard(input: {
  allowDevAutomerge: boolean;
  pr: ApprovalPrInfo;
  facts: ApprovalFacts;
  decision: ApprovalDecision;
  latestReviewRun: ReviewRunRecord | null;
}): DevAutoMergeGuardResult {
  const blockedReasons: string[] = [];

  if (!input.allowDevAutomerge) {
    blockedReasons.push("Repository allowDevAutomerge setting is false.");
  }
  if (input.pr.baseBranch.trim().toLowerCase() !== "dev") {
    blockedReasons.push(`Base branch "${input.pr.baseBranch}" is not "dev" (non-dev targets are hard-blocked).`);
  }
  if (input.pr.isDraft) {
    blockedReasons.push("PR is still a draft.");
  }
  if (!/^[0-9a-f]{40}$/u.test(input.pr.headSha) || input.decision.headSha !== input.pr.headSha) {
    blockedReasons.push("Head SHA mismatch or invalid SHA.");
  }
  if (
    input.decision.verdict !== "approve" ||
    input.decision.requiredSeats !== 0 ||
    input.decision.classifierErrors.length > 0
  ) {
    blockedReasons.push(
      `Approvals verdict "${input.decision.verdict}" (seats=${input.decision.requiredSeats}, errors=${input.decision.classifierErrors.length}) does not grant auto-merge.`,
    );
  }
  if (
    !input.latestReviewRun ||
    input.latestReviewRun.headSha !== input.pr.headSha ||
    input.latestReviewRun.verdict !== "APPROVE"
  ) {
    blockedReasons.push(
      input.latestReviewRun
        ? `Latest Ship review (${input.latestReviewRun.verdict} at ${input.latestReviewRun.headSha.slice(0, 7)}) is not APPROVE at HEAD ${input.pr.headSha.slice(0, 7)}.`
        : `No clean Ship APPROVE review recorded at HEAD ${input.pr.headSha.slice(0, 7)}.`,
    );
  }
  if (!input.facts.ciGreen) {
    blockedReasons.push(
      `CI checks are not green (total=${input.facts.totalChecks}, failing=${input.facts.failingChecks}, pending=${input.facts.pendingChecks}).`,
    );
  }
  if (input.facts.collisionLabels.length > 0) {
    blockedReasons.push(`Collision labels active: ${input.facts.collisionLabels.join(", ")}`);
  }
  if (input.facts.touchedNeverEditPaths.length > 0) {
    blockedReasons.push(
      `Protected/secret paths touched: ${input.facts.touchedNeverEditPaths.slice(0, 5).join(", ")}`,
    );
  }

  return {
    eligible: blockedReasons.length === 0,
    blockedReasons,
  };
}
