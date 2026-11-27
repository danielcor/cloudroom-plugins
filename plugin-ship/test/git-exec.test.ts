import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultGitExec,
  isSupportedGitVersion,
  mergeEnv,
  parseGitVersion,
  runProcess,
} from "../src/safety/git-exec.js";

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

async function makeSentinelScript(
  dir: string,
  name: string,
  sentinelPath: string,
  exitCode = 0,
): Promise<string> {
  const scriptPath = join(dir, name);
  await writeFile(
    scriptPath,
    `#!/bin/sh\nprintf 'pwned\\n' > ${JSON.stringify(sentinelPath)}\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return scriptPath;
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

async function transpileGitExecModule(dir: string): Promise<string> {
  const src = await readFile(fileURLToPath(new URL("../src/safety/git-exec.ts", import.meta.url)), "utf8");
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const outPath = join(dir, "git-exec.mjs");
  await writeFile(outPath, outputText, "utf8");
  return pathToFileURL(outPath).href;
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

  it("enforces the strict read-only plumbing allowlist while allowing literal -- pathspecs", async () => {
    const repo = await initEmptyRepo();
    const env = isolatedGitEnv(repo);
    await writeFile(join(repo, "file.txt"), "hello\n", "utf8");
    const first = await gitCommitAll(repo, "init", env);
    await writeFile(join(repo, "file.txt"), "hello 2\n", "utf8");
    const second = await gitCommitAll(repo, "second", env);

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
      ["--paginate", "rev-parse", "HEAD"],
      ["-c", "core.fsmonitor=echo", "rev-parse", "HEAD"],
      ["-C", tmpdir(), "rev-parse", "HEAD"],
      ["push", "origin", "main"],
      ["fetch", "origin"],
      ["clone", repo, "copy"],
      ["checkout", "HEAD"],
      ["diff"],
      ["status"],
      ["show", "HEAD"],
      ["log", "-1"],
      ["range-diff", "HEAD~1", "HEAD"],
      ["stash", "show"],
      ["reflog", "show"],
      ["blame", "file.txt"],
      ["grep", "hello"],
      ["ls-files"],
      ["ls-files", "-z"],
      ["ls-files", "--cached"],
      ["ls-files", "-m"],
      ["ls-files", "--modified"],
      ["config", "user.name", "evil"],
      ["config", "--edit"],
      ["config", "--list", "extra-pos"],
      ["for-each-ref", "-z"],
      ["for-each-ref", "--format=%(signature)"],
      ["for-each-ref", "--sort=signature"],
      ["merge-tree", "--write-tree", first, second],
      ["merge-tree", first, second],
      ["cat-file", "--textconv", "HEAD:file.txt"],
      ["cat-file", "--textcon", "HEAD:file.txt"],
      ["cat-file", "--filters", "HEAD:file.txt"],
      ["cat-file", "--batch-command"],
      ["diff-tree", "--ext-diff", first, second],
      ["diff-tree", "--textconv", first, second],
      ["diff-tree", "--submodule=diff", first, second],
      ["diff-tree", "--output=/tmp/out", first, second],
    ]) {
      const res = await defaultGitExec(repo, badArgs, { env });
      expect(res.code).not.toBe(0);
      expect(res.errorCode).toBe("EINVAL");
    }

    const literalDt = await defaultGitExec(repo, ["diff-tree", "-r", first, second, "--", "--ext-diff"], { env });
    expect(literalDt.code).toBe(0);
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

    // S2: addAbortListener must still trigger process termination when an earlier listener calls stopImmediatePropagation().
    const s2Dir = await mkdtemp(join(tmpdir(), "ship-ge-s2-"));
    dirs.push(s2Dir);
    const s2PidFile = join(s2Dir, "child.pid");
    const s2Ac = new AbortController();
    s2Ac.signal.addEventListener("abort", (e) => e.stopImmediatePropagation());
    let s2Pid = 0;
    try {
      const s2Promise = runProcess(
        process.execPath,
        [
          "-e",
          'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 10000);',
          s2PidFile,
        ],
        { cwd: s2Dir, signal: s2Ac.signal, timeoutMs: 10_000 },
      );
      s2Pid = await waitForPidFile(s2PidFile);
      s2Ac.abort();
      const s2Res = await s2Promise;
      expect(s2Res.code).not.toBe(0);
      expect(s2Res.errorCode).toBe("ABORT_ERR");
      expect(isPidAlive(s2Pid)).toBe(false);
    } finally {
      if (s2Pid > 0) {
        try {
          process.kill(s2Pid, "SIGKILL");
        } catch {
          // Already exited.
        }
      }
    }
  });

  it("enforces Git >= 2.45.1, bypasses PATH=. cache collisions, and blocks lazy fetch in partial clones (S5)", async () => {
    expect(parseGitVersion("git version 2.45.1")).toEqual({ major: 2, minor: 45, patch: 1 });
    expect(isSupportedGitVersion("git version 2.43.2")).toBe(false);
    expect(isSupportedGitVersion("git version 2.45.0")).toBe(false);
    expect(isSupportedGitVersion("git version 2.45.1")).toBe(true);
    expect(isSupportedGitVersion("git version 2.56.1")).toBe(true);
    expect(isSupportedGitVersion("git version 3.0.0")).toBe(true);

    const oldBinDir = await mkdtemp(join(tmpdir(), "ship-ge-oldgit-"));
    dirs.push(oldBinDir);
    await writeFile(
      join(oldBinDir, "git"),
      "#!/bin/sh\necho 'git version 2.45.0'\n",
      { mode: 0o755 },
    );
    const oldRes = await defaultGitExec(process.cwd(), ["rev-parse", "HEAD"], {
      env: { PATH: oldBinDir },
    });
    expect(oldRes.code).not.toBe(0);
    expect(oldRes.errorCode).toBe("ENOTSUP");

    // PATH=. across two different working directories must never reuse cached binary identity.
    const dotNewDir = await mkdtemp(join(tmpdir(), "ship-ge-dotnew-"));
    const dotOldDir = await mkdtemp(join(tmpdir(), "ship-ge-dotold-"));
    dirs.push(dotNewDir, dotOldDir);
    await writeFile(
      join(dotNewDir, "git"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.56.1"; exit 0; fi\necho "true"\n',
      { mode: 0o755 },
    );
    await writeFile(
      join(dotOldDir, "git"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.39.5"; exit 0; fi\necho "should-not-run"\n',
      { mode: 0o755 },
    );
    const dotOkRes = await defaultGitExec(dotNewDir, ["rev-parse", "--is-inside-work-tree"], {
      env: { PATH: "." },
    });
    expect(dotOkRes.code).toBe(0);
    const dotOldRes = await defaultGitExec(dotOldDir, ["rev-parse", "--is-inside-work-tree"], {
      env: { PATH: "." },
    });
    expect(dotOldRes.code).not.toBe(0);
    expect(dotOldRes.errorCode).toBe("ENOTSUP");

    // In-place binary replacement preserving byte size and mtime/atime must still fail once downgraded.
    const inPlaceDir = await mkdtemp(join(tmpdir(), "ship-ge-inplace-"));
    dirs.push(inPlaceDir);
    const inPlaceGit = join(inPlaceDir, "git");
    await writeFile(
      inPlaceGit,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.56.1"; exit 0; fi\necho "ok"\n',
      { mode: 0o755 },
    );
    const firstSt = await stat(inPlaceGit);
    const firstInPlace = await defaultGitExec(process.cwd(), ["rev-parse", "--is-inside-work-tree"], {
      env: { PATH: inPlaceDir },
    });
    expect(firstInPlace.code).toBe(0);

    await writeFile(
      inPlaceGit,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.45.0"; exit 0; fi\necho "ok"\n',
      { mode: 0o755 },
    );
    await utimes(inPlaceGit, firstSt.atime, firstSt.mtime);
    const downgradedInPlace = await defaultGitExec(process.cwd(), ["rev-parse", "--is-inside-work-tree"], {
      env: { PATH: inPlaceDir },
    });
    expect(downgradedInPlace.code).not.toBe(0);
    expect(downgradedInPlace.errorCode).toBe("ENOTSUP");

    // S4 (PATH traversal): Relative PATH=../bin through a symlinked working directory follows filesystem '..'.
    const symRoot = await mkdtemp(join(tmpdir(), "ship-ge-s4sym-"));
    dirs.push(symRoot);
    const realParent = join(symRoot, "real", "parent");
    const realWork = join(realParent, "work");
    const realBin = join(realParent, "bin");
    const linkWork = join(symRoot, "link-work");
    await mkdir(realWork, { recursive: true });
    await mkdir(realBin, { recursive: true });
    await writeFile(
      join(realBin, "git"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.56.1"; exit 0; fi\necho "symlink-ok"\n',
      { mode: 0o755 },
    );
    await symlink(realWork, linkWork);
    const symPathRes = await defaultGitExec(linkWork, ["rev-parse", "--is-inside-work-tree"], {
      env: { PATH: "../bin" },
    });
    expect(symPathRes.code).toBe(0);
    expect(symPathRes.stdout.trim()).toBe("symlink-ok");

    // S2: Honor PATH="" for cwd/git, skip bad-shebang launch errors to later entries, and stop at older Git.
    const emptyPathDir = await mkdtemp(join(tmpdir(), "ship-ge-s2empty-"));
    const badShebangDir = await mkdtemp(join(tmpdir(), "ship-ge-s2badsheb-"));
    const goodFallbackDir = await mkdtemp(join(tmpdir(), "ship-ge-s2good-"));
    dirs.push(emptyPathDir, badShebangDir, goodFallbackDir);

    await writeFile(
      join(emptyPathDir, "git"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.56.1"; exit 0; fi\necho "empty-path-ok"\n',
      { mode: 0o755 },
    );
    const emptyPathRes = await defaultGitExec(emptyPathDir, ["rev-parse", "--is-inside-work-tree"], {
      env: { PATH: "" },
    });
    expect(emptyPathRes.code).toBe(0);
    expect(emptyPathRes.stdout.trim()).toBe("empty-path-ok");

    await writeFile(join(badShebangDir, "git"), "#!/nonexistent/ship-interp\necho no\n", { mode: 0o755 });
    await writeFile(
      join(goodFallbackDir, "git"),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "git version 2.56.1"; exit 0; fi\necho "after-bad-shebang"\n',
      { mode: 0o755 },
    );
    const fallbackRes = await defaultGitExec(process.cwd(), ["rev-parse", "--is-inside-work-tree"], {
      env: { PATH: `${badShebangDir}${delimiter}${goodFallbackDir}` },
    });
    expect(fallbackRes.code).toBe(0);
    expect(fallbackRes.stdout.trim()).toBe("after-bad-shebang");

    const oldBeforeGoodRes = await defaultGitExec(process.cwd(), ["rev-parse", "--is-inside-work-tree"], {
      env: { PATH: `${oldBinDir}${delimiter}${goodFallbackDir}` },
    });
    expect(oldBeforeGoodRes.code).not.toBe(0);
    expect(oldBeforeGoodRes.errorCode).toBe("ENOTSUP");

    // S2 (terminal errors): Recursive shebang and symlink loops propagate ELOOP instead of falling through.
    const recShebDir = await mkdtemp(join(tmpdir(), "ship-ge-s2recsheb-"));
    const symLoopDir = await mkdtemp(join(tmpdir(), "ship-ge-s2symloop-"));
    dirs.push(recShebDir, symLoopDir);
    const recShebGit = join(recShebDir, "git");
    await writeFile(recShebGit, `#!${recShebGit}\necho no\n`, { mode: 0o755 });
    const recShebRes = await defaultGitExec(process.cwd(), ["rev-parse", "--is-inside-work-tree"], {
      env: { PATH: `${recShebDir}${delimiter}${goodFallbackDir}` },
    });
    expect(recShebRes.code).not.toBe(0);
    expect(recShebRes.errorCode).toBe("ELOOP");

    await symlink(join(symLoopDir, "git"), join(symLoopDir, "git"));
    const symLoopRes = await defaultGitExec(process.cwd(), ["rev-parse", "--is-inside-work-tree"], {
      env: { PATH: `${symLoopDir}${delimiter}${goodFallbackDir}` },
    });
    expect(symLoopRes.code).not.toBe(0);
    expect(symLoopRes.errorCode).toBe("ELOOP");

    // S2 (argv[0] basename): Preserve `git` basename across a symlink pointing to `git-versioned`.
    const versionedRoot = await mkdtemp(join(tmpdir(), "ship-ge-s2ver-"));
    dirs.push(versionedRoot);
    const verTargetDir = join(versionedRoot, "target");
    const verBinDir = join(versionedRoot, "bin");
    await mkdir(verTargetDir, { recursive: true });
    await mkdir(verBinDir, { recursive: true });
    const { stdout: whichGitOut } = await execFileAsync("which", ["git"]);
    const verGitBin = join(verTargetDir, "git-versioned");
    await copyFile(whichGitOut.trim(), verGitBin);
    await chmod(verGitBin, 0o755);
    await symlink(verGitBin, join(verBinDir, "git"));
    const verRepo = await initEmptyRepo();
    const verRes = await defaultGitExec(verRepo, ["rev-parse", "--is-inside-work-tree"], {
      env: { ...isolatedGitEnv(verRepo), PATH: verBinDir },
    });
    expect(verRes.code).toBe(0);
    expect(verRes.stdout.trim()).toBe("true");

    const mockBinDir = await mkdtemp(join(tmpdir(), "ship-ge-mockgit-"));
    dirs.push(mockBinDir);
    const capturedEnvFile = join(mockBinDir, "lazy.env");
    await writeFile(
      join(mockBinDir, "git"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        '  echo "git version 2.50.0"',
        "  exit 0",
        "fi",
        `printf 'LAZY=%s\\nTERM=%s\\n' "$GIT_NO_LAZY_FETCH" "$GIT_TERMINAL_PROMPT" > ${JSON.stringify(capturedEnvFile)}`,
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    const mockRes = await defaultGitExec(process.cwd(), ["rev-parse", "--is-inside-work-tree"], {
      env: { PATH: mockBinDir, GIT_NO_LAZY_FETCH: "0", GIT_TERMINAL_PROMPT: "1" },
    });
    expect(mockRes.code).toBe(0);
    expect(await readFile(capturedEnvFile, "utf8")).toBe("LAZY=1\nTERM=0\n");

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
    for (const k of keysToDirty) saved[k] = process.env[k];

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
      expect((await defaultGitExec(repoB, ["config", "--get", "ship.indexed"])).code).toBe(1);
      expect((await defaultGitExec(repoB, ["config", "--get", "ship.param"])).code).toBe(1);
      expect((await defaultGitExec(repoB, ["rev-parse", "--is-inside-work-tree"])).code).toBe(0);

      delete process.env.GIT_GLOB_PATHSPECS;
      process.env.GIT_ICASE_PATHSPECS = "1";
      expect((await defaultGitExec(repoB, ["rev-parse", "--is-inside-work-tree"])).code).toBe(0);

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

    // Real partial clone (--filter=blob:none): positive control fetches via uploadpack, defaultGitExec does not.
    const originRepo = await initEmptyRepo();
    const originEnv = isolatedGitEnv(originRepo);
    await execFileAsync("git", ["config", "uploadpack.allowFilter", "true"], {
      cwd: originRepo,
      env: originEnv,
    });
    await execFileAsync("git", ["config", "uploadpack.allowAnySHA1InWant", "true"], {
      cwd: originRepo,
      env: originEnv,
    });
    await writeFile(join(originRepo, "blob.txt"), "promisor-blob-data\n", "utf8");
    await gitCommitAll(originRepo, "init", originEnv);

    const partialBase = await mkdtemp(join(tmpdir(), "ship-ge-partial-"));
    dirs.push(partialBase);
    const partial1 = join(partialBase, "clone1");
    const partial2 = join(partialBase, "clone2");
    const upSentinel = join(partialBase, "uploadpack.ran");
    const upScript = join(partialBase, "uploadpack.sh");
    await writeFile(
      upScript,
      `#!/bin/sh\nprintf 'fetched\\n' > ${JSON.stringify(upSentinel)}\nexec git-upload-pack "$@"\n`,
      { mode: 0o755 },
    );

    await execFileAsync(
      "git",
      [
        "-c",
        "protocol.file.allow=always",
        "clone",
        "--no-local",
        "--filter=blob:none",
        "--no-checkout",
        `file://${originRepo}`,
        partial1,
      ],
      { cwd: partialBase, env: isolatedGitEnv(partialBase) },
    );
    await execFileAsync("git", ["config", "remote.origin.uploadpack", upScript], {
      cwd: partial1,
      env: isolatedGitEnv(partial1),
    });
    await execFileAsync("git", ["cat-file", "-p", "HEAD:blob.txt"], {
      cwd: partial1,
      env: { ...isolatedGitEnv(partial1), GIT_ALLOW_PROTOCOL: "file" },
    });
    expect(existsSync(upSentinel)).toBe(true);
    await rm(upSentinel, { force: true });

    await execFileAsync(
      "git",
      [
        "-c",
        "protocol.file.allow=always",
        "clone",
        "--no-local",
        "--filter=blob:none",
        "--no-checkout",
        `file://${originRepo}`,
        partial2,
      ],
      { cwd: partialBase, env: isolatedGitEnv(partialBase) },
    );
    await execFileAsync("git", ["config", "remote.origin.uploadpack", upScript], {
      cwd: partial2,
      env: isolatedGitEnv(partial2),
    });
    const noFetchEnv = { ...isolatedGitEnv(partial2), GIT_ALLOW_PROTOCOL: "file" };
    const noFetchCat = await defaultGitExec(partial2, ["cat-file", "-p", "HEAD:blob.txt"], {
      env: noFetchEnv,
    });
    expect(noFetchCat.code).not.toBe(0);
    const noFetchDt = await defaultGitExec(partial2, ["diff-tree", "-p", "--root", "HEAD"], {
      env: noFetchEnv,
    });
    expect(noFetchDt.code).not.toBe(0);
    expect(existsSync(upSentinel)).toBe(false);
  });

  it("blocks ext-diff, textconv, gpg verification, and leaves index unchanged on stat-only edits (S1/S6/S10/S16/S17)", async () => {
    const repo = await initEmptyRepo();
    const sentinelDir = await mkdtemp(join(tmpdir(), "ship-ge-sentinels-"));
    dirs.push(sentinelDir);
    const env = isolatedGitEnv(repo);

    await writeFile(join(repo, "file.txt"), "hello world\n", "utf8");
    await writeFile(join(repo, "plain.log"), "plain v1\n", "utf8");
    await writeFile(join(repo, ".gitattributes"), "*.txt diff=evil\n", "utf8");
    const first = await gitCommitAll(repo, "init", env);
    await writeFile(join(repo, "file.txt"), "hello updated\n", "utf8");
    await writeFile(join(repo, "plain.log"), "plain v2\n", "utf8");
    const second = await gitCommitAll(repo, "update", env);

    const { stdout: rawCommit } = await execFileAsync("git", ["cat-file", "-p", second], { cwd: repo, env });
    const sepIdx = rawCommit.indexOf("\n\n");
    const signedRaw =
      rawCommit.slice(0, sepIdx) +
      "\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n fake\n -----END PGP SIGNATURE-----" +
      rawCommit.slice(sepIdx);
    const hashRes = await runProcess("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd: repo,
      env,
      stdin: signedRaw,
    });
    expect(hashRes.code).toBe(0);
    const signedSha = hashRes.stdout.trim();
    await execFileAsync("git", ["update-ref", "refs/heads/signed", signedSha], { cwd: repo, env });

    const extSentinel = join(sentinelDir, "ext.ran");
    const drvSentinel = join(sentinelDir, "drv.ran");
    const txtSentinel = join(sentinelDir, "txt.ran");
    const gpgSentinel = join(sentinelDir, "gpg.ran");
    const extScript = await makeSentinelScript(sentinelDir, "ext.sh", extSentinel);
    const drvScript = await makeSentinelScript(sentinelDir, "drv.sh", drvSentinel);
    const txtScript = await makeSentinelScript(sentinelDir, "txt.sh", txtSentinel);
    const gpgScript = await makeSentinelScript(sentinelDir, "gpg.sh", gpgSentinel);

    await execFileAsync("git", ["config", "diff.external", extScript], { cwd: repo, env });
    await execFileAsync("git", ["config", "diff.evil.command", drvScript], { cwd: repo, env });
    await execFileAsync("git", ["config", "diff.evil.textconv", txtScript], { cwd: repo, env });
    await execFileAsync("git", ["config", "gpg.program", gpgScript], { cwd: repo, env });
    await execFileAsync("git", ["config", "log.showSignature", "true"], { cwd: repo, env });
    await execFileAsync("git", ["config", "format.pretty", "format:%h %G?"], { cwd: repo, env });

    // Positive controls (S10): unhardened git triggers external diff, driver, textconv, and gpg.
    await execFileAsync("git", ["diff-tree", "-p", "--ext-diff", first, second, "--", "file.txt"], { cwd: repo, env });
    expect(existsSync(drvSentinel)).toBe(true);
    await execFileAsync("git", ["diff", first, second, "--", "plain.log"], { cwd: repo, env });
    expect(existsSync(extSentinel)).toBe(true);
    await execFileAsync("git", ["diff-tree", "-p", "--textconv", first, second, "--", "file.txt"], { cwd: repo, env });
    expect(existsSync(txtSentinel)).toBe(true);
    await execFileAsync("git", ["show", "-s", signedSha], { cwd: repo, env });
    expect(existsSync(gpgSentinel)).toBe(true);

    for (const s of [extSentinel, drvSentinel, txtSentinel, gpgSentinel]) {
      await rm(s, { force: true });
    }

    const dtTwo = await defaultGitExec(repo, ["diff-tree", "-p", first, second], { env });
    expect(dtTwo.code).toBe(0);
    const dtOne = await defaultGitExec(repo, ["diff-tree", "-p", signedSha], { env });
    expect(dtOne.code).toBe(0);
    const fer = await defaultGitExec(repo, ["for-each-ref", "--count=2", "refs/heads"], { env });
    expect(fer.code).toBe(0);
    for (const flag of ["-p", "-t", "-s", "-e"]) {
      const cf = await defaultGitExec(repo, ["cat-file", flag, "HEAD:file.txt"], { env });
      expect(cf.code).toBe(0);
    }

    for (const s of [extSentinel, drvSentinel, txtSentinel, gpgSentinel]) {
      expect(existsSync(s)).toBe(false);
    }

    // S6: stat-only modification on a tracked file must leave .git/index byte-for-byte identical.
    const indexPath = join(repo, ".git", "index");
    const indexBefore = await readFile(indexPath);
    const future = new Date(Date.now() + 10_000);
    await utimes(join(repo, "file.txt"), future, future);

    expect((await defaultGitExec(repo, ["diff-tree", "-r", first, second], { env })).code).toBe(0);
    expect((await defaultGitExec(repo, ["rev-parse", "HEAD"], { env })).code).toBe(0);
    expect((await defaultGitExec(repo, ["ls-tree", "-r", "HEAD"], { env })).code).toBe(0);
    const indexAfter = await readFile(indexPath);
    expect(Buffer.compare(indexBefore, indexAfter)).toBe(0);

    // Split-index reads leave .git/index bytes untouched and report the real index path.
    await execFileAsync("git", ["update-index", "--split-index"], { cwd: repo, env });
    const splitIndexBefore = await readFile(indexPath);

    const idxPathRes = await defaultGitExec(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"], { env });
    expect(idxPathRes.code).toBe(0);
    expect(idxPathRes.stdout.trim()).toBe(indexPath);
    expect(existsSync(idxPathRes.stdout.trim())).toBe(true);

    expect((await defaultGitExec(repo, ["diff-tree", "-r", first, second], { env })).code).toBe(0);
    expect((await defaultGitExec(repo, ["diff-tree", "-p", second], { env })).code).toBe(0);
    expect((await defaultGitExec(repo, ["rev-parse", "HEAD"], { env })).code).toBe(0);
    await defaultGitExec(repo, ["rev-parse", ":file.txt"], { env });
    expect((await defaultGitExec(repo, ["cat-file", "-p", "HEAD:file.txt"], { env })).code).toBe(0);
    await defaultGitExec(repo, ["cat-file", "-p", ":file.txt"], { env });
    expect((await defaultGitExec(repo, ["cat-file", "--batch"], { env, stdin: ":file.txt\n" })).code).toBe(0);
    expect((await defaultGitExec(repo, ["ls-tree", "-r", "HEAD"], { env })).code).toBe(0);

    expect(Buffer.compare(splitIndexBefore, await readFile(indexPath))).toBe(0);
  });

  it("preserves staged .gitattributes, staged objects, and SHA-256 split-index reads without mutating .git/index bytes (S1)", async () => {
    const repo = await initEmptyRepo();
    const env = isolatedGitEnv(repo);
    await writeFile(join(repo, "file.txt"), "hello\n", "utf8");
    const first = await gitCommitAll(repo, "init", env);
    await writeFile(join(repo, "file.txt"), "world\n", "utf8");
    const second = await gitCommitAll(repo, "second", env);

    // Stage .gitattributes absent from the worktree and a staged-only blob absent from commits.
    await writeFile(join(repo, ".gitattributes"), "*.txt -diff\n", "utf8");
    await writeFile(join(repo, "staged.txt"), "staged-only\n", "utf8");
    await execFileAsync("git", ["add", ".gitattributes", "staged.txt"], { cwd: repo, env });
    await rm(join(repo, ".gitattributes"));

    await execFileAsync("git", ["update-index", "--split-index"], { cwd: repo, env });
    const indexPath = join(repo, ".git", "index");
    const splitIndexBefore = await readFile(indexPath);

    const execDiff = await defaultGitExec(repo, ["diff-tree", "-p", first, second], { env });
    expect(execDiff.code).toBe(0);
    expect(execDiff.stdout).toContain("Binary files");

    const batchStaged = await defaultGitExec(repo, ["cat-file", "--batch"], { env, stdin: ":staged.txt\n" });
    expect(batchStaged.code).toBe(0);
    expect(batchStaged.stdout).toContain("staged-only\n");
    expect(batchStaged.stdout).not.toContain("missing");

    const catStaged = await defaultGitExec(repo, ["cat-file", "-p", ":staged.txt"], { env });
    expect(catStaged.code).toBe(0);
    expect(catStaged.stdout).toBe("staged-only\n");

    const revStaged = await defaultGitExec(repo, ["rev-parse", ":staged.txt"], { env });
    expect(revStaged.code).toBe(0);
    expect(revStaged.stdout.trim()).toMatch(/^[0-9a-f]{40}$/u);

    expect(Buffer.compare(splitIndexBefore, await readFile(indexPath))).toBe(0);

    const nativeDiff = await execFileAsync("git", ["diff-tree", "-p", first, second], { cwd: repo, env });
    expect(execDiff.stdout).toBe(nativeDiff.stdout);

    // SHA-256 split-index repository support.
    const s256Repo = await mkdtemp(join(tmpdir(), "ship-ge-s256-split-"));
    dirs.push(s256Repo);
    const s256Env = isolatedGitEnv(s256Repo);
    await execFileAsync("git", ["init", "--object-format=sha256", "-b", "main"], { cwd: s256Repo, env: s256Env });
    await writeFile(join(s256Repo, "x.txt"), "s256\n", "utf8");
    await gitCommitAll(s256Repo, "init", s256Env);
    await execFileAsync("git", ["update-index", "--split-index"], { cwd: s256Repo, env: s256Env });
    const s256IndexPath = join(s256Repo, ".git", "index");
    const s256IndexBefore = await readFile(s256IndexPath);

    const s256Cat = await defaultGitExec(s256Repo, ["cat-file", "-p", ":x.txt"], { env: s256Env });
    expect(s256Cat.code).toBe(0);
    expect(s256Cat.stdout).toBe("s256\n");
    expect(Buffer.compare(s256IndexBefore, await readFile(s256IndexPath))).toBe(0);
  });

  it("operates without any TMPDIR dependency even when TMPDIR is an unusable regular file", async () => {
    const repo = await initEmptyRepo();
    const env = isolatedGitEnv(repo);
    await writeFile(join(repo, "file.txt"), "one\n", "utf8");
    const first = await gitCommitAll(repo, "init", env);
    await writeFile(join(repo, "file.txt"), "two\n", "utf8");
    const second = await gitCommitAll(repo, "second", env);
    await execFileAsync("git", ["config", "--global", "ship.globalKey", "global-ok"], { cwd: repo, env });

    const tmpFixtureDir = await mkdtemp(join(tmpdir(), "ship-ge-notmp-"));
    dirs.push(tmpFixtureDir);
    const badTmpFile = join(tmpFixtureDir, "not-a-dir");
    await writeFile(badTmpFile, "file\n", "utf8");

    const savedTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = badTmpFile;
    try {
      const diffOk = await defaultGitExec(repo, ["diff-tree", "-r", first, second], { env });
      expect(diffOk.code).toBe(0);

      const metadataOk = await defaultGitExec(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"], {
        env,
      });
      expect(metadataOk.code).toBe(0);

      const configGlobalOk = await defaultGitExec(repo, ["config", "--global", "--list"], { env });
      expect(configGlobalOk.code).toBe(0);

      const configListOk = await defaultGitExec(repo, ["config", "--list"], { env });
      expect(configListOk.code).toBe(0);
    } finally {
      if (savedTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmpdir;
    }
  });

  it("preserves repository callback-related config values in allowlisted config queries without executing them (S4)", async () => {
    const repo = await initEmptyRepo();
    const sentinelDir = await mkdtemp(join(tmpdir(), "ship-ge-cfg-"));
    dirs.push(sentinelDir);
    const env = isolatedGitEnv(repo);
    const extSentinel = join(sentinelDir, "ext.ran");
    const extScript = await makeSentinelScript(sentinelDir, "ext.sh", extSentinel);

    await execFileAsync("git", ["config", "core.fsmonitor", "true"], { cwd: repo, env });
    await execFileAsync("git", ["config", "diff.external", extScript], { cwd: repo, env });

    const fsm = await defaultGitExec(repo, ["config", "--get", "core.fsmonitor"], { env });
    expect(fsm.code).toBe(0);
    expect(fsm.stdout.trim()).toBe("true");

    const ext = await defaultGitExec(repo, ["config", "--get", "diff.external"], { env });
    expect(ext.code).toBe(0);
    expect(ext.stdout.trim()).toBe(extScript);

    const list = await defaultGitExec(repo, ["config", "--list", "--show-scope"], { env });
    expect(list.code).toBe(0);
    expect(list.stdout).not.toContain("command\tcore.fsmonitor=false");
    expect(list.stdout).not.toContain("command\tdiff.external=");
    expect(existsSync(extSentinel)).toBe(false);
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

  it("kills the process tree and enforces the cleanup deadline when a detached descendant holds pipes open (S8/S21)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-ge-tree-"));
    dirs.push(dir);
    const pidsToCleanup: number[] = [];

    const spawnTreeScript = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const [parentFile, openChildFile, closedChildFile] = process.argv.slice(1);
      process.on("SIGTERM", () => {});
      const childBody = 'const fs = require("node:fs"); process.on("SIGTERM", () => {}); fs.writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.exit(0), 10000);';
      spawn(process.execPath, ["-e", childBody, openChildFile], { stdio: "inherit" });
      spawn(process.execPath, ["-e", childBody, closedChildFile], { stdio: "ignore" });
      fs.writeFileSync(parentFile, String(process.pid));
      setTimeout(() => process.exit(0), 10000);
    `;

    const detachedHolderScript = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const [parentFile, detachedFile, mode] = process.argv.slice(1);
      process.on("SIGTERM", () => {});
      const detached = spawn(
        process.execPath,
        ["-e", 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.exit(0), 10000);', detachedFile],
        { detached: true, stdio: ["ignore", 1, 2] },
      );
      detached.unref();
      fs.writeFileSync(parentFile, String(process.pid));
      if (mode === "flood") {
        const chunk = Buffer.alloc(64 * 1024, 66);
        const spam = () => { process.stdout.write(chunk); setImmediate(spam); };
        spam();
      } else {
        setTimeout(() => process.exit(0), 10000);
      }
    `;

    try {
      // S21: abort & timeout kill parent, open-stdio grandchild, and closed-stdio grandchild.
      const abortPids = await (async () => {
        const ac = new AbortController();
        const pf = join(dir, "ap.pid");
        const of = join(dir, "ao.pid");
        const cf = join(dir, "ac.pid");
        const p = runProcess(process.execPath, ["-e", spawnTreeScript, pf, of, cf], {
          cwd: dir,
          signal: ac.signal,
          timeoutMs: 10_000,
        });
        const pids = await Promise.all([waitForPidFile(pf), waitForPidFile(of), waitForPidFile(cf)]);
        pidsToCleanup.push(...pids);
        ac.abort();
        const res = await p;
        expect(res.errorCode).toBe("ABORT_ERR");
        return pids;
      })();
      for (const pid of abortPids) expect(isPidAlive(pid)).toBe(false);

      const toPids = await (async () => {
        const pf = join(dir, "tp.pid");
        const of = join(dir, "to.pid");
        const cf = join(dir, "tc.pid");
        const p = runProcess(process.execPath, ["-e", spawnTreeScript, pf, of, cf], {
          cwd: dir,
          timeoutMs: 200,
        });
        const pids = await Promise.all([waitForPidFile(pf), waitForPidFile(of), waitForPidFile(cf)]);
        pidsToCleanup.push(...pids);
        const res = await p;
        expect(res.errorCode).toBe("ETIMEDOUT");
        return pids;
      })();
      for (const pid of toPids) expect(isPidAlive(pid)).toBe(false);

      // S8: detached pipe-holding grandchild must not hang abort, timeout, or maxBuffer settlement.
      for (const mode of ["abort", "timeout", "flood"] as const) {
        const pf = join(dir, `det-${mode}-p.pid`);
        const df = join(dir, `det-${mode}-d.pid`);
        const ac = new AbortController();
        const t0 = performance.now();
        const p = runProcess(process.execPath, ["-e", detachedHolderScript, pf, df, mode], {
          cwd: dir,
          ...(mode === "abort" ? { signal: ac.signal, timeoutMs: 10_000 } : {}),
          ...(mode === "timeout" ? { timeoutMs: 120 } : {}),
          ...(mode === "flood" ? { maxBuffer: 64 * 1024, timeoutMs: 0 } : {}),
        });
        const [ppid, dpid] = await Promise.all([waitForPidFile(pf), waitForPidFile(df)]);
        pidsToCleanup.push(ppid, dpid);
        if (mode === "abort") ac.abort();
        const res = await p;
        expect(performance.now() - t0).toBeLessThan(1500);
        expect(res.code).not.toBe(0);
        expect(res.errorCode).toBe(
          mode === "abort"
            ? "ABORT_ERR"
            : mode === "timeout"
              ? "ETIMEDOUT"
              : "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        );
      }

      // S3: Normal leader exit (code 0) still tears down lingering same-group descendants with closed stdio.
      const orphanFile = join(dir, "normal-orphan.pid");
      const normalLeaderScript = `
        const { spawn } = require("node:child_process");
        const fs = require("node:fs");
        spawn(
          process.execPath,
          ["-e", 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.exit(0), 10000);', ${JSON.stringify(orphanFile)}],
          { stdio: "ignore" },
        );
        const timer = setInterval(() => {
          if (fs.existsSync(${JSON.stringify(orphanFile)})) {
            clearInterval(timer);
            process.exit(0);
          }
        }, 5);
      `;
      const normalRes = await runProcess(process.execPath, ["-e", normalLeaderScript], {
        cwd: dir,
        timeoutMs: 5000,
      });
      expect(normalRes.code).toBe(0);
      const orphanPid = Number.parseInt((await readFile(orphanFile, "utf8")).trim(), 10);
      expect(orphanPid).toBeGreaterThan(0);
      pidsToCleanup.push(orphanPid);
      expect(isPidAlive(orphanPid)).toBe(false);

      // S3: Inherited stdout held by a same-group descendant tears down on leader exit without ETIMEDOUT.
      const inheritOrphanFile = join(dir, "inherit-orphan.pid");
      const inheritLeaderScript = `
        const { spawn } = require("node:child_process");
        const fs = require("node:fs");
        spawn(
          process.execPath,
          ["-e", 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.exit(0), 10000);', ${JSON.stringify(inheritOrphanFile)}],
          { stdio: "inherit" },
        );
        const timer = setInterval(() => {
          if (fs.existsSync(${JSON.stringify(inheritOrphanFile)})) {
            clearInterval(timer);
            process.stdout.write("leader-stdout\\n", () => process.exit(0));
          }
        }, 5);
      `;
      const inheritRes = await runProcess(process.execPath, ["-e", inheritLeaderScript], {
        cwd: dir,
        timeoutMs: 350,
      });
      expect(inheritRes.code).toBe(0);
      expect(inheritRes.errorCode).toBeUndefined();
      expect(inheritRes.stdout.trim()).toBe("leader-stdout");
      const inheritOrphanPid = Number.parseInt((await readFile(inheritOrphanFile, "utf8")).trim(), 10);
      expect(inheritOrphanPid).toBeGreaterThan(0);
      pidsToCleanup.push(inheritOrphanPid);
      expect(isPidAlive(inheritOrphanPid)).toBe(false);

      // Detached child keeping stdout open past leader exit obeys caller deadline instead of truncating at 250ms.
      const detachedDelayedFile = join(dir, "detached-delayed.pid");
      const detachedDelayedScript = `
        const { spawn } = require("node:child_process");
        const fs = require("node:fs");
        const child = spawn(
          process.execPath,
          [
            "-e",
            'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.stdout.write("detached-final\\\\n", () => process.exit(0)), 350);',
            ${JSON.stringify(detachedDelayedFile)},
          ],
          { detached: true, stdio: ["ignore", 1, 2] },
        );
        child.unref();
        const timer = setInterval(() => {
          if (fs.existsSync(${JSON.stringify(detachedDelayedFile)})) {
            clearInterval(timer);
            process.stdout.write("leader-first\\n", () => process.exit(0));
          }
        }, 5);
      `;
      const delayedRes = await runProcess(process.execPath, ["-e", detachedDelayedScript], {
        cwd: dir,
        timeoutMs: 1000,
      });
      pidsToCleanup.push(Number.parseInt((await readFile(detachedDelayedFile, "utf8")).trim(), 10));
      expect(delayedRes.code).toBe(0);
      expect(delayedRes.errorCode).toBeUndefined();
      expect(delayedRes.stdout).toContain("leader-first\n");
      expect(delayedRes.stdout).toContain("detached-final\n");

      const detachedHungFile = join(dir, "detached-hung.pid");
      const detachedHungScript = `
        const { spawn } = require("node:child_process");
        const fs = require("node:fs");
        const child = spawn(
          process.execPath,
          [
            "-e",
            'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.exit(0), 2000);',
            ${JSON.stringify(detachedHungFile)},
          ],
          { detached: true, stdio: ["ignore", 1, 2] },
        );
        child.unref();
        const timer = setInterval(() => {
          if (fs.existsSync(${JSON.stringify(detachedHungFile)})) {
            clearInterval(timer);
            process.stdout.write("leader-only\\n", () => process.exit(0));
          }
        }, 5);
      `;
      const hungRes = await runProcess(process.execPath, ["-e", detachedHungScript], {
        cwd: dir,
        timeoutMs: 120,
      });
      pidsToCleanup.push(Number.parseInt((await readFile(detachedHungFile, "utf8")).trim(), 10));
      expect(hungRes.code).not.toBe(0);
      expect(hungRes.errorCode).toBe("ETIMEDOUT");
    } finally {
      for (const pid of pidsToCleanup) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already exited.
        }
      }
    }
  });

  it("keeps cleanup timers referenced in Node 20+ .mjs callers so standalone callers await full process-group teardown (S5/S9)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-ge-standalone-"));
    dirs.push(dir);
    const parentPidFile = join(dir, "parent.pid");
    const grandchildPidFile = join(dir, "grandchild.pid");
    const gitExecUrl = await transpileGitExecModule(dir);

    const standaloneScript = `
      import { readFile } from "node:fs/promises";
      import { runProcess } from ${JSON.stringify(gitExecUrl)};

      const parentBody = \`
        const { spawn } = require("node:child_process");
        const fs = require("node:fs");
        spawn(process.execPath, ["-e", 'const fs = require("node:fs"); process.on("SIGTERM", () => {}); fs.writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.exit(0), 10000);', ${JSON.stringify(grandchildPidFile)}], { stdio: "ignore" });
        process.on("SIGTERM", () => process.exit(0));
        fs.writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid));
        setTimeout(() => process.exit(0), 10000);
      \`;

      const ac = new AbortController();
      const promise = runProcess(process.execPath, ["-e", parentBody], {
        cwd: ${JSON.stringify(dir)},
        signal: ac.signal,
        timeoutMs: 10_000,
      });

      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        try {
          const p = Number.parseInt((await readFile(${JSON.stringify(parentPidFile)}, "utf8")).trim(), 10);
          const g = Number.parseInt((await readFile(${JSON.stringify(grandchildPidFile)}, "utf8")).trim(), 10);
          if (p > 0 && g > 0) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 15));
      }
      ac.abort();
      const res = await promise;
      console.log("SETTLED:" + res.errorCode);
    `;

    const scriptPath = join(dir, "standalone.mjs");
    await writeFile(scriptPath, standaloneScript, "utf8");
    let grandchildPid = 0;
    try {
      const { stdout } = await execFileAsync(process.execPath, [scriptPath], { cwd: dir });
      expect(stdout.trim()).toBe("SETTLED:ABORT_ERR");
      grandchildPid = Number.parseInt((await readFile(grandchildPidFile, "utf8")).trim(), 10);
      expect(grandchildPid).toBeGreaterThan(0);
      expect(isPidAlive(grandchildPid)).toBe(false);
    } finally {
      if (grandchildPid > 0) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // Already exited.
        }
      }
    }
  });
});
