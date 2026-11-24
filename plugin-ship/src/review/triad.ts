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

export interface TriadReviewInput {
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

export interface TriadReviewOutput {
  verdict: ReviewVerdict;
  validSeats: number;
  targetSeats: number;
  meanScore: number | null;
  seatOutcomes: SeatOutcome[];
  findings: MergedReviewFinding[];
}

export async function runTriadReview(
  input: TriadReviewInput,
  executor: SeatExecutor,
): Promise<TriadReviewOutput> {
  const distinctSeats: ReviewSeatRoute[] = [];
  const seenFamilies = new Set<string>();
  for (const s of input.seats) {
    if (seenFamilies.has(s.family)) continue;
    seenFamilies.add(s.family);
    distinctSeats.push(s);
    if (distinctSeats.length === 3) break;
  }

  if (distinctSeats.length === 0) {
    return {
      verdict: "INCOMPLETE",
      validSeats: 0,
      targetSeats: 3,
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

  const fallbacks = [...(input.fallbackPool ?? [])].filter((f) => !seenFamilies.has(f.family));
  const seatOutcomes = await Promise.all(
    distinctSeats.map((route, idx) =>
      runSeatWithRetry({
        reviewRunId: input.reviewRunId,
        route,
        fallbackRoute: fallbacks[idx] ?? null,
        headSha: input.headSha,
        baseBrief,
        allowCheckout: input.allowCheckout,
        allowSolFormat: false,
        requireContext: true,
        executor,
      }),
    ),
  );

  const valid = seatOutcomes.filter((s) => s.ok);
  const scored = valid.map((s) => s.score).filter((s): s is number => s !== null);
  const meanScore =
    scored.length > 0 ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 100) / 100 : null;
  const findings = mergeSeatFindings(seatOutcomes);

  const verdict: ReviewVerdict =
    findings.length > 0 ? "CHANGES" : valid.length < 3 ? "INCOMPLETE" : "APPROVE";

  return {
    verdict,
    validSeats: valid.length,
    targetSeats: 3,
    meanScore,
    seatOutcomes,
    findings,
  };
}
