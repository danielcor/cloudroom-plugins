import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectApprovalContextAt,
  inspectContainerGatesAt,
  runContainerGateAt,
  runMergeEligibilityAt,
} from "../host.js";
import { createShipPlugin } from "../server.js";
import { evaluateApprovalsPolicy, evaluateDevAutoMergeGuard } from "../src/approvals/evaluator.js";
import type { ApprovalPrInfo } from "../src/approvals/facts.js";
import { loadAndValidateClassifiers, parseApprovalsPolicy } from "../src/approvals/parser.js";
import {
  hostContract,
  type ContainerGateInspectionOutput,
  type MergeEligibilityOutput,
  type PollPrStateOutput,
  type RunContainerGateOutput,
} from "../src/contract.js";
import { MIGRATIONS, ShipStore, type WatchFullRecord } from "../src/db.js";
import {
  detectContainerGatePlan,
  evaluateEffectiveGateStatus,
  findPassingGateReceiptForSha,
  formatGateReceipt,
  parseGateReceipts,
} from "../src/gates/container-gates.js";
import { StewardPoller } from "../src/steward/poller.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: process.env });
  return stdout.trim();
}

const tempDirs: string[] = [];
const dbs: Database.Database[] = [];
const fakeHosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  for (const h of fakeHosts.splice(0)) await h.harness.dispose();
  for (const d of dbs.splice(0)) d.close();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createStore(): ShipStore {
  const db = new Database(":memory:");
  dbs.push(db);
  for (const stmt of MIGRATIONS) db.exec(stmt);
  return new ShipStore(db);
}

const HEAD_SHA = "c".repeat(40);
const OTHER_SHA = "d".repeat(40);

describe("Container Merge-Guard integration", () => {
  it("detects repo gate plans and enforces pmzbot dev-only sandbox bootstrap restriction", () => {
    const pmzDev = detectContainerGatePlan({
      repoSlug: "PeakBot/pmzbot",
      baseBranch: "dev",
      hasBootstrapCloudroom: true,
      hasMergeEligibilityScript: true,
      kiriFiles: ["scripts/ci/self-hosted-runner/Dockerfile"],
      inCloudSandbox: true,
    });
    expect(pmzDev.repoKind).toBe("pmzbot");
    expect(pmzDev.supportedForBase).toBe(true);
    expect(pmzDev.hasKiriRunner).toBe(true);
    expect(pmzDev.recommendedGateCommand).toContain("PMZBOT_UNIT_TMP_ROOT=/tmp");
    expect(pmzDev.recommendedGateCommand).toContain("bootstrap-cloudroom.sh");

    for (const badBase of ["beta", "master"]) {
      const pmzBlocked = detectContainerGatePlan({
        repoSlug: "PeakBot/pmzbot",
        baseBranch: badBase,
        hasBootstrapCloudroom: true,
        hasMergeEligibilityScript: true,
        kiriFiles: [],
        inCloudSandbox: true,
      });
      expect(pmzBlocked.supportedForBase).toBe(false);
      expect(pmzBlocked.unsupportedReason).toContain("dev");
      expect(pmzBlocked.recommendedGateCommand).toBeNull();
    }

    const aiBot = detectContainerGatePlan({
      repoSlug: "PeakBot/AiTradingBot",
      baseBranch: "main",
      hasBootstrapCloudroom: true,
      hasMergeEligibilityScript: false,
      kiriFiles: [],
      inCloudSandbox: false,
    });
    expect(aiBot.repoKind).toBe("AiTradingBot");
    expect(aiBot.supportedForBase).toBe(true);
    expect(aiBot.recommendedGateCommand).toContain("run-with-postgres.sh");

    const rustRepo = detectContainerGatePlan({
      repoSlug: "PeakBot/rust-pmz-copytrading",
      baseBranch: "main",
      hasBootstrapCloudroom: true,
      hasMergeEligibilityScript: false,
      kiriFiles: [],
      inCloudSandbox: false,
    });
    expect(rustRepo.repoKind).toBe("rust-pmz-copytrading");
    expect(rustRepo.recommendedGateCommand).toContain("--gate full --smoke-release");
  });

  it("parses canonical Gate receipts, checks exact HEAD SHA, and refuses overriding real CI failures", () => {
    const receiptText = formatGateReceipt({
      repo: "PeakBot/pmzbot",
      base: "dev",
      commit: HEAD_SHA,
      gate: "pmzbot:smoke",
      result: "PASS",
      passedCount: 42,
      failedCount: 0,
      skippedCount: 1,
      wall: "31.5s",
      host: "cloudroom-sandbox",
      bootstrap: "scripts/ci/bootstrap-cloudroom.sh",
      notRun: "full integration suite",
    });

    const parsed = parseGateReceipts(receiptText, { authorLogin: "danielcor", kind: "pr_body" });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      repo: "PeakBot/pmzbot",
      commit: HEAD_SHA,
      result: "PASS",
      passedCount: 42,
      failedCount: 0,
      skippedCount: 1,
    });

    const staleReceipt = findPassingGateReceiptForSha([{ text: receiptText }], OTHER_SHA);
    expect(staleReceipt).toBeNull();

    const failedCountReceipt = formatGateReceipt({
      repo: "PeakBot/pmzbot",
      base: "dev",
      commit: HEAD_SHA,
      gate: "pmzbot:full",
      result: "PASS",
      passedCount: 10,
      failedCount: 2,
      wall: "12s",
      host: "cloudroom-sandbox",
      bootstrap: "scripts/ci/bootstrap-cloudroom.sh",
    });
    expect(findPassingGateReceiptForSha([{ text: failedCountReceipt }], HEAD_SHA)).toBeNull();

    const matchedReceipt = findPassingGateReceiptForSha([{ text: receiptText }], HEAD_SHA);
    expect(matchedReceipt).not.toBeNull();

    // Billing-blocked / empty GitHub checks: trusted sandbox receipt satisfies gate.
    const fromReceipt = evaluateEffectiveGateStatus([], matchedReceipt);
    expect(fromReceipt).toMatchObject({
      ciGreen: true,
      gateSatisfied: true,
      gateSource: "sandbox_receipt",
    });

    // Real failing GitHub check MUST NEVER be overridden by a sandbox receipt.
    const withFailure = evaluateEffectiveGateStatus(
      [{ id: 9, name: "merge-guard", status: "completed", conclusion: "failure", detailsUrl: null }],
      matchedReceipt,
    );
    expect(withFailure).toMatchObject({
      ciGreen: false,
      gateSatisfied: false,
      gateSource: "none",
      failingChecks: 1,
    });
  });

  it("inspects container gates, rejects symlinked scripts, runs merge-eligibility, and refuses non-container hosts", async () => {
    const dir = await makeTempDir("ship-gates-host-");
    await mkdir(join(dir, "scripts", "ci", "self-hosted-runner", "host"), { recursive: true });
    await writeFile(join(dir, "scripts", "ci", "bootstrap-cloudroom.sh"), "#!/usr/bin/env bash\necho ok\n", "utf8");
    await writeFile(
      join(dir, "scripts", "ci", "self-hosted-runner", "Dockerfile"),
      "FROM ubuntu:24.04\n",
      "utf8",
    );
    const outsideScript = join(dir, "outside.sh");
    await writeFile(outsideScript, "#!/usr/bin/env bash\necho '{}'\n", "utf8");
    // Symlinked merge-eligibility.sh must be ignored/rejected.
    await symlink(outsideScript, join(dir, "scripts", "ci", "merge-eligibility.sh"));

    const symInspect = await inspectContainerGatesAt(
      { root: dir, repoSlug: "PeakBot/pmzbot", baseBranch: "dev" },
      { isContainerSandbox: () => false },
    );
    expect(symInspect.hasBootstrapCloudroom).toBe(true);
    expect(symInspect.hasMergeEligibilityScript).toBe(false);
    expect(symInspect.hasKiriRunner).toBe(true);
    expect(symInspect.inCloudSandbox).toBe(false);

    // Replace symlink with real regular executable script emitting pmzbot merge-eligibility JSON.
    await rm(join(dir, "scripts", "ci", "merge-eligibility.sh"));
    const realEligScript = join(dir, "scripts", "ci", "merge-eligibility.sh");
    await writeFile(
      realEligScript,
      `#!/usr/bin/env bash
printf '{"pr":%s,"conflict_free":true,"overlap_files":[],"nondocs_overlap":[],"always_overlap_hits":[],"docs_only_pr":false,"eligible":true,"policy":"%s","reason":"no_nondocs_overlap"}\n' "$1" "\${BEHIND_POLICY:-conflict-only}"
`,
      "utf8",
    );
    await chmod(realEligScript, 0o755);

    const elig = await runMergeEligibilityAt({ root: dir, prNumber: 77, behindPolicy: "conflict-only" });
    expect(elig).toMatchObject({
      ok: true,
      scriptFound: true,
      eligible: true,
      conflictFree: true,
      sharedContractOverlap: false,
      reason: "no_nondocs_overlap",
    });

    // Non-container host MUST refuse runContainerGateAt before running anything.
    const refused = await runContainerGateAt(
      {
        root: dir,
        repoSlug: "PeakBot/pmzbot",
        baseBranch: "dev",
        headSha: HEAD_SHA,
        mode: "smoke",
      },
      {
        isContainerSandbox: () => false,
        execShell: async () => {
          throw new Error("should never execute shell outside container");
        },
      },
    );
    expect(refused.refused).toBe(true);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("non-container");

    // Inside Cloudroom Cloud sandbox: executes, redacts secrets, and emits structured Gate receipt.
    const fakeSecret = ["ghp_", "ContainerGateSecretValue123456789012345"].join("");
    await writeFile(join(dir, ".env"), `API_KEY=${fakeSecret}\n`, "utf8");
    let nowTick = 1000;
    const passed = await runContainerGateAt(
      {
        root: dir,
        repoSlug: "PeakBot/pmzbot",
        baseBranch: "dev",
        headSha: HEAD_SHA,
        mode: "smoke",
        hostLabel: "sandbox-1",
      },
      {
        isContainerSandbox: () => true,
        nowMs: () => {
          nowTick += 2500;
          return nowTick;
        },
        execShell: async () => ({
          code: 0,
          stdout: `running smoke\nleaked=${fakeSecret}\n`,
          stderr: "",
        }),
      },
    );
    expect(passed.refused).toBe(false);
    expect(passed.passed).toBe(true);
    expect(passed.outputTail).not.toContain(fakeSecret);
    expect(passed.outputTail).toContain("[REDACTED]");
    expect(passed.receipt).toMatchObject({
      repo: "PeakBot/pmzbot",
      base: "dev",
      commit: HEAD_SHA,
      result: "PASS",
    });
  });

  it("extracts only trusted exact-SHA Gate receipts in inspectApprovalContextAt and drives gate_receipt_pass + dev auto-merge", async () => {
    const base = await makeTempDir("ship-gate-apr-");
    const bareDir = join(base, "origin.git");
    const repoDir = join(base, "work");
    await git(base, "init", "--bare", bareDir);
    await mkdir(join(repoDir, ".claude"), { recursive: true });
    await git(repoDir, "init", "-b", "dev");
    await git(repoDir, "config", "user.name", "Test");
    await git(repoDir, "config", "user.email", "test@example.com");

    const policyRaw = `version: 1
mode: enforce
status_context: "Cloudroom Ship / Approvals"
default_action: comment
rules:
  - id: sandbox-gate-auto
    when:
      ci_green: true
      gate_receipt_pass: true
      is_draft: false
    action: approve
    seats: 0
`;
    await writeFile(join(repoDir, ".claude", "approvals.yml"), policyRaw, "utf8");
    await git(repoDir, "add", ".claude/approvals.yml");
    await git(repoDir, "commit", "-m", "init approvals");
    await git(repoDir, "remote", "add", "origin", bareDir);
    await git(repoDir, "push", "-u", "origin", "dev");

    const validReceipt = formatGateReceipt({
      repo: "PeakBot/pmzbot",
      base: "dev",
      commit: HEAD_SHA,
      gate: "pmzbot:smoke",
      result: "PASS",
      passedCount: 15,
      failedCount: 0,
      wall: "19s",
      host: "cloudroom-sandbox",
      bootstrap: "scripts/ci/bootstrap-cloudroom.sh",
    });

    // Untrusted commenter tries passing a receipt; PR body has the real author receipt (or none in a second call).
    const mockGh = async (_cwd: string, args: readonly string[]) => {
      if (args[0] === "api" && args[1] === "graphql") {
        return {
          code: 0,
          stderr: "",
          stdout: JSON.stringify({
            data: {
              repository: {
                defaultBranchRef: { name: "dev" },
                pullRequest: {
                  number: 101,
                  title: "Fix copy trade guard",
                  body: "",
                  state: "OPEN",
                  isDraft: false,
                  headRefOid: HEAD_SHA,
                  baseRefName: "dev",
                  headRefName: "feat/guard",
                  author: { login: "danielcor" },
                  authorAssociation: "OWNER",
                  labels: { nodes: [] },
                  comments: {
                    nodes: [
                      {
                        author: { login: "random-stranger" },
                        authorAssociation: "NONE",
                        body: validReceipt,
                      },
                    ],
                  },
                  files: { nodes: [{ path: "src/guard.ts", additions: 5, deletions: 1 }] },
                },
              },
            },
          }),
        };
      }
      if (args[0] === "api") {
        return { code: 0, stderr: "", stdout: JSON.stringify({ check_runs: [] }) };
      }
      if (args[0] === "pr" && args[1] === "diff") {
        return { code: 0, stderr: "", stdout: "diff --git a/src/guard.ts b/src/guard.ts\n" };
      }
      return { code: 0, stderr: "", stdout: "" };
    };

    const untrustedCtx = await inspectApprovalContextAt(
      { root: repoDir, repo: "PeakBot/pmzbot", prNumber: 101 },
      { execGh: mockGh, isContainerSandbox: () => false },
    );
    expect(untrustedCtx.ok).toBe(true);
    expect(untrustedCtx.sandboxGateReceipt).toBeNull();

    const trustedCtx = await inspectApprovalContextAt(
      { root: repoDir, repo: "PeakBot/pmzbot", prNumber: 101 },
      {
        isContainerSandbox: () => false,
        execGh: async (cwd, args) => {
          if (args[0] === "api" && args[1] === "graphql") {
            return {
              code: 0,
              stderr: "",
              stdout: JSON.stringify({
                data: {
                  repository: {
                    defaultBranchRef: { name: "dev" },
                    pullRequest: {
                      number: 101,
                      title: "Fix copy trade guard",
                      body: `Summary\n\n${validReceipt}`,
                      state: "OPEN",
                      isDraft: false,
                      headRefOid: HEAD_SHA,
                      baseRefName: "dev",
                      headRefName: "feat/guard",
                      author: { login: "danielcor" },
                      authorAssociation: "OWNER",
                      labels: { nodes: [] },
                      comments: { nodes: [] },
                      files: { nodes: [{ path: "src/guard.ts", additions: 5, deletions: 1 }] },
                    },
                  },
                },
              }),
            };
          }
          return mockGh(cwd, args);
        },
      },
    );
    expect(trustedCtx.sandboxGateReceipt?.commit).toBe(HEAD_SHA);

    const store = createStore();
    const policy = parseApprovalsPolicy(policyRaw);
    const classifiers = loadAndValidateClassifiers(policy, []);
    const pr: ApprovalPrInfo = trustedCtx.pr!;

    const decision = await evaluateApprovalsPolicy({
      repo: "PeakBot/pmzbot",
      policy,
      policySha: "p".repeat(64),
      classifiers,
      pr,
      checkRuns: [],
      diffText: "",
      store,
      executor: null,
      sandboxGateReceipt: trustedCtx.sandboxGateReceipt,
      hasCloudroomBootstrap: false,
    });
    expect(decision.verdict).toBe("approve");
    expect(decision.matchedRuleIds).toEqual(["sandbox-gate-auto"]);
    expect(decision.facts.ciGreen).toBe(true);
    expect(decision.facts.gateSource).toBe("sandbox_receipt");

    const autoMerge = evaluateDevAutoMergeGuard({
      allowDevAutomerge: true,
      pr,
      facts: decision.facts,
      decision,
      latestReviewRun: {
        id: "rev_1",
        watchId: null,
        repo: "PeakBot/pmzbot",
        prNumber: 101,
        headSha: HEAD_SHA,
        mode: "triad",
        round: 1,
        seatsJson: '["claude","codex","grok"]',
        verdict: "APPROVE",
        meanScore: 9.5,
        createdAt: 1000,
      },
    });
    expect(autoMerge.eligible).toBe(true);
    expect(autoMerge.blockedReasons).toEqual([]);
  });

  it("skips unnecessary Steward BEHIND downmerges when conflict-only merge-eligibility.sh returns eligible", async () => {
    const spawnCalls: string[] = [];
    const pollRes: PollPrStateOutput = {
      discussion: {
        pr: {
          number: 55,
          url: "https://github.com/PeakBot/pmzbot/pull/55",
          title: "Behind but clean",
          body: "",
          mayHideBody: false,
          state: "OPEN",
          isDraft: false,
          headRefName: "feat/clean",
          headRefOid: HEAD_SHA,
          baseRefName: "dev",
          baseRefOid: "0".repeat(40),
          authorLogin: "danielcor",
          labels: [],
          mergeStateStatus: "BEHIND",
        },
        items: [],
        excludedCount: 0,
        truncatedCount: 0,
        droppedForBudgetCount: 0,
        collisionLabels: [],
      },
      checkRuns: [{ id: 1, name: "merge-guard", status: "completed", conclusion: "success", detailsUrl: null }],
    };

    const host = createFakePluginHost({
      pluginId: "ship",
      sdk: {
        threads: {
          spawn: async (args) => {
            spawnCalls.push(args.title ?? "");
            throw new Error("worker should not be spawned when conflict-free BEHIND");
          },
        },
      },
      experimental_callHostRpc: async ({ method }) => {
        if (method === "verifyPins") return { ok: true, driftedKey: null, reason: null };
        if (method === "pollPrState") return pollRes;
        if (method === "inspectContainerGates") {
          const out: ContainerGateInspectionOutput = {
            repoKind: "pmzbot",
            hasBootstrapCloudroom: true,
            bootstrapScriptPath: "scripts/ci/bootstrap-cloudroom.sh",
            hasMergeEligibilityScript: true,
            mergeEligibilityScriptPath: "scripts/ci/merge-eligibility.sh",
            hasKiriRunner: true,
            kiriFiles: ["scripts/ci/self-hosted-runner/Dockerfile"],
            inCloudSandbox: false,
            baseBranch: "dev",
            supportedForBase: true,
            unsupportedReason: null,
            recommendedGateCommand: "bash scripts/ci/bootstrap-cloudroom.sh",
            containerConstraints: [],
          };
          return out;
        }
        if (method === "runMergeEligibility") {
          const out: MergeEligibilityOutput = {
            ok: true,
            scriptFound: true,
            eligible: true,
            behind: true,
            behindCount: 2,
            conflictFree: true,
            sharedContractOverlap: false,
            overlapFiles: [],
            nondocsOverlap: [],
            alwaysOverlapHits: [],
            docsOnlyPr: false,
            reason: "no_nondocs_overlap",
            rawJson: "{}",
            error: null,
          };
          return out;
        }
        return {};
      },
    });
    fakeHosts.push(host);

    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, MIGRATIONS);
    const store = new ShipStore(db);
    const now = 5_000_000;
    const watch: WatchFullRecord = {
      id: "watch_behind_1",
      projectId: "proj_1",
      hostId: "host_1",
      worktreePath: "/tmp/pmz",
      repo: "PeakBot/pmzbot",
      prNumber: 55,
      headBranch: "feat/clean",
      headRemote: "origin",
      baseBranch: "dev",
      baseRemote: "origin",
      authorLogin: "danielcor",
      state: "watching",
      lastHeadSha: HEAD_SHA,
      lastStateHash: null,
      startedAt: now,
      expiresAt: now + 86_400_000,
      lastWokeAt: null,
      workerThreadId: null,
      pins: { "bin:git": "1" },
      trustedBots: [],
      seenCommentIds: [],
      causePushCounts: {},
      rerunJobIds: [],
      behindMergesCount: 0,
      stopReason: null,
    };
    store.createWatch(watch);

    const poller = new StewardPoller({
      bb: host.bb,
      store,
      hostClient: host.bb.hosts.experimental_client({ contract: hostContract }),
      getPollIntervalMs: async () => 120_000,
      getMaxPushesPerCause: async () => 3,
      getWatchMaxDays: async () => 7,
      nowMs: () => now,
    });

    const tick = await poller.tickOnce(now);
    expect(tick).toEqual({ checked: 1, woken: 0, stopped: 0, ready: 1 });
    expect(spawnCalls).toHaveLength(0);
    expect(store.getWatch("watch_behind_1")?.state).toBe("ready");
    const audits = store.listAudit({ watchId: "watch_behind_1", limit: 10 });
    expect(audits[0]?.action).toBe("steward.behind_conflict_free_skipped");
  });

  it("handles ship gate inspect, eligibility, and run CLI commands (non-container refusal, --cloud spawn, and sandbox execution)", async () => {
    let sandboxMode = false;
    const cloudSpawnArgs: Array<readonly string[]> = [];

    const host = createFakePluginHost({
      pluginId: "ship",
      sdk: {
        hosts: { list: async () => [{ id: "host_1", name: "aipc-ubuntu" }] as never },
        projects: {
          get: async () =>
            ({
              id: "proj_1",
              name: "pmzbot",
              kind: "standard",
              sources: [{ id: "s1", projectId: "proj_1", hostId: "host_1", path: "/opt/dev/pmzbot", isDefault: true }],
            }) as never,
        },
      },
      experimental_callHostRpc: async ({ method }) => {
        if (method === "inspectCheckout") {
          return {
            root: "/opt/dev/pmzbot",
            gitDir: "/opt/dev/pmzbot/.git",
            commonDir: "/opt/dev/pmzbot/.git",
            headSha: HEAD_SHA,
            branch: "feat/container-gate",
            isDetached: false,
            isClean: true,
            inProgressOp: null,
            remotes: [{ name: "origin", url: "git@github.com:PeakBot/pmzbot.git", kind: "fetch" }],
            changedFiles: [],
            hardLinks: [],
            submodules: [],
            gitDirLinkIssue: null,
          };
        }
        if (method === "inspectPublishContext") {
          return {
            inspection: {
              root: "/opt/dev/pmzbot",
              gitDir: "/opt/dev/pmzbot/.git",
              commonDir: "/opt/dev/pmzbot/.git",
              headSha: HEAD_SHA,
              branch: "feat/container-gate",
              isDetached: false,
              isClean: true,
              inProgressOp: null,
              remotes: [],
              changedFiles: [],
              hardLinks: [],
              submodules: [],
              gitDirLinkIssue: null,
            },
            remoteName: "origin",
            remoteUrl: "git@github.com:PeakBot/pmzbot.git",
            repoMeta: {
              slug: "PeakBot/pmzbot",
              owner: "PeakBot",
              name: "pmzbot",
              defaultBranch: "dev",
              isPrivate: true,
              isFork: false,
              parentSlug: null,
              viewerLogin: "danielcor",
              viewerPermission: "ADMIN",
            },
            existingPr: null,
            aheadCount: 1,
            commitSubjects: ["feat"],
            diffText: "",
            diffSecretFinding: null,
            localSecretMatchSource: null,
          };
        }
        if (method === "inspectContainerGates") {
          return detectContainerGatePlan({
            repoSlug: "PeakBot/pmzbot",
            baseBranch: "dev",
            hasBootstrapCloudroom: true,
            hasMergeEligibilityScript: true,
            kiriFiles: ["scripts/ci/self-hosted-runner/Dockerfile"],
            inCloudSandbox: sandboxMode,
          });
        }
        if (method === "runContainerGate") {
          const out: RunContainerGateOutput = {
            ok: true,
            passed: true,
            refused: false,
            exitCode: 0,
            wallSeconds: 18.2,
            receipt: {
              repo: "PeakBot/pmzbot",
              base: "dev",
              commit: HEAD_SHA,
              gate: "pmzbot:smoke",
              result: "PASS",
              passedCount: 12,
              failedCount: 0,
              skippedCount: 0,
              wall: "18.2s",
              host: "cloudroom-sandbox (sandbox-1)",
              bootstrap: "scripts/ci/bootstrap-cloudroom.sh",
              notRun: "none",
              sourceAuthor: "cloudroom-sandbox",
              sourceKind: "gate_runner",
            },
            outputTail: "PASS",
            error: null,
          };
          return out;
        }
        return {};
      },
    });
    fakeHosts.push(host);

    await createShipPlugin({
      disableBackgroundPoller: true,
      execCloudSpawn: async (args) => {
        cloudSpawnArgs.push(args);
        return { code: 0, stdout: JSON.stringify({ id: "thr_cloud_gate_1" }), stderr: "" };
      },
    })(host.bb);

    // 1) Inspect works on host
    const inspectRes = await host.harness.runCli(["gate", "inspect", "--base", "dev", "--json"], {
      projectId: "proj_1",
    });
    expect(inspectRes.exitCode).toBe(0);
    expect(JSON.parse(inspectRes.stdout)).toMatchObject({
      repoKind: "pmzbot",
      supportedForBase: true,
      inCloudSandbox: false,
    });

    // 2) `gate run` refuses running on non-container host without `--cloud`
    const refusedRes = await host.harness.runCli(["gate", "run", "--json"], { projectId: "proj_1" });
    expect(refusedRes.exitCode).toBe(1);
    expect(JSON.parse(refusedRes.stdout).status).toBe("refused_non_container");

    // 3) `gate run --cloud` spawns Cloudroom Cloud sandbox child via `room-cli thread spawn --machine cloud`
    const cloudRes = await host.harness.runCli(["gate", "run", "--cloud", "--json"], { projectId: "proj_1" });
    expect(cloudRes.exitCode).toBe(0);
    expect(JSON.parse(cloudRes.stdout)).toMatchObject({
      status: "cloud_spawned",
      threadId: "thr_cloud_gate_1",
      branch: "feat/container-gate",
    });
    expect(cloudSpawnArgs[0]).toContain("--machine");
    expect(cloudSpawnArgs[0]).toContain("cloud");

    // 4) Inside Cloudroom Cloud sandbox (`inCloudSandbox: true`), executes gate directly and emits Gate receipt
    sandboxMode = true;
    const sandboxRunRes = await host.harness.runCli(["gate", "run", "--json"], { projectId: "proj_1" });
    expect(sandboxRunRes.exitCode).toBe(0);
    const parsedRun = JSON.parse(sandboxRunRes.stdout);
    expect(parsedRun.status).toBe("passed");
    expect(parsedRun.formattedReceipt).toContain("Gate receipt");
    expect(parsedRun.formattedReceipt).toContain(`commit:    ${HEAD_SHA}`);
  });
});
