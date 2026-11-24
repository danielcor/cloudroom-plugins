import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry, { inspectReviewContextAt } from "../host.js";
import { createShipPlugin } from "../server.js";
import {
  isSafeReadOnlyReviewCommand,
  mergeSeatFindings,
  parseReviewReply,
  ReviewerGatekeeper,
  type ShipPendingInteraction,
} from "../src/review/types.js";

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

const HEAD = "c".repeat(40);
const BASE = "a".repeat(40);

describe("parseReviewReply, mergeSeatFindings & ReviewerGatekeeper", () => {
  it("validates Triad and Sol-loop formats, score bands, and merges overlapping findings", () => {
    expect(
      parseReviewReply(
        [
          `HEAD: ${HEAD}`,
          "CONTEXT: diff-only",
          "VERDICT: APPROVE",
          "SCORE: 10/10",
        ].join("\n"),
        { expectedHeadSha: HEAD, allowedContexts: ["checkout", "diff-only"] },
      ),
    ).toMatchObject({ ok: true, verdict: "APPROVE", score: 10, findings: [] });

    // Reject disallowed checkout context, mismatched HEAD, APPROVE with finding, wrong score band
    expect(
      parseReviewReply(`HEAD: ${HEAD}\nCONTEXT: checkout\nVERDICT: APPROVE\nSCORE: 10/10`, {
        expectedHeadSha: HEAD,
        allowedContexts: ["diff-only"],
      }).ok,
    ).toBe(false);

    expect(
      parseReviewReply(
        `HEAD: ${HEAD}\nCONTEXT: diff-only\nVERDICT: APPROVE\nSCORE: 10/10\nF1 [NIT] a.ts:1 Unused var. Evidence: x. Fix: remove x`,
        { expectedHeadSha: HEAD, allowedContexts: ["diff-only"] },
      ).ok,
    ).toBe(false);

    expect(
      parseReviewReply(
        `HEAD: ${HEAD}\nCONTEXT: diff-only\nVERDICT: CHANGES\nSCORE: 9/10\nF1 [BLOCKER] a.ts:1 Null crash. Evidence: x. Fix: guard x`,
        { expectedHeadSha: HEAD, allowedContexts: ["diff-only"] },
      ).ok,
    ).toBe(false);

    const solNit = parseReviewReply(
      `HEAD: ${HEAD}\nVERDICT: CHANGES\nS1 [nit] src/a.ts:10 Rename helper foo to parseConfig. Fix: rename helper`,
      { expectedHeadSha: HEAD, allowedContexts: ["checkout", "diff-only"], allowSolFormat: true, requireContext: false },
    );
    expect(solNit).toMatchObject({
      ok: true,
      verdict: "CHANGES",
      findings: [{ id: "S1", severity: "NIT", file: "src/a.ts", line: 10 }],
    });

    // Deduplicate same-area findings and keep highest severity
    const merged = mergeSeatFindings([
      {
        seatName: "gpt",
        family: "gpt",
        providerId: "codex",
        model: "gpt-6.2-sol",
        reasoningLevel: "high",
        hostId: "h1",
        context: "checkout",
        ok: true,
        attempts: 1,
        verdict: "CHANGES",
        score: 4,
        findings: [
          {
            id: "F1",
            severity: "BLOCKER",
            file: "./src/order.ts",
            line: 42,
            claim: "Order validation allows negative quantity without balance check",
            evidence: "if (qty) ...",
            fix: "Check qty > 0",
          },
        ],
        error: null,
        threadIds: [],
        environmentIds: [],
      },
      {
        seatName: "claude",
        family: "claude",
        providerId: "claude-code",
        model: "claude-opus-5-5",
        reasoningLevel: "high",
        hostId: "h1",
        context: "diff-only",
        ok: true,
        attempts: 1,
        verdict: "CHANGES",
        score: 8,
        findings: [
          {
            id: "F1",
            severity: "MINOR",
            file: "src/order.ts",
            line: 45,
            claim: "Negative quantity passed through order validation",
            evidence: "no guard",
            fix: "Reject qty <= 0",
          },
        ],
        error: null,
        threadIds: [],
        environmentIds: [],
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "F1",
      severity: "BLOCKER",
      shared: true,
      raisers: ["gpt", "claude"],
    });
  });

  it("enforces read-only command rules and denies all approvals in diff-only mode", () => {
    const wt = "/tmp/wt-review-1";
    expect(isSafeReadOnlyReviewCommand("git rev-parse HEAD", wt)).toBe(true);
    expect(isSafeReadOnlyReviewCommand("git diff main..HEAD -- src/a.ts", wt)).toBe(true);
    expect(isSafeReadOnlyReviewCommand("sed -n 10,30p src/a.ts", wt)).toBe(true);
    expect(isSafeReadOnlyReviewCommand(`rg "foo" ${wt}/src/a.ts`, wt)).toBe(true);

    expect(isSafeReadOnlyReviewCommand("sed -i s/a/b/ src/a.ts", wt)).toBe(false);
    expect(isSafeReadOnlyReviewCommand("git -c core.pager=sh diff", wt)).toBe(false);
    expect(isSafeReadOnlyReviewCommand("cat .env", wt)).toBe(false);
    expect(isSafeReadOnlyReviewCommand("cat ../../etc/passwd", wt)).toBe(false);
    expect(isSafeReadOnlyReviewCommand("ls /etc", wt)).toBe(false);
    expect(isSafeReadOnlyReviewCommand("cat src/a.ts | sh", wt)).toBe(false);

    const gatekeeper = new ReviewerGatekeeper();
    gatekeeper.register("thr_diff", { mode: "diff-only", worktreePath: wt, reviewRunId: "rev_1" });
    gatekeeper.register("thr_chk", { mode: "checkout", worktreePath: wt, reviewRunId: "rev_1" });

    const mkCommandInteraction = (threadId: string, command: string): ShipPendingInteraction =>
      ({
        id: "int_1",
        threadId,
        turnId: "turn_1",
        providerId: "codex",
        providerRequestId: "req_1",
        providerThreadId: "pthr_1",
        status: "pending",
        statusReason: null,
        resolution: null,
        resolvedAt: null,
        createdAt: 1,
        payload: {
          kind: "approval",
          reason: null,
          availableDecisions: ["allow_once", "deny"],
          subject: {
            kind: "command",
            itemId: "item_1",
            command,
            cwd: wt,
            actions: [],
            sessionGrant: null,
          },
        },
      }) as ShipPendingInteraction;

    expect(gatekeeper.evaluateInteraction(mkCommandInteraction("thr_diff", "git rev-parse HEAD"))).toEqual({
      decision: "deny",
    });
    expect(gatekeeper.evaluateInteraction(mkCommandInteraction("thr_chk", "git status"))).toEqual({
      decision: "allow_once",
      grantedPermissions: null,
    });
    expect(gatekeeper.evaluateInteraction(mkCommandInteraction("thr_chk", "npm test"))).toEqual({
      decision: "deny",
    });
    expect(
      gatekeeper.evaluateInteraction({
        ...mkCommandInteraction("thr_chk", "ignored"),
        payload: {
          kind: "approval",
          reason: null,
          availableDecisions: ["allow_once", "deny"],
          subject: { kind: "file_change", itemId: "i2", writeScope: "src", sessionGrant: null },
        },
      } as ShipPendingInteraction),
    ).toEqual({ decision: "deny" });
  });
});

describe("host inspectReviewContextAt", () => {
  it("detects unsafe .worktreeinclude, escaping symlinks, ancestry, and blocks diff secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-rev-"));
    tempDirs.push(dir);
    await git(dir, "init", "-b", "main");
    await git(dir, "config", "user.name", "Reviewer");
    await git(dir, "config", "user.email", "rev@example.com");
    await git(dir, "remote", "add", "origin", "https://github.com/acme/demo.git");
    await writeFile(join(dir, "app.ts"), "export const a = 1;\n", "utf8");
    await git(dir, "add", "app.ts");
    await git(dir, "commit", "-m", "base");
    const mainSha = await git(dir, "rev-parse", "HEAD");

    await git(dir, "checkout", "-b", "feat/risk");
    await writeFile(join(dir, ".worktreeinclude"), ".env.local\n", "utf8");
    await symlink("/etc/passwd", join(dir, "escape-link"));
    await writeFile(join(dir, "app.ts"), "export const a = 2;\n", "utf8");
    await git(dir, "add", ".worktreeinclude", "escape-link", "app.ts");
    await git(dir, "commit", "-m", "risky worktree");

    const inspected = await inspectReviewContextAt({ root: dir, baseRef: "main", priorReviewedSha: mainSha });
    expect(inspected.repoSlug).toBe("acme/demo");
    expect(inspected.baseSha).toBe(mainSha);
    expect(inspected.priorReviewedIsAncestor).toBe(true);
    expect(inspected.unsafeWorktreeHooks).toBe(true);
    expect(inspected.worktreeHookReason).toContain(".worktreeinclude");
    expect(inspected.hasEscapingSymlinks).toBe(true);
    expect(inspected.symlinkReason).toContain("/etc/passwd");
    expect(inspected.secretBlockedReason).toBeNull();

    // Commit a secret token -> secretBlockedReason triggers and diffText is cleared
    const fakeSecret = ["ghp_", "0123456789abcdef0123456789abcdef0123"].join("");
    await writeFile(join(dir, "leak.ts"), `export const tok = "${fakeSecret}";\n`, "utf8");
    await git(dir, "add", "leak.ts");
    await git(dir, "commit", "-m", "leak");
    const blocked = await inspectReviewContextAt({ root: dir, baseRef: "main" });
    expect(blocked.secretBlockedReason).toContain("GitHub token");
    expect(blocked.diffText).toBe("");
  });
});

describe("end-to-end ship review CLI across triad, sol-loop, and single --post", () => {
  it("runs triad retries, finding merging, INCOMPLETE checks, cleanup, sol-loop triggers, and single bot posting", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "ship-rev-e2e-"));
    tempDirs.push(repoDir);
    await git(repoDir, "init", "-b", "main");
    await git(repoDir, "config", "user.name", "Author");
    await git(repoDir, "config", "user.email", "author@example.com");
    await git(repoDir, "remote", "add", "origin", "https://github.com/acme/demo.git");
    await writeFile(join(repoDir, "src.ts"), "export const x = 1;\n", "utf8");
    await git(repoDir, "add", "src.ts");
    await git(repoDir, "commit", "-m", "base");

    await git(repoDir, "checkout", "-b", "feat/review");
    await writeFile(join(repoDir, "src.ts"), "export const x = 2;\nexport const y = 3;\n", "utf8");
    await git(repoDir, "add", "src.ts");
    await git(repoDir, "commit", "-m", "feat");
    const headSha = await git(repoDir, "rev-parse", "HEAD");
    await writeFile(join(repoDir, ".env"), "LOCAL_KEY=local_secret_987654\n", "utf8");

    const hostWorker = experimental_createHostEntryHarness(hostEntry);
    hostHarnesses.push(hostWorker);

    const botSecret = ["github_pat_", "rev_secret_1234567890abcdef"].join("");
    const postedReviews: Array<{ url: string; body: Record<string, unknown> }> = [];
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const s = String(url);
      if (s.includes("/check-runs")) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      if (s.endsWith("/graphql")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  number: 15,
                  url: "https://github.com/acme/demo/pull/15",
                  title: "Feat review",
                  body: "",
                  state: "OPEN",
                  isDraft: false,
                  headRefName: "feat/review",
                  headRefOid: headSha,
                  baseRefName: "main",
                  baseRefOid: BASE,
                  author: { login: "author" },
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
      if (s.endsWith("/pulls/15/reviews")) {
        postedReviews.push({ url: s, body: JSON.parse(String(init?.body ?? "{}")) });
        return new Response(JSON.stringify({ id: 888, state: "CHANGES_REQUESTED" }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const stoppedThreads: string[] = [];
    const archivedThreads: string[] = [];
    const deletedEnvs: string[] = [];
    const resolvedInteractions: Array<{ threadId: string; resolution: unknown }> = [];
    const spawnedPrompts: Array<{ threadId: string; providerId?: string; prompt: string }> = [];
    let spawnSeq = 0;

    // Scripted seat queue driven per spawned child thread
    let replyScript: (meta: { seq: number; providerId?: string; prompt: string }) => Promise<{
      outcome: "completed" | "failed";
      text?: string;
      error?: string;
      sendWriteInteraction?: boolean;
    }>;

    const fakeHost = createFakePluginHost({
      pluginId: "ship",
      settings: {
        botLogin: "ship-bot",
        botToken: botSecret,
      },
      sdk: {
        hosts: { list: async () => [{ id: "host_1", name: "aipc-ubuntu" }] as never },
        projects: {
          get: async () =>
            ({
              id: "proj_1",
              name: "demo",
              kind: "standard",
              sources: [{ id: "s1", projectId: "proj_1", hostId: "host_1", path: repoDir, isDefault: true }],
            }) as never,
        },
        environments: {
          get: async ({ environmentId }) => ({ id: environmentId, hostId: "host_1", path: repoDir }) as never,
          delete: async ({ environmentId }) => {
            deletedEnvs.push(environmentId);
            return { ok: true } as never;
          },
        },
        threads: {
          get: async () => ({ id: "thr_parent", projectId: "proj_1", environmentId: "env_parent" }) as never,
          spawn: async (args) => {
            const seq = ++spawnSeq;
            const threadId = `thr_child_${seq}`;
            const envId = args.environment.type === "host" ? `env_child_${seq}` : null;
            const thread = makeThreadResponse({
              id: threadId,
              projectId: args.projectId,
              environmentId: envId,
              createdAt: Date.now(),
            });
            const promptText = args.prompt ?? "";
            spawnedPrompts.push({ threadId, providerId: args.providerId, prompt: promptText });

            void (async () => {
              const scripted = await replyScript({ seq, providerId: args.providerId, prompt: promptText });
              if (scripted.sendWriteInteraction) {
                await fakeHost.harness.emitThreadEvent("interaction.pending", {
                  thread,
                  interaction: {
                    id: `int_${seq}`,
                    threadId,
                    turnId: "turn_1",
                    providerId: args.providerId ?? "codex",
                    providerRequestId: `preq_${seq}`,
                    providerThreadId: `pthr_${seq}`,
                    status: "pending",
                    statusReason: null,
                    resolution: null,
                    resolvedAt: null,
                    createdAt: 1001 + seq,
                    payload: {
                      kind: "approval",
                      reason: null,
                      availableDecisions: ["allow_once", "deny"],
                      subject: { kind: "file_change", itemId: "fc1", writeScope: "src", sessionGrant: null },
                    },
                  } as never,
                });
              }
              if (scripted.outcome === "completed") {
                await fakeHost.harness.emitThreadEvent("thread.idle", {
                  thread,
                  lastAssistantText: scripted.text ?? null,
                });
              } else {
                await fakeHost.harness.emitThreadEvent("thread.failed", {
                  thread,
                  error: scripted.error ?? "boom",
                });
              }
            })();

            return thread;
          },
          stop: async ({ threadId }) => {
            stoppedThreads.push(threadId);
            return { ok: true, status: "idle" } as never;
          },
          archive: async ({ threadId }) => {
            archivedThreads.push(threadId);
            return { ok: true } as never;
          },
          interactions: {
            resolve: async (args) => {
              resolvedInteractions.push({ threadId: args.threadId, resolution: args.resolution });
              return {} as never;
            },
          },
        },
      },
      experimental_callHostRpc: ({ method, input }) => hostWorker.experimental_call(method as never, input as never),
    });
    fakeHosts.push(fakeHost);

    const plugin = createShipPlugin({
      fetchImpl: mockFetch as typeof fetch,
      execDispatch: async () => ({ code: 1, stdout: "", stderr: "fallback" }),
      seatTimeoutMs: 5000,
    });
    await plugin(fakeHost.bb);

    // 1) Triad review: codex attempt 1 writes unparseable prose -> retried in tool-free diff-only + write attempt denied;
    //    claude & gemini raise an overlapping finding on src.ts:2 (BLOCKER + NIT -> merged shared BLOCKER).
    let codexCalls = 0;
    replyScript = async ({ providerId, prompt }) => {
      if (providerId === "codex") {
        codexCalls += 1;
        if (codexCalls === 1) {
          return { outcome: "completed", text: "Here are my thoughts without headers", sendWriteInteraction: true };
        }
        expect(prompt).toContain("Tool-free mode");
        return {
          outcome: "completed",
          text: `HEAD: ${headSha}\nCONTEXT: diff-only\nVERDICT: APPROVE\nSCORE: 10/10`,
        };
      }
      if (providerId === "claude-code") {
        return {
          outcome: "completed",
          text: [
            `HEAD: ${headSha}`,
            "CONTEXT: checkout",
            "VERDICT: CHANGES",
            "SCORE: 3/10",
            "F1 [BLOCKER] src.ts:2 Missing validation on exported constant y. Evidence: export const y = 3. Fix: validate y",
          ].join("\n"),
        };
      }
      return {
        outcome: "completed",
        text: [
          `HEAD: ${headSha}`,
          "CONTEXT: diff-only",
          "VERDICT: CHANGES",
          "SCORE: 8/10",
          "F1 [NIT] src.ts:2 Exported constant y lacks validation. Evidence: y = 3. Fix: validate constant y",
        ].join("\n"),
      };
    };

    const triadRes = await fakeHost.harness.runCli(["review", "--mode", "triad", "--json"], {
      projectId: "proj_1",
      threadId: "thr_parent",
    });
    expect(triadRes.exitCode).toBe(0);
    const triadParsed = JSON.parse(triadRes.stdout);
    expect(triadParsed).toMatchObject({
      status: "completed",
      mode: "triad",
      verdict: "CHANGES",
      validSeats: 3,
      targetSeats: 3,
    });
    expect(triadParsed.findings).toHaveLength(1);
    expect(triadParsed.findings[0]).toMatchObject({
      id: "F1",
      severity: "BLOCKER",
      shared: true,
      raisers: ["claude", "gemini"],
    });
    expect(resolvedInteractions).toContainEqual({ threadId: "thr_child_1", resolution: { decision: "deny" } });
    // All 4 spawned child threads (3 attempt1 + 1 retry) were stopped, archived, and had environments deleted!
    expect(stoppedThreads).toHaveLength(4);
    expect(archivedThreads).toHaveLength(4);
    expect(deletedEnvs).toHaveLength(4);

    // 2) Triad INCOMPLETE when fewer than 3 seats succeed
    replyScript = async ({ providerId }) => {
      if (providerId === "codex") {
        return { outcome: "completed", text: `HEAD: ${headSha}\nCONTEXT: diff-only\nVERDICT: APPROVE\nSCORE: 10/10` };
      }
      return { outcome: "failed", error: "provider down" };
    };
    const incRes = await fakeHost.harness.runCli(["review", "--mode", "triad", "--force", "--json"], {
      projectId: "proj_1",
      threadId: "thr_parent",
    });
    expect(JSON.parse(incRes.stdout)).toMatchObject({
      verdict: "INCOMPLETE",
      validSeats: 1,
      targetSeats: 3,
    });

    // 3) Sol-loop: clean APPROVE when 0 findings; round3_blocker stop trigger verified
    replyScript = async () => ({
      outcome: "completed",
      text: `HEAD: ${headSha}\nCONTEXT: checkout\nVERDICT: APPROVE\nSCORE: 10/10`,
    });
    const solOk = await fakeHost.harness.runCli(["review", "--mode", "sol-loop", "--round", "1", "--json"], {
      projectId: "proj_1",
      threadId: "thr_parent",
    });
    expect(JSON.parse(solOk.stdout)).toMatchObject({
      mode: "sol-loop",
      verdict: "APPROVE",
      stopTrigger: null,
    });

    replyScript = async () => ({
      outcome: "completed",
      text: `HEAD: ${headSha}\nVERDICT: CHANGES\nS1 [blocker] src.ts:2 Persistent crash in src. Fix: guard src`,
    });
    const solStop = await fakeHost.harness.runCli(["review", "--mode", "sol-loop", "--round", "3", "--force", "--json"], {
      projectId: "proj_1",
      threadId: "thr_parent",
    });
    expect(JSON.parse(solStop.stdout)).toMatchObject({
      mode: "sol-loop",
      verdict: "CHANGES",
      stopTrigger: "round3_blocker",
    });

    // 4) Single mode with --pr 15 --post: posts marker-tagged bot review, drops uncommitted file inline finding, hides botToken
    replyScript = async () => ({
      outcome: "completed",
      text: [
        `HEAD: ${headSha}`,
        "CONTEXT: checkout",
        "VERDICT: CHANGES",
        "SCORE: 6/10",
        "F1 [MAJOR] src.ts:2 Committed line issue with URL https://ignored.example and @bob. Evidence: x. Fix: fix src",
        "F2 [MINOR] .env:1 Never leak this uncommitted path inline. Evidence: env. Fix: ignore",
      ].join("\n"),
    });
    const singlePost = await fakeHost.harness.runCli(
      ["review", "--mode", "single", "--repo", "acme/demo", "--pr", "15", "--post", "--force", "--json"],
      { projectId: "proj_1", threadId: "thr_parent" },
    );
    expect(singlePost.exitCode).toBe(0);
    expect(singlePost.stdout).not.toContain(botSecret);
    expect(JSON.parse(singlePost.stdout)).toMatchObject({
      status: "completed",
      mode: "single",
      postedReviewId: 888,
      postError: null,
    });
    expect(postedReviews).toHaveLength(1);
    const postedBody = postedReviews[0]!.body;
    expect(String(postedBody.body)).toContain(`<!-- cloudroom-ship reviewed=${headSha} -->`);
    expect(postedBody.event).toBe("REQUEST_CHANGES");
    // Only src.ts (committed) gets an inline comment, NOT .env! And URL / @mention were stripped cleanly.
    expect(postedBody.comments).toEqual([
      expect.objectContaining({
        path: "src.ts",
        line: 2,
      }),
    ]);
  });
});
