import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host.js";
import shipPlugin from "../server.js";

const execFileAsync = promisify(execFile);
const fakeHosts: ReturnType<typeof createFakePluginHost>[] = [];
const hostHarnesses: ReturnType<typeof experimental_createHostEntryHarness>[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const h of fakeHosts.splice(0)) await h.harness.dispose();
  for (const h of hostHarnesses.splice(0)) await h.experimental_dispose();
  for (const d of tempDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

describe("ship server plugin", () => {
  it("registers settings, SQLite schema, RPC, and CLI without exposing botToken", async () => {
    const fakeToken = ["github_pat_", "fake_secret_token_1234567890"].join("");
    const host = createFakePluginHost({
      pluginId: "ship",
      settings: {
        botLogin: "cloudroom-ship-bot",
        botToken: fakeToken,
      },
    });
    fakeHosts.push(host);
    await shipPlugin(host.bb);

    expect([...host.harness.inspection.registrations.rpcMethods].sort()).toEqual([
      "listAudit",
      "listRepos",
      "listWatches",
      "status",
      "upsertRepo",
    ]);

    const status = (await host.harness.callRpc("status", {})) as Record<string, unknown>;
    expect(status).toEqual({
      pluginVersion: "0.1.0",
      botConfigured: true,
      botLogin: "cloudroom-ship-bot",
      defaultReviewMode: "triad",
      defaultReviewEffort: "high",
      pollIntervalSeconds: 120,
      watchMaxDays: 7,
      defaultMaxPushesPerCause: 3,
      repoCount: 0,
      activeWatchCount: 0,
    });
    expect(JSON.stringify(status)).not.toContain(fakeToken);

    const cliStatus = await host.harness.runCli(["status", "--json"]);
    expect(cliStatus.exitCode).toBe(0);
    expect(cliStatus.stdout).not.toContain(fakeToken);
    expect(JSON.parse(cliStatus.stdout)).toMatchObject({ botConfigured: true, defaultReviewMode: "triad" });
  });

  it("persists repository configs across CLI and RPC and records audit logs", async () => {
    const host = createFakePluginHost({ pluginId: "ship" });
    fakeHosts.push(host);
    await shipPlugin(host.bb);

    const setRes = await host.harness.runCli([
      "repos",
      "set",
      "danielcor/cloudroom-plugins",
      "--review-mode",
      "sol-loop",
      "--effort",
      "max",
      "--auto-steward",
      "auto",
      "--approvals",
      "enforce",
      "--max-pushes",
      "5",
      "--json",
    ]);
    expect(setRes.exitCode).toBe(0);
    expect(JSON.parse(setRes.stdout)).toMatchObject({
      repo: "danielcor/cloudroom-plugins",
      reviewMode: "sol-loop",
      reviewEffort: "max",
      autoSteward: "auto",
      approvalsMode: "enforce",
      maxPushesPerCause: 5,
    });

    const listRes = await host.harness.runCli(["repos", "list"]);
    expect(listRes.exitCode).toBe(0);
    expect(listRes.stdout).toContain("danielcor/cloudroom-plugins");
    expect(listRes.stdout).toContain("review=sol-loop:max");

    const audit = (await host.harness.callRpc("listAudit", {})) as Array<{ action: string }>;
    expect(audit[0]?.action).toBe("repo.set");
  });

  it("bridges room-cli ship safety-check to the host entry and flags dirty secret/never-edit files", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "ship-srv-"));
    tempDirs.push(repoDir);
    await git(repoDir, "init", "-b", "main");
    await git(repoDir, "config", "user.name", "Test Author");
    await git(repoDir, "config", "user.email", "test@example.com");
    await writeFile(join(repoDir, "src.ts"), "export const ok = true;\n", "utf8");
    await git(repoDir, "add", "src.ts");
    await git(repoDir, "commit", "-m", "init");
    await writeFile(join(repoDir, ".env"), "SECRET=abc123456\n", "utf8");
    await writeFile(join(repoDir, "CLAUDE.md"), "# rules\n", "utf8");

    const hostWorker = experimental_createHostEntryHarness(hostEntry);
    hostHarnesses.push(hostWorker);

    const host = createFakePluginHost({
      pluginId: "ship",
      sdk: {
        hosts: {
          list: async () => [{ id: "host_aipc", name: "aipc-ubuntu" }] as never,
        },
        projects: {
          get: async () =>
            ({
              id: "proj_1",
              name: "demo",
              kind: "standard",
              sources: [{ id: "src_1", projectId: "proj_1", hostId: "host_aipc", path: repoDir, isDefault: true }],
            }) as never,
        },
      },
      experimental_callHostRpc: ({ method, input, signal }) =>
        hostWorker.experimental_call(method as never, input as never, { signal }),
    });
    fakeHosts.push(host);
    await shipPlugin(host.bb);

    const check = await host.harness.runCli(["safety-check", "--json"], { projectId: "proj_1" });
    expect(check.exitCode).toBe(0);
    const parsed = JSON.parse(check.stdout);
    expect(parsed.hostId).toBe("host_aipc");
    expect(parsed.neverEditFiles).toEqual(expect.arrayContaining([".env", "CLAUDE.md"]));
    expect(parsed.secretFiles).toContain(".env");
    expect(parsed.pinsOk).toBe(true);
    expect(parsed.pinCount).toBeGreaterThan(0);
  });
});
