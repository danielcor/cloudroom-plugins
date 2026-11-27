import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { defaultGitExec, mergeEnv, runProcess } from "../src/safety/git-exec.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

function isolatedGitEnv(homeDir: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("GIT_")) continue;
    out[k] = v;
  }
  out.HOME = homeDir;
  out.XDG_CONFIG_HOME = join(homeDir, ".config");
  out.GIT_CONFIG_NOSYSTEM = "1";
  return out;
}

async function initEmptyRepo(bare = false): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ship-ge-"));
  dirs.push(dir);
  const args = bare ? ["init", "--bare", "-b", "main"] : ["init", "-b", "main"];
  await execFileAsync("git", args, { cwd: dir, env: isolatedGitEnv(dir) });
  return dir;
}

async function gitCommitAll(repo: string, message: string, env = isolatedGitEnv(repo)): Promise<string> {
  await execFileAsync("git", ["add", "-A"], { cwd: repo, env });
  await execFileAsync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", message],
    { cwd: repo, env },
  );
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo, env });
  return stdout.trim();
}

function nodeSentinelCmd(sentinelPath: string): string {
  return `"${process.execPath}" -e "require('node:fs').writeFileSync(${JSON.stringify(sentinelPath)}, 'pwned')"`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForPidFile(path: string, timeoutMs = 2000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
      if (pid > 0) return pid;
    } catch {
      // Wait for child to write its pid file.
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Timed out waiting for pid file ${path}`);
}

describe("git-exec and process runner", () => {
  it("merges environment variables and deletes keys set to undefined", () => {
    const merged = mergeEnv(
      { KEEP: "1", OVERRIDE: "old", DROP: "gone" },
      { OVERRIDE: "new", DROP: undefined, ADDED: "yes" },
    );
    expect(merged).toEqual({ KEEP: "1", OVERRIDE: "new", ADDED: "yes" });
    expect("DROP" in merged).toBe(false);
  });

  it("enforces the strict git subcommand and flag allowlist while allowing literal -- pathspecs", async () => {
    const repo = await initEmptyRepo();
    const env = isolatedGitEnv(repo);
    await writeFile(join(repo, "file.txt"), "hello\n", "utf8");
    await gitCommitAll(repo, "init", env);

    const version = await defaultGitExec(repo, ["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout).toContain("git version");

    const bin = await defaultGitExec(repo, ["--version"], { binary: true });
    expect(bin.code).toBe(0);
    expect(bin.stdout).toBe("");
    expect(Buffer.isBuffer(bin.stdoutBuffer)).toBe(true);
    expect(bin.stdoutBuffer?.toString("utf8")).toContain("git version");

    for (const badArgs of [
      [],
      ["--paginate", "status"],
      ["-c", "core.fsmonitor=echo", "status"],
      ["-C", tmpdir(), "status"],
      ["push", "origin", "main"],
      ["fetch", "origin"],
      ["clone", repo, "copy"],
      ["checkout", "HEAD"],
      ["range-diff", "HEAD~1", "HEAD"],
      ["stash", "show"],
      ["reflog", "show"],
      ["blame", "file.txt"],
      ["grep", "hello"],
      ["config", "user.name", "evil"],
      ["config", "--edit"],
      ["config", "--list", "extra-pos"],
      ["cat-file", "--textconv", "HEAD:file.txt"],
      ["cat-file", "--textcon", "HEAD:file.txt"],
      ["cat-file", "--filters", "HEAD:file.txt"],
      ["cat-file", "--batch-command"],
      ["diff", "--ext-diff"],
      ["diff", "--textconv"],
      ["diff", "--submodule=diff"],
      ["diff", "--ignore-submodules=none"],
      ["diff", "--no-index", "a", "b"],
      ["status", "--ignore-submodules=none"],
    ]) {
      const res = await defaultGitExec(repo, badArgs, { env });
      expect(res.code).not.toBe(0);
      expect(res.errorCode).toBe("EINVAL");
    }

    const literalDiff = await defaultGitExec(repo, ["diff", "--", "--ext-diff"], { env });
    expect(literalDiff.code).toBe(0);
  });

  it("handles EPIPE, AbortSignal, ENOENT, and closes stdin promptly when omitted", async () => {
    const epipeRes = await defaultGitExec(process.cwd(), ["--version"], { stdin: "a".repeat(2_000_000) });
    expect(epipeRes.code).not.toBe(0);
    expect(epipeRes.errorCode).toBe("EPIPE");

    const ac = new AbortController();
    ac.abort();
    const aborted = await defaultGitExec(process.cwd(), ["--version"], { signal: ac.signal });
    expect(aborted.code).not.toBe(0);
    expect(aborted.errorCode).toBe("ABORT_ERR");

    const missing = await runProcess("definitely-nonexistent-binary-ship-test", [], { cwd: process.cwd() });
    expect(missing.code).not.toBe(0);
    expect(missing.errorCode).toBe("ENOENT");

    const eofRes = await runProcess(
      process.execPath,
      ["-e", 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("eof"));'],
      { cwd: process.cwd(), timeoutMs: 2000 },
    );
    expect(eofRes.code).toBe(0);
    expect(eofRes.stdout).toBe("eof");
  });

  it("strips inherited repo-local, config, and pathspec Git env vars unless explicitly overridden", async () => {
    const repoA = await initEmptyRepo();
    const repoB = await initEmptyRepo();
    const cfgDir = await mkdtemp(join(tmpdir(), "ship-ge-env-"));
    dirs.push(cfgDir);
    const fakeCfg = join(cfgDir, "evil.gitconfig");
    await writeFile(fakeCfg, "[ship]\n\tinjected = yes\n", "utf8");

    const saved: Record<string, string | undefined> = {};
    const keysToDirty = [
      "GIT_DIR",
      "GIT_CONFIG",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GIT_GLOB_PATHSPECS",
      "GIT_ICASE_PATHSPECS",
      "GIT_EXTERNAL_DIFF",
      "GIT_PAGER",
    ];
    for (const k of keysToDirty) {
      saved[k] = process.env[k];
    }

    try {
      process.env.GIT_DIR = join(repoA, ".git");
      process.env.GIT_CONFIG = fakeCfg;
      process.env.GIT_CONFIG_PARAMETERS = "'ship.param=bad'";
      process.env.GIT_CONFIG_COUNT = "1";
      process.env.GIT_CONFIG_KEY_0 = "ship.indexed";
      process.env.GIT_CONFIG_VALUE_0 = "bad";
      process.env.GIT_GLOB_PATHSPECS = "1";
      delete process.env.GIT_ICASE_PATHSPECS;
      process.env.GIT_EXTERNAL_DIFF = "/nonexistent-ext-diff";
      process.env.GIT_PAGER = "/nonexistent-pager";

      const resB = await defaultGitExec(repoB, ["rev-parse", "--path-format=absolute", "--git-dir"]);
      expect(resB.code).toBe(0);
      expect(resB.stdout.trim()).toBe(join(repoB, ".git"));

      const cfgRes = await defaultGitExec(repoB, ["config", "--get", "ship.indexed"]);
      expect(cfgRes.code).toBe(1);

      const paramRes = await defaultGitExec(repoB, ["config", "--get", "ship.param"]);
      expect(paramRes.code).toBe(1);

      const lsGlob = await defaultGitExec(repoB, ["ls-files"]);
      expect(lsGlob.code).toBe(0);

      delete process.env.GIT_GLOB_PATHSPECS;
      process.env.GIT_ICASE_PATHSPECS = "1";
      const lsIcase = await defaultGitExec(repoB, ["ls-files"]);
      expect(lsIcase.code).toBe(0);

      const resExplicitA = await defaultGitExec(repoB, ["rev-parse", "--path-format=absolute", "--git-dir"], {
        env: { GIT_DIR: join(repoA, ".git") },
      });
      expect(resExplicitA.code).toBe(0);
      expect(resExplicitA.stdout.trim()).toBe(join(repoA, ".git"));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("blocks external diff, textconv, fsmonitor, cat-file transforms, filters, submodules, and merge drivers (S16/S17/S18)", async () => {
    const repo = await initEmptyRepo();
    const subOrigin = await initEmptyRepo();
    const sentinelDir = await mkdtemp(join(tmpdir(), "ship-ge-sentinels-"));
    dirs.push(sentinelDir);
    const env = isolatedGitEnv(repo);

    await writeFile(join(subOrigin, "sub.txt"), "sub v1\n", "utf8");
    const subSentinel = join(sentinelDir, "sub.ran");
    await execFileAsync("git", ["config", "diff.external", nodeSentinelCmd(subSentinel)], { cwd: subOrigin, env });
    await gitCommitAll(subOrigin, "sub init", env);

    await writeFile(join(repo, "file.txt"), "hello world\n", "utf8");
    await writeFile(join(repo, ".gitattributes"), "*.txt diff=evil\n", "utf8");
    await gitCommitAll(repo, "init", env);

    await execFileAsync("git", ["-c", "protocol.file.allow=always", "submodule", "add", subOrigin, "submod"], {
      cwd: repo,
      env,
    });
    await gitCommitAll(repo, "add submodule", env);

    const extSentinel = join(sentinelDir, "ext.ran");
    const drvSentinel = join(sentinelDir, "drv.ran");
    const txtSentinel = join(sentinelDir, "txt.ran");
    const fsmSentinel = join(sentinelDir, "fsm.ran");
    const subCleanSentinel = join(sentinelDir, "subclean.ran");
    await execFileAsync("git", ["config", "core.fsmonitor", nodeSentinelCmd(fsmSentinel)], { cwd: repo, env });
    await execFileAsync("git", ["config", "diff.external", nodeSentinelCmd(extSentinel)], { cwd: repo, env });
    await execFileAsync("git", ["config", "diff.evil.command", nodeSentinelCmd(drvSentinel)], { cwd: repo, env });
    await execFileAsync("git", ["config", "diff.evil.textconv", nodeSentinelCmd(txtSentinel)], { cwd: repo, env });
    await execFileAsync("git", ["config", "diff.submodule", "diff"], { cwd: repo, env });
    await execFileAsync("git", ["config", "status.submoduleSummary", "true"], { cwd: repo, env });
    await execFileAsync("git", ["config", "submodule.submod.ignore", "none"], { cwd: repo, env });

    const subGitCfgDir = join(repo, ".git", "modules", "submod");
    await execFileAsync("git", ["--git-dir", subGitCfgDir, "config", "diff.external", nodeSentinelCmd(subSentinel)], {
      cwd: repo,
      env,
    });
    await execFileAsync("git", ["--git-dir", subGitCfgDir, "config", "filter.subf.clean", nodeSentinelCmd(subCleanSentinel)], {
      cwd: repo,
      env,
    });
    await writeFile(join(repo, "submod", ".gitattributes"), "* filter=subf\n", "utf8");
    await writeFile(join(repo, "submod", "sub.txt"), "dirty submodule change\n", "utf8");
    await writeFile(join(repo, "file.txt"), "hello updated\n", "utf8");

    const diffRes = await defaultGitExec(repo, ["diff"], { env });
    expect(diffRes.code).toBe(0);
    expect(diffRes.stdout).toContain("diff --git a/file.txt b/file.txt");

    const statusRes = await defaultGitExec(repo, ["status", "--short"], { env });
    expect(statusRes.code).toBe(0);

    const showRes = await defaultGitExec(repo, ["show", "HEAD"], { env });
    expect(showRes.code).toBe(0);

    const logRes = await defaultGitExec(repo, ["log", "-p", "-1"], { env });
    expect(logRes.code).toBe(0);

    const dtRes = await defaultGitExec(repo, ["diff-tree", "-r", "-z", "--no-renames", "--ignore-submodules=none", "HEAD~1", "HEAD"], {
      env,
    });
    expect(dtRes.code).toBe(0);

    // S17: cat-file raw object modes work without running textconv/filters.
    for (const flag of ["-p", "-t", "-s", "-e"]) {
      const cf = await defaultGitExec(repo, ["cat-file", flag, "HEAD:file.txt"], { env });
      expect(cf.code).toBe(0);
    }

    for (const s of [extSentinel, drvSentinel, txtSentinel, fsmSentinel, subSentinel, subCleanSentinel]) {
      expect(existsSync(s)).toBe(false);
    }

    // S18: clean and process filters (even with required=true) are neutralized on worktree commands.
    const cleanSentinel = join(sentinelDir, "clean.ran");
    const procSentinel = join(sentinelDir, "proc.ran");
    await writeFile(join(repo, ".gitattributes"), "*.txt filter=evil\n*.dat filter=evilproc\n", "utf8");
    await writeFile(join(repo, "data.dat"), "payload\n", "utf8");
    await execFileAsync("git", ["config", "filter.evil.clean", nodeSentinelCmd(cleanSentinel)], { cwd: repo, env });
    await execFileAsync("git", ["config", "filter.evil.required", "true"], { cwd: repo, env });
    await execFileAsync("git", ["config", "filter.evilproc.process", nodeSentinelCmd(procSentinel)], { cwd: repo, env });
    await execFileAsync("git", ["config", "filter.evilproc.required", "true"], { cwd: repo, env });

    expect((await defaultGitExec(repo, ["diff"], { env })).code).toBe(0);
    expect((await defaultGitExec(repo, ["status", "--short"], { env })).code).toBe(0);
    expect((await defaultGitExec(repo, ["ls-files", "-m"], { env })).code).toBe(0);
    expect(existsSync(cleanSentinel)).toBe(false);
    expect(existsSync(procSentinel)).toBe(false);

    // Non-overridable filter subsection name must fail closed with EPERM.
    const badSubSentinel = join(sentinelDir, "badsub.ran");
    await execFileAsync("git", ["config", "filter.bad=name.clean", nodeSentinelCmd(badSubSentinel)], { cwd: repo, env });
    const badFilterDiff = await defaultGitExec(repo, ["diff"], { env });
    expect(badFilterDiff.code).not.toBe(0);
    expect(badFilterDiff.errorCode).toBe("EPERM");
    expect(existsSync(badSubSentinel)).toBe(false);
  });

  it("executes core read-only config, rev-parse, for-each-ref, and isolated merge-tree helpers while failing closed on merge drivers", async () => {
    const repo = await initEmptyRepo();
    const scratchBare = await initEmptyRepo(true);
    const env = isolatedGitEnv(repo);

    await writeFile(join(repo, "a.txt"), "base\n", "utf8");
    const baseSha = await gitCommitAll(repo, "base", env);
    await execFileAsync("git", ["checkout", "-b", "branch-a"], { cwd: repo, env });
    await writeFile(join(repo, "a.txt"), "from a\n", "utf8");
    const shaA = await gitCommitAll(repo, "a", env);
    await execFileAsync("git", ["checkout", "-b", "branch-b", baseSha], { cwd: repo, env });
    await writeFile(join(repo, "b.txt"), "from b\n", "utf8");
    const shaB = await gitCommitAll(repo, "b", env);

    const cfgList = await defaultGitExec(repo, ["config", "--show-scope", "--show-origin", "--null", "--list"], { env });
    expect(cfgList.code).toBe(0);

    const cfgIncludes = await defaultGitExec(
      repo,
      ["config", "--show-origin", "-z", "--type=path", "--get-regexp", String.raw`^include(if\..*)?\.path$`],
      { env },
    );
    expect([0, 1]).toContain(cfgIncludes.code);

    const rp = await defaultGitExec(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"], {
      env,
    });
    expect(rp.code).toBe(0);
    expect(rp.stdout.trim()).toBe(shaB);

    const fer = await defaultGitExec(repo, ["for-each-ref", "--count=1", "refs/heads"], { env });
    expect(fer.code).toBe(0);

    const mb = await defaultGitExec(repo, ["merge-base", "--is-ancestor", baseSha, shaB], { env });
    expect(mb.code).toBe(0);

    await execFileAsync("git", ["push", scratchBare, `${shaA}:refs/heads/a`, `${shaB}:refs/heads/b`], {
      cwd: repo,
      env,
    });
    const mt = await defaultGitExec(
      scratchBare,
      ["--git-dir", scratchBare, "merge-tree", "--write-tree", shaA, shaB],
      { env },
    );
    expect(mt.code).toBe(0);
    const treeSha = mt.stdout.trim();
    expect(treeSha).toMatch(/^[0-9a-f]{40,}$/u);

    const dt = await defaultGitExec(
      scratchBare,
      ["--git-dir", scratchBare, "diff-tree", "-r", "-z", "--no-renames", "--ignore-submodules=none", shaA, treeSha],
      { env },
    );
    expect(dt.code).toBe(0);

    await execFileAsync("git", ["--git-dir", scratchBare, "config", "merge.evil.driver", "false"], {
      cwd: repo,
      env,
    });
    const blockedMt = await defaultGitExec(
      scratchBare,
      ["--git-dir", scratchBare, "merge-tree", "--write-tree", shaA, shaB],
      { env },
    );
    expect(blockedMt.code).not.toBe(0);
    expect(blockedMt.errorCode).toBe("EPERM");
  });

  it("forcibly kills SIGTERM-ignoring children on maxBuffer overflow even with timeout disabled (S20)", async () => {
    const t0 = performance.now();
    const res = await runProcess(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM", () => {}); const chunk = Buffer.alloc(64 * 1024, 65); function spam() { process.stdout.write(chunk); setImmediate(spam); } spam();',
      ],
      { cwd: process.cwd(), maxBuffer: 128 * 1024, timeoutMs: 0 },
    );
    const elapsedMs = performance.now() - t0;
    expect(res.code).not.toBe(0);
    expect(res.errorCode).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    expect(elapsedMs).toBeLessThan(1500);
  });

  it("kills the entire process tree (including stdio-closing and SIGTERM-ignoring descendants) before settling on abort and timeout (S21)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-ge-tree-"));
    dirs.push(dir);

    const spawnedPids: number[] = [];
    const spawnTreeScript = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const [parentFile, openChildFile, closedChildFile] = process.argv.slice(1);
      process.on("SIGTERM", () => {});
      const childBody = 'const fs = require("node:fs"); process.on("SIGTERM", () => {}); fs.writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.exit(0), 10000);';
      const c1 = spawn(process.execPath, ["-e", childBody, openChildFile], { stdio: "inherit" });
      const c2 = spawn(process.execPath, ["-e", childBody, closedChildFile], { stdio: "ignore" });
      fs.writeFileSync(parentFile, String(process.pid));
      setTimeout(() => { void c1; void c2; process.exit(0); }, 10000);
    `;

    try {
      const abortParent = join(dir, "abort-parent.pid");
      const abortOpen = join(dir, "abort-open.pid");
      const abortClosed = join(dir, "abort-closed.pid");
      const ac = new AbortController();
      const abortPromise = runProcess(
        process.execPath,
        ["-e", spawnTreeScript, abortParent, abortOpen, abortClosed],
        { cwd: dir, signal: ac.signal, timeoutMs: 10_000 },
      );

      const abortPids = await Promise.all([
        waitForPidFile(abortParent),
        waitForPidFile(abortOpen),
        waitForPidFile(abortClosed),
      ]);
      spawnedPids.push(...abortPids);

      ac.abort();
      const abortRes = await abortPromise;
      expect(abortRes.code).not.toBe(0);
      expect(abortRes.errorCode).toBe("ABORT_ERR");
      for (const pid of abortPids) {
        expect(isPidAlive(pid)).toBe(false);
      }

      const toParent = join(dir, "to-parent.pid");
      const toOpen = join(dir, "to-open.pid");
      const toClosed = join(dir, "to-closed.pid");
      const toPromise = runProcess(
        process.execPath,
        ["-e", spawnTreeScript, toParent, toOpen, toClosed],
        { cwd: dir, timeoutMs: 250 },
      );

      const toPids = await Promise.all([
        waitForPidFile(toParent),
        waitForPidFile(toOpen),
        waitForPidFile(toClosed),
      ]);
      spawnedPids.push(...toPids);

      const toRes = await toPromise;
      expect(toRes.code).not.toBe(0);
      expect(toRes.errorCode).toBe("ETIMEDOUT");
      for (const pid of toPids) {
        expect(isPidAlive(pid)).toBe(false);
      }
    } finally {
      for (const pid of spawnedPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already exited.
        }
      }
    }
  });
});
