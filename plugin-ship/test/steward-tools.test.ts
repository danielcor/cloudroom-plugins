import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry, { stewardCommitAndPushAt, stewardMergeBaseAt } from "../host.js";
import { computeCheckoutPins } from "../src/safety/pins.js";
import { MIGRATIONS, ShipStore } from "../src/db.js";
import { createShipPlugin } from "../server.js";
import { STEWARD_TOOL_NAMES } from "../src/steward/tools.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const fakeHosts: ReturnType<typeof createFakePluginHost>[] = [];
const hostHarnesses: ReturnType<typeof experimental_createHostEntryHarness>[] = [];

afterEach(async () => {
  for (const h of fakeHosts.splice(0)) await h.harness.dispose();
  for (const h of hostHarnesses.splice(0)) await h.experimental_dispose();
  for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

describe("host Steward git mutations (-c core.hooksPath=/dev/null, pins, merge-guard, secret fence)", () => {
  it("commits and pushes with repo hooks disabled and enforces pin drift and merge-guard", async () => {
    const base = await mkdtemp(join(tmpdir(), "ship-stew-git-"));
    tempDirs.push(base);
    const bareDir = join(base, "origin.git");
    const workDir = join(base, "work");
    const hookRanMarker = join(base, "hook-should-not-run");

    await git(base, "init", "--bare", bareDir);
    await mkdir(workDir, { recursive: true });
    await git(workDir, "init", "-b", "main");
    await git(workDir, "config", "user.name", "Author");
    await git(workDir, "config", "user.email", "author@example.com");
    await writeFile(join(workDir, "app.ts"), "export const v = 1;\n", "utf8");
    await git(workDir, "add", "app.ts");
    await git(workDir, "commit", "-m", "init main");
    await git(workDir, "remote", "add", "origin", bareDir);
    await git(workDir, "push", "-u", "origin", "main");

    await git(workDir, "checkout", "-b", "feat/stew");
    await writeFile(join(workDir, "app.ts"), "export const v = 2;\n", "utf8");
    await git(workDir, "add", "app.ts");
    await git(workDir, "commit", "-m", "feat start");
    await git(workDir, "push", "-u", "origin", "feat/stew");

    // Install pre-commit hook AFTER branch creation — Steward must NOT trigger it!
    const hookFile = join(workDir, ".git", "hooks", "pre-commit");
    await writeFile(hookFile, `#!/bin/sh\ntouch "${hookRanMarker}"\nexit 1\n`, "utf8");
    await chmod(hookFile, 0o755);

    const pinSnap = await computeCheckoutPins(workDir);
    expect(pinSnap.ok).toBe(true);
    if (!pinSnap.ok) throw new Error(pinSnap.error);

    // 1) Never-edit paths and secret leaks are blocked before staging/commit
    await writeFile(join(workDir, ".env"), "LOCAL_TOK=secret_value_abc123\n", "utf8");
    const blockedEnv = await stewardCommitAndPushAt({
      root: workDir,
      headRemote: "origin",
      headBranch: "feat/stew",
      files: [".env"],
      commitMessage: "ship: add env",
      expectedPins: pinSnap.pins,
    });
    expect(blockedEnv.ok).toBe(false);
    expect(blockedEnv.error).toContain("secret");

    await writeFile(join(workDir, "app.ts"), "export const v = 'secret_value_abc123';\n", "utf8");
    const blockedLeak = await stewardCommitAndPushAt({
      root: workDir,
      headRemote: "origin",
      headBranch: "feat/stew",
      files: ["app.ts"],
      commitMessage: "ship: fix app",
      expectedPins: pinSnap.pins,
    });
    expect(blockedLeak.ok).toBe(false);
    expect(blockedLeak.error).toContain("LOCAL_TOK in .env");

    // 2) Valid commit succeeds WITHOUT executing .git/hooks/pre-commit!
    await writeFile(join(workDir, "app.ts"), "export const v = 3;\n", "utf8");
    const pushed = await stewardCommitAndPushAt({
      root: workDir,
      headRemote: "origin",
      headBranch: "feat/stew",
      files: ["app.ts"],
      commitMessage: "fix: update app export",
      expectedPins: pinSnap.pins,
    });
    expect(pushed).toMatchObject({ ok: true, committed: true, pushed: true, error: null });
    await expect(stat(hookRanMarker)).rejects.toThrow();
    expect(await git(bareDir, "rev-parse", "refs/heads/feat/stew")).toBe(pushed.headSha);

    // 3) Advance main safely, merge it via stewardMergeBaseAt; then protect .claude/settings.json on main
    const clone2 = join(base, "clone2");
    await git(base, "clone", bareDir, clone2);
    await git(clone2, "config", "user.name", "Base Maintainer");
    await git(clone2, "config", "user.email", "base@example.com");
    await git(clone2, "checkout", "main");
    await writeFile(join(clone2, "base.txt"), "upstream\n", "utf8");
    await git(clone2, "add", "base.txt");
    await git(clone2, "commit", "-m", "upstream update");
    const mainSha1 = await git(clone2, "rev-parse", "HEAD");
    await git(clone2, "push", "origin", "main");

    const merged = await stewardMergeBaseAt({
      root: workDir,
      baseRemote: "origin",
      baseBranch: "main",
      headRemote: "origin",
      headBranch: "feat/stew",
      expectedBaseSha: mainSha1,
      expectedPins: pinSnap.pins,
    });
    expect(merged.ok).toBe(true);
    expect(merged.pushed).toBe(true);
    expect(await git(bareDir, "rev-parse", "refs/heads/feat/stew")).toBe(merged.headSha);

    // Protected path merge attempt is blocked!
    await mkdir(join(clone2, ".claude"), { recursive: true });
    await writeFile(join(clone2, ".claude", "settings.json"), '{"danger":true}\n', "utf8");
    await git(clone2, "add", ".claude/settings.json");
    await git(clone2, "commit", "-m", "add claude settings");
    const mainSha2 = await git(clone2, "rev-parse", "HEAD");
    await git(clone2, "push", "origin", "main");

    const blockedMerge = await stewardMergeBaseAt({
      root: workDir,
      baseRemote: "origin",
      baseBranch: "main",
      expectedBaseSha: mainSha2,
      expectedPins: pinSnap.pins,
    });
    expect(blockedMerge.ok).toBe(false);
    expect(blockedMerge.reason).toContain(".claude/settings.json");

    // 4) Tampering a pinned file blocks subsequent operations
    await writeFile(join(workDir, ".mcp.json"), '{"mcpServers":{}}\n', "utf8");
    const driftBlocked = await stewardCommitAndPushAt({
      root: workDir,
      headRemote: "origin",
      headBranch: "feat/stew",
      files: ["app.ts"],
      commitMessage: "fix: post tamper",
      expectedPins: pinSnap.pins,
    });
    expect(driftBlocked.ok).toBe(false);
    expect(driftBlocked.error).toContain(".mcp.json");
  });
});

describe("agent configuration & fenced Steward tool budget enforcement", () => {
  it("grants 8 tools only to steward-worker threads and enforces push/rerun/merge/comment rules", async () => {
    const botSecret = ["github_pat_", "fake_steward_bot_token_123456"].join("");
    const hostWorker = experimental_createHostEntryHarness(hostEntry);
    hostHarnesses.push(hostWorker);

    const postedComments: string[] = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/issues/10/comments")) {
        const body = JSON.parse(String(init?.body ?? "{}")).body as string;
        postedComments.push(body);
        return new Response(JSON.stringify({ id: 777, html_url: "https://github.com/acme/demo/pull/10#c777" }), { status: 201 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const host = createFakePluginHost({
      pluginId: "ship",
      agentSkillIds: ["ship", "steward", "ship-approvals"],
      settings: { botLogin: "ship-bot", botToken: botSecret },
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "scanOutboundForLocalSecrets") return { ok: true, matchedSource: null };
        if (method === "stewardCommitAndPush") {
          return { ok: true, headSha: "d".repeat(40), committed: true, pushed: true, error: null };
        }
        if (method === "stewardRerunJob") return { ok: true, error: null };
        if (method === "stewardMergeBase") {
          return { ok: true, headSha: "e".repeat(40), pushed: true, noticePaths: [], reason: null };
        }
        return hostWorker.experimental_call(method as never, input as never);
      },
    });
    fakeHosts.push(host);

    const plugin = createShipPlugin({
      fetchImpl: mockFetch as typeof fetch,
      disableBackgroundPoller: true,
    });
    await plugin(host.bb);

    // 1) agents.configure scoping
    const userCfg = await host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: {} }),
    );
    expect(userCfg.tools).toEqual([]);
    expect(userCfg.skills).toEqual(["ship", "steward", "ship-approvals"]);

    const revCfg = await host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { shipRole: "reviewer" } }),
    );
    expect(revCfg.tools).toEqual([]);
    expect(revCfg.skills).toEqual([]);

    const workerCfg = await host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { shipRole: "steward-worker", watchId: "w_test" } }),
    );
    expect(workerCfg.tools.map((t) => t.name)).toEqual([...STEWARD_TOOL_NAMES]);
    expect(workerCfg.instructions).toContain("w_test");

    // 2) Non-worker thread calling tool is rejected
    const outsiderRes = await host.harness.callAgentTool("ship_steward_status", {}, { threadId: "thr_other" });
    expect((outsiderRes as { isError?: boolean }).isError).toBe(true);

    // Seed an active watch owned by thr_worker
    const store = new ShipStore(host.bb.storage.database());
    host.bb.storage.migrate(host.bb.storage.database(), MIGRATIONS);
    store.upsertRepo(
      { repo: "acme/demo", maxPushesPerCause: 3 },
      { reviewMode: "triad", reviewEffort: "high", maxPushesPerCause: 3 },
    );
    store.createWatch({
      id: "w_test",
      projectId: "proj_1",
      hostId: "host_1",
      worktreePath: "/tmp/wt",
      repo: "acme/demo",
      prNumber: 10,
      headBranch: "feat/demo",
      headRemote: "origin",
      baseBranch: "main",
      baseRemote: "origin",
      authorLogin: "danielcor",
      state: "working",
      lastHeadSha: "a".repeat(40),
      lastStateHash: null,
      startedAt: 1000,
      expiresAt: 10_000_000,
      lastWokeAt: 1000,
      workerThreadId: "thr_worker",
      pins: {},
      trustedBots: [],
      seenCommentIds: [],
      causePushCounts: {},
      rerunJobIds: [],
      behindMergesCount: 0,
      stopReason: null,
    });

    // 3) Rerun cap (1 per job)
    const rerun1 = await host.harness.callAgentTool("ship_steward_rerun_job", { jobId: 42 }, { threadId: "thr_worker" });
    expect((rerun1 as { isError?: boolean }).isError).toBeUndefined();
    const rerun2 = await host.harness.callAgentTool("ship_steward_rerun_job", { jobId: 42 }, { threadId: "thr_worker" });
    expect((rerun2 as { isError?: boolean }).isError).toBe(true);

    // 4) 3-push cap per cause
    for (let i = 0; i < 3; i++) {
      const res = await host.harness.callAgentTool(
        "ship_steward_commit_push",
        { files: ["src/a.ts"], commitMessage: `fix: step ${i + 1}`, causeKey: "check:ci" },
        { threadId: "thr_worker" },
      );
      expect((res as { isError?: boolean }).isError).toBeUndefined();
    }
    const push4 = await host.harness.callAgentTool(
      "ship_steward_commit_push",
      { files: ["src/a.ts"], commitMessage: "fix: step 4", causeKey: "check:ci" },
      { threadId: "thr_worker" },
    );
    expect((push4 as { isError?: boolean }).isError).toBe(true);

    // 5) 2-behind-merge cap
    for (let i = 0; i < 2; i++) {
      const m = await host.harness.callAgentTool(
        "ship_steward_merge_base",
        { expectedBaseSha: "f".repeat(40) },
        { threadId: "thr_worker" },
      );
      expect((m as { isError?: boolean }).isError).toBeUndefined();
    }
    const merge3 = await host.harness.callAgentTool(
      "ship_steward_merge_base",
      { expectedBaseSha: "f".repeat(40) },
      { threadId: "thr_worker" },
    );
    expect((merge3 as { isError?: boolean }).isError).toBe(true);

    // 6) Reply validation + marker prefix + seen comment tracking
    const badReply = await host.harness.callAgentTool(
      "ship_steward_reply_comment",
      { body: "Check https://evil.example @bob", commentId: "c1" },
      { threadId: "thr_worker" },
    );
    expect((badReply as { isError?: boolean }).isError).toBe(true);

    const okReply = await host.harness.callAgentTool(
      "ship_steward_reply_comment",
      { body: "Fixed the lint issue and updated tests.", commentId: "c1" },
      { threadId: "thr_worker" },
    );
    expect((okReply as { isError?: boolean }).isError).toBeUndefined();
    expect(postedComments[0]).toBe("<!-- cloudroom-ship -->\nFixed the lint issue and updated tests.");
    expect(store.getWatch("w_test")?.seenCommentIds).toContain("c1");

    // 7) Escalate sets needs_human & notifies
    const esc = await host.harness.callAgentTool(
      "ship_steward_escalate",
      { reason: "Needs manual conflict resolution." },
      { threadId: "thr_worker" },
    );
    expect((esc as { isError?: boolean }).isError).toBeUndefined();
    expect(store.getWatch("w_test")?.state).toBe("needs_human");
  });
});
