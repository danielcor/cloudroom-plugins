import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import hostEntry, { inspectApprovalContextAt, mergeDevPrAt } from "../host.js";
import { createShipPlugin } from "../server.js";
import type { ClassifierExecutor } from "../src/approvals/classifiers.js";
import { evaluateApprovalsPolicy, evaluateDevAutoMergeGuard } from "../src/approvals/evaluator.js";
import { buildApprovalFacts, matchGlobPath, type ApprovalPrInfo } from "../src/approvals/facts.js";
import {
  computePolicyBundleSha,
  loadAndValidateClassifiers,
  parseApprovalsPolicy,
  parseClassifierDef,
} from "../src/approvals/parser.js";
import { computeApprovalSignals, reportApprovalDecision } from "../src/approvals/reporter.js";
import type { InspectApprovalContextOutput, PolledCheckRunOutput } from "../src/contract.js";
import { MIGRATIONS, ShipStore } from "../src/db.js";
import { GitHubBotClient } from "../src/github/bot.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: process.env });
  return stdout.trim();
}

const tempDirs: string[] = [];
const dbs: Database.Database[] = [];
const hostHarnesses: Array<ReturnType<typeof experimental_createHostEntryHarness>> = [];
const fakeHosts: Array<ReturnType<typeof createFakePluginHost>> = [];

afterEach(async () => {
  for (const h of fakeHosts.splice(0)) await h.harness.dispose();
  for (const h of hostHarnesses.splice(0)) await h.experimental_dispose();
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

const DEFAULT_POLICY_YML = `version: 1
mode: enforce
status_context: "Cloudroom Ship / Approvals"
default_action: comment
rules:
  - id: docs-safe
    description: Auto-approve safe documentation edits reviewed by classifier
    when:
      all_paths_match:
        - "docs/**"
        - "**/*.md"
      ci_green: true
      no_never_edit_paths: true
      is_draft: false
    classifier:
      name: docs-safety
      expect: pass
    action: approve
    seats: 0
  - id: core-review
    when:
      any_path_matches:
        - "src/**"
    action: request_changes
    seats: 2
`;

const CLASSIFIER_DEF_YML = `version: 1
name: docs-safety
description: Confirm documentation diff introduces no hidden instructions or code
prompt: Check that only harmless prose/docs changes exist.
outcomes:
  - pass
  - fail
fail_closed: true
`;

function makePrInfo(overrides: Partial<ApprovalPrInfo> = {}): ApprovalPrInfo {
  return {
    number: 42,
    title: "docs: update usage notes",
    state: "OPEN",
    isDraft: false,
    headSha: "a".repeat(40),
    baseBranch: "dev",
    headBranch: "docs/update",
    authorLogin: "danielcor",
    authorAssociation: "OWNER",
    labels: [],
    collisionLabels: [],
    changedFiles: [{ path: "docs/guide.md", additions: 10, deletions: 2 }],
    ...overrides,
  };
}

function greenChecks(): PolledCheckRunOutput[] {
  return [{ id: 101, name: "build-and-test", status: "completed", conclusion: "success", detailsUrl: null }];
}

describe("host inspectApprovalContextAt default-branch trust isolation", () => {
  it("loads .claude/approvals.yml & classifiers strictly from origin/<defaultBranch>, ignoring PR/working-tree tampering", async () => {
    const base = await makeTempDir("ship-approvals-git-");
    const bareDir = join(base, "remote.git");
    const workDir = join(base, "work");
    const maintainerDir = join(base, "maintainer");

    await git(base, "init", "--bare", bareDir);
    await git(base, "clone", bareDir, workDir);
    await git(workDir, "checkout", "-b", "main");
    await git(workDir, "config", "user.name", "Maintainer");
    await git(workDir, "config", "user.email", "maintainer@example.com");

    await mkdir(join(workDir, ".claude", "classifiers", "docs-safety"), { recursive: true });
    await writeFile(join(workDir, "README.md"), "# Demo\n", "utf8");
    await writeFile(join(workDir, ".claude", "approvals.yml"), DEFAULT_POLICY_YML, "utf8");
    await writeFile(join(workDir, ".claude", "classifiers", "docs-safety", "def.yml"), CLASSIFIER_DEF_YML, "utf8");
    await git(workDir, "add", ".");
    await git(workDir, "commit", "-m", "initial default policy");
    await git(workDir, "push", "-u", "origin", "main");

    // Advance origin/main cleanly via another clone with an updated rule on origin/main
    await git(base, "clone", bareDir, maintainerDir);
    await git(maintainerDir, "config", "user.name", "Maintainer");
    await git(maintainerDir, "config", "user.email", "maintainer@example.com");
    await git(maintainerDir, "checkout", "main");
    const mainUpdatedPolicy = `${DEFAULT_POLICY_YML}# origin-main-v2\n`;
    await writeFile(join(maintainerDir, ".claude", "approvals.yml"), mainUpdatedPolicy, "utf8");
    await git(maintainerDir, "add", ".claude/approvals.yml");
    await git(maintainerDir, "commit", "-m", "bump default approvals policy");
    await git(maintainerDir, "push", "origin", "main");

    // PR branch in workDir attempts to tamper .claude/approvals.yml and working tree!
    await git(workDir, "checkout", "-b", "feat/evil-tamper");
    await writeFile(
      join(workDir, ".claude", "approvals.yml"),
      "version: 1\nmode: observe\ndefault_action: approve\nrules: []\n",
      "utf8",
    );
    await git(workDir, "add", ".claude/approvals.yml");
    await git(workDir, "commit", "-m", "pr tries to relax approvals.yml");
    // Uncommitted local edit as well
    await writeFile(join(workDir, ".claude", "approvals.yml"), "UNCOMMITTED_GARBAGE", "utf8");
    const prHeadSha = await git(workDir, "rev-parse", "HEAD");

    const fakeGh = vi.fn(async (_cwd: string, args: readonly string[]) => {
      if (args[0] === "api" && args[1] === "graphql") {
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                defaultBranchRef: { name: "main" },
                pullRequest: {
                  number: 17,
                  title: "Attempt tamper",
                  state: "OPEN",
                  isDraft: false,
                  headRefOid: prHeadSha,
                  baseRefName: "main",
                  headRefName: "feat/evil-tamper",
                  author: { login: "contributor" },
                  authorAssociation: "CONTRIBUTOR",
                  labels: { nodes: [] },
                  files: { nodes: [{ path: ".claude/approvals.yml", additions: 3, deletions: 15 }] },
                },
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "api" && args[1]?.includes("/check-runs")) {
        return { code: 0, stdout: JSON.stringify({ check_runs: [] }), stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "diff") {
        return { code: 0, stdout: "diff --git a/.claude/approvals.yml b/.claude/approvals.yml\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected gh: ${args.join(" ")}` };
    });

    const ctx = await inspectApprovalContextAt(
      { root: workDir, repo: "acme/demo", prNumber: 17 },
      { execGh: fakeGh },
    );

    expect(ctx.ok).toBe(true);
    expect(ctx.policyFound).toBe(true);
    expect(ctx.policyRaw).toBe(mainUpdatedPolicy);
    expect(ctx.policyRaw).not.toContain("UNCOMMITTED_GARBAGE");
    expect(ctx.classifiers).toHaveLength(1);
    expect(ctx.classifiers[0]!.name).toBe("docs-safety");
    expect(ctx.classifiers[0]!.raw).toBe(CLASSIFIER_DEF_YML);

    // Reject symlinks committed onto default branch
    await symlink("README.md", join(maintainerDir, ".claude", "approvals.yml")).catch(async () => {
      await rm(join(maintainerDir, ".claude", "approvals.yml"), { force: true });
      await symlink("README.md", join(maintainerDir, ".claude", "approvals.yml"));
    });
    await git(maintainerDir, "add", ".claude/approvals.yml");
    await git(maintainerDir, "commit", "-m", "symlink approvals.yml");
    await git(maintainerDir, "push", "origin", "main");

    const symRes = await inspectApprovalContextAt(
      { root: workDir, repo: "acme/demo", prNumber: 17 },
      { execGh: fakeGh },
    );
    expect(symRes.ok).toBe(false);
    expect(symRes.error).toContain("symlink");
  });
});

describe("policy parser, glob matching, evaluator caching, and fail-closed logic", () => {
  it("validates policy/classifier schemas and supports safe globs without backtracking", () => {
    expect(() => parseApprovalsPolicy("version: 2\nrules: []\n")).toThrow();
    expect(() =>
      parseApprovalsPolicy(
        "version: 1\nrules:\n  - id: dup\n    action: approve\n  - id: dup\n    action: comment\n",
      ),
    ).toThrow(/Duplicate approval rule id/);

    const policy = parseApprovalsPolicy(DEFAULT_POLICY_YML);
    expect(() =>
      loadAndValidateClassifiers(policy, []),
    ).toThrow(/missing default-branch classifier/);

    const clsMap = loadAndValidateClassifiers(policy, [
      { name: "docs-safety", path: ".claude/classifiers/docs-safety/def.yml", raw: CLASSIFIER_DEF_YML, sha: "abc" },
    ]);
    expect(clsMap.get("docs-safety")?.outcomes).toEqual(["pass", "fail"]);
    expect(() => parseClassifierDef(CLASSIFIER_DEF_YML, "other-name")).toThrow(/does not match/);

    expect(matchGlobPath("docs/**", "docs/guides/intro.md")).toBe(true);
    expect(matchGlobPath("**/*.md", "a\\b\\README.md")).toBe(true);
    expect(matchGlobPath("**/*.md", "src/index.ts")).toBe(false);
    expect(matchGlobPath("src/*/index.ts", "src/approvals/index.ts")).toBe(true);
    expect(matchGlobPath("src/*/index.ts", "src/a/b/index.ts")).toBe(false);
    expect(matchGlobPath("file?.txt", "file1.txt")).toBe(true);
  });

  it("short-circuits classifiers on failed free facts, treats cancelled CI as not green, caches hits by (headSha, classifierSha), and fails closed", async () => {
    const store = createStore();
    const policy = parseApprovalsPolicy(DEFAULT_POLICY_YML);
    const classifiers = loadAndValidateClassifiers(policy, [
      {
        name: "docs-safety",
        path: ".claude/classifiers/docs-safety/def.yml",
        raw: CLASSIFIER_DEF_YML,
        sha: "cls_sha_1",
      },
    ]);
    const policySha = computePolicyBundleSha(DEFAULT_POLICY_YML, [
      { path: ".claude/classifiers/docs-safety/def.yml", sha: "cls_sha_1" },
    ]);

    // 1) Cancelled check means ciGreen === false
    const cancelledFacts = buildApprovalFacts(makePrInfo(), [
      { id: 1, name: "ci", status: "completed", conclusion: "cancelled", detailsUrl: null },
    ]);
    expect(cancelledFacts.ciGreen).toBe(false);

    // 2) Failed deterministic predicate -> 0 classifier calls!
    const executor = vi.fn<ClassifierExecutor>(async () => ({
      ok: true,
      replyText: "VERDICT: pass\nREASON: Clean markdown edit.",
      error: null,
    }));
    const skippedPr = makePrInfo({
      changedFiles: [
        { path: "docs/guide.md", additions: 5, deletions: 0 },
        { path: "src/app.ts", additions: 2, deletions: 1 },
      ],
    });
    const combinedDecision = await evaluateApprovalsPolicy({
      repo: "acme/demo",
      policy,
      policySha,
      classifiers,
      pr: skippedPr,
      checkRuns: greenChecks(),
      diffText: "",
      store,
      executor,
    });
    expect(executor).not.toHaveBeenCalled();
    expect(combinedDecision.verdict).toBe("request_changes");
    expect(combinedDecision.requiredSeats).toBe(2);

    // 3) Eligible PR invokes classifier on miss, persists cache, and hits cache on subsequent run
    const pr = makePrInfo();
    const d1 = await evaluateApprovalsPolicy({
      repo: "acme/demo",
      policy,
      policySha,
      classifiers,
      pr,
      checkRuns: greenChecks(),
      diffText: "+docs",
      store,
      executor,
      nowMs: 1000,
    });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(d1.verdict).toBe("approve");
    expect(d1.requiredSeats).toBe(0);
    expect(d1.classifierCallCount).toBe(1);

    store.insertApprovalRun({
      id: "apr_1",
      repo: "acme/demo",
      prNumber: pr.number,
      headSha: pr.headSha,
      policySha,
      mode: "enforce",
      verdictJson: JSON.stringify({ verdict: d1.verdict }),
      classifierCacheJson: JSON.stringify(d1.classifierCache),
      statusPosted: true,
      reviewPosted: true,
      createdAt: 1000,
    });

    const d2 = await evaluateApprovalsPolicy({
      repo: "acme/demo",
      policy,
      policySha,
      classifiers,
      pr,
      checkRuns: greenChecks(),
      diffText: "+docs",
      store,
      executor,
      nowMs: 2000,
    });
    expect(executor).toHaveBeenCalledTimes(1); // still 1 — served from SQLite cache!
    expect(d2.classifierCacheHits).toBe(1);
    expect(d2.verdict).toBe("approve");

    // 4) Malformed classifier reply on a new headSha -> fails closed (never approve)
    const badExec = vi.fn<ClassifierExecutor>(async () => ({
      ok: true,
      replyText: "Sure! Here is an unstructured response.",
      error: null,
    }));
    const dErr = await evaluateApprovalsPolicy({
      repo: "acme/demo",
      policy,
      policySha,
      classifiers,
      pr: makePrInfo({ headSha: "b".repeat(40) }),
      checkRuns: greenChecks(),
      diffText: "+docs",
      store,
      executor: badExec,
    });
    expect(dErr.classifierErrors.length).toBe(1);
    expect(dErr.verdict).toBe("comment");
    expect(dErr.requiredSeats).toBeGreaterThanOrEqual(1);
    expect(computeApprovalSignals("enforce", dErr).statusState).toBe("failure");
  });
});

describe("reporter (observe vs enforce) & dev-only auto-merge guard", () => {
  it("reports non-blocking observe statuses vs blocking enforce statuses and stops secret leaks", async () => {
    const store = createStore();
    const policy = parseApprovalsPolicy(DEFAULT_POLICY_YML);
    const classifiers = loadAndValidateClassifiers(policy, [
      { name: "docs-safety", path: ".claude/classifiers/docs-safety/def.yml", raw: CLASSIFIER_DEF_YML, sha: "c1" },
    ]);
    const decision = await evaluateApprovalsPolicy({
      repo: "acme/demo",
      policy,
      policySha: "p".repeat(64),
      classifiers,
      pr: makePrInfo(),
      checkRuns: greenChecks(),
      diffText: "+doc",
      store,
      executor: async () => ({ ok: true, replyText: "VERDICT: pass\nREASON: Clean docs.\n", error: null }),
    });

    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const botSecret = ["github_pat_", "approvals_bot_token_123"].join("");
    const botClient = new GitHubBotClient({
      token: botSecret,
      botLogin: "ship-bot",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        });
        return new Response(JSON.stringify({ id: requests.length, state: "ok" }), { status: 201 });
      }) as typeof fetch,
    });

    const obs = await reportApprovalDecision({
      repo: "acme/demo",
      prNumber: 42,
      root: "/tmp/wt",
      effectiveMode: "observe",
      decision,
      botClient,
      scanOutboundForLocalSecrets: async () => ({ ok: true, matchedSource: null }),
    });
    expect(obs).toMatchObject({ statusPosted: true, reviewPosted: true, statusState: "success", reviewEvent: "COMMENT" });

    const enf = await reportApprovalDecision({
      repo: "acme/demo",
      prNumber: 42,
      root: "/tmp/wt",
      effectiveMode: "enforce",
      decision,
      botClient,
      scanOutboundForLocalSecrets: async () => ({ ok: true, matchedSource: null }),
    });
    expect(enf).toMatchObject({ statusPosted: true, reviewPosted: true, statusState: "success", reviewEvent: "APPROVE" });

    // Local secret match aborts before HTTP fetch
    const priorCount = requests.length;
    const blocked = await reportApprovalDecision({
      repo: "acme/demo",
      prNumber: 42,
      root: "/tmp/wt",
      effectiveMode: "enforce",
      decision,
      botClient,
      scanOutboundForLocalSecrets: async () => ({ ok: false, matchedSource: "TOKEN in .env" }),
    });
    expect(blocked.statusPosted).toBe(false);
    expect(blocked.error).toContain("TOKEN in .env");
    expect(requests.length).toBe(priorCount);
  });

  it("hard-blocks dev auto-merge on non-dev branches and enforces all 8 invariants cleanly", async () => {
    const store = createStore();
    const policy = parseApprovalsPolicy(DEFAULT_POLICY_YML);
    const classifiers = loadAndValidateClassifiers(policy, [
      { name: "docs-safety", path: ".claude/classifiers/docs-safety/def.yml", raw: CLASSIFIER_DEF_YML, sha: "c1" },
    ]);
    const pr = makePrInfo({ baseBranch: "dev", headSha: "d".repeat(40) });
    const decision = await evaluateApprovalsPolicy({
      repo: "acme/demo",
      policy,
      policySha: "p".repeat(64),
      classifiers,
      pr,
      checkRuns: greenChecks(),
      diffText: "+doc",
      store,
      executor: async () => ({ ok: true, replyText: "VERDICT: pass\nREASON: Safe.\n", error: null }),
    });
    const cleanReview = {
      id: "rev_1",
      watchId: null,
      repo: "acme/demo",
      prNumber: pr.number,
      headSha: pr.headSha,
      mode: "triad" as const,
      round: 1,
      seatsJson: "[]",
      verdict: "APPROVE",
      meanScore: 9.2,
      createdAt: 1000,
    };

    // Happy path on `dev`
    expect(
      evaluateDevAutoMergeGuard({
        allowDevAutomerge: true,
        pr,
        facts: decision.facts,
        decision,
        latestReviewRun: cleanReview,
      }),
    ).toEqual({ eligible: true, blockedReasons: [] });

    // Every forbidden base branch must be hard-blocked!
    for (const forbiddenBase of ["main", "master", "beta", "prod", "production", "release/1.0"]) {
      const g = evaluateDevAutoMergeGuard({
        allowDevAutomerge: true,
        pr: makePrInfo({ baseBranch: forbiddenBase, headSha: pr.headSha }),
        facts: decision.facts,
        decision,
        latestReviewRun: cleanReview,
      });
      expect(g.eligible).toBe(false);
      expect(g.blockedReasons[0]).toContain("not \"dev\"");
    }

    // Check remaining invariants: draft, stale review SHA, non-green CI, collision label, never-edit path
    expect(
      evaluateDevAutoMergeGuard({
        allowDevAutomerge: true,
        pr: { ...pr, isDraft: true },
        facts: decision.facts,
        decision,
        latestReviewRun: cleanReview,
      }).eligible,
    ).toBe(false);

    expect(
      evaluateDevAutoMergeGuard({
        allowDevAutomerge: true,
        pr,
        facts: decision.facts,
        decision,
        latestReviewRun: { ...cleanReview, headSha: "f".repeat(40) },
      }).eligible,
    ).toBe(false);

    const touchedCi = buildApprovalFacts(
      makePrInfo({
        baseBranch: "dev",
        headSha: pr.headSha,
        changedFiles: [{ path: ".github/workflows/ci.yml", additions: 1, deletions: 0 }],
      }),
      greenChecks(),
    );
    expect(
      evaluateDevAutoMergeGuard({
        allowDevAutomerge: true,
        pr,
        facts: touchedCi,
        decision,
        latestReviewRun: cleanReview,
      }).eligible,
    ).toBe(false);

    // Host mergeDevPrAt enforces baseBranch === "dev" & passes --match-head-commit
    const nonDevHostRes = await mergeDevPrAt({
      root: "/tmp/wt",
      repo: "acme/demo",
      prNumber: 42,
      baseBranch: "main",
      expectedHeadSha: pr.headSha,
    });
    expect(nonDevHostRes.ok).toBe(false);
    expect(nonDevHostRes.error).toContain('strictly restricted to base branch "dev"');

    const ghCalls: Array<readonly string[]> = [];
    const devHostRes = await mergeDevPrAt(
      {
        root: "/tmp/wt",
        repo: "acme/demo",
        prNumber: 42,
        baseBranch: "dev",
        expectedHeadSha: pr.headSha,
      },
      {
        execGh: async (_cwd, args) => {
          ghCalls.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );
    expect(devHostRes).toEqual({ ok: true, merged: true, error: null });
    expect(ghCalls[0]).toContain("--match-head-commit");
    expect(ghCalls[0]).toContain(pr.headSha);
  });
});

describe("server CLI room-cli ship approvals check", () => {
  it("evaluates, caches, posts Commit Status + review, and gates dev auto-merge end-to-end", async () => {
    const botSecret = ["github_pat_", "fake_cli_approvals_token"].join("");
    const headSha = "c".repeat(40);
    const postedUrls: string[] = [];

    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const s = String(url);
      postedUrls.push(s);
      if (s.endsWith("/graphql")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  number: 42,
                  url: "https://github.com/acme/demo/pull/42",
                  title: "docs: update usage notes",
                  body: "Body",
                  state: "OPEN",
                  isDraft: false,
                  headRefName: "docs/update",
                  headRefOid: headSha,
                  baseRefName: "dev",
                  baseRefOid: "0".repeat(40),
                  author: { login: "danielcor" },
                  labels: { nodes: [] },
                  comments: { nodes: [] },
                  reviews: { nodes: [] },
                  reviewThreads: { nodes: [] },
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ id: postedUrls.length, state: "APPROVED" }), { status: 201 });
    });

    const classifierCalls = vi.fn<ClassifierExecutor>(async () => ({
      ok: true,
      replyText: "VERDICT: pass\nREASON: Pure markdown update.\n",
      error: null,
    }));

    let approvalCtxMock: InspectApprovalContextOutput = {
      ok: true,
      error: null,
      defaultBranch: "main",
      baseRemote: "origin",
      policyFound: true,
      policyRaw: DEFAULT_POLICY_YML,
      policySha: "a".repeat(64),
      classifiers: [
        {
          name: "docs-safety",
          path: ".claude/classifiers/docs-safety/def.yml",
          raw: CLASSIFIER_DEF_YML,
          sha: "cls_v1_sha",
        },
      ],
      pr: makePrInfo({ baseBranch: "dev", headSha }),
      checkRuns: greenChecks(),
      diffText: "+clean doc",
      diffTruncated: false,
    };

    const mergeCalls: unknown[] = [];
    const hostWorker = experimental_createHostEntryHarness(hostEntry);
    hostHarnesses.push(hostWorker);

    const { makeThreadResponse } = await import("@get-bb/plugin-sdk/testing");
    const host = createFakePluginHost({
      pluginId: "ship",
      agentSkillIds: ["ship", "steward", "ship-approvals"],
      settings: { botLogin: "ship-bot", botToken: botSecret },
      sdk: {
        hosts: { list: async () => [{ id: "host_1", name: "aipc-ubuntu" }] as never },
        projects: {
          get: async () =>
            ({
              id: "proj_1",
              name: "demo",
              kind: "standard",
              sources: [{ id: "s1", projectId: "proj_1", hostId: "host_1", path: "/tmp/wt", isDefault: true }],
            }) as never,
        },
        threads: {
          spawn: async () => {
            const thr = makeThreadResponse({ id: "thr_rev_apr", projectId: "proj_1", createdAt: Date.now() });
            setTimeout(() => {
              void host.harness.emitThreadEvent("thread.idle", {
                thread: thr,
                lastAssistantText: [
                  `HEAD: ${headSha}`,
                  "CONTEXT: diff-only",
                  "SCORE: 10/10",
                  "VERDICT: APPROVE",
                ].join("\n"),
              });
            }, 5);
            return thr;
          },
          stop: async () => ({ ok: true }) as never,
          archive: async () => ({ ok: true }) as never,
        },
        environments: {
          get: async () => ({ id: "env_1", path: "/tmp/wt" }) as never,
          delete: async () => ({ ok: true }) as never,
        },
      },
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "inspectApprovalContext") return approvalCtxMock;
        if (method === "inspectReviewContext") {
          return {
            root: "/tmp/wt",
            repoSlug: "acme/demo",
            branch: "docs/update",
            headSha,
            baseSha: "0".repeat(40),
            priorReviewedIsAncestor: false,
            changedFiles: ["docs/guide.md"],
            committedFiles: ["docs/guide.md"],
            diffText: "+clean doc",
            unsafeWorktreeHooks: false,
            worktreeHookReason: null,
            hasEscapingSymlinks: false,
            symlinkReason: null,
            secretBlockedReason: null,
          };
        }
        if (method === "scanOutboundForLocalSecrets") return { ok: true, matchedSource: null };
        if (method === "readPrDiscussion") {
          return {
            pr: {
              number: 42,
              url: "https://github.com/acme/demo/pull/42",
              title: "docs: update usage notes",
              body: "Body",
              mayHideBody: false,
              state: "OPEN",
              isDraft: false,
              headRefName: "docs/update",
              headRefOid: headSha,
              baseRefName: "dev",
              baseRefOid: "0".repeat(40),
              authorLogin: "danielcor",
              labels: [],
              mergeStateStatus: "CLEAN",
            },
            items: [],
            excludedCount: 0,
            truncatedCount: 0,
            droppedForBudgetCount: 0,
            collisionLabels: [],
          };
        }
        if (method === "mergeDevPr") {
          mergeCalls.push(input);
          return { ok: true, merged: true, error: null };
        }
        return hostWorker.experimental_call(method as never, input as never);
      },
    });
    fakeHosts.push(host);

    const plugin = createShipPlugin({
      fetchImpl: mockFetch as typeof fetch,
      execDispatch: async () => ({ code: 1, stdout: "", stderr: "unavailable" }),
      classifierExecutor: classifierCalls,
      disableBackgroundPoller: true,
    });
    await plugin(host.bb);

    // Enable repo with enforce + dev automerge
    const repoSetRes = await host.harness.runCli([
      "repos",
      "set",
      "acme/demo",
      "--approvals",
      "enforce",
      "--dev-automerge",
      "--json",
    ]);
    expect(repoSetRes.exitCode).toBe(0);

    // 1) First run evaluates classifier & posts Commit Status + APPROVE review, blocked from auto-merge because no APPROVE review_run exists yet!
    const run1 = await host.harness.runCli(
      ["approvals", "check", "42", "--repo", "acme/demo", "--path", "/tmp/wt", "--post", "--automerge", "--json"],
    );
    expect(run1.exitCode, `${run1.stdout}\n${run1.stderr}`).toBe(0);
    const out1 = JSON.parse(run1.stdout);
    expect(out1.decision.verdict).toBe("approve");
    expect(out1.decision.classifierCallCount).toBe(1);
    expect(out1.report).toMatchObject({ statusPosted: true, reviewPosted: true, statusState: "success", reviewEvent: "APPROVE" });
    expect(out1.autoMerge.eligible).toBe(false);
    expect(mergeCalls).toHaveLength(0);
    expect(postedUrls.some((u) => u.includes(`/statuses/${headSha}`))).toBe(true);
    expect(postedUrls.some((u) => u.includes("/pulls/42/reviews"))).toBe(true);

    // 2) Record a clean Ship review on exact headSha, then re-run approvals check --automerge on dev:
    //    classifier hits cache (0 calls) AND dev auto-merge succeeds!
    const revRes = await host.harness.runCli(
      ["review", "--mode", "single", "--repo", "acme/demo", "--pr", "42", "--path", "/tmp/wt", "--project", "proj_1", "--json"],
    );
    expect(revRes.exitCode, `${revRes.stdout}\n${revRes.stderr}`).toBe(0);
    expect(JSON.parse(revRes.stdout).verdict).toBe("APPROVE");

    const run2 = await host.harness.runCli(
      ["approvals", "check", "42", "--repo", "acme/demo", "--path", "/tmp/wt", "--automerge", "--json"],
    );
    expect(run2.exitCode).toBe(0);
    const out2 = JSON.parse(run2.stdout);
    expect(out2.decision.classifierCallCount).toBe(0);
    expect(out2.decision.classifierCacheHits).toBe(1);
    expect(out2.autoMerge).toMatchObject({ eligible: true, attempted: true, merged: true });
    expect(mergeCalls).toHaveLength(1);

    // 3) Check main-target refusal even when --automerge is passed
    approvalCtxMock = {
      ...approvalCtxMock,
      pr: makePrInfo({ baseBranch: "main", headSha }),
    };
    const runMain = await host.harness.runCli(
      ["approvals", "check", "42", "--repo", "acme/demo", "--path", "/tmp/wt", "--automerge", "--json"],
    );
    const outMain = JSON.parse(runMain.stdout);
    expect(outMain.autoMerge.eligible).toBe(false);
    expect(mergeCalls).toHaveLength(1);
  });
});
