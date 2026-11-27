import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  errorCode?: string;
  stdoutBuffer?: Buffer;
}

export interface GitExecOptions {
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  binary?: boolean;
  timeoutMs?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
}

export type GitExec = (cwd: string, args: readonly string[], opts?: GitExecOptions) => Promise<ExecResult>;

export function mergeEnv(base: NodeJS.ProcessEnv, overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  if (!overrides) return out;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete out[k];
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const SAFE_GIT_FLAGS = [
  "--no-pager",
  "-c",
  "safe.bareRepository=explicit",
  "--no-replace-objects",
  "-c",
  "core.commitGraph=false",
  "-c",
  "core.multiPackIndex=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "diff.submodule=short",
  "-c",
  "diff.autoRefreshIndex=false",
  "-c",
  "format.pretty=medium",
  "-c",
  "log.showSignature=false",
  "-c",
  "merge.renormalize=false",
  "--literal-pathspecs",
  "--no-optional-locks",
] as const;

const REPO_LOCAL_GIT_ENV_KEYS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_SUPER_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_ICASE_PATHSPECS",
  "GIT_LITERAL_PATHSPECS",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
  "GIT_PAGER",
  "GIT_ATTR_NOSYSTEM",
  "GIT_ATTR_SOURCE",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
]);

const NON_REPO_CLEAR_KEYS = new Set([
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
]);

const GIT_CONFIG_INDEXED_RE = /^GIT_CONFIG_(?:KEY|VALUE)_/u;

function stripRepoLocalGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || REPO_LOCAL_GIT_ENV_KEYS.has(k) || GIT_CONFIG_INDEXED_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Remove all Git config and callback overrides from `env` for internal runner queries. */
function cleanInternalConfigEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (
      v === undefined ||
      k === "GIT_ATTR_SOURCE" ||
      k.startsWith("GIT_CONFIG") ||
      GIT_CONFIG_INDEXED_RE.test(k)
    ) {
      continue;
    }
    out[k] = v;
  }
  out.GIT_CONFIG_NOSYSTEM = "1";
  out.GIT_CONFIG_GLOBAL = "/dev/null";
  out.GIT_CONFIG_SYSTEM = "/dev/null";
  out.GIT_CONFIG_COUNT = "0";
  out.GIT_ATTR_NOSYSTEM = "1";
  out.GIT_PAGER = "cat";
  out.GIT_TERMINAL_PROMPT = "0";
  out.GIT_TEST_COMMIT_GRAPH = "0";
  out.GIT_NO_LAZY_FETCH = "1";
  return out;
}

/** Remove repo-pointing environment variables in addition to internal config overrides. */
function cleanNoRepoEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = cleanInternalConfigEnv(env);
  for (const k of NON_REPO_CLEAR_KEYS) {
    delete out[k];
  }
  return out;
}

const MIN_GIT_MAJOR = 2;
const MIN_GIT_MINOR = 45;
const MIN_GIT_PATCH = 1;
const GIT_VERSION_RE = /\bgit version (\d+)\.(\d+)(?:\.(\d+))?/u;
const verifiedGitBinaryCache = new Set<string>();

export function parseGitVersion(output: string): { major: number; minor: number; patch: number } | null {
  const m = GIT_VERSION_RE.exec(output);
  if (!m) return null;
  const major = Number.parseInt(m[1]!, 10);
  const minor = Number.parseInt(m[2]!, 10);
  const patch = m[3] ? Number.parseInt(m[3], 10) : 0;
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) return null;
  return { major, minor, patch };
}

export function isSupportedGitVersion(output: string): boolean {
  const parsed = parseGitVersion(output);
  if (!parsed) return false;
  if (parsed.major !== MIN_GIT_MAJOR) return parsed.major > MIN_GIT_MAJOR;
  if (parsed.minor !== MIN_GIT_MINOR) return parsed.minor > MIN_GIT_MINOR;
  return parsed.patch >= MIN_GIT_PATCH;
}

interface ResolvedGitBinary {
  path: string;
  cacheKey: string;
}

async function resolveGitBinary(cwd: string, pathEnv: string | undefined): Promise<ResolvedGitBinary | null> {
  if (pathEnv === undefined || pathEnv === "") return null;
  const exeName = process.platform === "win32" ? "git.exe" : "git";
  for (const entry of pathEnv.split(delimiter)) {
    const dir = resolve(cwd, entry || ".");
    const candidate = join(dir, exeName);
    try {
      await access(candidate, constants.X_OK);
      const st = await stat(candidate);
      if (!st.isFile()) continue;
      const realBin = await realpath(candidate);
      return {
        path: realBin,
        cacheKey: `${realBin}\0${st.dev}:${st.ino}:${st.mtimeMs}:${st.size}`,
      };
    } catch {
      continue;
    }
  }
  return null;
}

type StopReason = "timeout" | "abort" | "maxBuffer";
const CLEANUP_DEADLINE_MS = 250;

/** Run an external binary with bounded stdio buffers, wall-clock timeout, abort support, and POSIX process-group cleanup. */
export function runProcess(
  command: string,
  args: readonly string[],
  opts: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
    binary?: boolean;
    timeoutMs?: number;
    maxBuffer?: number;
    signal?: AbortSignal;
  },
): Promise<ExecResult> {
  const buildResult = (
    code: number,
    stdoutBuf: Buffer,
    stderrText: string,
    errorCode?: string,
  ): ExecResult => ({
    code,
    stdout: opts.binary ? "" : stdoutBuf.toString("utf8"),
    stderr: stderrText,
    ...(errorCode ? { errorCode } : {}),
    ...(opts.binary ? { stdoutBuffer: stdoutBuf } : {}),
  });

  if (opts.signal?.aborted) {
    return Promise.resolve(buildResult(1, Buffer.alloc(0), "Operation aborted.", "ABORT_ERR"));
  }

  return new Promise((resolvePromise) => {
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const maxBuffer = opts.maxBuffer ?? 10 * 1024 * 1024;
    const useProcessGroup = process.platform !== "win32";

    let child: ChildProcess | undefined;
    let stdinErr: NodeJS.ErrnoException | undefined;
    let stdinFinished = opts.stdin === undefined || opts.stdin.length === 0;
    let settled = false;
    let childExited = false;
    let stopReason: StopReason | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (opts.signal && onAbort) {
        opts.signal.removeEventListener("abort", onAbort);
      }
    };

    const signalTree = (sig: NodeJS.Signals) => {
      const pid = child?.pid;
      if (pid === undefined) return;
      if (useProcessGroup) {
        try {
          process.kill(-pid, sig);
          return;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
        }
      }
      if (!childExited) {
        try {
          child?.kill(sig);
        } catch {
          // Child already exited.
        }
      }
    };

    const isGroupAlive = (): boolean => {
      const pid = child?.pid;
      if (!useProcessGroup || pid === undefined) return false;
      try {
        process.kill(-pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };

    const waitForGroupExit = async (maxWaitMs = 200): Promise<void> => {
      if (!useProcessGroup || child?.pid === undefined || !isGroupAlive()) return;
      // Escalate immediately when a child closes stdio while leaving a process-group descendant alive.
      signalTree("SIGKILL");
      const deadline = Date.now() + maxWaitMs;
      while (isGroupAlive() && Date.now() < deadline) {
        await new Promise<void>((r) => {
          // Keep timer referenced so standalone callers do not exit before group cleanup finishes.
          setTimeout(r, 5);
        });
      }
    };

    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimers();

      if (child?.stdin && !stdinFinished && !child.stdin.writableFinished) {
        child.stdin.destroy();
      }

      void (async () => {
        if (stopReason !== undefined) {
          await waitForGroupExit(200);
        }

        const stdoutBuf = Buffer.concat(stdoutChunks);
        const stderrText = Buffer.concat(stderrChunks).toString("utf8");

        if (stopReason === "abort") {
          resolvePromise(buildResult(1, stdoutBuf, stderrText || "Operation aborted.", "ABORT_ERR"));
          return;
        }
        if (stopReason === "timeout") {
          const timeoutMsg = `Process timed out after ${timeoutMs}ms.`;
          resolvePromise(
            buildResult(1, stdoutBuf, stderrText ? `${stderrText}\n${timeoutMsg}` : timeoutMsg, "ETIMEDOUT"),
          );
          return;
        }
        if (stopReason === "maxBuffer") {
          const overflowMsg = `maxBuffer length (${maxBuffer}) exceeded.`;
          resolvePromise(
            buildResult(
              1,
              stdoutBuf,
              stderrText ? `${stderrText}\n${overflowMsg}` : overflowMsg,
              "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            ),
          );
          return;
        }

        const writeComplete = stdinFinished || Boolean(child?.stdin?.writableFinished);
        if (code === 0 && signal === null) {
          if (stdinErr || !writeComplete) {
            const msg = stdinErr?.message ?? "stdin closed before write finished";
            resolvePromise(
              buildResult(1, stdoutBuf, stderrText ? `${stderrText}\n${msg}` : msg, stdinErr?.code ?? "EPIPE"),
            );
            return;
          }
          resolvePromise(buildResult(0, stdoutBuf, stderrText));
          return;
        }

        resolvePromise(buildResult(code ?? 1, stdoutBuf, stderrText, stdinErr?.code));
      })();
    };

    const scheduleForcedCleanup = () => {
      if (settled || cleanupTimer) return;
      // Keep cleanup deadline referenced so a detached pipe-holder cannot hang shutdown or leave early.
      cleanupTimer = setTimeout(() => {
        if (settled) return;
        signalTree("SIGKILL");
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        child?.stdin?.destroy();
        settle(null, "SIGKILL");
      }, CLEANUP_DEADLINE_MS);
    };

    const startTermination = (reason: StopReason, graceMs: number) => {
      if (settled || stopReason !== undefined) return;
      stopReason = reason;
      if (reason === "maxBuffer" || graceMs <= 0) {
        signalTree("SIGKILL");
        scheduleForcedCleanup();
        return;
      }
      signalTree("SIGTERM");
      // Keep grace timer referenced so standalone event loops stay alive until SIGKILL escalation completes.
      killTimer = setTimeout(() => {
        if (settled) return;
        signalTree("SIGKILL");
        scheduleForcedCleanup();
      }, graceMs);
    };

    const attachStreamCollector = (
      stream: NodeJS.ReadableStream | null | undefined,
      chunks: Buffer[],
      getBytes: () => number,
      setBytes: (next: number) => void,
    ) => {
      stream?.on("data", (rawChunk: Buffer | string) => {
        if (stopReason === "maxBuffer") return;
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        const nextBytes = getBytes() + chunk.length;
        if (nextBytes > maxBuffer) {
          startTermination("maxBuffer", 0);
          return;
        }
        chunks.push(chunk);
        setBytes(nextBytes);
      });
    };

    try {
      child = spawn(command, [...args], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: useProcessGroup,
      });
    } catch (err) {
      const anyErr = err as NodeJS.ErrnoException;
      resolvePromise(buildResult(1, Buffer.alloc(0), anyErr.message, anyErr.code));
      return;
    }

    attachStreamCollector(
      child.stdout,
      stdoutChunks,
      () => stdoutBytes,
      (n) => {
        stdoutBytes = n;
      },
    );
    attachStreamCollector(
      child.stderr,
      stderrChunks,
      () => stderrBytes,
      (n) => {
        stderrBytes = n;
      },
    );

    child.once("exit", () => {
      childExited = true;
    });

    child.once("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolvePromise(buildResult(1, Buffer.alloc(0), err.message, err.code));
    });

    child.once("close", (code, signal) => {
      settle(code, signal);
    });

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        const graceMs = Math.min(200, Math.max(50, Math.floor(timeoutMs / 4)));
        startTermination("timeout", graceMs);
      }, timeoutMs);
      timeoutTimer.unref?.();
    }
    if (opts.signal) {
      onAbort = () => startTermination("abort", 150);
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (child.stdin) {
      child.stdin.on("error", (e: NodeJS.ErrnoException) => {
        if (opts.stdin !== undefined && !stdinErr) stdinErr = e;
      });
      if (opts.stdin !== undefined && opts.stdin.length > 0) {
        child.stdin.once("finish", () => {
          stdinFinished = true;
        });
        child.stdin.end(opts.stdin);
      } else {
        child.stdin.end();
      }
    }
  });
}

interface SubcommandRule {
  exact: Set<string>;
  valueFlags?: Map<string, RegExp | undefined>;
  patterns?: RegExp[];
  inject?: readonly string[];
  isolatedMergeTree?: boolean;
  validate?: (flags: string[], positionals: string[]) => boolean;
}

const SUBCOMMAND_RULES = new Map<string, SubcommandRule>([
  [
    "rev-parse",
    {
      exact: new Set([
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
        "--is-inside-work-tree",
        "--is-bare-repository",
        "--verify",
        "--quiet",
        "-q",
        "--short",
        "--abbrev-ref",
        "--symbolic",
        "--symbolic-full-name",
        "--show-prefix",
        "--show-cdup",
        "--path-format=absolute",
        "--path-format=relative",
        "--end-of-options",
        "--",
      ]),
      valueFlags: new Map([["--git-path", undefined]]),
      patterns: [/^--short=[0-9]+$/u],
    },
  ],
  [
    "config",
    {
      exact: new Set([
        "--list",
        "-l",
        "--get",
        "--get-all",
        "--get-regexp",
        "--show-scope",
        "--show-origin",
        "--null",
        "-z",
        "--name-only",
        "--includes",
        "--no-includes",
        "--local",
        "--global",
        "--system",
        "--worktree",
        "--fixed-value",
        "--type=path",
        "--type=bool",
        "--type=int",
        "--end-of-options",
        "--",
      ]),
      valueFlags: new Map([["--default", undefined]]),
      patterns: [/^--default=/u],
      validate: (flags, positionals) => {
        const hasList = flags.includes("--list") || flags.includes("-l");
        const hasGet = flags.includes("--get") || flags.includes("--get-all") || flags.includes("--get-regexp");
        if (hasList === hasGet) return false;
        return hasList ? positionals.length === 0 : positionals.length >= 1 && positionals.length <= 2;
      },
    },
  ],
  [
    "for-each-ref",
    {
      exact: new Set(["--merged", "--no-merged", "--end-of-options", "--"]),
      patterns: [/^--count=[0-9]+$/u],
    },
  ],
  [
    "merge-base",
    {
      exact: new Set(["--is-ancestor", "--octopus", "--all", "--fork-point", "--end-of-options", "--"]),
    },
  ],
  [
    "merge-tree",
    {
      exact: new Set([
        "--write-tree",
        "--no-messages",
        "--name-only",
        "-z",
        "--allow-unrelated-histories",
        "--end-of-options",
        "--",
      ]),
      patterns: [/^--merge-base=.+$/u],
      isolatedMergeTree: true,
      validate: (flags) => flags.includes("--write-tree"),
    },
  ],
  [
    "diff-tree",
    {
      exact: new Set([
        "-r",
        "-t",
        "-z",
        "--name-only",
        "--name-status",
        "--numstat",
        "--stat",
        "--raw",
        "--root",
        "--no-commit-id",
        "--no-renames",
        "-M",
        "--find-renames",
        "--ignore-submodules=none",
        "--ignore-submodules=all",
        "--ignore-submodules=dirty",
        "--ignore-submodules=untracked",
        "--submodule=short",
        "--no-ext-diff",
        "--no-textconv",
        "--no-patch",
        "-s",
        "-p",
        "-u",
        "--binary",
        "--full-index",
        "--abbrev",
        "--no-color",
        "--end-of-options",
        "--",
      ]),
      patterns: [/^-(?:U|M)[0-9]+$/u, /^--unified=[0-9]+$/u, /^--abbrev=[0-9]+$/u],
      inject: ["--no-ext-diff", "--no-textconv", "--submodule=short"],
    },
  ],
  [
    "cat-file",
    {
      exact: new Set([
        "-p",
        "-t",
        "-s",
        "-e",
        "--batch",
        "--batch-check",
        "--batch-all-objects",
        "-z",
        "-Z",
        "--unordered",
        "--buffer",
        "--end-of-options",
        "--",
      ]),
    },
  ],
  [
    "ls-tree",
    {
      exact: new Set([
        "-r",
        "-t",
        "-d",
        "-l",
        "-z",
        "--name-only",
        "--name-status",
        "--full-tree",
        "--full-name",
        "--object-only",
        "--end-of-options",
        "--",
      ]),
    },
  ],
]);

type ValidatedGitArgs =
  | {
      ok: true;
      isVersionQuery: boolean;
      globalPrefix: string[];
      subcommandAndArgs: string[];
      isolatedMergeTree: boolean;
    }
  | { ok: false; disallowed: string };

function validateAndHardenGitArgs(args: readonly string[]): ValidatedGitArgs {
  if (args.length === 0) {
    return { ok: false, disallowed: "(empty)" };
  }
  if (args.length === 1 && args[0] === "--version") {
    return {
      ok: true,
      isVersionQuery: true,
      globalPrefix: [],
      subcommandAndArgs: ["--version"],
      isolatedMergeTree: false,
    };
  }

  const globalPrefix: string[] = [];
  let idx = 0;
  while (idx < args.length) {
    const arg = args[idx]!;
    if (!arg.startsWith("-")) break;
    if (arg === "--git-dir" || arg === "--work-tree") {
      const val = args[idx + 1];
      if (val === undefined || val === "") {
        return { ok: false, disallowed: arg };
      }
      globalPrefix.push(arg, val);
      idx += 2;
      continue;
    }
    if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      const eq = arg.indexOf("=");
      if (eq === arg.length - 1) {
        return { ok: false, disallowed: arg };
      }
      globalPrefix.push(arg);
      idx += 1;
      continue;
    }
    return { ok: false, disallowed: arg };
  }

  if (idx >= args.length) {
    return { ok: false, disallowed: args[args.length - 1] ?? "(missing subcommand)" };
  }

  const sub = args[idx]!;
  const rule = SUBCOMMAND_RULES.get(sub);
  if (!rule) {
    return { ok: false, disallowed: sub };
  }

  const subArgs: string[] = [sub, ...(rule.inject ?? [])];
  const seenFlags: string[] = [];
  const positionals: string[] = [];
  let literalOnly = false;

  for (let i = idx + 1; i < args.length; i++) {
    const arg = args[i]!;
    if (literalOnly || !arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      subArgs.push(arg);
      continue;
    }
    if (arg === "--" || arg === "--end-of-options") {
      if (!rule.exact.has(arg)) {
        return { ok: false, disallowed: arg };
      }
      literalOnly = true;
      subArgs.push(arg);
      continue;
    }

    if (rule.valueFlags?.has(arg)) {
      const val = args[i + 1];
      const valRe = rule.valueFlags.get(arg);
      if (val === undefined || val === "" || (valRe && !valRe.test(val))) {
        return { ok: false, disallowed: val === undefined ? arg : `${arg} ${val}` };
      }
      seenFlags.push(arg);
      subArgs.push(arg, val);
      i += 1;
      continue;
    }

    const matchesExact = rule.exact.has(arg);
    const matchesPattern = !matchesExact && (rule.patterns?.some((re) => re.test(arg)) ?? false);
    if (!matchesExact && !matchesPattern) {
      return { ok: false, disallowed: arg };
    }

    seenFlags.push(arg);
    subArgs.push(arg);
  }

  if (rule.validate && !rule.validate(seenFlags, positionals)) {
    return { ok: false, disallowed: sub };
  }

  return {
    ok: true,
    isVersionQuery: false,
    globalPrefix,
    subcommandAndArgs: subArgs,
    isolatedMergeTree: rule.isolatedMergeTree === true,
  };
}

function isSameOrDescendant(candidate: string, ancestor: string): boolean {
  const rel = relative(ancestor, candidate);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

function pathsOverlap(a: string, b: string): boolean {
  return isSameOrDescendant(a, b) || isSameOrDescendant(b, a);
}

async function resolveExistingDir(dirPath: string): Promise<string | null> {
  if (!dirPath || !isAbsolute(dirPath)) return null;
  try {
    const st = await stat(dirPath);
    if (!st.isDirectory()) return null;
    return await realpath(dirPath);
  } catch {
    return null;
  }
}

async function ensureSupportedGitVersion(
  gitBin: ResolvedGitBinary,
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  binary: boolean | undefined,
): Promise<{ ok: true } | { ok: false; result: ExecResult }> {
  if (verifiedGitBinaryCache.has(gitBin.cacheKey)) {
    return { ok: true };
  }
  const versionRes = await runProcess(gitBin.path, ["--version"], {
    cwd,
    env: cleanNoRepoEnv(env),
    signal,
    timeoutMs,
  });
  if (versionRes.errorCode !== undefined || versionRes.code !== 0) {
    return {
      ok: false,
      result: binary ? { ...versionRes, stdout: "", stdoutBuffer: Buffer.alloc(0) } : versionRes,
    };
  }
  if (!isSupportedGitVersion(versionRes.stdout)) {
    return {
      ok: false,
      result: {
        code: 1,
        stdout: "",
        stderr: `Git >= 2.45.1 is required for authoritative GIT_NO_LAZY_FETCH support (found: ${versionRes.stdout.trim() || "unknown"}).`,
        errorCode: "ENOTSUP",
        ...(binary ? { stdoutBuffer: Buffer.alloc(0) } : {}),
      },
    };
  }
  verifiedGitBinaryCache.add(gitBin.cacheKey);
  return { ok: true };
}

async function resolveCommitInSource(
  gitBin: string,
  cwd: string,
  globalPrefix: readonly string[],
  rev: string,
  sourceEnv: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  binary: boolean | undefined,
): Promise<{ ok: true; sha: string } | { ok: false; result: ExecResult }> {
  const res = await runProcess(
    gitBin,
    [...SAFE_GIT_FLAGS, ...globalPrefix, "rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`],
    {
      cwd,
      env: sourceEnv,
      signal,
      timeoutMs,
    },
  );
  if (res.errorCode !== undefined || res.code !== 0) {
    return {
      ok: false,
      result: binary ? { ...res, stdout: "", stdoutBuffer: Buffer.alloc(0) } : res,
    };
  }
  return { ok: true, sha: res.stdout.trim() };
}

async function runIsolatedMergeTree(
  gitBin: string,
  cwd: string,
  validated: Extract<ValidatedGitArgs, { ok: true }>,
  env: NodeJS.ProcessEnv,
  callerEnv: NodeJS.ProcessEnv | undefined,
  emptyIdxPath: string,
  opts: GitExecOptions,
  deadline: number | undefined,
  totalTimeoutMs: number,
  remainingTimeoutMs: () => number,
  failResult: (code: number, stderr: string, errorCode?: string) => ExecResult,
): Promise<ExecResult> {
  const rawObjDir = callerEnv?.GIT_OBJECT_DIRECTORY;
  const realObjDir = rawObjDir ? await resolveExistingDir(rawObjDir) : null;
  if (!realObjDir) {
    return failResult(
      1,
      "merge-tree --write-tree requires an existing absolute scratch GIT_OBJECT_DIRECTORY.",
      "EINVAL",
    );
  }

  const realAlts: string[] = [];
  const rawAlts = callerEnv?.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  if (rawAlts !== undefined && rawAlts !== "") {
    const parts = rawAlts.split(delimiter).filter(Boolean);
    if (parts.length === 0) {
      return failResult(1, "Invalid GIT_ALTERNATE_OBJECT_DIRECTORIES for merge-tree.", "EINVAL");
    }
    for (const part of parts) {
      const resolvedAlt = await resolveExistingDir(part);
      if (!resolvedAlt) {
        return failResult(1, `Invalid GIT_ALTERNATE_OBJECT_DIRECTORIES entry for merge-tree: ${part}`, "EINVAL");
      }
      if (pathsOverlap(realObjDir, resolvedAlt)) {
        return failResult(1, "merge-tree scratch GIT_OBJECT_DIRECTORY must be distinct from alternate objects.", "EINVAL");
      }
      realAlts.push(resolvedAlt);
    }
  }

  if (deadline !== undefined && Date.now() >= deadline) {
    return failResult(1, `Process timed out after ${totalTimeoutMs}ms.`, "ETIMEDOUT");
  }

  const scratchRepoProbe = await runProcess(
    gitBin,
    ["-c", "safe.bareRepository=all", "rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: realObjDir,
      env: cleanNoRepoEnv(env),
      signal: opts.signal,
      timeoutMs: remainingTimeoutMs(),
    },
  );
  if (scratchRepoProbe.errorCode !== undefined) {
    return opts.binary ? { ...scratchRepoProbe, stdout: "", stdoutBuffer: Buffer.alloc(0) } : scratchRepoProbe;
  }
  if (scratchRepoProbe.code === 0) {
    return failResult(1, "merge-tree scratch GIT_OBJECT_DIRECTORY must not be inside any Git repository.", "EINVAL");
  }

  if (deadline !== undefined && Date.now() >= deadline) {
    return failResult(1, `Process timed out after ${totalTimeoutMs}ms.`, "ETIMEDOUT");
  }

  const sourceEnv = mergeEnv(cleanInternalConfigEnv(env), {
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_INDEX_FILE: emptyIdxPath,
  });

  const repoInfoRes = await runProcess(
    gitBin,
    [
      ...SAFE_GIT_FLAGS,
      ...validated.globalPrefix,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      "--git-dir",
      "--is-inside-work-tree",
      "--show-object-format",
    ],
    {
      cwd,
      env: sourceEnv,
      signal: opts.signal,
      timeoutMs: remainingTimeoutMs(),
    },
  );
  if (repoInfoRes.errorCode !== undefined) {
    return opts.binary ? { ...repoInfoRes, stdout: "", stdoutBuffer: Buffer.alloc(0) } : repoInfoRes;
  }
  if (repoInfoRes.code !== 0) {
    return failResult(
      1,
      repoInfoRes.stderr.trim() || "merge-tree requires a valid, unambiguously discovered source repository.",
      "EINVAL",
    );
  }

  const infoLines = repoInfoRes.stdout.trim().split(/\r?\n/u);
  const realCommonDir = infoLines[0] ? await resolveExistingDir(infoLines[0].trim()) : null;
  const realGitDir = infoLines[1] ? await resolveExistingDir(infoLines[1].trim()) : null;
  const insideWorkTree = infoLines[2]?.trim() === "true";
  const objectFormat = infoLines[3]?.trim() === "sha256" ? "sha256" : "sha1";

  if (!realCommonDir || !realGitDir) {
    return failResult(1, "merge-tree could not resolve source repository paths.", "EINVAL");
  }
  if (pathsOverlap(realObjDir, realCommonDir) || pathsOverlap(realObjDir, realGitDir)) {
    return failResult(1, "merge-tree scratch GIT_OBJECT_DIRECTORY must be distinct from the repository.", "EINVAL");
  }

  if (insideWorkTree) {
    if (deadline !== undefined && Date.now() >= deadline) {
      return failResult(1, `Process timed out after ${totalTimeoutMs}ms.`, "ETIMEDOUT");
    }
    const topRes = await runProcess(
      gitBin,
      [...SAFE_GIT_FLAGS, ...validated.globalPrefix, "rev-parse", "--path-format=absolute", "--show-toplevel"],
      {
        cwd,
        env: sourceEnv,
        signal: opts.signal,
        timeoutMs: remainingTimeoutMs(),
      },
    );
    if (topRes.errorCode !== undefined) {
      return opts.binary ? { ...topRes, stdout: "", stdoutBuffer: Buffer.alloc(0) } : topRes;
    }
    const realTopLevel = topRes.code === 0 ? await resolveExistingDir(topRes.stdout.trim()) : null;
    if (!realTopLevel) {
      return failResult(1, "merge-tree could not resolve source worktree root.", "EINVAL");
    }
    if (pathsOverlap(realObjDir, realTopLevel)) {
      return failResult(1, "merge-tree scratch GIT_OBJECT_DIRECTORY must be distinct from the worktree.", "EINVAL");
    }
  }

  if (realAlts.length === 0) {
    const sourceObjects = await resolveExistingDir(resolve(realCommonDir, "objects"));
    if (!sourceObjects || pathsOverlap(realObjDir, sourceObjects)) {
      return failResult(1, "merge-tree could not resolve source object store.", "EINVAL");
    }
    realAlts.push(sourceObjects);
  }

  const resolvedArgs: string[] = ["merge-tree"];
  const resolvedPositionals: string[] = [];
  let literalOnly = false;
  for (let i = 1; i < validated.subcommandAndArgs.length; i++) {
    const arg = validated.subcommandAndArgs[i]!;
    if (!literalOnly && (arg === "--" || arg === "--end-of-options")) {
      literalOnly = true;
      resolvedArgs.push(arg);
      continue;
    }
    if (!literalOnly && arg.startsWith("--merge-base=")) {
      if (deadline !== undefined && Date.now() >= deadline) {
        return failResult(1, `Process timed out after ${totalTimeoutMs}ms.`, "ETIMEDOUT");
      }
      const baseRev = arg.slice("--merge-base=".length);
      const baseRes = await resolveCommitInSource(
        gitBin,
        cwd,
        validated.globalPrefix,
        baseRev,
        sourceEnv,
        opts.signal,
        remainingTimeoutMs(),
        opts.binary,
      );
      if (!baseRes.ok) return baseRes.result;
      resolvedArgs.push(`--merge-base=${baseRes.sha}`);
      continue;
    }
    if (!literalOnly && arg.startsWith("-") && arg !== "-") {
      resolvedArgs.push(arg);
      continue;
    }
    if (deadline !== undefined && Date.now() >= deadline) {
      return failResult(1, `Process timed out after ${totalTimeoutMs}ms.`, "ETIMEDOUT");
    }
    const revRes = await resolveCommitInSource(
      gitBin,
      cwd,
      validated.globalPrefix,
      arg,
      sourceEnv,
      opts.signal,
      remainingTimeoutMs(),
      opts.binary,
    );
    if (!revRes.ok) return revRes.result;
    resolvedPositionals.push(revRes.sha);
    resolvedArgs.push(revRes.sha);
  }

  if (deadline !== undefined && Date.now() >= deadline) {
    return failResult(1, `Process timed out after ${totalTimeoutMs}ms.`, "ETIMEDOUT");
  }

  let runnerGitDir: string;
  try {
    runnerGitDir = await mkdtemp(join(tmpdir(), "ship-ge-mt-"));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return failResult(1, e.message, e.code ?? "EIO");
  }

  let res: ExecResult;
  try {
    await mkdir(join(runnerGitDir, "refs"), { recursive: true, mode: 0o700 });
    await writeFile(join(runnerGitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
    const bareConfig =
      objectFormat === "sha256"
        ? "[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectformat = sha256\n"
        : "[core]\n\trepositoryformatversion = 0\n\tbare = true\n";
    await writeFile(join(runnerGitDir, "config"), bareConfig, "utf8");

    const sealedEnv = mergeEnv(cleanNoRepoEnv(env), {
      GIT_DIR: runnerGitDir,
      GIT_COMMON_DIR: runnerGitDir,
      GIT_OBJECT_DIRECTORY: realObjDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: realAlts.join(delimiter),
      ...(resolvedPositionals[0] ? { GIT_ATTR_SOURCE: resolvedPositionals[0] } : {}),
    });

    res = await runProcess(gitBin, [...SAFE_GIT_FLAGS, "--git-dir", runnerGitDir, ...resolvedArgs], {
      cwd: runnerGitDir,
      stdin: opts.stdin,
      binary: opts.binary,
      timeoutMs: remainingTimeoutMs(),
      maxBuffer: opts.maxBuffer,
      signal: opts.signal,
      env: sealedEnv,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    res = failResult(1, e.message, e.code ?? "EIO");
  }

  try {
    await rm(runnerGitDir, { recursive: true, force: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (res.code === 0) {
      res = failResult(1, e.message, e.code ?? "EIO");
    }
  }
  return res;
}

/**
 * Execute an allowlisted read-only Git plumbing command (or isolated `merge-tree --write-tree`)
 * using a single resolved Git >= 2.45.1 executable, isolated index metadata, and callback hardening.
 */
export async function defaultGitExec(
  cwd: string,
  args: readonly string[],
  opts: GitExecOptions = {},
): Promise<ExecResult> {
  const failResult = (code: number, stderr: string, errorCode?: string): ExecResult => ({
    code,
    stdout: "",
    stderr,
    ...(errorCode ? { errorCode } : {}),
    ...(opts.binary ? { stdoutBuffer: Buffer.alloc(0) } : {}),
  });

  const validated = validateAndHardenGitArgs(args);
  if (!validated.ok) {
    return failResult(1, `Disallowed git option or subcommand: ${validated.disallowed}`, "EINVAL");
  }

  const env = mergeEnv(stripRepoLocalGitEnv(process.env), {
    ...opts.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_TEST_COMMIT_GRAPH: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_PAGER: "cat",
  });

  const totalTimeoutMs = opts.timeoutMs ?? 20_000;
  const deadline = totalTimeoutMs > 0 ? Date.now() + totalTimeoutMs : undefined;
  const remainingTimeoutMs = (): number => {
    if (deadline === undefined) return 0;
    return Math.max(1, deadline - Date.now());
  };

  const resolvedGit = await resolveGitBinary(cwd, env.PATH);
  if (!resolvedGit) {
    return failResult(1, "spawn git ENOENT", "ENOENT");
  }

  if (validated.isVersionQuery) {
    return runProcess(resolvedGit.path, ["--version"], {
      cwd,
      stdin: opts.stdin,
      binary: opts.binary,
      timeoutMs: remainingTimeoutMs(),
      maxBuffer: opts.maxBuffer,
      signal: opts.signal,
      env: cleanNoRepoEnv(env),
    });
  }

  const versionCheck = await ensureSupportedGitVersion(
    resolvedGit,
    cwd,
    env,
    opts.signal,
    remainingTimeoutMs(),
    opts.binary,
  );
  if (!versionCheck.ok) {
    return versionCheck.result;
  }

  if (deadline !== undefined && Date.now() >= deadline) {
    return failResult(1, `Process timed out after ${totalTimeoutMs}ms.`, "ETIMEDOUT");
  }

  let idxTmpDir: string;
  try {
    idxTmpDir = await mkdtemp(join(tmpdir(), "ship-ge-idx-"));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return failResult(1, e.message, e.code ?? "EIO");
  }
  const emptyIdxPath = join(idxTmpDir, "index");

  let res: ExecResult;
  try {
    if (validated.isolatedMergeTree) {
      res = await runIsolatedMergeTree(
        resolvedGit.path,
        cwd,
        validated,
        env,
        opts.env,
        emptyIdxPath,
        opts,
        deadline,
        totalTimeoutMs,
        remainingTimeoutMs,
        failResult,
      );
    } else {
      res = await runProcess(
        resolvedGit.path,
        [...SAFE_GIT_FLAGS, ...validated.globalPrefix, ...validated.subcommandAndArgs],
        {
          cwd,
          stdin: opts.stdin,
          binary: opts.binary,
          timeoutMs: remainingTimeoutMs(),
          maxBuffer: opts.maxBuffer,
          signal: opts.signal,
          env: mergeEnv(env, { GIT_INDEX_FILE: emptyIdxPath }),
        },
      );
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    res = failResult(1, e.message, e.code ?? "EIO");
  }

  try {
    await rm(idxTmpDir, { recursive: true, force: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (res.code === 0) {
      res = failResult(1, e.message, e.code ?? "EIO");
    }
  }
  return res;
}
