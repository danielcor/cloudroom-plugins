import { runProcess, type ExecResult } from "../safety/git-exec.js";
import type { ReviewEffort, ReviewMode, ReviewSeatRoute } from "./types.js";

export type DispatchExec = (args: readonly string[]) => Promise<ExecResult>;

export function defaultDispatchExec(args: readonly string[]): Promise<ExecResult> {
  return runProcess("room-cli", args, {
    timeoutMs: 25_000,
    env: process.env,
  });
}

export interface CooldownEntry {
  providerId: string;
  model: string;
  hostId: string | null;
  kind: "quota" | "auth" | "entitlement" | "unknown_model";
  failedAtMs: number;
}

const SHORT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const LONG_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function isRouteInCooldown(entry: CooldownEntry, nowMs = Date.now()): boolean {
  const ttl = entry.kind === "quota" || entry.kind === "auth" ? SHORT_COOLDOWN_MS : LONG_COOLDOWN_MS;
  return nowMs >= entry.failedAtMs && nowMs - entry.failedAtMs < ttl;
}

const NY_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Returns true during US equity market hours (Mon–Fri, 09:00–16:15 America/New_York). */
export function isUsMarketHours(now: Date = new Date()): boolean {
  const parts = NY_PARTS_FORMATTER.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  if (weekday !== "Mon" && weekday !== "Tue" && weekday !== "Wed" && weekday !== "Thu" && weekday !== "Fri") {
    return false;
  }
  const rawHour = Number.parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = Number.parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const hour = rawHour % 24;
  const totalMins = hour * 60 + minute;
  return totalMins >= 9 * 60 && totalMins <= 16 * 60 + 15;
}

export interface DispatchAttributionPayload {
  routeId: string;
  model: string;
  family: string;
  provider: string;
  providerModel: string;
  reasoningLevel: string | null;
  hostId: string | null;
}

export interface DispatchVerdictPayload {
  routeId: string;
  eligible: boolean;
  reason: string;
  attribution?: DispatchAttributionPayload;
}

export interface DispatchSeatPlanPayload {
  name: string;
  chosen: DispatchVerdictPayload | null;
  verdicts: DispatchVerdictPayload[];
}

export interface DispatchPreviewResult {
  available: boolean;
  ready: boolean;
  seats: DispatchSeatPlanPayload[];
  error: string | null;
}

export async function queryDispatchPreview(opts: {
  profile: string;
  hostId?: string | null;
  requireRoute?: string;
  execDispatch?: DispatchExec;
}): Promise<DispatchPreviewResult> {
  const execDispatch = opts.execDispatch ?? defaultDispatchExec;
  const args = ["dispatch", "preview", opts.profile, "--workspace", "worktree", "--json"];
  if (opts.hostId && opts.hostId !== "cloud") {
    args.push("--host", opts.hostId);
  }
  if (opts.requireRoute) {
    args.push("--require-route", opts.requireRoute);
  }

  const res = await execDispatch(args);
  if (res.code !== 0) {
    return {
      available: false,
      ready: false,
      seats: [],
      error: res.stderr.trim() || res.stdout.trim() || `dispatch preview exited ${res.code}`,
    };
  }
  try {
    const parsed = JSON.parse(res.stdout) as {
      ready?: boolean;
      seats?: DispatchSeatPlanPayload[];
    };
    if (!Array.isArray(parsed.seats)) {
      return { available: false, ready: false, seats: [], error: "dispatch preview returned invalid shape" };
    }
    return {
      available: true,
      ready: Boolean(parsed.ready),
      seats: parsed.seats,
      error: null,
    };
  } catch (err) {
    return {
      available: false,
      ready: false,
      seats: [],
      error: err instanceof Error ? err.message : "failed to parse dispatch preview JSON",
    };
  }
}

export interface FamilyCatalogEntry {
  family: string;
  providerId: string;
  models: Record<ReviewEffort, { model: string; reasoningLevel: string }>;
}

export const DEFAULT_FAMILY_CATALOG: readonly FamilyCatalogEntry[] = [
  {
    family: "gpt",
    providerId: "codex",
    models: {
      low: { model: "gpt-6.2-sol", reasoningLevel: "low" },
      medium: { model: "gpt-6.2-sol", reasoningLevel: "medium" },
      high: { model: "gpt-6.2-sol", reasoningLevel: "high" },
      max: { model: "gpt-6.2-sol", reasoningLevel: "high" },
    },
  },
  {
    family: "claude",
    providerId: "claude-code",
    models: {
      low: { model: "claude-sonnet-5-5", reasoningLevel: "medium" },
      medium: { model: "claude-opus-5-5", reasoningLevel: "medium" },
      high: { model: "claude-opus-5-5", reasoningLevel: "high" },
      max: { model: "claude-opus-5-5", reasoningLevel: "max" },
    },
  },
  {
    family: "gemini",
    providerId: "agy",
    models: {
      low: { model: "gemini-4-neon-low", reasoningLevel: "low" },
      medium: { model: "gemini-4-neon-medium", reasoningLevel: "medium" },
      high: { model: "gemini-4-neon-high", reasoningLevel: "high" },
      max: { model: "gemini-4-neon-high", reasoningLevel: "high" },
    },
  },
  {
    family: "kimi",
    providerId: "acp-kimi",
    models: {
      low: { model: "kimi-code/k3.1-pro", reasoningLevel: "low" },
      medium: { model: "kimi-code/k3.1-pro", reasoningLevel: "high" },
      high: { model: "kimi-code/k3.1-pro", reasoningLevel: "max" },
      max: { model: "kimi-code/k3.1-pro", reasoningLevel: "max" },
    },
  },
  {
    family: "muse",
    providerId: "acp-muse",
    models: {
      low: { model: "muse-wonder-1.0", reasoningLevel: "medium" },
      medium: { model: "muse-wonder-1.0", reasoningLevel: "high" },
      high: { model: "muse-wonder-full-1.0", reasoningLevel: "high" },
      max: { model: "muse-wonder-full-1.0", reasoningLevel: "high" },
    },
  },
];

export function inferFamilyFromProviderOrModel(providerOrModel: string): string {
  const lower = providerOrModel.toLowerCase();
  if (lower.includes("codex") || lower.includes("gpt") || lower.includes("openai")) return "gpt";
  if (lower.includes("claude") || lower.includes("anthropic")) return "claude";
  if (lower.includes("gemini") || lower.includes("agy") || lower.includes("antigravity")) return "gemini";
  if (lower.includes("kimi") || lower.includes("qoder")) return "kimi";
  if (lower.includes("muse")) return "muse";
  return lower.split("/")[0] || "unknown";
}

function normalizeFamily(family: string): string {
  const lower = family.trim().toLowerCase();
  if (lower === "openai" || lower === "codex") return "gpt";
  if (lower === "anthropic") return "claude";
  if (lower === "google" || lower === "agy") return "gemini";
  return lower;
}

export interface ResolvedSeatsResult {
  seats: ReviewSeatRoute[];
  fallbackPool: ReviewSeatRoute[];
  usedDispatch: boolean;
  marketHoursActive: boolean;
  skippedReasons: string[];
}

export async function resolveReviewSeats(opts: {
  mode: ReviewMode;
  effort: ReviewEffort;
  hostId: string | null;
  authorFamily?: string | null;
  allowCloud?: boolean;
  now?: Date;
  cooldowns?: readonly CooldownEntry[];
  overrideProvider?: string;
  overrideModel?: string;
  execDispatch?: DispatchExec;
}): Promise<ResolvedSeatsResult> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const marketHoursActive = isUsMarketHours(now);
  const cooldowns = opts.cooldowns ?? [];
  const authorFamily = opts.authorFamily ? normalizeFamily(opts.authorFamily) : null;
  const skippedReasons: string[] = [];

  const inCooldown = (providerId: string, model: string, routeHostId: string | null): boolean =>
    cooldowns.some(
      (c) =>
        c.providerId === providerId &&
        c.model === model &&
        (c.hostId === null || routeHostId === null || c.hostId === routeHostId) &&
        isRouteInCooldown(c, nowMs),
    );

  const allowRoute = (route: ReviewSeatRoute): boolean => {
    if (marketHoursActive && !opts.allowCloud && route.isCloud) {
      skippedReasons.push(`${route.family}/${route.model} skipped: cloud disabled during US market hours`);
      return false;
    }
    if (inCooldown(route.providerId, route.model, route.hostId)) {
      skippedReasons.push(`${route.family}/${route.model} skipped: active cooldown`);
      return false;
    }
    return true;
  };

  if (opts.mode === "sol-loop") {
    const preview = await queryDispatchPreview({
      profile: "reviewer",
      hostId: opts.hostId,
      requireRoute: "codex-gpt-6.2-sol",
      execDispatch: opts.execDispatch,
    });
    const seat0 = preview.seats[0];
    if (preview.available && seat0) {
      const dispatchList = seat0.chosen ? [seat0.chosen, ...seat0.verdicts] : seat0.verdicts;
      for (const v of dispatchList) {
        if (!v.eligible || !v.attribution) continue;
        const a = v.attribution;
        const routeHost = a.hostId ?? opts.hostId;
        const candidate: ReviewSeatRoute = {
          seatName: "sol",
          family: "gpt",
          providerId: a.provider || "codex",
          model: a.providerModel || a.model || "gpt-6.2-sol",
          reasoningLevel: "high",
          hostId: routeHost,
          isCloud: routeHost === "cloud",
          routeId: v.routeId,
          source: "dispatch",
        };
        if (allowRoute(candidate)) {
          return {
            seats: [candidate],
            fallbackPool: [],
            usedDispatch: true,
            marketHoursActive,
            skippedReasons,
          };
        }
      }
    }

    const fallback: ReviewSeatRoute = {
      seatName: "sol",
      family: "gpt",
      providerId: "codex",
      model: "gpt-6.2-sol",
      reasoningLevel: "high",
      hostId: opts.hostId,
      isCloud: opts.hostId === "cloud" || opts.hostId === null,
      source: "fallback",
    };
    if (allowRoute(fallback)) {
      return { seats: [fallback], fallbackPool: [], usedDispatch: preview.available, marketHoursActive, skippedReasons };
    }
    return { seats: [], fallbackPool: [], usedDispatch: preview.available, marketHoursActive, skippedReasons };
  }

  if (opts.mode === "single") {
    if (opts.overrideProvider || opts.overrideModel) {
      const providerId = opts.overrideProvider ?? "codex";
      const catalog = DEFAULT_FAMILY_CATALOG.find((c) => c.providerId === providerId);
      const modelSpec = catalog?.models[opts.effort];
      const model = opts.overrideModel ?? modelSpec?.model ?? "gpt-6.2-sol";
      const route: ReviewSeatRoute = {
        seatName: "main",
        family: normalizeFamily(catalog?.family ?? inferFamilyFromProviderOrModel(`${providerId}/${model}`)),
        providerId,
        model,
        reasoningLevel: modelSpec?.reasoningLevel ?? (opts.effort === "low" ? "low" : "high"),
        hostId: opts.hostId,
        isCloud: opts.hostId === "cloud" || opts.hostId === null,
        source: "override",
      };
      return {
        seats: allowRoute(route) ? [route] : [],
        fallbackPool: [],
        usedDispatch: false,
        marketHoursActive,
        skippedReasons,
      };
    }

    const preview = await queryDispatchPreview({
      profile: "reviewer",
      hostId: opts.hostId,
      execDispatch: opts.execDispatch,
    });

    if (preview.available) {
      const candidates: ReviewSeatRoute[] = [];
      for (const s of preview.seats) {
        const list = s.chosen ? [s.chosen, ...s.verdicts] : s.verdicts;
        for (const v of list) {
          if (!v.eligible || !v.attribution) continue;
          const a = v.attribution;
          const routeHost = a.hostId ?? opts.hostId;
          candidates.push({
            seatName: "main",
            family: normalizeFamily(a.family || inferFamilyFromProviderOrModel(a.provider)),
            providerId: a.provider,
            model: a.providerModel || a.model,
            reasoningLevel: a.reasoningLevel || (opts.effort === "low" ? "low" : "high"),
            hostId: routeHost,
            isCloud: routeHost === "cloud",
            routeId: v.routeId,
            source: "dispatch",
          });
        }
      }
      const allowed = candidates.filter(allowRoute);
      if (allowed.length > 0) {
        return {
          seats: [allowed[0]!],
          fallbackPool: allowed.slice(1),
          usedDispatch: true,
          marketHoursActive,
          skippedReasons,
        };
      }
    }

    const orderedCatalog = [
      ...DEFAULT_FAMILY_CATALOG.filter((f) => f.family !== authorFamily),
      ...DEFAULT_FAMILY_CATALOG.filter((f) => f.family === authorFamily),
    ];
    const fallbackPool: ReviewSeatRoute[] = [];
    for (const entry of orderedCatalog) {
      const spec = entry.models[opts.effort];
      const route: ReviewSeatRoute = {
        seatName: "main",
        family: entry.family,
        providerId: entry.providerId,
        model: spec.model,
        reasoningLevel: spec.reasoningLevel,
        hostId: opts.hostId,
        isCloud: opts.hostId === "cloud" || opts.hostId === null,
        source: "fallback",
      };
      if (allowRoute(route)) fallbackPool.push(route);
    }
    return {
      seats: fallbackPool[0] ? [fallbackPool[0]] : [],
      fallbackPool: fallbackPool.slice(1),
      usedDispatch: false,
      marketHoursActive,
      skippedReasons,
    };
  }

  // mode === "triad"
  const preview = await queryDispatchPreview({
    profile: "triad-review",
    hostId: opts.hostId,
    execDispatch: opts.execDispatch,
  });

  const picked: ReviewSeatRoute[] = [];
  const usedFamilies = new Set<string>();
  const deferredAuthorCandidates: ReviewSeatRoute[] = [];

  if (preview.available) {
    const dispatchPool: ReviewSeatRoute[] = [];
    for (const seat of preview.seats) {
      const list = seat.chosen ? [seat.chosen, ...seat.verdicts] : seat.verdicts;
      for (const v of list) {
        if (!v.eligible || !v.attribution) continue;
        const a = v.attribution;
        const routeHost = a.hostId ?? opts.hostId;
        dispatchPool.push({
          seatName: seat.name || normalizeFamily(a.family),
          family: normalizeFamily(a.family || inferFamilyFromProviderOrModel(a.provider)),
          providerId: a.provider,
          model: a.providerModel || a.model,
          reasoningLevel: a.reasoningLevel || (opts.effort === "low" ? "low" : "high"),
          hostId: routeHost,
          isCloud: routeHost === "cloud",
          routeId: v.routeId,
          source: "dispatch",
        });
      }
    }

    for (const candidate of dispatchPool) {
      if (picked.length >= 3) break;
      if (usedFamilies.has(candidate.family)) continue;
      if (!allowRoute(candidate)) continue;
      if (authorFamily && candidate.family === authorFamily) {
        deferredAuthorCandidates.push(candidate);
        continue;
      }
      usedFamilies.add(candidate.family);
      picked.push({ ...candidate, seatName: `${candidate.family}` });
    }
  }

  const orderedCatalog = [
    ...DEFAULT_FAMILY_CATALOG.filter((f) => f.family !== authorFamily),
    ...DEFAULT_FAMILY_CATALOG.filter((f) => f.family === authorFamily),
  ];

  const fallbackPool: ReviewSeatRoute[] = [];
  for (const entry of orderedCatalog) {
    if (usedFamilies.has(entry.family)) continue;
    const spec = entry.models[opts.effort];
    const route: ReviewSeatRoute = {
      seatName: entry.family,
      family: entry.family,
      providerId: entry.providerId,
      model: spec.model,
      reasoningLevel: spec.reasoningLevel,
      hostId: opts.hostId,
      isCloud: opts.hostId === "cloud" || opts.hostId === null,
      source: "fallback",
    };
    if (!allowRoute(route)) continue;
    if (authorFamily && entry.family === authorFamily) {
      deferredAuthorCandidates.push(route);
      continue;
    }
    if (picked.length < 3) {
      usedFamilies.add(entry.family);
      picked.push(route);
    } else {
      fallbackPool.push(route);
    }
  }

  for (const authorCandidate of deferredAuthorCandidates) {
    if (picked.length >= 3) {
      if (!usedFamilies.has(authorCandidate.family)) fallbackPool.push(authorCandidate);
      continue;
    }
    if (usedFamilies.has(authorCandidate.family)) continue;
    usedFamilies.add(authorCandidate.family);
    picked.push({ ...authorCandidate, seatName: authorCandidate.family });
  }

  return {
    seats: picked,
    fallbackPool,
    usedDispatch: preview.available,
    marketHoursActive,
    skippedReasons,
  };
}
