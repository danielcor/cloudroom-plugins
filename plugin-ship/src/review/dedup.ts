import type { CheckRunSummary } from "../github/bot.js";

export const REVIEWED_MARKER_RE = /<!--\s*cloudroom-ship\s+reviewed=([0-9a-f]{40})\s*-->/iu;

export interface ReviewMarkerCommentLike {
  body: string;
  createdAt?: string;
}

export function extractLastReviewedSha(comments: readonly ReviewMarkerCommentLike[]): string | null {
  const ordered = [...comments].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  let latest: string | null = null;
  for (const c of ordered) {
    const m = REVIEWED_MARKER_RE.exec(c.body);
    if (m) {
      latest = m[1]!.toLowerCase();
    }
  }
  return latest;
}

export interface HostedReviewDetection {
  found: boolean;
  checkRunName: string | null;
  status: string | null;
  conclusion: string | null;
}

const HOSTED_SKIPPED_CONCLUSIONS = new Set(["cancelled", "skipped", "failure", "timed_out", "stale"]);

export function detectHostedClaudeReview(checkRuns: readonly CheckRunSummary[]): HostedReviewDetection {
  for (const run of checkRuns) {
    const lower = run.name.toLowerCase();
    if (!lower.includes("claude code review") && !lower.includes("claude-code-review")) {
      continue;
    }
    const status = run.status.toLowerCase();
    const conclusion = run.conclusion ? run.conclusion.toLowerCase() : null;
    if (conclusion && HOSTED_SKIPPED_CONCLUSIONS.has(conclusion)) {
      continue;
    }
    if (status === "queued" || status === "in_progress" || status === "completed") {
      return {
        found: true,
        checkRunName: run.name,
        status: run.status,
        conclusion: run.conclusion,
      };
    }
  }
  return { found: false, checkRunName: null, status: null, conclusion: null };
}

export interface ReviewDedupResult {
  skip: boolean;
  reason: string | null;
  mode: "full" | "incremental";
  reviewBaseSha: string;
  lastReviewedSha: string | null;
  hostedReviewName: string | null;
}

export async function evaluateReviewDedup(opts: {
  headSha: string;
  baseSha: string;
  checkRuns: readonly CheckRunSummary[];
  comments: readonly ReviewMarkerCommentLike[];
  isAncestor?: (ancestorSha: string, descendantSha: string) => Promise<boolean>;
  force?: boolean;
}): Promise<ReviewDedupResult> {
  const hosted = detectHostedClaudeReview(opts.checkRuns);
  const lastReviewedSha = extractLastReviewedSha(opts.comments);

  if (!opts.force && hosted.found) {
    return {
      skip: true,
      reason: `Hosted check run "${hosted.checkRunName}" is already active/completed on ${opts.headSha}.`,
      mode: "full",
      reviewBaseSha: opts.baseSha,
      lastReviewedSha,
      hostedReviewName: hosted.checkRunName,
    };
  }

  if (!opts.force && lastReviewedSha && lastReviewedSha === opts.headSha.toLowerCase()) {
    return {
      skip: true,
      reason: `Commit ${opts.headSha} was already reviewed by Cloudroom Ship.`,
      mode: "full",
      reviewBaseSha: opts.baseSha,
      lastReviewedSha,
      hostedReviewName: hosted.checkRunName,
    };
  }

  if (lastReviewedSha && lastReviewedSha !== opts.headSha.toLowerCase() && opts.isAncestor) {
    const isAnc = await opts.isAncestor(lastReviewedSha, opts.headSha).catch(() => false);
    if (isAnc) {
      return {
        skip: false,
        reason: null,
        mode: "incremental",
        reviewBaseSha: lastReviewedSha,
        lastReviewedSha,
        hostedReviewName: hosted.checkRunName,
      };
    }
  }

  return {
    skip: false,
    reason: null,
    mode: "full",
    reviewBaseSha: opts.baseSha,
    lastReviewedSha,
    hostedReviewName: hosted.checkRunName,
  };
}
