import { describe, expect, it } from "vitest";
import { detectHostedClaudeReview, evaluateReviewDedup, extractLastReviewedSha } from "../src/review/dedup.js";
import { isRouteInCooldown, isUsMarketHours, queryDispatchPreview, resolveReviewSeats } from "../src/review/dispatch.js";

const HEAD_SHA = "b".repeat(40);
const PREV_SHA = "a".repeat(40);
const BASE_SHA = "0".repeat(40);

describe("review deduplication & incremental scoping", () => {
  it("detects hosted Claude Code Review checks and ignores cancelled/failed ones", () => {
    expect(
      detectHostedClaudeReview([
        { id: 1, name: "CI / test", status: "completed", conclusion: "success", htmlUrl: null },
        { id: 2, name: "Claude Code Review", status: "completed", conclusion: "cancelled", htmlUrl: null },
      ]).found,
    ).toBe(false);

    expect(
      detectHostedClaudeReview([
        { id: 3, name: "Claude Code Review", status: "in_progress", conclusion: null, htmlUrl: null },
      ]),
    ).toEqual({
      found: true,
      checkRunName: "Claude Code Review",
      status: "in_progress",
      conclusion: null,
    });
  });

  it("extracts latest reviewed marker SHA and drives skip vs incremental vs full", async () => {
    const comments = [
      { body: `<!-- cloudroom-ship reviewed=${"1".repeat(40)} -->\nOld`, createdAt: "2026-11-24T01:00:00Z" },
      { body: `<!-- cloudroom-ship reviewed=${PREV_SHA} -->\nNewer`, createdAt: "2026-11-24T02:00:00Z" },
    ];
    expect(extractLastReviewedSha(comments)).toBe(PREV_SHA);

    // 1) Hosted check skips unless forced
    const hostedSkip = await evaluateReviewDedup({
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      checkRuns: [{ id: 1, name: "Claude Code Review", status: "completed", conclusion: "success", htmlUrl: null }],
      comments,
    });
    expect(hostedSkip.skip).toBe(true);

    // 2) Same HEAD marker skips unless forced
    const sameHeadSkip = await evaluateReviewDedup({
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      checkRuns: [],
      comments: [{ body: `<!-- cloudroom-ship reviewed=${HEAD_SHA} -->\nDone`, createdAt: "2026-11-24T03:00:00Z" }],
    });
    expect(sameHeadSkip.skip).toBe(true);

    const forced = await evaluateReviewDedup({
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      checkRuns: [{ id: 1, name: "Claude Code Review", status: "completed", conclusion: "success", htmlUrl: null }],
      comments: [{ body: `<!-- cloudroom-ship reviewed=${HEAD_SHA} -->\nDone` }],
      force: true,
    });
    expect(forced.skip).toBe(false);
    expect(forced.mode).toBe("full");

    // 3) Ancestor prior SHA selects incremental scope
    const incremental = await evaluateReviewDedup({
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      checkRuns: [],
      comments,
      isAncestor: async () => true,
    });
    expect(incremental).toMatchObject({
      skip: false,
      mode: "incremental",
      reviewBaseSha: PREV_SHA,
      lastReviewedSha: PREV_SHA,
    });

    // 4) Non-ancestor (rebased/amended) prior SHA falls back to full baseSha
    const fullFallback = await evaluateReviewDedup({
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      checkRuns: [],
      comments,
      isAncestor: async () => false,
    });
    expect(fullFallback).toMatchObject({
      skip: false,
      mode: "full",
      reviewBaseSha: BASE_SHA,
    });
  });
});

describe("dispatch preview routing, cooldowns, and market hours", () => {
  it("parses live dispatch preview output, enforces distinct triad families, and deprioritizes authorFamily", async () => {
    const offHours = new Date("2026-11-24T22:00:00.000Z"); // 17:00 ET
    expect(isUsMarketHours(offHours)).toBe(false);

    const previewPayload = {
      ready: true,
      seats: [
        {
          name: "seat-1",
          chosen: {
            routeId: "codex-gpt-6.2-sol",
            eligible: true,
            reason: "ok",
            attribution: {
              routeId: "codex-gpt-6.2-sol",
              model: "gpt-6.2-sol",
              family: "gpt",
              provider: "codex",
              providerModel: "gpt-6.2-sol",
              reasoningLevel: "high",
              hostId: "host_aipc",
            },
          },
          verdicts: [],
        },
        {
          name: "seat-2",
          chosen: {
            routeId: "duplicate-gpt",
            eligible: true,
            reason: "ok",
            attribution: {
              routeId: "duplicate-gpt",
              model: "gpt-6.1-sol",
              family: "gpt",
              provider: "codex",
              providerModel: "gpt-6.1-sol",
              reasoningLevel: "high",
              hostId: "host_aipc",
            },
          },
          verdicts: [
            {
              routeId: "agy-gemini-4-neon",
              eligible: true,
              reason: "ok",
              attribution: {
                routeId: "agy-gemini-4-neon",
                model: "gemini-4-neon-high",
                family: "gemini",
                provider: "agy",
                providerModel: "gemini-4-neon-high",
                reasoningLevel: "high",
                hostId: "host_aipc",
              },
            },
          ],
        },
      ],
    };

    const resolved = await resolveReviewSeats({
      mode: "triad",
      effort: "high",
      hostId: "host_aipc",
      authorFamily: "gpt",
      now: offHours,
      execDispatch: async () => ({ code: 0, stdout: JSON.stringify(previewPayload), stderr: "" }),
    });

    expect(resolved.usedDispatch).toBe(true);
    expect(resolved.seats).toHaveLength(3);
    // Distinct families guaranteed and authorFamily ("gpt") moved after other available families
    const families = resolved.seats.map((s) => s.family);
    expect(new Set(families).size).toBe(3);
    expect(families).not.toContain("gpt");
  });

  it("enforces 6h/24h cooldowns, US market hours cloud restriction, strict sol-loop pin, and CLI fallback", async () => {
    const marketTime = new Date("2026-11-24T15:00:00.000Z"); // Tue 10:00 AM ET
    expect(isUsMarketHours(marketTime)).toBe(true);
    const nowMs = marketTime.getTime();

    expect(
      isRouteInCooldown({ providerId: "codex", model: "gpt-6.2-sol", hostId: "h", kind: "quota", failedAtMs: nowMs - 5 * 3600_000 }, nowMs),
    ).toBe(true);
    expect(
      isRouteInCooldown({ providerId: "codex", model: "gpt-6.2-sol", hostId: "h", kind: "quota", failedAtMs: nowMs - 7 * 3600_000 }, nowMs),
    ).toBe(false);
    expect(
      isRouteInCooldown({ providerId: "agy", model: "m", hostId: "h", kind: "entitlement", failedAtMs: nowMs - 20 * 3600_000 }, nowMs),
    ).toBe(true);

    // Market hours blocks cloud seats unless allowCloud=true
    const previewCloudOnly = {
      ready: true,
      seats: [
        {
          name: "main",
          chosen: {
            routeId: "cloud-codex",
            eligible: true,
            reason: "ok",
            attribution: {
              routeId: "cloud-codex",
              model: "gpt-6.2-sol",
              family: "gpt",
              provider: "codex",
              providerModel: "gpt-6.2-sol",
              reasoningLevel: "high",
              hostId: "cloud",
            },
          },
          verdicts: [],
        },
      ],
    };

    const marketBlocked = await resolveReviewSeats({
      mode: "sol-loop",
      effort: "high",
      hostId: "host_aipc",
      now: marketTime,
      execDispatch: async () => ({ code: 0, stdout: JSON.stringify(previewCloudOnly), stderr: "" }),
    });
    expect(marketBlocked.marketHoursActive).toBe(true);
    expect(marketBlocked.skippedReasons.some((r) => r.includes("market hours"))).toBe(true);
    // Sol-loop still resolves local fallback when hostId is local and not in cooldown.
    expect(marketBlocked.seats[0]?.hostId).toBe("host_aipc");

    // Sol-loop never substitutes another model when codex/gpt-6.2-sol is in cooldown.
    const solInCooldown = await resolveReviewSeats({
      mode: "sol-loop",
      effort: "high",
      hostId: "host_aipc",
      now: marketTime,
      cooldowns: [{ providerId: "codex", model: "gpt-6.2-sol", hostId: "host_aipc", kind: "quota", failedAtMs: nowMs - 1000 }],
      execDispatch: async () => ({ code: 1, stdout: "", stderr: "dispatch unavailable" }),
    });
    expect(solInCooldown.seats).toHaveLength(0);

    // Dispatch CLI failure cleanly falls back to static catalog for triad
    const previewErr = await queryDispatchPreview({
      profile: "triad-review",
      execDispatch: async () => ({ code: 1, stdout: "", stderr: "not installed" }),
    });
    expect(previewErr.available).toBe(false);

    const triadFallback = await resolveReviewSeats({
      mode: "triad",
      effort: "high",
      hostId: "host_aipc",
      now: marketTime,
      execDispatch: async () => ({ code: 1, stdout: "", stderr: "not installed" }),
    });
    expect(triadFallback.usedDispatch).toBe(false);
    expect(triadFallback.seats.map((s) => s.family)).toEqual(["gpt", "claude", "gemini"]);
  });
});
