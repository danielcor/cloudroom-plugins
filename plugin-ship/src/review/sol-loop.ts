import { runSeatWithRetry } from "./seat-runner.js";
import {
  buildSolLoopBrief,
  evaluateSolLoopStopTriggers,
  mergeSeatFindings,
  type MergedReviewFinding,
  type ReviewSeatRoute,
  type ReviewVerdict,
  type SeatExecutor,
  type SeatOutcome,
  type StopSplitTrigger,
} from "./types.js";

export interface SolLoopReviewInput {
  reviewRunId: string;
  repoSlug: string;
  baseSha: string;
  headSha: string;
  intent: string;
  outOfScope?: string;
  checks?: string;
  diffText: string;
  round: number;
  maxRounds: number;
  seats: readonly ReviewSeatRoute[];
  allowCheckout: boolean;
  priorFindings?: readonly MergedReviewFinding[];
  previousRoundCount?: number | null;
  previousRoundFiles?: readonly string[];
  priorSameAreaChurnCount?: number;
}

export interface SolLoopReviewOutput {
  verdict: ReviewVerdict;
  validSeats: number;
  targetSeats: number;
  meanScore: number | null;
  seatOutcomes: SeatOutcome[];
  findings: MergedReviewFinding[];
  stopTrigger: StopSplitTrigger | null;
  stopReason: string | null;
  nextSameAreaChurnCount: number;
}

export async function runSolLoopReview(
  input: SolLoopReviewInput,
  executor: SeatExecutor,
): Promise<SolLoopReviewOutput> {
  const seat = input.seats[0];
  if (!seat) {
    return {
      verdict: "INCOMPLETE",
      validSeats: 0,
      targetSeats: 1,
      meanScore: null,
      seatOutcomes: [],
      findings: [],
      stopTrigger: null,
      stopReason: "No eligible GPT Sol (gpt-6.2-sol) route is available.",
      nextSameAreaChurnCount: input.priorSameAreaChurnCount ?? 0,
    };
  }

  const baseBrief = buildSolLoopBrief({
    repoSlug: input.repoSlug,
    baseSha: input.baseSha,
    headSha: input.headSha,
    intent: input.intent,
    outOfScope: input.outOfScope,
    checks: input.checks,
    diffText: input.diffText,
    round: input.round,
    priorFindings: input.priorFindings,
  });

  const outcome = await runSeatWithRetry({
    reviewRunId: input.reviewRunId,
    route: seat,
    fallbackRoute: null,
    headSha: input.headSha,
    baseBrief,
    allowCheckout: input.allowCheckout,
    allowSolFormat: true,
    requireContext: false,
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
      stopTrigger: null,
      stopReason: outcome.error,
      nextSameAreaChurnCount: input.priorSameAreaChurnCount ?? 0,
    };
  }

  const findings = mergeSeatFindings([outcome]);
  const stopCheck = evaluateSolLoopStopTriggers({
    round: input.round,
    maxRounds: input.maxRounds,
    currentFindings: findings,
    previousRoundCount: input.previousRoundCount ?? null,
    previousRoundFiles: input.previousRoundFiles ?? [],
    priorSameAreaChurnCount: input.priorSameAreaChurnCount ?? 0,
  });

  const verdict: ReviewVerdict = findings.length === 0 ? "APPROVE" : "CHANGES";
  return {
    verdict,
    validSeats: 1,
    targetSeats: 1,
    meanScore: outcome.score,
    seatOutcomes: [outcome],
    findings,
    stopTrigger: stopCheck.trigger,
    stopReason: stopCheck.reason,
    nextSameAreaChurnCount: stopCheck.nextSameAreaChurnCount,
  };
}
