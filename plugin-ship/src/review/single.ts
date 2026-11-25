import { runSeatWithRetry } from "./seat-runner.js";
import {
  buildReviewBrief,
  mergeSeatFindings,
  type MergedReviewFinding,
  type ReviewSeatRoute,
  type ReviewVerdict,
  type SeatExecutor,
  type SeatOutcome,
} from "./types.js";

export interface SingleReviewInput {
  reviewRunId: string;
  repoSlug: string;
  baseSha: string;
  headSha: string;
  intent: string;
  outOfScope?: string;
  checks?: string;
  diffText: string;
  seats: readonly ReviewSeatRoute[];
  fallbackPool?: readonly ReviewSeatRoute[];
  allowCheckout: boolean;
}

export interface SingleReviewOutput {
  verdict: ReviewVerdict;
  validSeats: number;
  targetSeats: number;
  meanScore: number | null;
  seatOutcomes: SeatOutcome[];
  findings: MergedReviewFinding[];
}

export async function runSingleReview(
  input: SingleReviewInput,
  executor: SeatExecutor,
): Promise<SingleReviewOutput> {
  const seat = input.seats[0];
  if (!seat) {
    return {
      verdict: "INCOMPLETE",
      validSeats: 0,
      targetSeats: 1,
      meanScore: null,
      seatOutcomes: [],
      findings: [],
    };
  }

  const baseBrief = buildReviewBrief({
    repoSlug: input.repoSlug,
    baseSha: input.baseSha,
    headSha: input.headSha,
    intent: input.intent,
    outOfScope: input.outOfScope,
    checks: input.checks,
    diffText: input.diffText,
  });

  const outcome = await runSeatWithRetry({
    reviewRunId: input.reviewRunId,
    route: seat,
    fallbackRoute: input.fallbackPool?.[0] ?? null,
    headSha: input.headSha,
    baseBrief,
    allowCheckout: input.allowCheckout,
    allowSolFormat: false,
    requireContext: true,
    executor,
  });

  if (!outcome.ok) {
    return {
      verdict: "INCOMPLETE",
      validSeats: 0,
      targetSeats: 1,
      meanScore: null,
      seatOutcomes: [outcome],
      findings: [],
    };
  }

  const findings = mergeSeatFindings([outcome]);
  return {
    verdict: findings.length > 0 ? "CHANGES" : "APPROVE",
    validSeats: 1,
    targetSeats: 1,
    meanScore: outcome.score,
    seatOutcomes: [outcome],
    findings,
  };
}
