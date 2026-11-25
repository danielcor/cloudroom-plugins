import { randomUUID } from "node:crypto";
import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import { cliCommand, defineCli, PluginCliError } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  approvalsModeSchema,
  autoStewardSchema,
  hostContract,
  repoSlugSchema,
  reviewEffortSchema,
  reviewModeSchema,
  rpcContract,
  type ApprovalRunSummary,
  type RepoConfig,
  type ReviewFindingSummary,
  type ReviewMode,
  type ReviewRunSummary,
  type ShipStatus,
  type WatchRecord,
} from "./src/contract.js";
import { createCloudroomClassifierExecutor, type ClassifierExecutor } from "./src/approvals/classifiers.js";
import { evaluateApprovalsPolicy, evaluateDevAutoMergeGuard } from "./src/approvals/evaluator.js";
import { computePolicyBundleSha, loadAndValidateClassifiers, parseApprovalsPolicy } from "./src/approvals/parser.js";
import { reportApprovalDecision, type ApprovalReportResult } from "./src/approvals/reporter.js";
import {
  MIGRATIONS,
  ShipStore,
  toPublicWatchRecord,
  type ApprovalRunRecord,
  type RepoDefaults,
  type ReviewFindingRecord,
  type ReviewRunRecord,
} from "./src/db.js";
import { formatGateReceipt } from "./src/gates/container-gates.js";
import { GitHubBotClient } from "./src/github/bot.js";
import { fetchPrDiscussion, type FilteredPrDiscussion } from "./src/github/comments.js";
import { runShipPublish, type ShipPublishResult } from "./src/publish/publisher.js";
import type { DispatchExec } from "./src/review/dispatch.js";
import {
  createCloudroomSeatExecutor,
  runShipReview,
  type SettledThreadWaiter,
  type ThreadSettlementEvent,
} from "./src/review/runner.js";
import { ReviewerGatekeeper } from "./src/review/types.js";
import { runProcess } from "./src/safety/git-exec.js";
import { isNeverEditPath, isSecretFilename } from "./src/safety/never-edit.js";
import { SHIP_MARKER_PREFIX, validateCommentText } from "./src/safety/outbound-text.js";
import { StewardWorkerGatekeeper } from "./src/steward/gatekeeper.js";
import { StewardPoller, type DiscoveredPrCandidate } from "./src/steward/poller.js";
import { MAX_BEHIND_MERGES } from "./src/steward/state-machine.js";
import { registerStewardTools } from "./src/steward/tools.js";
import { SUPPORTED_GITHUB_WEBHOOK_EVENTS, verifyGitHubWebhookSignature } from "./src/webhook.js";

export const PLUGIN_VERSION = "0.1.0";
export const STEWARD_TERMS_KV_KEY = "steward_terms_accepted_at";
export const SHIP_WEBHOOK_PATH = "/api/v1/plugins/ship/http/webhook/github";

const POSITIVE_INT_SCHEMA = z.number().int();

export type CloudSpawnExec = (
  args: readonly string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface ShipServerDeps {
  nowMs?: () => number;
  fetchImpl?: typeof fetch;
  minDwellMs?: number;
  execDispatch?: DispatchExec;
  execCloudSpawn?: CloudSpawnExec;
  seatTimeoutMs?: number;
  classifierExecutor?: ClassifierExecutor;
  pollIntervalMs?: number;
  disableBackgroundPoller?: boolean;
  discoverRepoPrs?: (repo: string) => Promise<DiscoveredPrCandidate[]>;
  onPollerReady?: (poller: StewardPoller) => void;
}

export function createShipPlugin(deps: ShipServerDeps = {}) {
  return async function shipPlugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    defaultReviewMode: {
      type: "select",
      label: "Default review mode",
      description: "Review strategy used when starting /ship without a per-repo override.",
      options: ["triad", "sol-loop", "single"],
      default: "triad",
    },
    defaultReviewEffort: {
      type: "select",
      label: "Default review effort",
      description: "Reasoning level requested for code review seats.",
      options: ["low", "medium", "high", "max"],
      default: "high",
    },
    botLogin: {
      type: "string",
      label: "GitHub bot username",
      description: "Dedicated GitHub bot account used to post reviews, commit statuses, and approvals.",
      default: "",
    },
    botToken: {
      type: "string",
      label: "GitHub bot token",
      description: "Fine-grained PAT for the bot account. Stored in a 0600 file; never exposed to SQLite or UI.",
      secret: true,
    },
    pollIntervalSeconds: {
      type: "number",
      label: "Poller interval (seconds)",
      description: "Zero-token GitHub check cadence for watched PRs (30–900 seconds).",
      experimental_schema: POSITIVE_INT_SCHEMA.min(30).max(900),
      default: 120,
    },
    watchMaxDays: {
      type: "number",
      label: "Max watch duration (days)",
      description: "Maximum age of an unattended PR watch before automatic stop.",
      experimental_schema: POSITIVE_INT_SCHEMA.min(1).max(30),
      default: 7,
    },
    defaultMaxPushesPerCause: {
      type: "number",
      label: "Max pushes per cause",
      description: "Cap on Steward push rounds for a single failing check, conflict, or comment.",
      experimental_schema: POSITIVE_INT_SCHEMA.min(1).max(10),
      default: 3,
    },
    webhookSecret: {
      type: "string",
      label: "GitHub webhook secret",
      description: "Optional HMAC-SHA256 secret for instant GitHub webhook wakeups at /api/v1/plugins/ship/http/webhook/github.",
      secret: true,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new ShipStore(db);
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  const gatekeeper = new ReviewerGatekeeper();
  const stewardGatekeeper = new StewardWorkerGatekeeper(store);
  const settledWaiters = new Map<string, SettledThreadWaiter>();

  async function currentBotClient(): Promise<GitHubBotClient | null> {
    const s = await settings.get();
    const token = typeof s.botToken === "string" ? s.botToken.trim() : "";
    if (!token) return null;
    return new GitHubBotClient({
      token,
      botLogin: (s.botLogin ?? "").trim(),
      fetchImpl: deps.fetchImpl,
    });
  }

  function publishWatchesSignal(payload: Record<string, unknown>): void {
    try {
      bb.realtime.publish("watches", payload);
    } catch {
      // Ignore realtime errors in detached harnesses.
    }
  }

  function publishNotificationSignal(payload: Record<string, unknown>): void {
    try {
      bb.realtime.publish("notifications", payload);
    } catch {
      // Ignore realtime errors in detached harnesses.
    }
  }

  const poller = new StewardPoller({
    bb,
    store,
    hostClient,
    getPollIntervalMs: async () => {
      if (deps.pollIntervalMs !== undefined) return deps.pollIntervalMs;
      const { status } = await currentDefaults();
      return status.pollIntervalSeconds * 1000;
    },
    getMaxPushesPerCause: async (repo) => {
      const repoCfg = store.getRepo(repo);
      if (repoCfg) return repoCfg.maxPushesPerCause;
      const { status } = await currentDefaults();
      return status.defaultMaxPushesPerCause;
    },
    getWatchMaxDays: async () => (await currentDefaults()).status.watchMaxDays,
    discoverRepoPrs: deps.discoverRepoPrs,
    nowMs: deps.nowMs,
  });

  registerStewardTools(bb, {
    store,
    hostClient,
    getBotClient: currentBotClient,
    getMaxPushesPerCause: async (repo) => {
      const repoCfg = store.getRepo(repo);
      if (repoCfg) return repoCfg.maxPushesPerCause;
      const { status } = await currentDefaults();
      return status.defaultMaxPushesPerCause;
    },
    publishWatchUpdate: (watchId) => publishWatchesSignal({ type: "watch.updated", watchId }),
    publishNotification: (payload) => publishNotificationSignal(payload),
  });

  if (!deps.disableBackgroundPoller) {
    bb.background.service("ship-poller", {
      start: (signal) => poller.start(signal),
    });
  }
  deps.onPollerReady?.(poller);

  bb.events.on("interaction.pending", async ({ interaction }) => {
    const resolution =
      gatekeeper.evaluateInteraction(interaction) ?? stewardGatekeeper.evaluateInteraction(interaction);
    if (!resolution) return;
    await bb.sdk.threads.interactions
      .resolve({
        threadId: interaction.threadId,
        interactionId: interaction.id,
        resolution,
      })
      .catch(() => undefined);
  });

  function handleThreadSettled(event: ThreadSettlementEvent): void {
    settledWaiters.get(event.threadId)?.resolve(event);
    poller.handleWorkerSettled(event.threadId);
  }

  bb.events.on("thread.idle", (e) => {
    handleThreadSettled({
      threadId: e.thread.id,
      outcome: "completed",
      lastAssistantText: e.lastAssistantText ?? null,
      error: null,
    });
  });

  bb.events.on("thread.failed", (e) => {
    handleThreadSettled({
      threadId: e.thread.id,
      outcome: "failed",
      lastAssistantText: null,
      error: e.error ?? null,
    });
  });

  bb.events.on("thread.archived", (e) => {
    handleThreadSettled({
      threadId: e.thread.id,
      outcome: "archived",
      lastAssistantText: null,
      error: null,
    });
  });

  bb.events.on("thread.deleted", (e) => {
    handleThreadSettled({
      threadId: e.thread.id,
      outcome: "deleted",
      lastAssistantText: null,
      error: null,
    });
  });

  async function currentDefaults(): Promise<{ status: ShipStatus; repoDefaults: RepoDefaults }> {
    const s = await settings.get();
    const defaultReviewMode = reviewModeSchema.catch("triad").parse(s.defaultReviewMode);
    const defaultReviewEffort = reviewEffortSchema.catch("high").parse(s.defaultReviewEffort);
    const pollIntervalSeconds = Math.max(30, Math.round(s.pollIntervalSeconds || 120));
    const watchMaxDays = Math.max(1, Math.round(s.watchMaxDays || 7));
    const defaultMaxPushesPerCause = Math.max(1, Math.round(s.defaultMaxPushesPerCause || 3));
    return {
      status: {
        pluginVersion: PLUGIN_VERSION,
        botConfigured: typeof s.botToken === "string" && s.botToken.trim().length > 0,
        botLogin: (s.botLogin ?? "").trim(),
        webhookConfigured: typeof s.webhookSecret === "string" && s.webhookSecret.trim().length > 0,
        webhookPath: SHIP_WEBHOOK_PATH,
        defaultReviewMode,
        defaultReviewEffort,
        pollIntervalSeconds,
        watchMaxDays,
        defaultMaxPushesPerCause,
        repoCount: store.countRepos(),
        activeWatchCount: store.countActiveWatches(),
      },
      repoDefaults: {
        reviewMode: defaultReviewMode,
        reviewEffort: defaultReviewEffort,
        maxPushesPerCause: defaultMaxPushesPerCause,
      },
    };
  }

  async function resolveHostAndRoot(
    ctx: PluginCliContext,
    hostOverride?: string,
    pathOverride?: string,
    projectOverride?: string,
  ): Promise<{ hostId: string; root: string; projectId: string | null }> {
    let hostId = hostOverride?.trim() || undefined;
    let root = pathOverride?.trim() || ctx.cwd?.trim() || undefined;
    let projectId = projectOverride?.trim() || ctx.projectId?.trim() || null;

    if ((!hostId || !root || !projectId) && ctx.threadId) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
        projectId ??= thread.projectId ?? null;
        if (thread.environmentId) {
          const env = await bb.sdk.environments.get({ environmentId: thread.environmentId });
          if (!hostId && env.hostId) hostId = env.hostId;
          if (!root && env.path) root = env.path;
        }
        if ((!hostId || !root) && thread.projectId) {
          const project = await bb.sdk.projects.get({ projectId: thread.projectId });
          const src = project.sources.find((x) => x.isDefault) ?? project.sources[0];
          if (src) {
            hostId ??= src.hostId;
            root ??= src.path;
          }
        }
      } catch {
        // Fall through to project/host lookup.
      }
    }

    if ((!hostId || !root) && projectId) {
      const project = await bb.sdk.projects.get({ projectId });
      const src = project.sources.find((x) => x.isDefault) ?? project.sources[0];
      if (src) {
        hostId ??= src.hostId;
        root ??= src.path;
      }
    }

    if (!hostId) {
      const hosts = await bb.sdk.hosts.list();
      const first = hosts[0];
      if (!first) {
        throw new PluginCliError("No connected Cloudroom host found.", {
          code: "no_host",
          hint: "Pass --host <hostId> or run inside a local project thread.",
        });
      }
      hostId = first.id;
    } else {
      const hosts = await bb.sdk.hosts.list();
      const matched = hosts.find((h) => h.id === hostId || h.name === hostId);
      if (matched) hostId = matched.id;
    }

    if (!root) {
      throw new PluginCliError("Could not determine checkout directory.", {
        code: "no_checkout_path",
        hint: "Pass --path <dir> or run from inside a repository checkout.",
      });
    }

    if (!projectId) {
      const normRoot = root.replace(/\/+$/u, "");
      try {
        const projects = await bb.sdk.projects.list();
        for (const proj of projects) {
          const matchedSrc = proj.sources.find((src) => {
            if (src.hostId && src.hostId !== hostId) return false;
            const srcRoot = src.path?.replace(/\/+$/u, "");
            if (!srcRoot) return false;
            return normRoot === srcRoot || normRoot.startsWith(`${srcRoot}/`);
          });
          if (matchedSrc) {
            projectId = proj.id;
            break;
          }
        }
      } catch {
        // Ignore unavailable project listing.
      }
    }

    return { hostId, root, projectId };
  }

  async function applyWatchControl(
    id: string,
    action: "stop" | "pause" | "resume",
    actor: string,
  ): Promise<WatchRecord> {
    const current = store.getWatch(id);
    if (!current) {
      throw new PluginCliError(`Watch "${id}" was not found.`, { code: "watch_not_found" });
    }
    let updated = current;
    if (action === "stop") {
      if (current.workerThreadId) {
        await bb.sdk.threads.stop({ threadId: current.workerThreadId }).catch(() => undefined);
        await bb.sdk.threads.archive({ threadId: current.workerThreadId }).catch(() => undefined);
      }
      updated = store.stopWatch(id, `stopped by ${actor}`, "stopped")!;
    } else if (action === "pause") {
      updated = store.pauseWatch(id)!;
    } else {
      updated = store.resumeWatch(id)!;
    }
    store.appendAudit({
      watchId: id,
      actor,
      action: `steward.${action}`,
      outcome: "ok",
      detail: { state: updated.state },
    });
    publishWatchesSignal({ type: "watch.updated", watchId: id, state: updated.state });
    return toPublicWatchRecord(updated);
  }

  function parseStringArrayJson(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  function toReviewRunSummary(row: ReviewRunRecord): ReviewRunSummary {
    const parsedMode = reviewModeSchema.catch("triad").parse(row.mode);
    return {
      id: row.id,
      watchId: row.watchId,
      repo: row.repo,
      prNumber: row.prNumber,
      headSha: row.headSha,
      mode: parsedMode as ReviewMode,
      round: row.round,
      seats: parseStringArrayJson(row.seatsJson),
      verdict: row.verdict,
      meanScore: row.meanScore,
      createdAt: row.createdAt,
    };
  }

  function toReviewFindingSummary(row: ReviewFindingRecord): ReviewFindingSummary {
    return {
      id: row.id,
      reviewRunId: row.reviewRunId,
      severity: row.severity,
      file: row.file,
      line: row.line,
      claim: row.claim,
      raisers: parseStringArrayJson(row.raisersJson),
      status: row.status,
      resolutionSha: row.resolutionSha,
    };
  }

  function toApprovalRunSummary(row: ApprovalRunRecord): ApprovalRunSummary {
    let verdict = "comment";
    let requiredSeats = 1;
    let matchedRuleIds: string[] = [];
    let classifierErrors: string[] = [];
    try {
      const parsed = JSON.parse(row.verdictJson) as {
        verdict?: unknown;
        requiredSeats?: unknown;
        matchedRuleIds?: unknown;
        classifierErrors?: unknown;
      };
      if (typeof parsed.verdict === "string") verdict = parsed.verdict;
      if (typeof parsed.requiredSeats === "number" && Number.isFinite(parsed.requiredSeats)) {
        requiredSeats = parsed.requiredSeats;
      }
      if (Array.isArray(parsed.matchedRuleIds)) {
        matchedRuleIds = parsed.matchedRuleIds.filter((x): x is string => typeof x === "string");
      }
      if (Array.isArray(parsed.classifierErrors)) {
        classifierErrors = parsed.classifierErrors.filter((x): x is string => typeof x === "string");
      }
    } catch {
      // Keep safe defaults for legacy/malformed rows.
    }
    return {
      id: row.id,
      repo: row.repo,
      prNumber: row.prNumber,
      headSha: row.headSha,
      policySha: row.policySha,
      mode: approvalsModeSchema.catch("observe").parse(row.mode),
      verdict,
      requiredSeats,
      matchedRuleIds,
      classifierErrors,
      statusPosted: row.statusPosted,
      reviewPosted: row.reviewPosted,
      createdAt: row.createdAt,
    };
  }

  async function resolveProjectForRepo(repoSlug: string): Promise<{
    hostId?: string;
    root?: string;
    projectId?: string;
  }> {
    const shortName = repoSlug.split("/")[1]?.toLowerCase() ?? "";
    if (!shortName) return {};
    try {
      const projects = await bb.sdk.projects.list();
      for (const proj of projects) {
        const src = proj.sources.find((s) => s.isDefault) ?? proj.sources[0];
        if (!src) continue;
        const pathTail = src.path?.replace(/\/+$/u, "").split("/").pop()?.toLowerCase() ?? "";
        if (proj.name.toLowerCase() === shortName || pathTail === shortName) {
          return {
            ...(src.hostId ? { hostId: src.hostId } : {}),
            ...(src.path ? { root: src.path } : {}),
            projectId: proj.id,
          };
        }
      }
    } catch {
      // Fall back to explicit overrides.
    }
    return {};
  }

  async function createOrReuseWatch(params: {
    actor: "cli" | "rpc";
    ctx: PluginCliContext;
    host?: string;
    path?: string;
    project?: string;
    repo?: string;
    pr?: number;
    remote?: string;
    base?: string;
    acceptTerms?: boolean;
  }): Promise<{ alreadyWatching: boolean; watch: WatchRecord }> {
    const nowMs = (deps.nowMs ?? Date.now)();
    let acceptedAt = await bb.storage.kv.get<number>(STEWARD_TERMS_KV_KEY);
    if (!acceptedAt) {
      if (params.acceptTerms) {
        acceptedAt = nowMs;
        await bb.storage.kv.set(STEWARD_TERMS_KV_KEY, acceptedAt);
      } else {
        throw new PluginCliError(
          "PR Steward terms must be accepted before starting a watch. Run `room-cli ship terms --accept` or pass `--accept-terms`.",
          { code: "steward_terms_required" },
        );
      }
    }

    if (params.repo) {
      const parsedRepo = repoSlugSchema.safeParse(params.repo);
      if (!parsedRepo.success) {
        throw new PluginCliError(`Invalid repository "${params.repo}": expected owner/repo.`, {
          code: "invalid_repo",
        });
      }
    }

    const inferred =
      params.repo && (!params.path || !params.host)
        ? await resolveProjectForRepo(params.repo)
        : {};

    const { hostId, root, projectId } = await resolveHostAndRoot(
      params.ctx,
      params.host ?? inferred.hostId,
      params.path ?? inferred.root,
      params.project ?? inferred.projectId,
    );

    const inspectCtx = await hostClient.call(
      "inspectPublishContext",
      {
        root,
        ...(params.remote ? { remote: params.remote } : {}),
        ...(params.base ? { baseBranch: params.base } : {}),
      },
      { hostId },
    );

    const repo = params.repo ?? inspectCtx.repoMeta?.slug ?? null;
    if (!repo) {
      throw new PluginCliError("Could not determine GitHub repository. Pass --repo <owner/repo>.", {
        code: "no_repo",
      });
    }
    const prNumber = params.pr ?? inspectCtx.existingPr?.number ?? null;
    if (!prNumber) {
      throw new PluginCliError(
        "No open PR found for the current branch. Pass --pr <number> or publish with `room-cli ship publish` first.",
        { code: "no_pr" },
      );
    }

    const repoCfg = store.getRepo(repo);
    const trustedBots = repoCfg?.trustedBots ?? [];
    const polled = await hostClient.call(
      "pollPrState",
      { root, repo, prNumber, trustedBots },
      { hostId },
    );

    if (polled.discussion.collisionLabels.length > 0) {
      throw new PluginCliError(
        `PR #${prNumber} carries steward collision label(s): ${polled.discussion.collisionLabels.join(", ")}`,
        { code: "collision_label" },
      );
    }

    const existing = store.getActiveWatchByRepoPr(repo, prNumber);
    if (existing) {
      return { alreadyWatching: true, watch: toPublicWatchRecord(existing) };
    }

    const pinSnap = await hostClient.call("computePins", { root }, { hostId });
    if (!pinSnap.ok) {
      throw new PluginCliError(`Failed to snapshot checkout tamper pins: ${pinSnap.error}`, {
        code: "pins_failed",
      });
    }

    const { status } = await currentDefaults();
    const watchId = `watch_${randomUUID()}`;
    const created = store.createWatch({
      id: watchId,
      projectId,
      hostId,
      worktreePath: inspectCtx.inspection.root,
      repo,
      prNumber,
      headBranch: polled.discussion.pr.headRefName,
      headRemote: inspectCtx.remoteName || "origin",
      baseBranch: params.base?.trim() || polled.discussion.pr.baseRefName,
      baseRemote: inspectCtx.remoteName || "origin",
      authorLogin: polled.discussion.pr.authorLogin,
      state: "watching",
      lastHeadSha: polled.discussion.pr.headRefOid,
      lastStateHash: null,
      startedAt: nowMs,
      expiresAt: nowMs + status.watchMaxDays * 24 * 60 * 60 * 1000,
      lastWokeAt: null,
      workerThreadId: null,
      pins: pinSnap.pins,
      trustedBots,
      seenCommentIds: [],
      causePushCounts: {},
      rerunJobIds: [],
      behindMergesCount: 0,
      stopReason: null,
    });

    store.appendAudit({
      watchId,
      actor: params.actor,
      action: "steward.started",
      outcome: "ok",
      detail: { repo, prNumber, headBranch: created.headBranch, baseBranch: created.baseBranch },
    });
    publishWatchesSignal({ type: "watch.created", watchId, state: "watching" });

    return { alreadyWatching: false, watch: toPublicWatchRecord(created) };
  }

  bb.rpc.register(rpcContract, {
    status: async () => (await currentDefaults()).status,
    listRepos: async () => store.listRepos(),
    upsertRepo: async (input) => {
      const { repoDefaults } = await currentDefaults();
      const updated = store.upsertRepo(input, repoDefaults);
      store.appendAudit({
        actor: "rpc",
        action: "repo.upsert",
        outcome: "ok",
        detail: { repo: updated.repo, reviewMode: updated.reviewMode, approvalsMode: updated.approvalsMode },
      });
      return updated;
    },
    listWatches: async (input) => store.listWatches(input),
    getWatchDetail: async ({ id }) => {
      const full = store.getWatch(id);
      if (!full) {
        throw new Error(`Watch "${id}" was not found.`);
      }
      const { repoDefaults } = await currentDefaults();
      const repoCfg = store.getRepo(full.repo);
      const latestRevRow = store.getLastReviewRun(full.repo, full.prNumber);
      const latestReview = latestRevRow ? toReviewRunSummary(latestRevRow) : null;
      const findings = latestRevRow
        ? store.listReviewFindings(latestRevRow.id).map(toReviewFindingSummary)
        : [];
      const latestAprRow = store.getLatestApprovalRun(full.repo, full.prNumber);
      const latestApproval = latestAprRow ? toApprovalRunSummary(latestAprRow) : null;
      const audits = store.listAudit({ watchId: id, limit: 25 });

      return {
        watch: toPublicWatchRecord(full),
        budgets: {
          causePushCounts: full.causePushCounts,
          maxPushesPerCause: repoCfg?.maxPushesPerCause ?? repoDefaults.maxPushesPerCause,
          behindMergesCount: full.behindMergesCount,
          maxBehindMerges: MAX_BEHIND_MERGES,
          rerunJobIds: full.rerunJobIds,
          pinsCount: Object.keys(full.pins).length,
          trustedBots: full.trustedBots,
          seenCommentsCount: full.seenCommentIds.length,
        },
        latestReview,
        findings,
        latestApproval,
        audits,
      };
    },
    startWatch: async (input) =>
      createOrReuseWatch({
        actor: "rpc",
        ctx: { cwd: input.worktreePath, projectId: input.projectId },
        host: input.hostId,
        path: input.worktreePath,
        project: input.projectId,
        repo: input.repo,
        pr: input.prNumber,
        base: input.baseBranch,
        acceptTerms: input.acceptTerms,
      }),
    controlWatch: async (input) => applyWatchControl(input.id, input.action, "rpc"),
    listReviewRuns: async (input) => store.listReviewRuns(input).map(toReviewRunSummary),
    listApprovalRuns: async (input) => store.listApprovalRuns(input).map(toApprovalRunSummary),
    listAudit: async (input) => store.listAudit(input),
    verifyBot: async () => {
      const s = await settings.get();
      const configuredLogin = (s.botLogin ?? "").trim();
      const bot = await currentBotClient();
      if (!bot) {
        return {
          configured: false,
          ok: false,
          configuredLogin,
          login: null,
          viewerId: null,
          loginMatches: null,
          error: "GitHub botToken is not configured.",
        };
      }
      try {
        const viewer = await bot.getViewerLogin();
        const loginMatches =
          configuredLogin === "" ? null : viewer.login.toLowerCase() === configuredLogin.toLowerCase();
        return {
          configured: true,
          ok: true,
          configuredLogin,
          login: viewer.login,
          viewerId: viewer.id,
          loginMatches,
          error: null,
        };
      } catch (err) {
        return {
          configured: true,
          ok: false,
          configuredLogin,
          login: null,
          viewerId: null,
          loginMatches: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    getThreadWatch: async (input) => {
      let full = store.getWatchByWorkerThreadId(input.threadId);
      if (!full && input.projectId) {
        full =
          store
            .listFullWatches({ activeOnly: true, limit: 100 })
            .find((w) => w.projectId === input.projectId) ?? null;
      }
      if (!full) {
        return {
          watch: null,
          latestReviewVerdict: null,
          latestReviewScore: null,
          latestApprovalVerdict: null,
        };
      }
      const latestRev = store.getLastReviewRun(full.repo, full.prNumber);
      const latestApr = store.getLatestApprovalRun(full.repo, full.prNumber);
      const aprSummary = latestApr ? toApprovalRunSummary(latestApr) : null;
      return {
        watch: toPublicWatchRecord(full),
        latestReviewVerdict: latestRev?.verdict ?? null,
        latestReviewScore: latestRev?.meanScore ?? null,
        latestApprovalVerdict: aprSummary?.verdict ?? null,
      };
    },
  });

  bb.http.route(
    "POST",
    "/webhook/github",
    async (c) => {
      const s = await settings.get();
      const secret = typeof s.webhookSecret === "string" ? s.webhookSecret.trim() : "";
      if (!secret) {
        return c.json({ ok: false, error: "webhook_not_configured" }, 503);
      }

      const rawBody = await c.req.text();
      const sigHeader = c.req.header("x-hub-signature-256");
      const event = (c.req.header("x-github-event") ?? "").trim().toLowerCase();

      if (!verifyGitHubWebhookSignature(rawBody, sigHeader, secret)) {
        store.appendAudit({
          actor: "webhook",
          action: "webhook.rejected",
          outcome: "error",
          detail: { event: event || "unknown" },
        });
        return c.json({ ok: false, error: "invalid_signature" }, 401);
      }

      if (event === "ping") {
        return c.json({ ok: true, event: "ping", triggered: false }, 200);
      }

      if (SUPPORTED_GITHUB_WEBHOOK_EVENTS.has(event)) {
        store.appendAudit({
          actor: "webhook",
          action: "webhook.received",
          outcome: "ok",
          detail: { event },
        });
        void poller.tickOnce().catch((err) => {
          bb.log?.error?.(
            `Webhook-triggered poll failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        return c.json({ ok: true, event, triggered: true }, 202);
      }

      return c.json({ ok: true, event: event || "unknown", triggered: false }, 200);
    },
    { auth: "none" },
  );

  async function startStewardWatch(
    ctx: PluginCliContext,
    options: {
      path?: string;
      host?: string;
      project?: string;
      repo?: string;
      pr?: number;
      remote?: string;
      base?: string;
      "accept-terms"?: boolean;
      json?: boolean;
    },
  ) {
    const res = await createOrReuseWatch({
      actor: "cli",
      ctx,
      host: options.host,
      path: options.path,
      project: options.project,
      repo: options.repo,
      pr: options.pr,
      remote: options.remote,
      base: options.base,
      acceptTerms: options["accept-terms"],
    });
    if (options.json) {
      return { exitCode: 0, stdout: `${JSON.stringify(res, null, 2)}\n` };
    }
    if (res.alreadyWatching) {
      return {
        exitCode: 0,
        stdout: `Already watching ${res.watch.repo}#${res.watch.prNumber} (${res.watch.id}, state=${res.watch.state})\n`,
      };
    }
    return {
      exitCode: 0,
      stdout: `Started watch ${res.watch.id} for ${res.watch.repo}#${res.watch.prNumber} (${res.watch.headBranch} -> ${res.watch.baseBranch})\n`,
    };
  }

  bb.cli.register(
    defineCli({
      name: "ship",
      summary: "Publish, review, steward, and approve GitHub pull requests.",
      description:
        "Cloudroom Ship manages GitHub PR publishing, multi-model triad/sol-loop reviews, persistent PR Steward watches, and policy approvals.",
      commands: {
        status: cliCommand({
          summary: "Show Ship plugin configuration, bot status, and active watch counts.",
          options: {
            json: { type: "boolean", description: "Print JSON output." },
          },
          async run({ options }) {
            const { status } = await currentDefaults();
            if (options.json) {
              return { exitCode: 0, stdout: `${JSON.stringify(status, null, 2)}\n` };
            }
            const lines = [
              `Ship v${status.pluginVersion}`,
              `Bot identity: ${status.botConfigured ? `configured${status.botLogin ? ` (${status.botLogin})` : ""}` : "not configured"}`,
              `Default review: ${status.defaultReviewMode} (${status.defaultReviewEffort})`,
              `Poller: ${status.pollIntervalSeconds}s | Max watch: ${status.watchMaxDays}d | Push cap: ${status.defaultMaxPushesPerCause}/cause`,
              `Repos configured: ${status.repoCount} | Active watches: ${status.activeWatchCount}`,
            ];
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          },
        }),
        "repos list": cliCommand({
          summary: "List per-repository Ship configurations.",
          options: {
            json: { type: "boolean", description: "Print JSON output." },
          },
          async run({ options }) {
            const repos = store.listRepos();
            if (options.json) {
              return { exitCode: 0, stdout: `${JSON.stringify(repos, null, 2)}\n` };
            }
            if (repos.length === 0) {
              return { exitCode: 0, stdout: "No repositories configured yet. Run `room-cli ship repos set owner/repo`.\n" };
            }
            const lines = repos.map(
              (r: RepoConfig) =>
                `${r.repo}\tenabled=${r.enabled}\treview=${r.reviewMode}:${r.reviewEffort}\tsteward=${r.autoSteward}\tapprovals=${r.approvalsMode}\tpushes<=${r.maxPushesPerCause}`,
            );
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          },
        }),
        "repos set": cliCommand({
          summary: "Create or update Ship settings for a GitHub repository.",
          positionals: [{ name: "repo", description: "GitHub repository (owner/repo).", required: true }],
          options: {
            "review-mode": {
              type: "enum",
              values: ["triad", "sol-loop", "single"],
              description: "Review mode for this repository.",
            },
            effort: {
              type: "enum",
              values: ["low", "medium", "high", "max"],
              description: "Review reasoning effort.",
            },
            "auto-steward": {
              type: "enum",
              values: ["manual", "auto"],
              description: "Manual (/ship or /steward) or automatic PR watching.",
            },
            approvals: {
              type: "enum",
              values: ["off", "observe", "enforce"],
              description: "Claude Approvals policy evaluation mode.",
            },
            "dev-automerge": {
              type: "boolean",
              description: "Enable opt-in dev-only auto-merge for this repository.",
            },
            "no-dev-automerge": {
              type: "boolean",
              description: "Disable dev-only auto-merge for this repository.",
            },
            "max-pushes": {
              type: "integer",
              min: 1,
              max: 20,
              description: "Maximum Steward pushes per cause.",
            },
            "max-rounds": {
              type: "integer",
              min: 1,
              max: 10,
              description: "Maximum review rounds.",
            },
            enabled: {
              type: "boolean",
              description: "Enable Ship for this repository.",
            },
            disabled: {
              type: "boolean",
              description: "Disable Ship for this repository.",
            },
            json: {
              type: "boolean",
              description: "Print JSON output.",
            },
          },
          constraints: [
            { kind: "at-most-one", options: ["enabled", "disabled"] },
            { kind: "at-most-one", options: ["dev-automerge", "no-dev-automerge"] },
          ],
          async run({ positionals, options }) {
            const parsedRepo = repoSlugSchema.safeParse(positionals.repo);
            if (!parsedRepo.success) {
              throw new PluginCliError(`Invalid repository "${positionals.repo}": expected owner/repo.`, {
                code: "invalid_repo",
              });
            }
            const { repoDefaults } = await currentDefaults();
            const saved = store.upsertRepo(
              {
                repo: parsedRepo.data,
                ...(options.enabled ? { enabled: true } : options.disabled ? { enabled: false } : {}),
                ...(options["review-mode"] ? { reviewMode: reviewModeSchema.parse(options["review-mode"]) } : {}),
                ...(options.effort ? { reviewEffort: reviewEffortSchema.parse(options.effort) } : {}),
                ...(options["auto-steward"] ? { autoSteward: autoStewardSchema.parse(options["auto-steward"]) } : {}),
                ...(options.approvals ? { approvalsMode: approvalsModeSchema.parse(options.approvals) } : {}),
                ...(options["dev-automerge"]
                  ? { allowDevAutomerge: true }
                  : options["no-dev-automerge"]
                    ? { allowDevAutomerge: false }
                    : {}),
                ...(options["max-pushes"] !== undefined ? { maxPushesPerCause: options["max-pushes"] } : {}),
                ...(options["max-rounds"] !== undefined ? { maxReviewRounds: options["max-rounds"] } : {}),
              },
              repoDefaults,
            );
            store.appendAudit({
              actor: "cli",
              action: "repo.set",
              outcome: "ok",
              detail: { repo: saved.repo },
            });
            if (options.json) {
              return { exitCode: 0, stdout: `${JSON.stringify(saved, null, 2)}\n` };
            }
            return {
              exitCode: 0,
              stdout: `Saved ${saved.repo}: enabled=${saved.enabled} review=${saved.reviewMode}:${saved.reviewEffort} steward=${saved.autoSteward} approvals=${saved.approvalsMode} devAutomerge=${saved.allowDevAutomerge}\n`,
            };
          },
        }),
        "safety-check": cliCommand({
          summary: "Inspect a checkout through the host daemon and classify changed files against Ship safety rules.",
          options: {
            path: { type: "string", description: "Absolute path to git checkout on the target host." },
            host: { type: "string", description: "Cloudroom host id or name." },
            json: { type: "boolean", description: "Print JSON output." },
          },
          async run({ options }, ctx) {
            const { hostId, root } = await resolveHostAndRoot(ctx, options.host, options.path);
            const [inspection, pinSnap] = await Promise.all([
              hostClient.call("inspectCheckout", { root }, { hostId }),
              hostClient.call("computePins", { root }, { hostId }),
            ]);
            const neverEditFiles = inspection.changedFiles.filter((f) => isNeverEditPath(f));
            const secretFiles = inspection.changedFiles.filter((f) => isSecretFilename(f));
            const payload = {
              hostId,
              inspection,
              neverEditFiles,
              secretFiles,
              pinsOk: pinSnap.ok,
              pinCount: Object.keys(pinSnap.pins).length,
              pinError: pinSnap.error,
            };
            if (options.json) {
              return { exitCode: 0, stdout: `${JSON.stringify(payload, null, 2)}\n` };
            }
            const lines = [
              `Host: ${hostId} | Checkout: ${inspection.root}`,
              `Branch: ${inspection.branch ?? "(detached)"} | HEAD: ${inspection.headSha ?? "(none)"} | Clean: ${inspection.isClean}`,
              `Changed files: ${inspection.changedFiles.length} | Never-edit hits: ${neverEditFiles.length} | Secret-filename hits: ${secretFiles.length}`,
              `Hard links: ${inspection.hardLinks.length} | Submodules: ${inspection.submodules.length} | In-progress op: ${inspection.inProgressOp ?? "none"}`,
              `Git-dir link issue: ${inspection.gitDirLinkIssue ?? "none"} | Pins captured: ${payload.pinCount} (${pinSnap.ok ? "ok" : pinSnap.error})`,
            ];
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          },
        }),
        publish: cliCommand({
          summary: "Run safety preflight, confirm, commit/push changes, and open or update a GitHub PR.",
          options: {
            path: { type: "string", description: "Absolute path to git checkout on the target host." },
            host: { type: "string", description: "Cloudroom host id or name." },
            remote: { type: "string", description: "Git remote name (defaults to origin)." },
            branch: { type: "string", description: "Target branch name (auto-created when on default branch)." },
            base: { type: "string", description: "Target base branch for the PR (defaults to repo default branch)." },
            title: { type: "string", description: "PR title hint." },
            body: { type: "string", description: "PR description hint." },
            "commit-message": { type: "string", description: "Commit message to use when staging dirty changes." },
            draft: { type: "boolean", description: "Create the PR as a draft." },
            "dry-run": { type: "boolean", description: "Run preflight and preview texts without modifying git or GitHub." },
            confirm: { type: "boolean", description: "Confirm headless publishing without an interactive thread card." },
            "allow-public-commit": { type: "boolean", description: "Allow non-interactive staging/committing on public repos." },
            "no-footer": { type: "boolean", description: "Omit the Cloudroom attribution footer from PR description." },
            json: { type: "boolean", description: "Print JSON output." },
          },
          async run({ options }, ctx) {
            const { hostId, root } = await resolveHostAndRoot(ctx, options.host, options.path);
            const result: ShipPublishResult = await runShipPublish(
              {
                hostId,
                root,
                threadId: ctx.threadId,
                remote: options.remote,
                requestedBranch: options.branch,
                baseBranch: options.base,
                titleHint: options.title,
                bodyHint: options.body,
                commitMessageHint: options["commit-message"],
                draft: options.draft,
                dryRun: options["dry-run"],
                confirm: options.confirm,
                allowPublicCommit: options["allow-public-commit"],
                includeFooter: !options["no-footer"],
                minDwellMs: deps.minDwellMs,
                nowMs: deps.nowMs,
              },
              {
                inspectPublishContext: (input) => hostClient.call("inspectPublishContext", input, { hostId }),
                publishChanges: (input) => hostClient.call("publishChanges", input, { hostId }),
                requestInput: (req) => bb.ui.requestInput(req),
                store,
              },
            );

            const exitCode = result.status === "published" || result.status === "dry_run" ? 0 : 1;
            if (options.json) {
              return { exitCode, stdout: `${JSON.stringify(result, null, 2)}\n` };
            }
            if (result.status === "blocked") {
              const lines = [
                "Preflight blocked publishing:",
                ...result.preflight.blockers.map((b) => `- [${b.code}] ${b.message}`),
              ];
              return { exitCode: 1, stderr: `${lines.join("\n")}\n` };
            }
            if (result.status === "dry_run") {
              const plan = result.preflight.plan!;
              const lines = [
                `Dry-run OK for ${plan.repoSlug} (${plan.isPrivate ? "private" : "public"})`,
                `Branch: ${plan.targetBranch} -> ${plan.baseBranch}${plan.createBranch ? " (new)" : ""}`,
                `Files to stage: ${plan.filesToStage.length} | Ahead commits: ${plan.aheadCount}`,
                `PR title: ${result.prTitle}`,
                ...(result.preflight.warnings.map((w) => `Warning [${w.code}]: ${w.message}`)),
              ];
              return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
            }
            if (result.status === "published") {
              const p = result.publish;
              const lines = [
                `Published ${p.branch} (${p.headSha ?? "unknown"})`,
                ...(p.prUrl ? [`PR #${p.prNumber}: ${p.prUrl}`] : []),
              ];
              return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
            }
            if (result.status === "failed") {
              return { exitCode: 1, stderr: `Publish failed: ${result.publish.error ?? "unknown error"}\n` };
            }
            return { exitCode: 1, stderr: `Publish ${result.status}: ${result.reason}\n` };
          },
        }),
        "pr comments": cliCommand({
          summary: "Read trust-filtered and markup-sanitized comments on a GitHub pull request.",
          positionals: [
            { name: "repo", description: "GitHub repository (owner/repo).", required: true },
            { name: "pr", description: "Pull request number.", required: true },
          ],
          options: {
            path: { type: "string", description: "Absolute path to git checkout on the target host." },
            host: { type: "string", description: "Cloudroom host id or name." },
            "via-bot": { type: "boolean", description: "Read using configured botToken instead of host gh CLI." },
            json: { type: "boolean", description: "Print JSON output." },
          },
          async run({ positionals, options }, ctx) {
            const parsedRepo = repoSlugSchema.safeParse(positionals.repo);
            if (!parsedRepo.success) {
              throw new PluginCliError(`Invalid repository "${positionals.repo}": expected owner/repo.`, {
                code: "invalid_repo",
              });
            }
            if (!/^[1-9]\d*$/u.test(positionals.pr)) {
              throw new PluginCliError(`Invalid PR number "${positionals.pr}".`, { code: "invalid_pr_number" });
            }
            const repo = parsedRepo.data;
            const prNumber = Number.parseInt(positionals.pr, 10);
            const repoCfg = store.getRepo(repo);

            let discussion: FilteredPrDiscussion;
            if (options["via-bot"]) {
              const s = await settings.get();
              const token = typeof s.botToken === "string" ? s.botToken.trim() : "";
              if (!token) {
                throw new PluginCliError(
                  "GitHub botToken is not configured. Run `room-cli plugin config ship set botToken <pat>`.",
                  { code: "bot_not_configured" },
                );
              }
              const bot = new GitHubBotClient({
                token,
                botLogin: (s.botLogin ?? "").trim(),
                fetchImpl: deps.fetchImpl,
              });
              discussion = await fetchPrDiscussion({
                repo,
                prNumber,
                trustedBots: repoCfg?.trustedBots ?? [],
                runGraphql: (query, vars) => bot.graphql(query, vars),
                fetchCollaboratorPermission: (r, u) => bot.getCollaboratorPermission(r, u),
              });
            } else {
              const { hostId, root } = await resolveHostAndRoot(ctx, options.host, options.path);
              discussion = await hostClient.call(
                "readPrDiscussion",
                {
                  root,
                  repo,
                  prNumber,
                  trustedBots: repoCfg?.trustedBots ?? [],
                },
                { hostId },
              );
            }

            if (options.json) {
              return { exitCode: 0, stdout: `${JSON.stringify(discussion, null, 2)}\n` };
            }
            const lines = [
              `${repo}#${discussion.pr.number}: ${discussion.pr.title} (${discussion.pr.state})`,
              `Trusted items: ${discussion.items.length} | Excluded: ${discussion.excludedCount} | Collision labels: ${discussion.collisionLabels.length}`,
              ...discussion.items.map(
                (item) => `- [${item.kind}:${item.trustReason}${item.mayHide ? ":may-hide" : ""}] @${item.authorLogin}: ${item.body.slice(0, 120)}`,
              ),
            ];
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          },
        }),
        "bot check": cliCommand({
          summary: "Verify the configured Ship GitHub bot token without printing credentials.",
          options: {
            json: { type: "boolean", description: "Print JSON output." },
          },
          async run({ options }) {
            const s = await settings.get();
            const token = typeof s.botToken === "string" ? s.botToken.trim() : "";
            const configuredLogin = (s.botLogin ?? "").trim();
            if (!token) {
              throw new PluginCliError(
                "GitHub botToken is not configured. Run `room-cli plugin config ship set botToken <pat>`.",
                { code: "bot_not_configured" },
              );
            }
            const bot = new GitHubBotClient({
              token,
              botLogin: configuredLogin,
              fetchImpl: deps.fetchImpl,
            });
            const viewer = await bot.getViewerLogin();
            const loginMatches =
              configuredLogin === "" ? null : viewer.login.toLowerCase() === configuredLogin.toLowerCase();
            const payload = {
              configured: true,
              configuredLogin,
              actualLogin: viewer.login,
              viewerId: viewer.id,
              loginMatches,
            };
            if (options.json) {
              return { exitCode: 0, stdout: `${JSON.stringify(payload, null, 2)}\n` };
            }
            const matchNote =
              loginMatches === null
                ? "(botLogin setting not set)"
                : loginMatches
                  ? "(matches botLogin)"
                  : `(WARNING: differs from configured botLogin "${configuredLogin}")`;
            return {
              exitCode: 0,
              stdout: `Bot token valid as "${viewer.login}" (id ${viewer.id}) ${matchNote}\n`,
            };
          },
        }),
        review: cliCommand({
          summary: "Run a multi-model code review (triad default, sol-loop, or single) on committed HEAD.",
          options: {
            path: { type: "string", description: "Absolute path to git checkout on the target host." },
            host: { type: "string", description: "Cloudroom host id or name." },
            project: { type: "string", description: "Cloudroom project id for spawning reviewer child threads." },
            repo: { type: "string", description: "GitHub repository (owner/repo) for PR dedup/posting." },
            pr: { type: "integer", min: 1, max: 9_999_999, description: "Optional pull request number." },
            base: { type: "string", description: "Base ref or commit SHA to diff from." },
            mode: {
              type: "enum",
              values: ["triad", "sol-loop", "single"],
              description: "Review mode override.",
            },
            effort: {
              type: "enum",
              values: ["low", "medium", "high", "max"],
              description: "Reasoning effort override.",
            },
            intent: { type: "string", description: "Concise statement of change intent for reviewers." },
            "out-of-scope": { type: "string", description: "Notes on out-of-scope items reviewers should ignore." },
            checks: { type: "string", description: "Summary of local typecheck/test results." },
            round: { type: "integer", min: 1, max: 10, description: "Sol-loop / review round number." },
            force: { type: "boolean", description: "Force review even if hosted or prior Ship review exists." },
            post: { type: "boolean", description: "Post summary and inline comments to GitHub using botToken." },
            "dry-run": { type: "boolean", description: "Resolve dedup, risk, and seat routes without spawning threads." },
            json: { type: "boolean", description: "Print JSON output." },
          },
          async run({ options }, ctx) {
            if (options.repo) {
              const parsedRepo = repoSlugSchema.safeParse(options.repo);
              if (!parsedRepo.success) {
                throw new PluginCliError(`Invalid repository "${options.repo}": expected owner/repo.`, {
                  code: "invalid_repo",
                });
              }
            }
            const { hostId, root, projectId } = await resolveHostAndRoot(
              ctx,
              options.host,
              options.path,
              options.project,
            );
            if (!options["dry-run"] && !projectId) {
              throw new PluginCliError("Could not determine projectId to spawn reviewer child threads.", {
                code: "no_project_id",
                hint: "Run from inside a Cloudroom project or thread.",
              });
            }

            const s = await settings.get();
            const token = typeof s.botToken === "string" ? s.botToken.trim() : "";
            const botClient = token
              ? new GitHubBotClient({
                  token,
                  botLogin: (s.botLogin ?? "").trim(),
                  fetchImpl: deps.fetchImpl,
                })
              : null;

            const defaults = await currentDefaults();
            const mode = options.mode
              ? reviewModeSchema.parse(options.mode)
              : undefined;
            const effort = options.effort
              ? reviewEffortSchema.parse(options.effort)
              : undefined;

            let cachedHeadSha = "0".repeat(40);
            const result = await runShipReview(
              {
                hostId,
                root,
                repo: options.repo,
                prNumber: options.pr,
                baseRef: options.base,
                mode,
                effort,
                defaultMode: defaults.repoDefaults.reviewMode,
                defaultEffort: defaults.repoDefaults.reviewEffort,
                intent: options.intent,
                outOfScope: options["out-of-scope"],
                checks: options.checks,
                round: options.round,
                force: options.force,
                post: options.post,
                dryRun: options["dry-run"],
                nowMs: deps.nowMs,
              },
              {
                store,
                inspectReviewContext: async (input) => {
                  const res = await hostClient.call("inspectReviewContext", input, { hostId });
                  cachedHeadSha = res.headSha;
                  return res;
                },
                scanOutboundForLocalSecrets: (input) => hostClient.call("scanOutboundForLocalSecrets", input, { hostId }),
                readPrDiscussion: (input) =>
                  hostClient.call("readPrDiscussion", { root: input.root, repo: input.repo, prNumber: input.prNumber, trustedBots: input.trustedBots }, { hostId }),
                botClient,
                execDispatch: deps.execDispatch,
                executor: createCloudroomSeatExecutor({
                  bb,
                  projectId: projectId ?? "dry-run",
                  parentThreadId: ctx.threadId,
                  get headSha() {
                    return cachedHeadSha;
                  },
                  gatekeeper,
                  settledWaiters,
                  seatTimeoutMs: deps.seatTimeoutMs,
                }),
              },
            );

            const exitCode =
              result.status === "blocked" || (result.status === "completed" && result.postError !== null) ? 1 : 0;
            if (options.json) {
              return { exitCode, stdout: `${JSON.stringify(result, null, 2)}\n` };
            }
            if (result.status === "blocked") {
              return { exitCode: 1, stderr: `Review blocked: ${result.reason}\n` };
            }
            if (result.status === "skipped") {
              return { exitCode: 0, stdout: `Review skipped: ${result.reason}\n` };
            }
            if (result.status === "dry_run") {
              const lines = [
                `Review dry-run: mode=${result.mode} (${result.effort}) risk=${result.riskTier} checkout=${result.allowCheckout}`,
                `HEAD: ${result.headSha} | Base: ${result.baseSha}`,
                `Seats (${result.seats.length}): ${result.seats.map((seat) => `${seat.family}:${seat.model}@${seat.hostId ?? "cloud"}`).join(", ") || "none"}`,
              ];
              return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
            }
            const lines = [
              `Review ${result.reviewRunId}: verdict=${result.verdict} (${result.validSeats}/${result.targetSeats} seats, score=${result.meanScore ?? "n/a"}, risk=${result.riskTier})`,
              `Findings: ${result.findings.length}${result.stopReason ? ` | Stop notice: ${result.stopReason}` : ""}`,
              ...result.findings.map((f) => `- ${f.id} [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""} ${f.claim}`),
              ...(result.postedReviewId ? [`Posted GitHub review id=${result.postedReviewId}`] : []),
              ...(result.postError ? [`Post error: ${result.postError}`] : []),
            ];
            return { exitCode, stdout: `${lines.join("\n")}\n` };
          },
        }),
        terms: cliCommand({
          summary: "View or accept PR Steward autonomous background watch terms.",
          options: {
            accept: { type: "boolean", description: "Accept PR Steward terms." },
            json: { type: "boolean", description: "Print JSON output." },
          },
          async run({ options }) {
            let acceptedAt = await bb.storage.kv.get<number>(STEWARD_TERMS_KV_KEY);
            if (options.accept && !acceptedAt) {
              acceptedAt = (deps.nowMs ?? Date.now)();
              await bb.storage.kv.set(STEWARD_TERMS_KV_KEY, acceptedAt);
              store.appendAudit({
                actor: "cli",
                action: "steward.terms_accepted",
                outcome: "ok",
                detail: { acceptedAt },
              });
            }
            const accepted = typeof acceptedAt === "number";
            if (options.json) {
              return { exitCode: 0, stdout: `${JSON.stringify({ accepted, acceptedAt: acceptedAt ?? null }, null, 2)}\n` };
            }
            return {
              exitCode: 0,
              stdout: accepted
                ? `PR Steward terms accepted at ${new Date(acceptedAt!).toISOString()}\n`
                : "PR Steward terms not accepted yet. Run `room-cli ship terms --accept`.\n",
            };
          },
        }),
        start: cliCommand({
          summary: "Start persistent PR Steward watching on a pull request.",
          options: {
            path: { type: "string", description: "Absolute path to git checkout on the target host." },
            host: { type: "string", description: "Cloudroom host id or name." },
            project: { type: "string", description: "Cloudroom project id for spawning Steward workers." },
            repo: { type: "string", description: "GitHub repository (owner/repo)." },
            pr: { type: "integer", min: 1, max: 9_999_999, description: "Pull request number." },
            remote: { type: "string", description: "Git remote name (defaults to origin)." },
            base: { type: "string", description: "Base branch override." },
            "accept-terms": { type: "boolean", description: "Accept PR Steward terms if not yet accepted." },
            json: { type: "boolean", description: "Print JSON output." },
          },
          async run({ options }, ctx) {
            return startStewardWatch(ctx, options);
          },
        }),
        steward: cliCommand({
          summary: "Start persistent PR Steward watching on a pull request (alias for ship start).",
          options: {
            path: { type: "string", description: "Absolute path to git checkout on the target host." },
            host: { type: "string", description: "Cloudroom host id or name." },
            project: { type: "string", description: "Cloudroom project id for spawning Steward workers." },
            repo: { type: "string", description: "GitHub repository (owner/repo)." },
            pr: { type: "integer", min: 1, max: 9_999_999, description: "Pull request number." },
            remote: { type: "string", description: "Git remote name (defaults to origin)." },
            base: { type: "string", description: "Base branch override." },
            "accept-terms": { type: "boolean", description: "Accept PR Steward terms if not yet accepted." },
            json: { type: "boolean", description: "Print JSON output." },
          },
          async run({ options }, ctx) {
            return startStewardWatch(ctx, options);
          },
        }),
        watches: cliCommand({
          summary: "List active or historical PR Steward watches.",
          options: {
            all: { type: "boolean", description: "Include stopped, merged, and closed watches." },
            state: { type: "string", description: "Filter by exact watch state." },
            json: { type: "boolean", description: "Print JSON output." },
          },
          async run({ options }) {
            const list = options.state
              ? store.listWatches({ state: options.state, limit: 200 })
              : store
                  .listWatches({ limit: 200 })
                  .filter((w) => options.all || (w.state !== "stopped" && w.state !== "merged" && w.state !== "closed"));
            if (options.json) {
              return { exitCode: 0, stdout: `${JSON.stringify(list, null, 2)}\n` };
            }
            if (list.length === 0) {
              return { exitCode: 0, stdout: "No PR watches matching filter.\n" };
            }
            const lines = list.map(
              (w) => `${w.id}\t${w.repo}#${w.prNumber}\t${w.headBranch}->${w.baseBranch}\tstate=${w.state}\t${w.stopReason ?? ""}`,
            );
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          },
        }),
        stop: cliCommand({
          summary: "Stop a PR Steward watch and archive any running worker.",
          positionals: [{ name: "watchId", description: "Watch id to stop.", required: true }],
          options: { json: { type: "boolean", description: "Print JSON output." } },
          async run({ positionals, options }) {
            const updated = await applyWatchControl(positionals.watchId, "stop", "cli");
            if (options.json) return { exitCode: 0, stdout: `${JSON.stringify(updated, null, 2)}\n` };
            return { exitCode: 0, stdout: `Stopped watch ${updated.id} (${updated.repo}#${updated.prNumber})\n` };
          },
        }),
        pause: cliCommand({
          summary: "Pause a PR Steward watch.",
          positionals: [{ name: "watchId", description: "Watch id to pause.", required: true }],
          options: { json: { type: "boolean", description: "Print JSON output." } },
          async run({ positionals, options }) {
            const updated = await applyWatchControl(positionals.watchId, "pause", "cli");
            if (options.json) return { exitCode: 0, stdout: `${JSON.stringify(updated, null, 2)}\n` };
            return { exitCode: 0, stdout: `Paused watch ${updated.id} (${updated.repo}#${updated.prNumber})\n` };
          },
        }),
        resume: cliCommand({
          summary: "Resume a paused PR Steward watch.",
          positionals: [{ name: "watchId", description: "Watch id to resume.", required: true }],
          options: { json: { type: "boolean", description: "Print JSON output." } },
          async run({ positionals, options }) {
            const updated = await applyWatchControl(positionals.watchId, "resume", "cli");
            if (options.json) return { exitCode: 0, stdout: `${JSON.stringify(updated, null, 2)}\n` };
            return { exitCode: 0, stdout: `Resumed watch ${updated.id} (${updated.repo}#${updated.prNumber})\n` };
          },
        }),
        "approvals check": cliCommand({
          summary: "Evaluate default-branch .claude/approvals.yml policy and optional dev-only auto-merge.",
          positionals: [{ name: "pr", description: "Pull request number.", required: true }],
          options: {
            path: { type: "string", description: "Absolute path to git checkout on the target host." },
            host: { type: "string", description: "Cloudroom host id or name." },
            project: { type: "string", description: "Cloudroom project id for running LLM classifiers." },
            repo: { type: "string", description: "GitHub repository (owner/repo)." },
            remote: { type: "string", description: "Base git remote name (defaults to origin)." },
            "default-branch": { type: "string", description: "Default branch override for policy loading." },
            mode: {
              type: "enum",
              values: ["observe", "enforce", "off"],
              description: "Override approvals mode (observe, enforce, or off).",
            },
            post: { type: "boolean", description: "Post Commit Status and bot PR review via botToken." },
            automerge: { type: "boolean", description: "Attempt dev-only auto-merge if all 8 guard invariants pass." },
            "dry-run": { type: "boolean", description: "Evaluate without persisting approval_runs or posting to GitHub." },
            json: { type: "boolean", description: "Print JSON output." },
          },
          async run({ positionals, options }, ctx) {
            if (!/^[1-9]\d*$/u.test(positionals.pr)) {
              throw new PluginCliError(`Invalid PR number "${positionals.pr}".`, { code: "invalid_pr_number" });
            }
            const prNumber = Number.parseInt(positionals.pr, 10);

            if (options.repo) {
              const parsedRepo = repoSlugSchema.safeParse(options.repo);
              if (!parsedRepo.success) {
                throw new PluginCliError(`Invalid repository "${options.repo}": expected owner/repo.`, {
                  code: "invalid_repo",
                });
              }
            }

            const { hostId, root, projectId } = await resolveHostAndRoot(
              ctx,
              options.host,
              options.path,
              options.project,
            );

            let repo = options.repo;
            if (!repo) {
              const pubCtx = await hostClient.call("inspectPublishContext", { root }, { hostId });
              repo = pubCtx.repoMeta?.slug;
              if (!repo) {
                throw new PluginCliError("Could not determine GitHub repository. Pass --repo <owner/repo>.", {
                  code: "no_repo",
                });
              }
            }

            const approvalCtx = await hostClient.call(
              "inspectApprovalContext",
              {
                root,
                repo,
                prNumber,
                ...(options.remote ? { baseRemote: options.remote } : {}),
                ...(options["default-branch"] ? { defaultBranch: options["default-branch"] } : {}),
              },
              { hostId },
            );

            if (!approvalCtx.ok || !approvalCtx.pr) {
              const errMsg = approvalCtx.error ?? "Failed to inspect approval context.";
              if (options.json) {
                return { exitCode: 1, stdout: `${JSON.stringify({ status: "error", error: errMsg }, null, 2)}\n` };
              }
              return { exitCode: 1, stderr: `Approvals check failed: ${errMsg}\n` };
            }

            if (!approvalCtx.policyFound || !approvalCtx.policyRaw) {
              if (!options["dry-run"]) {
                store.appendAudit({
                  actor: "cli",
                  action: "approvals.no_policy",
                  outcome: "skipped",
                  detail: { repo, prNumber, defaultBranch: approvalCtx.defaultBranch },
                });
              }
              const noPolicyPayload = {
                status: "no_policy",
                repo,
                prNumber,
                defaultBranch: approvalCtx.defaultBranch,
                headSha: approvalCtx.pr.headSha,
              };
              if (options.json) {
                return { exitCode: 0, stdout: `${JSON.stringify(noPolicyPayload, null, 2)}\n` };
              }
              return {
                exitCode: 0,
                stdout: `No .claude/approvals.yml found on ${approvalCtx.baseRemote}/${approvalCtx.defaultBranch} for ${repo}.\n`,
              };
            }

            let policy;
            let classifiers;
            let bundleSha: string;
            try {
              policy = parseApprovalsPolicy(approvalCtx.policyRaw);
              classifiers = loadAndValidateClassifiers(policy, approvalCtx.classifiers);
              bundleSha = computePolicyBundleSha(approvalCtx.policyRaw, approvalCtx.classifiers);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (!options["dry-run"]) {
                store.appendAudit({
                  actor: "cli",
                  action: "approvals.invalid_policy",
                  outcome: "error",
                  detail: { repo, prNumber, error: msg },
                });
              }
              if (options.json) {
                return { exitCode: 1, stdout: `${JSON.stringify({ status: "invalid_policy", error: msg }, null, 2)}\n` };
              }
              return { exitCode: 1, stderr: `Invalid approvals policy on default branch: ${msg}\n` };
            }

            const repoCfg = store.getRepo(repo);
            const effectiveMode = approvalsModeSchema.parse(
              options.mode ?? repoCfg?.approvalsMode ?? policy.mode ?? "observe",
            );

            const executor: ClassifierExecutor | null =
              deps.classifierExecutor ??
              (!options["dry-run"] && projectId
                ? createCloudroomClassifierExecutor({
                    bb,
                    projectId,
                    parentThreadId: ctx.threadId,
                    gatekeeper,
                    settledWaiters,
                    timeoutMs: deps.seatTimeoutMs,
                  })
                : null);

            const nowMs = (deps.nowMs ?? Date.now)();
            const decision = await evaluateApprovalsPolicy({
              repo,
              policy,
              policySha: bundleSha,
              classifiers,
              pr: approvalCtx.pr,
              checkRuns: approvalCtx.checkRuns,
              diffText: approvalCtx.diffText,
              store,
              executor,
              sandboxGateReceipt: approvalCtx.sandboxGateReceipt ?? null,
              hasCloudroomBootstrap: approvalCtx.containerGates?.hasBootstrapCloudroom ?? false,
              nowMs,
            });

            let report: ApprovalReportResult | null = null;
            if (!options["dry-run"] && options.post && effectiveMode !== "off") {
              report = await reportApprovalDecision({
                repo,
                prNumber,
                root,
                effectiveMode,
                decision,
                botClient: await currentBotClient(),
                scanOutboundForLocalSecrets: (input) =>
                  hostClient.call("scanOutboundForLocalSecrets", input, { hostId }),
              });
            }

            const latestReviewRun = store.getLatestReviewRun(repo, prNumber, approvalCtx.pr.headSha);
            const autoMergeGuard = evaluateDevAutoMergeGuard({
              allowDevAutomerge: repoCfg?.allowDevAutomerge ?? false,
              pr: approvalCtx.pr,
              facts: decision.facts,
              decision,
              latestReviewRun,
            });

            let mergeResult: { attempted: boolean; merged: boolean; error: string | null } = {
              attempted: false,
              merged: false,
              error: null,
            };
            if (!options["dry-run"] && options.automerge && autoMergeGuard.eligible) {
              const res = await hostClient.call(
                "mergeDevPr",
                {
                  root,
                  repo,
                  prNumber,
                  baseBranch: approvalCtx.pr.baseBranch,
                  expectedHeadSha: approvalCtx.pr.headSha,
                },
                { hostId },
              );
              mergeResult = { attempted: true, merged: res.merged, error: res.error };
              store.appendAudit({
                actor: "cli",
                action: "approvals.automerge",
                outcome: res.ok && res.merged ? "merged" : "error",
                detail: { repo, prNumber, headSha: approvalCtx.pr.headSha, error: res.error },
              });
            }

            if (!options["dry-run"]) {
              const runId = `apr_${randomUUID()}`;
              store.insertApprovalRun({
                id: runId,
                repo,
                prNumber,
                headSha: approvalCtx.pr.headSha,
                policySha: bundleSha,
                mode: effectiveMode,
                verdictJson: JSON.stringify({
                  verdict: decision.verdict,
                  requiredSeats: decision.requiredSeats,
                  matchedRuleIds: decision.matchedRuleIds,
                  classifierErrors: decision.classifierErrors,
                }),
                classifierCacheJson: JSON.stringify(decision.classifierCache),
                statusPosted: report?.statusPosted ?? false,
                reviewPosted: report?.reviewPosted ?? false,
                createdAt: nowMs,
              });
              store.appendAudit({
                actor: "cli",
                action: "approvals.checked",
                outcome: decision.verdict,
                detail: {
                  repo,
                  prNumber,
                  headSha: approvalCtx.pr.headSha,
                  mode: effectiveMode,
                  requiredSeats: decision.requiredSeats,
                  classifierCalls: decision.classifierCallCount,
                  cacheHits: decision.classifierCacheHits,
                  statusPosted: report?.statusPosted ?? false,
                  reviewPosted: report?.reviewPosted ?? false,
                },
              });
            }

            const hasPostError = Boolean(report?.error);
            const hasMergeError = mergeResult.attempted && !mergeResult.merged;
            const exitCode = hasPostError || hasMergeError ? 1 : 0;

            const outputPayload = {
              status: options["dry-run"] ? "dry_run" : "checked",
              repo,
              prNumber,
              defaultBranch: approvalCtx.defaultBranch,
              effectiveMode,
              decision: {
                headSha: decision.headSha,
                policySha: decision.policySha,
                statusContext: decision.statusContext,
                verdict: decision.verdict,
                requiredSeats: decision.requiredSeats,
                usedFallbackDefault: decision.usedFallbackDefault,
                matchedRuleIds: decision.matchedRuleIds,
                classifierErrors: decision.classifierErrors,
                classifierCallCount: decision.classifierCallCount,
                classifierCacheHits: decision.classifierCacheHits,
                gateSource: decision.facts.gateSource,
                gateSatisfied: decision.facts.gateSatisfied,
                sandboxGateReceipt: decision.facts.sandboxGateReceipt,
                ruleResults: decision.ruleResults,
              },
              report,
              autoMerge: {
                ...autoMergeGuard,
                ...mergeResult,
              },
            };

            if (options.json) {
              return { exitCode, stdout: `${JSON.stringify(outputPayload, null, 2)}\n` };
            }

            const lines = [
              `Approvals (${effectiveMode}) for ${repo}#${prNumber}@${decision.headSha.slice(0, 7)}: verdict=${decision.verdict}, seats=${decision.requiredSeats}, gate=${decision.facts.gateSource}`,
              `Matched rules: ${decision.matchedRuleIds.join(", ") || "(default_action)"}`,
              ...(decision.classifierErrors.length > 0
                ? [`Classifier errors: ${decision.classifierErrors.join("; ")}`]
                : []),
              ...(report
                ? [
                    `Posted: status=${report.statusPosted ? report.statusState : "no"} review=${report.reviewPosted ? report.reviewEvent : "no"}${report.error ? ` (${report.error})` : ""}`,
                  ]
                : []),
              `Dev auto-merge eligible: ${autoMergeGuard.eligible}${autoMergeGuard.blockedReasons.length > 0 ? ` (${autoMergeGuard.blockedReasons[0]})` : ""}`,
              ...(mergeResult.attempted
                ? [`Dev auto-merge result: ${mergeResult.merged ? "merged" : `failed (${mergeResult.error})`}`]
                : []),
            ];
            return { exitCode, stdout: `${lines.join("\n")}\n` };
          },
        }),
        "gate inspect": cliCommand({
          summary: "Inspect container merge-guard gate scripts, Kiri runners, and Cloud sandbox status.",
          options: {
            host: { type: "string", description: "Cloudroom host id or name." },
            path: { type: "string", description: "Absolute path to git checkout on the target host." },
            base: { type: "string", description: "Target base branch (e.g. dev or main)." },
            repo: { type: "string", description: "GitHub repository (owner/repo) override." },
            json: { type: "boolean", description: "Print JSON output." },
          },
          async run({ options }, ctx) {
            if (options.repo) {
              const parsedRepo = repoSlugSchema.safeParse(options.repo);
              if (!parsedRepo.success) {
                throw new PluginCliError(`Invalid repository "${options.repo}": expected owner/repo.`, {
                  code: "invalid_repo",
                });
              }
            }
            const { hostId, root } = await resolveHostAndRoot(ctx, options.host, options.path);
            let repoSlug = options.repo;
            if (!repoSlug) {
              const pubCtx = await hostClient
                .call("inspectPublishContext", { root }, { hostId })
                .catch(() => null);
              repoSlug = pubCtx?.repoMeta?.slug ?? undefined;
            }
            const plan = await hostClient.call(
              "inspectContainerGates",
              {
                root,
                ...(options.base ? { baseBranch: options.base } : {}),
                ...(repoSlug ? { repoSlug } : {}),
              },
              { hostId },
            );
            if (options.json) {
              return { exitCode: 0, stdout: `${JSON.stringify({ hostId, root, repoSlug: repoSlug ?? null, ...plan }, null, 2)}\n` };
            }
            const lines = [
              `Container gates (${plan.repoKind}): sandbox=${plan.inCloudSandbox} supportedForBase=${plan.supportedForBase}`,
              `Scripts: bootstrap=${plan.bootstrapScriptPath ?? "none"}, merge-eligibility=${plan.mergeEligibilityScriptPath ?? "none"}, kiri=${plan.hasKiriRunner ? plan.kiriFiles.join(", ") : "none"}`,
              ...(plan.unsupportedReason ? [`Restriction: ${plan.unsupportedReason}`] : []),
              ...(plan.recommendedGateCommand ? [`Recommended command: ${plan.recommendedGateCommand}`] : []),
            ];
            return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
          },
        }),
        "gate eligibility": cliCommand({
          summary: "Check deterministic conflict-only merge eligibility for a PR via scripts/ci/merge-eligibility.sh.",
          positionals: [{ name: "pr", description: "Pull request number.", required: true }],
          options: {
            host: { type: "string", description: "Cloudroom host id or name." },
            path: { type: "string", description: "Absolute path to git checkout on the target host." },
            base: { type: "string", description: "Optional base branch ref." },
            repo: { type: "string", description: "Optional GitHub repository (owner/repo)." },
            policy: {
              type: "enum",
              values: ["conflict-only", "strict"],
              description: "Behind policy mode (default conflict-only).",
            },
            json: { type: "boolean", description: "Print JSON output." },
          },
          async run({ positionals, options }, ctx) {
            if (!/^[1-9]\d*$/u.test(positionals.pr)) {
              throw new PluginCliError(`Invalid PR number "${positionals.pr}".`, { code: "invalid_pr_number" });
            }
            const prNumber = Number.parseInt(positionals.pr, 10);
            if (options.repo) {
              const parsedRepo = repoSlugSchema.safeParse(options.repo);
              if (!parsedRepo.success) {
                throw new PluginCliError(`Invalid repository "${options.repo}": expected owner/repo.`, {
                  code: "invalid_repo",
                });
              }
            }
            const { hostId, root } = await resolveHostAndRoot(ctx, options.host, options.path);
            const result = await hostClient.call(
              "runMergeEligibility",
              {
                root,
                prNumber,
                ...(options.base ? { baseRef: options.base } : {}),
                ...(options.repo ? { repo: options.repo } : {}),
                behindPolicy: options.policy ?? "conflict-only",
              },
              { hostId },
            );
            const exitCode = result.scriptFound ? 0 : 1;
            if (options.json) {
              return { exitCode, stdout: `${JSON.stringify(result, null, 2)}\n` };
            }
            if (!result.scriptFound) {
              return { exitCode: 1, stderr: `Merge eligibility check unavailable: ${result.error}\n` };
            }
            return {
              exitCode: 0,
              stdout: `PR #${prNumber} eligibility: eligible=${result.eligible}, conflictFree=${result.conflictFree}, sharedContractOverlap=${result.sharedContractOverlap}, reason=${result.reason ?? "none"}\n`,
            };
          },
        }),
        "gate run": cliCommand({
          summary: "Run the repository container merge-guard gate inside a Cloudroom Cloud sandbox (or spawn a Cloud child with --cloud).",
          options: {
            host: { type: "string", description: "Cloudroom host id or name." },
            path: { type: "string", description: "Absolute path to git checkout on the target host." },
            project: { type: "string", description: "Cloudroom project id for spawning a Cloud sandbox thread." },
            repo: { type: "string", description: "GitHub repository (owner/repo)." },
            pr: { type: "integer", min: 1, max: 9_999_999, description: "Optional pull request number for posting a Gate receipt." },
            base: { type: "string", description: "Target base branch (defaults to PR base or dev/main)." },
            branch: { type: "string", description: "Head branch name to check out in --cloud mode." },
            mode: {
              type: "enum",
              values: ["smoke", "full"],
              description: "Container gate depth (smoke or full; default smoke).",
            },
            cloud: { type: "boolean", description: "Spawn an ephemeral Cloudroom Cloud sandbox child thread instead of running on the current host." },
            provider: { type: "string", description: "Agent provider id for --cloud spawn (default codex)." },
            post: { type: "boolean", description: "Post canonical Gate receipt to the PR via botToken." },
            json: { type: "boolean", description: "Print JSON output." },
          },
          async run({ options }, ctx) {
            if (options.repo) {
              const parsedRepo = repoSlugSchema.safeParse(options.repo);
              if (!parsedRepo.success) {
                throw new PluginCliError(`Invalid repository "${options.repo}": expected owner/repo.`, {
                  code: "invalid_repo",
                });
              }
            }
            const { hostId, root, projectId } = await resolveHostAndRoot(
              ctx,
              options.host,
              options.path,
              options.project,
            );
            const checkout = await hostClient.call("inspectCheckout", { root }, { hostId });
            const pubCtx = await hostClient
              .call("inspectPublishContext", { root }, { hostId })
              .catch(() => null);
            const repoSlug = options.repo ?? pubCtx?.repoMeta?.slug ?? null;
            if (!repoSlug) {
              throw new PluginCliError("Could not determine GitHub repository. Pass --repo <owner/repo>.", {
                code: "no_repo",
              });
            }
            const headSha = checkout.headSha ?? "";
            if (!/^[0-9a-f]{40}$/u.test(headSha)) {
              throw new PluginCliError("Checkout has no valid 40-char HEAD commit SHA.", {
                code: "no_head_sha",
              });
            }
            const baseBranch =
              options.base?.trim() ||
              pubCtx?.existingPr?.baseRefName ||
              pubCtx?.repoMeta?.defaultBranch ||
              "dev";
            const headBranch = options.branch?.trim() || checkout.branch || pubCtx?.existingPr?.headRefName || null;

            const gates = await hostClient.call(
              "inspectContainerGates",
              { root, baseBranch, repoSlug },
              { hostId },
            );

            if (!gates.hasBootstrapCloudroom) {
              const errMsg = "scripts/ci/bootstrap-cloudroom.sh not found in repository checkout.";
              if (options.json) {
                return { exitCode: 1, stdout: `${JSON.stringify({ status: "no_bootstrap", error: errMsg, gates }, null, 2)}\n` };
              }
              return { exitCode: 1, stderr: `${errMsg}\n` };
            }
            if (!gates.supportedForBase || !gates.recommendedGateCommand) {
              const errMsg = gates.unsupportedReason ?? `Container gate unsupported for base branch "${baseBranch}".`;
              if (options.json) {
                return { exitCode: 1, stdout: `${JSON.stringify({ status: "unsupported_base", error: errMsg, gates }, null, 2)}\n` };
              }
              return { exitCode: 1, stderr: `${errMsg}\n` };
            }

            // Refuse running container bootstrap on a non-container host unless explicitly delegating via --cloud.
            if (!gates.inCloudSandbox || options.cloud) {
              if (!options.cloud) {
                const payload = {
                  status: "refused_non_container",
                  inCloudSandbox: false,
                  repo: repoSlug,
                  baseBranch,
                  headSha,
                  recommendedGateCommand: gates.recommendedGateCommand,
                  hint: "Re-run with --cloud (after pushing the branch) or execute inside a Cloudroom Cloud sandbox thread.",
                };
                if (options.json) {
                  return { exitCode: 1, stdout: `${JSON.stringify(payload, null, 2)}\n` };
                }
                return {
                  exitCode: 1,
                  stderr: `Refused to run bootstrap-cloudroom.sh on non-container host. ${payload.hint}\n`,
                };
              }

              if (!headBranch) {
                throw new PluginCliError("Cannot launch --cloud gate from detached HEAD without --branch.", {
                  code: "no_branch",
                });
              }

              const provider = options.provider?.trim() || "codex";
              const gateMode = options.mode ?? "smoke";
              const cloudPrompt = [
                `Run the Cloudroom Cloud sandbox merge-guard gate (${gateMode}) for ${repoSlug} branch ${headBranch} targeting base ${baseBranch} (expected commit ${headSha}).`,
                `1. Verify you are inside a Cloudroom Cloud sandbox container (/.dockerenv present, CLOUDROOM_WORKLOAD set) and HEAD matches ${headSha}.`,
                `2. Execute: ${gates.recommendedGateCommand}`,
                "3. Return ONLY a concise summary including the exact canonical `Gate receipt` block.",
              ].join("\n");

              const spawnArgs = [
                "thread",
                "spawn",
                "--machine",
                "cloud",
                "--provider",
                provider,
                "--base-branch",
                headBranch,
                "--title",
                `ship-gate ${repoSlug}@${headSha.slice(0, 7)}`,
                ...(projectId ? ["--project", projectId] : []),
                ...(ctx.threadId ? ["--parent-thread", ctx.threadId] : []),
                "--prompt",
                cloudPrompt,
                "--json",
              ];

              const execCloudSpawn =
                deps.execCloudSpawn ??
                ((args: readonly string[]) =>
                  runProcess("room-cli", args, { cwd: root, timeoutMs: 30_000 }));
              const spawnRes = await execCloudSpawn(spawnArgs);
              if (spawnRes.code !== 0) {
                const errText = spawnRes.stderr.trim() || spawnRes.stdout.trim() || `room-cli thread spawn exited ${spawnRes.code}`;
                if (options.json) {
                  return { exitCode: 1, stdout: `${JSON.stringify({ status: "cloud_spawn_failed", error: errText }, null, 2)}\n` };
                }
                return { exitCode: 1, stderr: `Failed to spawn Cloudroom Cloud sandbox gate thread: ${errText}\n` };
              }

              let threadId: string | null = null;
              try {
                const parsed = JSON.parse(spawnRes.stdout) as { id?: unknown; threadId?: unknown; thread?: { id?: unknown } };
                if (typeof parsed.id === "string") threadId = parsed.id;
                else if (typeof parsed.threadId === "string") threadId = parsed.threadId;
                else if (parsed.thread && typeof parsed.thread.id === "string") threadId = parsed.thread.id;
              } catch {
                threadId = null;
              }

              store.appendAudit({
                actor: "cli",
                action: "gate.cloud_spawned",
                outcome: "ok",
                detail: { repo: repoSlug, baseBranch, headBranch, headSha, threadId, mode: gateMode },
              });

              const payload = {
                status: "cloud_spawned",
                threadId,
                repo: repoSlug,
                branch: headBranch,
                baseBranch,
                headSha,
                provider,
                mode: gateMode,
                recommendedGateCommand: gates.recommendedGateCommand,
              };
              if (options.json) {
                return { exitCode: 0, stdout: `${JSON.stringify(payload, null, 2)}\n` };
              }
              return {
                exitCode: 0,
                stdout: `Spawned Cloudroom Cloud sandbox gate thread ${threadId ?? "(pending)"} for ${repoSlug}@${headSha.slice(0, 7)} (base ${baseBranch}).\n`,
              };
            }

            const hosts = await bb.sdk.hosts.list().catch(() => []);
            const hostName = hosts.find((h) => h.id === hostId)?.name ?? hostId;
            const runRes = await hostClient.call(
              "runContainerGate",
              {
                root,
                repoSlug,
                baseBranch,
                headSha,
                mode: options.mode ?? "smoke",
                hostLabel: hostName,
              },
              { hostId },
            );

            store.appendAudit({
              actor: "cli",
              action: "gate.run",
              outcome: runRes.passed ? "pass" : runRes.refused ? "refused" : "fail",
              detail: {
                repo: repoSlug,
                baseBranch,
                headSha,
                exitCode: runRes.exitCode,
                wallSeconds: runRes.wallSeconds,
                passed: runRes.passed,
              },
            });

            const formattedReceipt = runRes.receipt
              ? formatGateReceipt({
                  repo: runRes.receipt.repo,
                  base: runRes.receipt.base,
                  commit: runRes.receipt.commit,
                  gate: runRes.receipt.gate,
                  result: runRes.receipt.result,
                  passedCount: runRes.receipt.passedCount,
                  failedCount: runRes.receipt.failedCount,
                  skippedCount: runRes.receipt.skippedCount,
                  wall: runRes.receipt.wall ?? `${runRes.wallSeconds}s`,
                  host: runRes.receipt.host ?? `cloudroom-sandbox (${hostName})`,
                  bootstrap: runRes.receipt.bootstrap ?? "scripts/ci/bootstrap-cloudroom.sh",
                  notRun: runRes.receipt.notRun ?? "none",
                })
              : null;

            let postedCommentId: number | null = null;
            let postError: string | null = null;
            const prNum = options.pr ?? pubCtx?.existingPr?.number ?? null;
            if (options.post && formattedReceipt && prNum) {
              const bot = await currentBotClient();
              if (!bot) {
                postError = "GitHub botToken is not configured.";
              } else {
                const commentBody = `${SHIP_MARKER_PREFIX} -->\n${formattedReceipt}`;
                const textOk = validateCommentText(commentBody);
                if (!textOk.ok) {
                  postError = `Outbound validation blocked Gate receipt: ${textOk.reason}`;
                } else {
                  const secCheck = await hostClient.call(
                    "scanOutboundForLocalSecrets",
                    { root, text: commentBody },
                    { hostId },
                  );
                  if (!secCheck.ok) {
                    postError = `Local secret match blocked Gate receipt post (${secCheck.matchedSource}).`;
                  } else {
                    try {
                      const posted = await bot.postIssueComment(repoSlug, prNum, commentBody);
                      postedCommentId = posted.id;
                    } catch (err) {
                      postError = err instanceof Error ? err.message : String(err);
                    }
                  }
                }
              }
            }

            const exitCode = runRes.ok && runRes.passed && !postError ? 0 : 1;
            const payload = {
              status: runRes.refused ? "refused" : runRes.passed ? "passed" : "failed",
              repo: repoSlug,
              baseBranch,
              headSha,
              prNumber: prNum,
              ...runRes,
              formattedReceipt,
              postedCommentId,
              postError,
            };
            if (options.json) {
              return { exitCode, stdout: `${JSON.stringify(payload, null, 2)}\n` };
            }
            const lines = [
              `Container gate ${payload.status} for ${repoSlug}@${headSha.slice(0, 7)} (${runRes.wallSeconds}s)`,
              ...(formattedReceipt ? ["", formattedReceipt] : []),
              ...(postedCommentId ? [`Posted Gate receipt comment id=${postedCommentId}`] : []),
              ...(postError ? [`Post error: ${postError}`] : []),
              ...(runRes.error ? [`Error: ${runRes.error}`] : []),
            ];
            return { exitCode, stdout: `${lines.join("\n")}\n` };
          },
        }),
      },
    }),
  );
  };
}

export default async function shipPlugin(bb: BbPluginApi): Promise<void> {
  return createShipPlugin()(bb);
}
