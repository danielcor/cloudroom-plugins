import type { ApprovalsMode } from "../contract.js";
import type { CommitStatusState, GitHubBotClient, ReviewEvent } from "../github/bot.js";
import { SHIP_MARKER_PREFIX, validateCommentText } from "../safety/outbound-text.js";
import type { ApprovalDecision } from "./evaluator.js";

export interface ApprovalReportResult {
  effectiveMode: ApprovalsMode;
  statusPosted: boolean;
  reviewPosted: boolean;
  statusState: CommitStatusState | null;
  statusDescription: string | null;
  reviewEvent: ReviewEvent | null;
  statusId: number | null;
  reviewId: number | null;
  error: string | null;
}

function sanitizeInlineText(raw: string): string {
  return raw
    .replace(/<!--/gu, "")
    .replace(/-->/gu, "")
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/giu, "[link-removed]")
    .replace(/\bwww\.[^\s)]+/giu, "[link-removed]")
    .replace(/(^|[^A-Za-z0-9_])@([A-Za-z0-9])/gu, "$1at-$2")
    .replace(/^\s*\//gmu, "./")
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\\+$/u, "")
    .trim();
}

/**
 * Format a safe, marked bot PR review comment summarizing an approval policy decision.
 */
export function formatApprovalReviewBody(mode: ApprovalsMode, decision: ApprovalDecision): string {
  const matchedSummary =
    decision.matchedRuleIds.length > 0
      ? `Matched rules: ${decision.matchedRuleIds.map(sanitizeInlineText).join(", ")}`
      : decision.usedFallbackDefault
        ? "Matched rules: none (used policy default_action)"
        : "Matched rules: none";

  const lines = [
    `${SHIP_MARKER_PREFIX} -->`,
    `Ship Approvals (${mode}): head=${decision.headSha.slice(0, 12)}, verdict=${decision.verdict}, requiredSeats=${decision.requiredSeats}, policy=${decision.policySha.slice(0, 12)}`,
    matchedSummary,
  ];

  if (decision.classifierErrors.length > 0) {
    lines.push(
      `Classifier failures (${decision.classifierErrors.length}): ${decision.classifierErrors.slice(0, 3).map(sanitizeInlineText).join("; ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * Derive GitHub Commit Status and PR Review event from `observe` vs `enforce` policy mode.
 */
export function computeApprovalSignals(
  mode: Exclude<ApprovalsMode, "off">,
  decision: ApprovalDecision,
): {
  statusState: CommitStatusState;
  statusDescription: string;
  reviewEvent: ReviewEvent;
} {
  if (mode === "observe") {
    return {
      statusState: "success",
      statusDescription: `[observe] verdict=${decision.verdict} seats=${decision.requiredSeats} (${decision.matchedRuleIds.join(",") || "default"})`.slice(
        0,
        140,
      ),
      reviewEvent: "COMMENT",
    };
  }

  if (decision.classifierErrors.length > 0 || decision.verdict === "request_changes") {
    return {
      statusState: "failure",
      statusDescription:
        decision.classifierErrors.length > 0
          ? `Approvals fail-closed: classifier error (${decision.classifierErrors.length})`.slice(0, 140)
          : `Approvals requested changes (seats=${decision.requiredSeats})`.slice(0, 140),
      reviewEvent: decision.verdict === "request_changes" ? "REQUEST_CHANGES" : "COMMENT",
    };
  }

  if (decision.verdict === "approve" && decision.requiredSeats === 0) {
    return {
      statusState: "success",
      statusDescription: `Approved by policy (${decision.matchedRuleIds.join(",") || "default"})`.slice(0, 140),
      reviewEvent: "APPROVE",
    };
  }

  return {
    statusState: "pending",
    statusDescription: `Awaiting ${Math.max(1, decision.requiredSeats)} approval seat(s) (${decision.verdict})`.slice(
      0,
      140,
    ),
    reviewEvent: "COMMENT",
  };
}

/**
 * Post GitHub Commit Status and bot PR review via the dedicated `botToken` client.
 */
export async function reportApprovalDecision(input: {
  repo: string;
  prNumber: number;
  root: string;
  effectiveMode: ApprovalsMode;
  decision: ApprovalDecision;
  botClient: GitHubBotClient | null;
  scanOutboundForLocalSecrets: (arg: { root: string; text: string }) => Promise<{
    ok: boolean;
    matchedSource: string | null;
  }>;
}): Promise<ApprovalReportResult> {
  if (input.effectiveMode === "off") {
    return {
      effectiveMode: "off",
      statusPosted: false,
      reviewPosted: false,
      statusState: null,
      statusDescription: null,
      reviewEvent: null,
      statusId: null,
      reviewId: null,
      error: null,
    };
  }

  const signals = computeApprovalSignals(input.effectiveMode, input.decision);
  if (!input.botClient) {
    return {
      effectiveMode: input.effectiveMode,
      statusPosted: false,
      reviewPosted: false,
      statusState: signals.statusState,
      statusDescription: signals.statusDescription,
      reviewEvent: signals.reviewEvent,
      statusId: null,
      reviewId: null,
      error: "GitHub botToken is not configured; cannot post approvals status or review.",
    };
  }

  const body = formatApprovalReviewBody(input.effectiveMode, input.decision);
  const valid = validateCommentText(body);
  if (!valid.ok) {
    return {
      effectiveMode: input.effectiveMode,
      statusPosted: false,
      reviewPosted: false,
      statusState: signals.statusState,
      statusDescription: signals.statusDescription,
      reviewEvent: signals.reviewEvent,
      statusId: null,
      reviewId: null,
      error: `Approval review body failed outbound text validation: ${valid.reason}`,
    };
  }

  const secretCheck = await input.scanOutboundForLocalSecrets({ root: input.root, text: body });
  if (!secretCheck.ok) {
    return {
      effectiveMode: input.effectiveMode,
      statusPosted: false,
      reviewPosted: false,
      statusState: signals.statusState,
      statusDescription: signals.statusDescription,
      reviewEvent: signals.reviewEvent,
      statusId: null,
      reviewId: null,
      error: `Approval review body matched local secret (${secretCheck.matchedSource}).`,
    };
  }

  try {
    const statusRes = await input.botClient.postCommitStatus(input.repo, input.decision.headSha, {
      state: signals.statusState,
      context: input.decision.statusContext,
      description: signals.statusDescription,
    });
    const reviewRes = await input.botClient.submitReview(input.repo, input.prNumber, {
      commitId: input.decision.headSha,
      event: signals.reviewEvent,
      body,
    });

    return {
      effectiveMode: input.effectiveMode,
      statusPosted: true,
      reviewPosted: true,
      statusState: signals.statusState,
      statusDescription: signals.statusDescription,
      reviewEvent: signals.reviewEvent,
      statusId: statusRes.id,
      reviewId: reviewRes.id,
      error: null,
    };
  } catch (err) {
    return {
      effectiveMode: input.effectiveMode,
      statusPosted: false,
      reviewPosted: false,
      statusState: signals.statusState,
      statusDescription: signals.statusDescription,
      reviewEvent: signals.reviewEvent,
      statusId: null,
      reviewId: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
