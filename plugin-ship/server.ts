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
} from "./src/contract.js";
import { MIGRATIONS, ShipStore, type RepoDefaults } from "./src/db.js";
import { GitHubBotClient } from "./src/github/bot.js";
import { fetchPrDiscussion, type FilteredPrDiscussion } from "./src/github/comments.js";
import { runShipPublish, type ShipPublishResult } from "./src/publish/publisher.js";
import { isNeverEditPath, isSecretFilename } from "./src/safety/never-edit.js";

export const PLUGIN_VERSION = "0.1.0";

const POSITIVE_INT_SCHEMA = z.number().int();

export interface ShipServerDeps {
  nowMs?: () => number;
  fetchImpl?: typeof fetch;
  minDwellMs?: number;
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
  ): Promise<{ hostId: string; root: string }> {
    let hostId = hostOverride?.trim() || undefined;
    let root = pathOverride?.trim() || ctx.cwd?.trim() || undefined;

    if ((!hostId || !root) && ctx.threadId) {
      try {
        const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
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

    if ((!hostId || !root) && ctx.projectId) {
      const project = await bb.sdk.projects.get({ projectId: ctx.projectId });
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

    return { hostId, root };
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
    listAudit: async (input) => store.listAudit(input),
  });

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
      },
    }),
  );
  };
}

export default async function shipPlugin(bb: BbPluginApi): Promise<void> {
  return createShipPlugin()(bb);
}
