import { execFile } from "node:child_process";
import { chmod, copyFile, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry, { inspectPublishContextAt, publishChangesAt } from "../host.js";
import type { CheckoutInspection } from "../src/contract.js";
import type { GhExec, PullRequestSummary, RepoMeta } from "../src/github/client.js";
import { runPreflight } from "../src/publish/preflight.js";
import { CLOUDROOM_PR_FOOTER, synthesizeCommitMessage, synthesizePrTexts } from "../src/publish/pr-texts.js";
import { createShipPlugin } from "../server.js";

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

function baseInspection(overrides: Partial<CheckoutInspection> = {}): CheckoutInspection {
  return {
    root: "/tmp/repo",
    gitDir: "/tmp/repo/.git",
    commonDir: "/tmp/repo/.git",
    headSha: "a".repeat(40),
    branch: "feat/demo",
    isDetached: false,
    isClean: false,
    inProgressOp: null,
    remotes: [{ name: "origin", url: "git@github.com:acme/demo.git", kind: "push" }],
    changedFiles: ["src/index.ts"],
    hardLinks: [],
    submodules: [],
    gitDirLinkIssue: null,
    ...overrides,
  };
}

function baseRepoMeta(overrides: Partial<RepoMeta> = {}): RepoMeta {
  return {
    slug: "acme/demo",
    owner: "acme",
    name: "demo",
    defaultBranch: "main",
    isPrivate: true,
    isFork: false,
    parentSlug: null,
    viewerLogin: "danielcor",
    viewerPermission: "write",
    ...overrides,
  };
}

describe("runPreflight guardrails", () => {
  it("blocks non-github remotes, detached HEAD, in-progress ops, .git symlinks, forks, and collision labels", () => {
    const r1 = runPreflight({
      inspection: baseInspection({ remotes: [{ name: "origin", url: "git@gitlab.com:acme/demo.git", kind: "push" }] }),
      remoteName: "origin",
      remoteUrl: "git@gitlab.com:acme/demo.git",
      repoMeta: null,
      existingPr: null,
      aheadCount: 1,
      diffSecretFinding: null,
      localSecretMatchSource: null,
    });
    expect(r1.ok).toBe(false);
    expect(r1.blockers.map((b) => b.code)).toContain("non_github_remote");

    const r2 = runPreflight({
      inspection: baseInspection({ branch: null, isDetached: true, inProgressOp: "rebase", gitDirLinkIssue: "/tmp/.git/index" }),
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/demo.git",
      repoMeta: baseRepoMeta({ isFork: true, parentSlug: "upstream/demo" }),
      existingPr: {
        number: 10,
        url: "https://github.com/acme/demo/pull/10",
        title: "Open",
        state: "OPEN",
        isDraft: false,
        headRefName: "feat/demo",
        headRefOid: "a".repeat(40),
        baseRefName: "main",
        baseRefOid: "b".repeat(40),
        authorLogin: "danielcor",
        labels: ["claude-pr-steward-active"],
        mergeStateStatus: "CLEAN",
        isCrossRepository: false,
      } satisfies PullRequestSummary,
      aheadCount: 1,
      diffSecretFinding: null,
      localSecretMatchSource: null,
    });
    expect(r2.ok).toBe(false);
    expect(r2.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(["detached_head", "in_progress_op", "git_dir_symlink", "fork_repo", "steward_label_collision"]),
    );
  });

  it("blocks hardlinks, submodules, secret filenames, never-edit paths, secret content, and public-repo headless dirty commits", () => {
    const res = runPreflight({
      inspection: baseInspection({
        changedFiles: [".env", ".github/workflows/deploy.yml", "src/app.ts"],
        hardLinks: ["src/app.ts"],
        submodules: ["vendor/sub/"],
      }),
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/demo.git",
      repoMeta: baseRepoMeta({ isPrivate: false }),
      existingPr: null,
      aheadCount: 0,
      diffSecretFinding: { kind: "AWS access key id", line: 4 },
      localSecretMatchSource: "API_KEY in .env",
      nonInteractive: true,
    });
    expect(res.ok).toBe(false);
    expect(res.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining([
        "hardlink_changed_file",
        "submodule_changed",
        "secret_filename",
        "never_edit_path",
        "secret_content_detected",
        "public_repo_auto_commit_refused",
      ]),
    );
  });

  it("suggests a feature branch on default branch, rejects invalid branch names, and requires something to ship", () => {
    const onDefault = runPreflight({
      inspection: baseInspection({ branch: "main", changedFiles: ["src/widget.ts"] }),
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/demo.git",
      repoMeta: baseRepoMeta(),
      existingPr: null,
      aheadCount: 0,
      diffSecretFinding: null,
      localSecretMatchSource: null,
    });
    expect(onDefault.ok).toBe(true);
    expect(onDefault.plan?.createBranch).toBe(true);
    expect(onDefault.plan?.targetBranch).toBe("ship/src-widget");
    expect(onDefault.warnings.map((w) => w.code)).toContain("create_branch_from_default");

    const badBranch = runPreflight({
      inspection: baseInspection({ branch: "main" }),
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/demo.git",
      repoMeta: baseRepoMeta(),
      existingPr: null,
      aheadCount: 0,
      diffSecretFinding: null,
      localSecretMatchSource: null,
      requestedBranch: "../bad.lock",
    });
    expect(badBranch.ok).toBe(false);
    expect(badBranch.blockers.map((b) => b.code)).toContain("invalid_branch_name");

    const empty = runPreflight({
      inspection: baseInspection({ branch: "feat/empty", changedFiles: [], isClean: true }),
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/demo.git",
      repoMeta: baseRepoMeta(),
      existingPr: null,
      aheadCount: 0,
      diffSecretFinding: null,
      localSecretMatchSource: null,
    });
    expect(empty.ok).toBe(false);
    expect(empty.blockers.map((b) => b.code)).toContain("nothing_to_ship");
  });
});

describe("pr-texts synthesis", () => {
  it("validates commit messages and falls back safely when PR text parrots 8+ diff words", () => {
    expect(synthesizeCommitMessage({ branch: "feat/a", changedFiles: ["a.ts"], hint: "fixes #123" }).ok).toBe(false);
    expect(synthesizeCommitMessage({ branch: "feat/a", changedFiles: ["src/a.ts"] })).toMatchObject({
      ok: true,
      fromHint: false,
    });

    const diffText = "+ const sentence = 'alpha bravo charlie delta echo foxtrot golf hotel india';\n";
    const parroted = synthesizePrTexts({
      branch: "feat/clean",
      commitSubjects: ["alpha bravo charlie delta echo foxtrot golf hotel"],
      changedFiles: ["src/a.ts"],
      diffText,
    });
    expect(parroted.usedFallback).toBe(true);
    expect(parroted.title).not.toContain("alpha bravo");
    expect(parroted.body.endsWith(CLOUDROOM_PR_FOOTER)).toBe(true);

    const noFooter = synthesizePrTexts({
      branch: "feat/clean",
      commitSubjects: ["Add ship publisher workflow"],
      changedFiles: ["src/publisher.ts"],
      diffText: "+ export const publisherReady = true;",
      includeFooter: false,
    });
    expect(noFooter.usedFallback).toBe(false);
    expect(noFooter.body).toBe("## Summary\n\n- Add ship publisher workflow");
  });
});

describe("host publishChangesAt & inspectPublishContextAt against real git + bare remote", () => {
  it("inspects context without leaking secrets and publishes branch with repo hooks ON and named staging", async () => {
    const base = await mkdtemp(join(tmpdir(), "ship-pub-"));
    tempDirs.push(base);
    const bareDir = join(base, "origin.git");
    const workDir = join(base, "work");
    const hookRanMarker = join(base, "pre-commit-hook-ran");

    await git(base, "init", "--bare", bareDir);
    await mkdir(workDir, { recursive: true });
    await git(workDir, "init", "-b", "main");
    await git(workDir, "config", "user.name", "Test Author");
    await git(workDir, "config", "user.email", "author@example.com");
    await writeFile(join(workDir, "README.md"), "# Demo\n", "utf8");
    await git(workDir, "add", "README.md");
    await git(workDir, "commit", "-m", "init main");
    await git(workDir, "remote", "add", "origin", bareDir);
    await git(workDir, "remote", "add", "gh", "git@github.com:acme/demo.git");
    await git(workDir, "push", "-u", "origin", "main");

    // Add pre-commit hook to ensure author git hooks execute during publishChangesAt.
    const hookPath = join(workDir, ".git", "hooks", "pre-commit");
    await writeFile(hookPath, `#!/bin/sh\ntouch "${hookRanMarker}"\nexit 0\n`, "utf8");
    await chmod(hookPath, 0o755);

    const leakedToken = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    await writeFile(join(workDir, ".env"), "LOCAL_SECRET=super_secret_val_999\n", "utf8");
    await writeFile(join(workDir, "feature.ts"), `export const key = "${leakedToken}";\n`, "utf8");

    const createdInputs: Array<{ args: readonly string[]; stdin?: string }> = [];
    const fakeGh: GhExec = async (_cwd, args, stdin) => {
      const joined = args.join(" ");
      if (args[0] === "api" && args[1] === "graphql") {
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              viewer: { login: "danielcor" },
              repository: {
                nameWithOwner: "acme/demo",
                isPrivate: true,
                isFork: false,
                viewerPermission: "WRITE",
                defaultBranchRef: { name: "main" },
                parent: null,
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "pr" && args[1] === "list") {
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "create") {
        createdInputs.push({ args, stdin });
        return { code: 0, stdout: "https://github.com/acme/demo/pull/42\n", stderr: "" };
      }
      if (args[0] === "pr" && args[1] === "view") {
        const currentHead = await git(workDir, "rev-parse", "HEAD");
        return {
          code: 0,
          stdout: JSON.stringify({ number: 42, url: "https://github.com/acme/demo/pull/42", headRefOid: currentHead }),
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected gh call: ${joined}` };
    };

    // Inspect context sees the leaked key in feature.ts and strips diffText to prevent RPC exposure.
    const ctxWithSecret = await inspectPublishContextAt({ root: workDir, remote: "gh" }, { execGh: fakeGh });
    expect(ctxWithSecret.repoMeta?.slug).toBe("acme/demo");
    expect(ctxWithSecret.diffSecretFinding?.kind).toBe("AWS access key id");
    expect(ctxWithSecret.diffText).toBe("");

    // Fix feature.ts cleanly.
    await writeFile(join(workDir, "feature.ts"), "export const shipped = true;\n", "utf8");
    const mainHead = await git(workDir, "rev-parse", "HEAD");

    // Verify expectedHeadSha mismatch fails safely.
    const mismatch = await publishChangesAt(
      {
        root: workDir,
        remote: "origin",
        repoSlug: "acme/demo",
        targetBranch: "ship/feature",
        createBranch: true,
        baseBranch: "main",
        filesToStage: ["feature.ts"],
        commitMessage: "ship: add feature",
        prTitle: "Add feature",
        prBody: "## Summary\n\n- Add feature",
        draft: false,
        createPr: true,
        expectedHeadSha: "0".repeat(40),
      },
      { execGh: fakeGh },
    );
    expect(mismatch.ok).toBe(false);
    expect(mismatch.error).toContain("HEAD moved");

    // Verify local .env secret leakage into prBody is blocked before mutating git.
    const leakedBody = await publishChangesAt(
      {
        root: workDir,
        remote: "origin",
        repoSlug: "acme/demo",
        targetBranch: "ship/feature",
        createBranch: true,
        baseBranch: "main",
        filesToStage: ["feature.ts"],
        commitMessage: "ship: add feature",
        prTitle: "Add feature",
        prBody: "## Summary\n\n- token super_secret_val_999",
        draft: false,
        createPr: true,
        expectedHeadSha: mainHead,
      },
      { execGh: fakeGh },
    );
    expect(leakedBody.ok).toBe(false);
    expect(leakedBody.error).toContain("LOCAL_SECRET in .env");

    // Note: use bareDir via origin remote; since `parseGitHubRemoteUrl` checks remote URL on inspect,
    // pass `publishChangesAt` directly with `origin` pointing to `bareDir`!
    const published = await publishChangesAt(
      {
        root: workDir,
        remote: "origin",
        repoSlug: "acme/demo",
        targetBranch: "ship/feature",
        createBranch: true,
        baseBranch: "main",
        filesToStage: ["feature.ts"],
        commitMessage: "ship: add feature module",
        prTitle: "Add feature module",
        prBody: `## Summary\n\n- Add feature module\n\n${CLOUDROOM_PR_FOOTER}`,
        draft: true,
        createPr: true,
        expectedHeadSha: mainHead,
      },
      { execGh: fakeGh },
    );

    expect(published).toMatchObject({
      ok: true,
      branch: "ship/feature",
      committed: true,
      pushed: true,
      prNumber: 42,
      prUrl: "https://github.com/acme/demo/pull/42",
      prCreated: true,
      error: null,
    });

    // Verify pre-commit hook ran, `.env` stayed untracked, remote tip matches HEAD, and PR body used stdin.
    const { stat } = await import("node:fs/promises");
    await expect(stat(hookRanMarker)).resolves.toBeDefined();
    const statusAfter = await git(workDir, "status", "--short");
    expect(statusAfter).toBe("?? .env");
    const remoteTip = await git(bareDir, "rev-parse", "refs/heads/ship/feature");
    expect(remoteTip).toBe(published.headSha);
    expect(createdInputs[0]!.args).toContain("--draft");
    expect(createdInputs[0]!.args).toContain("--body-file");
    expect(createdInputs[0]!.stdin).toContain(CLOUDROOM_PR_FOOTER);
  });

  it("catches .git/index symlinks and changed hardlinks via inspectPublishContextAt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-link-"));
    tempDirs.push(dir);
    await git(dir, "init", "-b", "main");
    await git(dir, "config", "user.name", "Author");
    await git(dir, "config", "user.email", "a@b.c");
    await writeFile(join(dir, "a.ts"), "1\n", "utf8");
    await git(dir, "add", "a.ts");
    await git(dir, "commit", "-m", "init");
    await link(join(dir, "a.ts"), join(dir, "b.ts"));
    await copyFile(join(dir, ".git", "index"), join(dir, "outside-index"));
    await rm(join(dir, ".git", "index"), { force: true });
    await symlink(join(dir, "outside-index"), join(dir, ".git", "index"));

    const ctx = await inspectPublishContextAt({ root: dir });
    expect(ctx.inspection.hardLinks).toContain("b.ts");
    expect(ctx.inspection.gitDirLinkIssue).toContain("index");
  });
});

async function waitForPendingInteractionId(host: ReturnType<typeof createFakePluginHost>): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const first = host.harness.inspection.pendingInteractions[0];
    if (first) return first.id;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("Timed out waiting for pendingInteraction to be registered");
}

describe("server publish confirmation dwell, audit log, and bot CLI", () => {
  it("enforces 3.5s dwell on thread requestInput, supports cancellation/dry-run/publish, and hides botToken", async () => {
    let clockMs = 10_000;
    const hostWorker = experimental_createHostEntryHarness(hostEntry);
    hostHarnesses.push(hostWorker);

    const botSecret = ["github_pat_", "fake_token_never_leak_9999"].join("");
    const mockFetch = async (url: string | URL | Request) => {
      if (String(url).endsWith("/user")) {
        return new Response(JSON.stringify({ login: "ship-bot", id: 707 }), { status: 200 });
      }
      if (String(url).endsWith("/graphql")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  number: 12,
                  url: "https://github.com/acme/demo/pull/12",
                  title: "Fix bug",
                  body: "Body",
                  state: "OPEN",
                  isDraft: false,
                  headRefName: "feat/fix",
                  headRefOid: "b".repeat(40),
                  baseRefName: "main",
                  baseRefOid: "a".repeat(40),
                  author: { login: "danielcor" },
                  labels: { nodes: [] },
                  comments: {
                    nodes: [
                      {
                        id: "c1",
                        body: "Trusted author comment",
                        createdAt: "2026-11-24T00:00:00Z",
                        author: { login: "danielcor" },
                      },
                    ],
                  },
                  reviews: { nodes: [] },
                  reviewThreads: { nodes: [] },
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const publishCalls: unknown[] = [];
    const baseInspectionPayload = {
      inspection: baseInspection({ changedFiles: ["src/fix.ts"] }),
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/demo.git",
      repoMeta: baseRepoMeta(),
      existingPr: null,
      aheadCount: 1,
      commitSubjects: ["Fix edge case"],
      diffText: "+ export const fixed = true;",
      diffSecretFinding: null,
      localSecretMatchSource: null,
    };

    const fakeHost = createFakePluginHost({
      pluginId: "ship",
      settings: {
        botLogin: "ship-bot",
        botToken: botSecret,
      },
      sdk: {
        hosts: { list: async () => [{ id: "host_1", name: "local" }] as never },
        projects: {
          get: async () =>
            ({
              id: "proj_1",
              name: "demo",
              kind: "standard",
              sources: [{ id: "s1", projectId: "proj_1", hostId: "host_1", path: "/tmp/repo", isDefault: true }],
            }) as never,
        },
        threads: {
          get: async () => ({ id: "thr_1", projectId: "proj_1", environmentId: null }) as never,
        },
      },
      experimental_callHostRpc: async ({ method, input }) => {
        if (method === "inspectPublishContext") return baseInspectionPayload;
        if (method === "publishChanges") {
          publishCalls.push(input);
          return {
            ok: true,
            branch: "feat/demo",
            headSha: "c".repeat(40),
            committed: true,
            pushed: true,
            prNumber: 99,
            prUrl: "https://github.com/acme/demo/pull/99",
            prCreated: true,
            error: null,
          };
        }
        return hostWorker.experimental_call(method as never, input as never);
      },
    });
    fakeHosts.push(fakeHost);

    const plugin = createShipPlugin({
      nowMs: () => clockMs,
      fetchImpl: mockFetch as typeof fetch,
      minDwellMs: 3500,
    });
    await plugin(fakeHost.bb);

    // 1) Dry-run succeeds with zero mutations.
    const dryRunRes = await fakeHost.harness.runCli(["publish", "--dry-run", "--json"], {
      projectId: "proj_1",
      threadId: "thr_1",
    });
    expect(dryRunRes.exitCode).toBe(0);
    expect(JSON.parse(dryRunRes.stdout)).toMatchObject({ status: "dry_run", prTitle: "Fix edge case" });
    expect(publishCalls).toHaveLength(0);

    // 2) Submission before 3.5s dwell expires is rejected.
    const earlyPromise = fakeHost.harness.runCli(["publish", "--json"], { projectId: "proj_1", threadId: "thr_1" });
    const id1 = await waitForPendingInteractionId(fakeHost);
    clockMs += 1000;
    fakeHost.harness.submitInteraction(id1, { approved: true, prTitle: "Early", prBody: "## Summary\n\n- Quick", commitMessage: "fix", draft: false });
    const earlyRes = await earlyPromise;
    expect(earlyRes.exitCode).toBe(1);
    expect(JSON.parse(earlyRes.stdout)).toMatchObject({
      status: "rejected",
      reason: "Confirmation submitted before 3.5s dwell period elapsed.",
    });
    expect(publishCalls).toHaveLength(0);

    // 3) Cancelled submission stops cleanly.
    const cancelPromise = fakeHost.harness.runCli(["publish", "--json"], { projectId: "proj_1", threadId: "thr_1" });
    const id2 = await waitForPendingInteractionId(fakeHost);
    fakeHost.harness.cancelInteraction(id2);
    const cancelRes = await cancelPromise;
    expect(cancelRes.exitCode).toBe(1);
    expect(JSON.parse(cancelRes.stdout)).toMatchObject({ status: "cancelled" });
    expect(publishCalls).toHaveLength(0);

    // 4) Submission after >= 3.5s dwell with edited title and draft=true publishes cleanly.
    const okPromise = fakeHost.harness.runCli(["publish", "--json"], { projectId: "proj_1", threadId: "thr_1" });
    const id3 = await waitForPendingInteractionId(fakeHost);
    clockMs += 3600;
    fakeHost.harness.submitInteraction(id3, {
      approved: true,
      prTitle: "Edited PR title",
      prBody: "## Summary\n\n- Edited PR body",
      commitMessage: "ship: fix edge case",
      draft: true,
    });
    const okRes = await okPromise;
    expect(okRes.exitCode).toBe(0);
    expect(JSON.parse(okRes.stdout)).toMatchObject({
      status: "published",
      publish: { prNumber: 99, prUrl: "https://github.com/acme/demo/pull/99" },
    });
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]).toMatchObject({ prTitle: "Edited PR title", draft: true, commitMessage: "ship: fix edge case" });

    // Audit trail captured dwell rejection, cancellation, and success.
    const audit = (await fakeHost.harness.callRpc("listAudit", {})) as Array<{ action: string }>;
    expect(audit.map((a) => a.action)).toEqual(["publish.succeeded", "publish.cancelled", "publish.dwell_rejected"]);

    // 5) `bot check` and `pr comments --via-bot` never leak botToken.
    const botCheck = await fakeHost.harness.runCli(["bot", "check", "--json"]);
    expect(botCheck.exitCode).toBe(0);
    expect(botCheck.stdout).not.toContain(botSecret);
    expect(JSON.parse(botCheck.stdout)).toMatchObject({
      configured: true,
      configuredLogin: "ship-bot",
      actualLogin: "ship-bot",
      loginMatches: true,
    });

    const commentsRes = await fakeHost.harness.runCli(["pr", "comments", "acme/demo", "12", "--via-bot", "--json"]);
    expect(commentsRes.exitCode).toBe(0);
    expect(commentsRes.stdout).not.toContain(botSecret);
    expect(JSON.parse(commentsRes.stdout).items).toHaveLength(1);
  });
});
