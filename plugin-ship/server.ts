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
  type RepoConfig,
  type ShipStatus,
  type WatchRecord,
} from "./src/contract.js";
import { MIGRATIONS, ShipStore, toPublicWatchRecord, type RepoDefaults } from "./src/db.js";
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
import { isNeverEditPath, isSecretFilename } from "./src/safety/never-edit.js";
import { StewardWorkerGatekeeper } from "./src/steward/gatekeeper.js";
import { StewardPoller, type DiscoveredPrCandidate } from "./src/steward/poller.js";
import { registerStewardTools } from "./src/steward/tools.js";

export const PLUGIN_VERSION = "0.1.0";
export const STEWARD_TERMS_KV_KEY = "steward_terms_accepted_at";

const POSITIVE_INT_SCHEMA = z.number().int();

export interface ShipServerDeps {
  nowMs?: () => number;
  fetchImpl?: typeof fetch;
  minDwellMs?: number;
  execDispatch?: DispatchExec;
  seatTimeoutMs?: number;
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
      const projects = await bb.sdk.projects.list().catch(() => []);
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
    controlWatch: async (input) => applyWatchControl(input.id, input.action, "rpc"),
    listAudit: async (input) => store.listAudit(input),
  });

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
    const nowMs = (deps.nowMs ?? Date.now)();
    let acceptedAt = await bb.storage.kv.get<number>(STEWARD_TERMS_KV_KEY);
    if (!acceptedAt) {
      if (options["accept-terms"]) {
        acceptedAt = nowMs;
        await bb.storage.kv.set(STEWARD_TERMS_KV_KEY, acceptedAt);
      } else {
        throw new PluginCliError(
          "PR Steward terms must be accepted before starting a watch. Run `room-cli ship terms --accept` or pass `--accept-terms`.",
          { code: "steward_terms_required" },
        );
      }
    }

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

    const inspectCtx = await hostClient.call(
      "inspectPublishContext",
      {
        root,
        ...(options.remote ? { remote: options.remote } : {}),
        ...(options.base ? { baseBranch: options.base } : {}),
      },
      { hostId },
    );

    const repo = options.repo ?? inspectCtx.repoMeta?.slug ?? null;
    if (!repo) {
      throw new PluginCliError("Could not determine GitHub repository. Pass --repo <owner/repo>.", {
        code: "no_repo",
      });
    }
    const prNumber = options.pr ?? inspectCtx.existingPr?.number ?? null;
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
      const pub = toPublicWatchRecord(existing);
      if (options.json) {
        return { exitCode: 0, stdout: `${JSON.stringify({ alreadyWatching: true, watch: pub }, null, 2)}\n` };
      }
      return { exitCode: 0, stdout: `Already watching ${repo}#${prNumber} (${existing.id}, state=${existing.state})\n` };
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
      baseBranch: options.base?.trim() || polled.discussion.pr.baseRefName,
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
      actor: "cli",
      action: "steward.started",
      outcome: "ok",
      detail: { repo, prNumber, headBranch: created.headBranch, baseBranch: created.baseBranch },
    });
    publishWatchesSignal({ type: "watch.created", watchId, state: "watching" });

    const pub = toPublicWatchRecord(created);
    if (options.json) {
      return { exitCode: 0, stdout: `${JSON.stringify({ alreadyWatching: false, watch: pub }, null, 2)}\n` };
    }
    return {
      exitCode: 0,
      stdout: `Started watch ${watchId} for ${repo}#${prNumber} (${created.headBranch} -> ${created.baseBranch})\n`,
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
          constraints: [{ kind: "at-most-one", options: ["enabled", "disabled"] }],
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
              stdout: `Saved ${saved.repo}: enabled=${saved.enabled} review=${saved.reviewMode}:${saved.reviewEffort} steward=${saved.autoSteward} approvals=${saved.approvalsMode}\n`,
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
      },
    }),
  );
  };
}

export default async function shipPlugin(bb: BbPluginApi): Promise<void> {
  return createShipPlugin()(bb);
}
