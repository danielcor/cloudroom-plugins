import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
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
      ["rev-parse", "--git-path", "index", ":file.txt"],
      ["rev-parse", "--git-path", "index", "--", "HEAD"],
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

    // S4: split-index sharedindex.* mtime and .git/index bytes must remain untouched across plumbing reads.
    await execFileAsync("git", ["update-index", "--split-index"], { cwd: repo, env });
    const sharedFile = (await readdir(join(repo, ".git"))).find((f) => f.startsWith("sharedindex."));
    expect(sharedFile).toBeDefined();
    const sharedPath = join(repo, ".git", sharedFile!);
    const oldTime = new Date("2020-01-01T00:00:00Z");
    await utimes(sharedPath, oldTime, oldTime);
    const sharedMtimeBefore = (await stat(sharedPath)).mtimeMs;
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

    expect((await stat(sharedPath)).mtimeMs).toBe(sharedMtimeBefore);
    expect(Buffer.compare(splitIndexBefore, await readFile(indexPath))).toBe(0);
  });

  it("converts temporary directory setup and cleanup failures into ExecResult diagnostics (S15)", async () => {
    const repo = await initEmptyRepo();
    const env = isolatedGitEnv(repo);
    await writeFile(join(repo, "file.txt"), "one\n", "utf8");
    const first = await gitCommitAll(repo, "init", env);
    await writeFile(join(repo, "file.txt"), "two\n", "utf8");
    const second = await gitCommitAll(repo, "second", env);

    const tmpFixtureDir = await mkdtemp(join(tmpdir(), "ship-ge-s15-"));
    dirs.push(tmpFixtureDir);
    const badTmpFile = join(tmpFixtureDir, "not-a-dir");
    await writeFile(badTmpFile, "file\n", "utf8");

    const savedTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = badTmpFile;
    try {
      const tmpFailPlumbing = await defaultGitExec(repo, ["diff-tree", "-r", first, second], { env });
      expect(tmpFailPlumbing.code).not.toBe(0);
      expect(tmpFailPlumbing.errorCode).toBe("ENOTDIR");

      const metadataStillOk = await defaultGitExec(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"], { env });
      expect(metadataStillOk.code).toBe(0);
    } finally {
      if (savedTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmpdir;
    }

    const parentTmp = await mkdtemp(join(tmpdir(), "ship-ge-rmfail-"));
    dirs.push(parentTmp);
    const mockBinDir = join(tmpFixtureDir, "bin");
    await mkdir(mockBinDir, { recursive: true });
    await writeFile(
      join(mockBinDir, "git"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        '  echo "git version 2.56.1"',
        "  exit 0",
        "fi",
        'chmod 0500 "$(dirname "$(dirname "$GIT_INDEX_FILE")")"',
        'if [ "$SHIP_TEST_FAIL" = "1" ]; then',
        '  echo "semantic failure" >&2',
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    process.env.TMPDIR = parentTmp;
    try {
      try {
        const cleanCmdRmFail = await defaultGitExec(repo, ["diff-tree", "-r", first, second], {
          env: { ...env, PATH: `${mockBinDir}:${env.PATH ?? ""}` },
        });
        expect(cleanCmdRmFail.code).toBe(1);
        expect(cleanCmdRmFail.errorCode).toBe("EACCES");
        expect(cleanCmdRmFail.stderr).toContain("Failed to remove temporary index directory");
      } finally {
        await chmod(parentTmp, 0o700);
      }

      try {
        const errCmdRmFail = await defaultGitExec(repo, ["diff-tree", "-r", first, second], {
          env: { ...env, PATH: `${mockBinDir}:${env.PATH ?? ""}`, SHIP_TEST_FAIL: "1" },
        });
        expect(errCmdRmFail.code).toBe(1);
        expect(errCmdRmFail.errorCode).toBe("EACCES");
        expect(errCmdRmFail.stderr).toContain("semantic failure");
        expect(errCmdRmFail.stderr).toContain("Failed to remove temporary index directory");
      } finally {
        await chmod(parentTmp, 0o700);
      }
    } finally {
      await chmod(parentTmp, 0o700);
      if (savedTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmpdir;
    }
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

  it("keeps cleanup timers referenced so standalone callers await full process-group teardown (S9)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-ge-standalone-"));
    dirs.push(dir);
    const parentPidFile = join(dir, "parent.pid");
    const grandchildPidFile = join(dir, "grandchild.pid");
    const gitExecUrl = pathToFileURL(join(process.cwd(), "src", "safety", "git-exec.ts")).href;

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

    const scriptPath = join(dir, "standalone.mts");
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
