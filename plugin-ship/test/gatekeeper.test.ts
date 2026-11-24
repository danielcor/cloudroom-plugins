import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, ShipStore } from "../src/db.js";
import type { ShipPendingInteraction } from "../src/review/types.js";
import { isAllowedStewardWorkerCommand, StewardWorkerGatekeeper } from "../src/steward/gatekeeper.js";

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function createStore(): ShipStore {
  const db = new Database(":memory:");
  dbs.push(db);
  for (const stmt of MIGRATIONS) db.exec(stmt);
  return new ShipStore(db);
}

describe("StewardWorkerGatekeeper & command firewall", () => {
  it("blocks git, gh, network tools, pipes, env files, never-edit paths, and outside paths while allowing safe builds/tests", () => {
    const wt = "/tmp/wt-steward-1";

    expect(isAllowedStewardWorkerCommand("npm test", wt)).toBe(true);
    expect(isAllowedStewardWorkerCommand("npx vitest run test/foo.test.ts", wt)).toBe(true);
    expect(isAllowedStewardWorkerCommand("cargo test --lib", wt)).toBe(true);
    expect(isAllowedStewardWorkerCommand("dotnet test src/My.Tests.csproj", wt)).toBe(true);
    expect(isAllowedStewardWorkerCommand("sed -n 1,25p src/index.ts", wt)).toBe(true);

    expect(isAllowedStewardWorkerCommand("git push origin main", wt)).toBe(false);
    expect(isAllowedStewardWorkerCommand("gh pr comment 10", wt)).toBe(false);
    expect(isAllowedStewardWorkerCommand("curl https://evil.example", wt)).toBe(false);
    expect(isAllowedStewardWorkerCommand("ssh aipc-ubuntu ls", wt)).toBe(false);
    expect(isAllowedStewardWorkerCommand("npm install malicious-pkg", wt)).toBe(false);
    expect(isAllowedStewardWorkerCommand("npm test && curl https://x", wt)).toBe(false);
    expect(isAllowedStewardWorkerCommand("cat .env", wt)).toBe(false);
    expect(isAllowedStewardWorkerCommand("cat ../../etc/passwd", wt)).toBe(false);
    expect(isAllowedStewardWorkerCommand("cat /etc/passwd", wt)).toBe(false);
    expect(isAllowedStewardWorkerCommand("sed -i s/a/b/ src/index.ts", wt)).toBe(false);
    expect(isAllowedStewardWorkerCommand("sed -n '1e id' src/index.ts", wt)).toBe(false);
    expect(isAllowedStewardWorkerCommand("pytest --rootdir=/etc", wt)).toBe(false);
    expect(isAllowedStewardWorkerCommand("vitest --env-file=.env", wt)).toBe(false);
  });

  it("enforces file_change, tool_use, command, and permission_grant policies on worker threads while ignoring others", () => {
    const store = createStore();
    store.createWatch({
      id: "w_gate",
      projectId: "proj_1",
      hostId: "host_1",
      worktreePath: "/tmp/wt-steward-1",
      repo: "acme/demo",
      prNumber: 7,
      headBranch: "feat/fix",
      headRemote: "origin",
      baseBranch: "main",
      baseRemote: "origin",
      authorLogin: "danielcor",
      state: "working",
      lastHeadSha: "a".repeat(40),
      lastStateHash: null,
      startedAt: 100,
      expiresAt: 9_000_000,
      lastWokeAt: 100,
      workerThreadId: "thr_worker_1",
      pins: {},
      trustedBots: [],
      seenCommentIds: [],
      causePushCounts: {},
      rerunJobIds: [],
      behindMergesCount: 0,
      stopReason: null,
    });

    const gk = new StewardWorkerGatekeeper(store);
    const makeInteraction = (threadId: string, subject: unknown): ShipPendingInteraction =>
      ({
        id: "int_1",
        threadId,
        turnId: "t1",
        providerId: "codex",
        providerRequestId: "pr1",
        providerThreadId: "pt1",
        status: "pending",
        statusReason: null,
        resolution: null,
        resolvedAt: null,
        createdAt: 1,
        payload: {
          kind: "approval",
          reason: null,
          availableDecisions: ["allow_once", "deny"],
          subject,
        },
      }) as ShipPendingInteraction;

    // Non-worker thread -> null (ignored)
    expect(gk.evaluateInteraction(makeInteraction("thr_user", { kind: "permission_grant" }))).toBeNull();

    // permission_grant / plan -> denied
    expect(
      gk.evaluateInteraction(makeInteraction("thr_worker_1", { kind: "permission_grant", itemId: "1", toolName: "bash", permissions: { fileSystem: null, network: null } })),
    ).toEqual({ decision: "deny" });
    expect(
      gk.evaluateInteraction(makeInteraction("thr_worker_1", { kind: "plan", itemId: "2", plan: "x", planFilePath: null })),
    ).toEqual({ decision: "deny" });

    // file_change: src allowed; .github/workflows/ci.yml, CLAUDE.md, .env, outside -> denied
    expect(
      gk.evaluateInteraction(makeInteraction("thr_worker_1", { kind: "file_change", itemId: "3", writeScope: "src/fix.ts", sessionGrant: null })),
    ).toEqual({ decision: "allow_once", grantedPermissions: null });
    for (const blocked of [".github/workflows/ci.yml", "CLAUDE.md", ".env", "/etc/hosts", "../secret"]) {
      expect(
        gk.evaluateInteraction(makeInteraction("thr_worker_1", { kind: "file_change", itemId: "4", writeScope: blocked, sessionGrant: null })),
      ).toEqual({ decision: "deny" });
    }

    // tool_use: ship_steward_* allowed; raw bash/git/gh denied
    expect(
      gk.evaluateInteraction(makeInteraction("thr_worker_1", { kind: "tool_use", itemId: "5", tool: "ship_steward_commit_push", presentation: {} })),
    ).toEqual({ decision: "allow_once", grantedPermissions: null });
    expect(
      gk.evaluateInteraction(makeInteraction("thr_worker_1", { kind: "tool_use", itemId: "6", tool: "bash", presentation: {} })),
    ).toEqual({ decision: "deny" });

    // command: npm test allowed; git push denied
    expect(
      gk.evaluateInteraction(makeInteraction("thr_worker_1", { kind: "command", itemId: "7", command: "npm test", cwd: null, actions: [], sessionGrant: null })),
    ).toEqual({ decision: "allow_once", grantedPermissions: null });
    expect(
      gk.evaluateInteraction(makeInteraction("thr_worker_1", { kind: "command", itemId: "8", command: "git push", cwd: null, actions: [], sessionGrant: null })),
    ).toEqual({ decision: "deny" });
  });
});
