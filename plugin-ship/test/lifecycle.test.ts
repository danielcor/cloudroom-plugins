import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host.js";
import { createShipPlugin } from "../server.js";
import type { PollPrStateOutput } from "../src/contract.js";
import type { StewardPoller } from "../src/steward/poller.js";

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

describe("end-to-end PR Steward watch lifecycle", () => {
  it("runs terms -> steward -> poller wake -> fenced worker commit/push -> settled -> green ready -> pause/resume/stop", async () => {
    const base = await mkdtemp(join(tmpdir(), "ship-life-"));
    tempDirs.push(base);
    const repoDir = join(base, "work");
    const bareDir = join(base, "origin.git");

    await git(base, "init", "--bare", bareDir);
    await mkdir(repoDir, { recursive: true });
    await git(repoDir, "init", "-b", "main");
    await git(repoDir, "config", "user.name", "Daniel");
    await git(repoDir, "config", "user.email", "daniel@example.com");
    await writeFile(join(repoDir, "src.ts"), "export const val = 1;\n", "utf8");
    await git(repoDir, "add", "src.ts");
    await git(repoDir, "commit", "-m", "init");
    await git(repoDir, "remote", "add", "origin", bareDir);
    await git(repoDir, "push", "-u", "origin", "main");
    await git(repoDir, "checkout", "-b", "feat/life");
    await writeFile(join(repoDir, "src.ts"), "export const val = 2;\n", "utf8");
    await git(repoDir, "add", "src.ts");
    await git(repoDir, "commit", "-m", "feat");
    await git(repoDir, "push", "-u", "origin", "feat/life");

    const headSha1 = await git(repoDir, "rev-parse", "HEAD");
    const baseSha = await git(repoDir, "rev-parse", "main");

    let ciConclusion: "failure" | "success" = "failure";
    let currentPrHead = headSha1;

    const hostWorker = experimental_createHostEntryHarness(hostEntry);
    hostHarnesses.push(hostWorker);

    let pollerRef: StewardPoller | undefined;
    let clockMs = 10_000_000;
    const stoppedWorkerIds: string[] = [];

    const host = createFakePluginHost({
      pluginId: "ship",
      agentSkillIds: ["ship", "steward"],
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
        threads: {
          get: async () => ({ id: "thr_parent", projectId: "proj_1", environmentId: null }) as never,
          spawn: async (args) => {
            const thread = makeThreadResponse({
              id: "thr_stew_worker",
              projectId: args.projectId,
              createdAt: Date.now(),
            });
            return thread;
          },
          stop: async ({ threadId }) => {
            stoppedWorkerIds.push(threadId);
            return { ok: true, status: "idle" } as never;
          },
          archive: async () => ({ ok: true } as never),
        },
      },
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "inspectPublishContext") {
          return {
            inspection: await hostWorker.experimental_call("inspectCheckout", { root: repoDir }),
            remoteName: "origin",
            remoteUrl: "git@github.com:acme/demo.git",
            repoMeta: {
              slug: "acme/demo",
              owner: "acme",
              name: "demo",
              defaultBranch: "main",
              isPrivate: true,
              isFork: false,
              parentSlug: null,
              viewerLogin: "danielcor",
              viewerPermission: "write",
            },
            existingPr: {
              number: 88,
              url: "https://github.com/acme/demo/pull/88",
              title: "Lifecycle test",
              state: "OPEN",
              isDraft: false,
              headRefName: "feat/life",
              headRefOid: currentPrHead,
              baseRefName: "main",
              baseRefOid: baseSha,
              authorLogin: "danielcor",
              labels: [],
              mergeStateStatus: "CLEAN",
              isCrossRepository: false,
            },
            aheadCount: 1,
            commitSubjects: ["feat"],
            diffText: "",
            diffSecretFinding: null,
            localSecretMatchSource: null,
          };
        }
        if (method === "pollPrState") {
          const out: PollPrStateOutput = {
            discussion: {
              pr: {
                number: 88,
                url: "https://github.com/acme/demo/pull/88",
                title: "Lifecycle test",
                body: "",
                mayHideBody: false,
                state: "OPEN",
                isDraft: false,
                headRefName: "feat/life",
                headRefOid: currentPrHead,
                baseRefName: "main",
                baseRefOid: baseSha,
                authorLogin: "danielcor",
                labels: [],
                mergeStateStatus: "CLEAN",
              },
              items: [],
              excludedCount: 0,
              truncatedCount: 0,
              droppedForBudgetCount: 0,
              collisionLabels: [],
            },
            checkRuns: [
              { id: 1001, name: "Vitest", status: "completed", conclusion: ciConclusion, detailsUrl: null },
            ],
          };
          return out;
        }
        return hostWorker.experimental_call(method as never, input as never);
      },
    });
    fakeHosts.push(host);

    const plugin = createShipPlugin({
      nowMs: () => clockMs,
      disableBackgroundPoller: true,
      onPollerReady: (p) => {
        pollerRef = p;
      },
    });
    await plugin(host.bb);

    // 1) Steward refuses until terms accepted
    const noTerms = await host.harness.runCli(["steward", "--json"], { projectId: "proj_1" });
    expect(noTerms.exitCode).toBe(1);

    const acceptRes = await host.harness.runCli(["terms", "--accept", "--json"]);
    expect(acceptRes.exitCode).toBe(0);
    expect(JSON.parse(acceptRes.stdout)).toMatchObject({ accepted: true });

    // 2) Start steward watch
    const startRes = await host.harness.runCli(["steward", "--repo", "acme/demo", "--pr", "88", "--json"], {
      projectId: "proj_1",
    });
    expect(startRes.exitCode).toBe(0);
    const { watch } = JSON.parse(startRes.stdout) as { watch: { id: string; state: string } };
    expect(watch.state).toBe("watching");

    // 3) First poller tick detects failing check -> spawns fenced worker
    const t1 = await pollerRef!.tickOnce(clockMs);
    expect(t1.woken).toBe(1);

    // 4) Worker edits file and pushes via fenced `ship_steward_commit_push`
    await writeFile(join(repoDir, "src.ts"), "export const val = 3;\n", "utf8");
    const pushRes = await host.harness.callAgentTool(
      "ship_steward_commit_push",
      { files: ["src.ts"], commitMessage: "fix: repair failing vitest check", causeKey: "check:vitest" },
      { threadId: "thr_stew_worker", projectId: "proj_1" },
    );
    expect((pushRes as { isError?: boolean }).isError).toBeUndefined();
    currentPrHead = await git(repoDir, "rev-parse", "HEAD");
    expect(currentPrHead).not.toBe(headSha1);

    // 5) Worker settles -> watch returns to watching; CI turns green -> Ready + notification
    await host.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_stew_worker", projectId: "proj_1", createdAt: Date.now() }),
      lastAssistantText: "Pushed fix.",
    });
    ciConclusion = "success";
    const t2 = await pollerRef!.tickOnce(clockMs + 1000);
    expect(t2.ready).toBe(1);
    expect(host.harness.inspection.realtimeSignals.some((m) => m.channel === "notifications")).toBe(true);

    // 6) Pause, resume, and stop via CLI
    expect((await host.harness.runCli(["pause", watch.id, "--json"])).exitCode).toBe(0);
    expect(JSON.parse((await host.harness.runCli(["watches", "--state", "paused", "--json"])).stdout)).toHaveLength(1);
    expect((await host.harness.runCli(["resume", watch.id, "--json"])).exitCode).toBe(0);
    expect((await host.harness.runCli(["stop", watch.id, "--json"])).exitCode).toBe(0);

    const activeWatches = await host.harness.runCli(["watches", "--json"]);
    expect(JSON.parse(activeWatches.stdout)).toHaveLength(0);
    expect(stoppedWorkerIds).toEqual([]);
  });
});
