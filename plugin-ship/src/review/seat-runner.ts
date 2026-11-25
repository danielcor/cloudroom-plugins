import {
  buildToolFreeBrief,
  parseReviewReply,
  type ReviewSeatRoute,
  type SeatContextMode,
  type SeatExecutor,
  type SeatOutcome,
} from "./types.js";

export function isQoderProvider(providerId: string): boolean {
  return providerId.trim().toLowerCase() === "qoder";
}

export async function runSeatWithRetry(opts: {
  reviewRunId: string;
  route: ReviewSeatRoute;
  fallbackRoute?: ReviewSeatRoute | null;
  headSha: string;
  baseBrief: string;
  allowCheckout: boolean;
  allowSolFormat?: boolean;
  requireContext?: boolean;
  executor: SeatExecutor;
}): Promise<SeatOutcome> {
  const canUseCheckoutAttempt1 =
    opts.allowCheckout && !opts.route.isCloud && !isQoderProvider(opts.route.providerId);
  const attempt1Context: SeatContextMode = canUseCheckoutAttempt1 ? "checkout" : "diff-only";
  const attempt1Allowed: readonly SeatContextMode[] =
    attempt1Context === "checkout" ? ["checkout", "diff-only"] : ["diff-only"];
  const attempt1Prompt =
    attempt1Context === "checkout" ? opts.baseBrief : buildToolFreeBrief(opts.baseBrief);

  const threadIds: string[] = [];
  const environmentIds: string[] = [];

  const res1 = await opts.executor({
    reviewRunId: opts.reviewRunId,
    seatName: opts.route.seatName,
    route: opts.route,
    attempt: 1,
    contextMode: attempt1Context,
    headSha: opts.headSha,
    prompt: attempt1Prompt,
  });
  if (res1.threadId) threadIds.push(res1.threadId);
  if (res1.environmentId) environmentIds.push(res1.environmentId);

  let firstFailureReason = res1.error ?? "seat failed without reply";
  if (res1.ok && res1.replyText !== null) {
    const parsed1 = parseReviewReply(res1.replyText, {
      expectedHeadSha: opts.headSha,
      allowedContexts: attempt1Allowed,
      allowSolFormat: opts.allowSolFormat,
      requireContext: opts.requireContext,
    });
    if (parsed1.ok && parsed1.verdict) {
      return {
        seatName: opts.route.seatName,
        family: opts.route.family,
        providerId: opts.route.providerId,
        model: opts.route.model,
        reasoningLevel: opts.route.reasoningLevel,
        hostId: opts.route.hostId,
        context: parsed1.context ?? attempt1Context,
        ok: true,
        attempts: 1,
        verdict: parsed1.verdict,
        score: parsed1.score,
        findings: parsed1.findings,
        error: null,
        threadIds,
        environmentIds,
      };
    }
    firstFailureReason = `invalid reply: ${parsed1.error ?? "parse failed"}`;
  }

  // Attempt 2: always tool-free diff-only; swap to fallbackRoute if attempt 1 hit quota/auth/model failure.
  const canSwapFallback =
    !res1.ok &&
    (res1.errorCategory === "quota" ||
      res1.errorCategory === "auth" ||
      res1.errorCategory === "entitlement" ||
      res1.errorCategory === "unknown_model") &&
    Boolean(opts.fallbackRoute);

  const retryRoute = canSwapFallback && opts.fallbackRoute ? opts.fallbackRoute : opts.route;
  const res2 = await opts.executor({
    reviewRunId: opts.reviewRunId,
    seatName: opts.route.seatName,
    route: retryRoute,
    attempt: 2,
    contextMode: "diff-only",
    headSha: opts.headSha,
    prompt: buildToolFreeBrief(opts.baseBrief),
  });
  if (res2.threadId) threadIds.push(res2.threadId);
  if (res2.environmentId) environmentIds.push(res2.environmentId);

  let secondFailureReason = res2.error ?? "retry seat failed without reply";
  if (res2.ok && res2.replyText !== null) {
    const parsed2 = parseReviewReply(res2.replyText, {
      expectedHeadSha: opts.headSha,
      allowedContexts: ["diff-only"],
      allowSolFormat: opts.allowSolFormat,
      requireContext: opts.requireContext,
    });
    if (parsed2.ok && parsed2.verdict) {
      return {
        seatName: opts.route.seatName,
        family: retryRoute.family,
        providerId: retryRoute.providerId,
        model: retryRoute.model,
        reasoningLevel: retryRoute.reasoningLevel,
        hostId: retryRoute.hostId,
        context: parsed2.context ?? "diff-only",
        ok: true,
        attempts: 2,
        verdict: parsed2.verdict,
        score: parsed2.score,
        findings: parsed2.findings,
        error: null,
        threadIds,
        environmentIds,
      };
    }
    secondFailureReason = `invalid reply: ${parsed2.error ?? "parse failed"}`;
  }

  return {
    seatName: opts.route.seatName,
    family: retryRoute.family,
    providerId: retryRoute.providerId,
    model: retryRoute.model,
    reasoningLevel: retryRoute.reasoningLevel,
    hostId: retryRoute.hostId,
    context: null,
    ok: false,
    attempts: 2,
    verdict: null,
    score: null,
    findings: [],
    error: `attempt 1: ${firstFailureReason}; attempt 2: ${secondFailureReason}`,
    threadIds,
    environmentIds,
  };
}
