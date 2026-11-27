import { spawn, type ChildProcess } from "node:child_process";
import { addAbortListener } from "node:events";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, sep } from "node:path";

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
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

export const SAFE_GIT_FLAGS = [
  "--no-pager", "-c", "safe.bareRepository=explicit", "--no-replace-objects",
  "-c", "core.commitGraph=false", "-c", "core.multiPackIndex=false", "-c", "core.fsmonitor=false",
  "-c", "diff.external=", "-c", "diff.submodule=short", "-c", "diff.autoRefreshIndex=false",
  "-c", "format.pretty=medium", "-c", "log.showSignature=false", "--literal-pathspecs", "--no-optional-locks",
] as const;

const SAFE_CONFIG_GIT_FLAGS = ["--no-pager", "--no-optional-locks"] as const;

const REPO_LOCAL_GIT_ENV_KEYS = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX",
  "GIT_SUPER_PREFIX", "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
  "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS", "GIT_LITERAL_PATHSPECS",
  "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_PAGER", "GIT_ATTR_NOSYSTEM", "GIT_ATTR_SOURCE",
  "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS",
]);

const NON_REPO_CLEAR_KEYS = new Set([
  "GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
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

/** Clear repo-pointing and config-overriding variables for uncached `git --version` probes. */
function cleanVersionProbeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k === "GIT_ATTR_SOURCE" || k.startsWith("GIT_CONFIG") || NON_REPO_CLEAR_KEYS.has(k)) {
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

const MIN_GIT_MAJOR = 2;
const MIN_GIT_MINOR = 45;
const MIN_GIT_PATCH = 1;
const GIT_VERSION_RE = /\bgit version (\d+)\.(\d+)(?:\.(\d+))?/u;

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

function joinRawPath(base: string, part: string): string {
  if (!base) return part;
  return base.endsWith(sep) ? `${base}${part}` : `${base}${sep}${part}`;
}

const PATH_SKIP_ERROR_CODES = new Set(["ENOENT", "EACCES", "ENOTDIR", "EISDIR", "ELOOP", "ENAMETOOLONG"]);

async function raceCancellation<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  deadline: number | undefined,
): Promise<{ ok: true; value: T } | { ok: false; reason: "abort" | "timeout" }> {
  void work.catch(() => {});
  if (signal?.aborted) return { ok: false, reason: "abort" };
  if (deadline !== undefined && Date.now() >= deadline) return { ok: false, reason: "timeout" };

  let timer: NodeJS.Timeout | undefined;
  let abortSub: Disposable | undefined;
  const blockers: Promise<{ ok: false; reason: "abort" | "timeout" }>[] = [];

  if (signal) {
    blockers.push(
      new Promise((resolveCancel) => {
        abortSub = addAbortListener(signal, () => resolveCancel({ ok: false, reason: "abort" }));
      }),
    );
  }
  if (deadline !== undefined) {
    const remaining = Math.max(0, deadline - Date.now());
    blockers.push(
      new Promise((resolveCancel) => {
        timer = setTimeout(() => resolveCancel({ ok: false, reason: "timeout" }), remaining);
      }),
    );
  }

  try {
    const wrapped = work.then((value) => ({ ok: true as const, value }));
    return blockers.length === 0 ? await wrapped : await Promise.race([wrapped, ...blockers]);
  } finally {
    if (timer) clearTimeout(timer);
    abortSub?.[Symbol.dispose]();
  }
}

async function probeCandidatePath(
  candidate: string,
  state: { cancelled: boolean },
): Promise<{ kind: "found"; realBin: string } | { kind: "skip"; eacces: boolean }> {
  try {
    await access(candidate, constants.X_OK);
    if (state.cancelled) return { kind: "skip", eacces: false };
    const st = await stat(candidate);
    if (state.cancelled) return { kind: "skip", eacces: false };
    if (!st.isFile()) return { kind: "skip", eacces: st.isDirectory() };
    return { kind: "found", realBin: await realpath(candidate) };
  } catch (err) {
    return { kind: "skip", eacces: (err as NodeJS.ErrnoException).code === "EACCES" };
  }
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
    let abortDisposable: Disposable | undefined;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (abortDisposable) {
        abortDisposable[Symbol.dispose]();
        abortDisposable = undefined;
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
      // Escalate immediately to tear down any remaining same-group descendant after leader exit or stdio close.
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
        await waitForGroupExit(200);

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
      abortDisposable = addAbortListener(opts.signal, () => startTermination("abort", 150));
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
  valueFlags?: Set<string>;
  patterns?: RegExp[];
  inject?: readonly string[];
  validate?: (flags: string[], positionals: string[]) => boolean;
}

const SUBCOMMAND_RULES = new Map<string, SubcommandRule>([
  [
    "rev-parse",
    {
      exact: new Set([
        "--show-toplevel", "--git-dir", "--git-common-dir", "--is-inside-work-tree",
        "--is-bare-repository", "--verify", "--quiet", "-q", "--short", "--abbrev-ref",
        "--symbolic", "--symbolic-full-name", "--show-prefix", "--show-cdup",
        "--path-format=absolute", "--path-format=relative", "--end-of-options", "--",
      ]),
      valueFlags: new Set(["--git-path"]),
      patterns: [/^--short=[0-9]+$/u],
    },
  ],
  [
    "config",
    {
      exact: new Set([
        "--list", "-l", "--get", "--get-all", "--get-regexp", "--show-scope", "--show-origin",
        "--null", "-z", "--name-only", "--includes", "--no-includes", "--local", "--global",
        "--system", "--worktree", "--fixed-value", "--type=path", "--type=bool", "--type=int",
        "--end-of-options", "--",
      ]),
      valueFlags: new Set(["--default"]),
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
    { exact: new Set(["--is-ancestor", "--octopus", "--all", "--fork-point", "--end-of-options", "--"]) },
  ],
  [
    "diff-tree",
    {
      exact: new Set([
        "-r", "-t", "-z", "--name-only", "--name-status", "--numstat", "--stat", "--raw", "--root",
        "--no-commit-id", "--no-renames", "-M", "--find-renames", "--ignore-submodules=none",
        "--ignore-submodules=all", "--ignore-submodules=dirty", "--ignore-submodules=untracked",
        "--submodule=short", "--no-ext-diff", "--no-textconv", "--no-patch", "-s", "-p", "-u",
        "--binary", "--full-index", "--abbrev", "--no-color", "--end-of-options", "--",
      ]),
      patterns: [/^-(?:U|M)[0-9]+$/u, /^--unified=[0-9]+$/u, /^--abbrev=[0-9]+$/u],
      inject: ["--no-ext-diff", "--no-textconv", "--submodule=short"],
    },
  ],
  [
    "cat-file",
    {
      exact: new Set([
        "-p", "-t", "-s", "-e", "--batch", "--batch-check", "--batch-all-objects",
        "-z", "-Z", "--unordered", "--buffer", "--end-of-options", "--",
      ]),
    },
  ],
  [
    "ls-tree",
    {
      exact: new Set([
        "-r", "-t", "-d", "-l", "-z", "--name-only", "--name-status", "--full-tree",
        "--full-name", "--object-only", "--end-of-options", "--",
      ]),
    },
  ],
]);

type ValidatedGitArgs =
  | {
      ok: true;
      isVersionQuery: boolean;
      isConfigQuery: boolean;
      globalPrefix: string[];
      subcommandAndArgs: string[];
    }
  | { ok: false; disallowed: string };

function validateAndHardenGitArgs(args: readonly string[]): ValidatedGitArgs {
  if (args.length === 0) return { ok: false, disallowed: "(empty)" };
  if (args.length === 1 && args[0] === "--version") {
    return {
      ok: true,
      isVersionQuery: true,
      isConfigQuery: false,
      globalPrefix: [],
      subcommandAndArgs: ["--version"],
    };
  }

  const globalPrefix: string[] = [];
  let idx = 0;
  while (idx < args.length) {
    const arg = args[idx]!;
    if (!arg.startsWith("-")) break;
    if (arg === "--git-dir" || arg === "--work-tree") {
      const val = args[idx + 1];
      if (val === undefined || val === "") return { ok: false, disallowed: arg };
      globalPrefix.push(arg, val);
      idx += 2;
      continue;
    }
    if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      if (arg.indexOf("=") === arg.length - 1) return { ok: false, disallowed: arg };
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
  if (!rule) return { ok: false, disallowed: sub };

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
      if (!rule.exact.has(arg)) return { ok: false, disallowed: arg };
      literalOnly = true;
      subArgs.push(arg);
      continue;
    }
    if (rule.valueFlags?.has(arg)) {
      const val = args[i + 1];
      if (val === undefined || val === "") {
        return { ok: false, disallowed: val === undefined ? arg : `${arg} ${val}` };
      }
      seenFlags.push(arg);
      subArgs.push(arg, val);
      i += 1;
      continue;
    }

    const matchesExact = rule.exact.has(arg);
    const matchesPattern = !matchesExact && (rule.patterns?.some((re) => re.test(arg)) ?? false);
    if (!matchesExact && !matchesPattern) return { ok: false, disallowed: arg };

    seenFlags.push(arg);
    subArgs.push(arg);
  }

  if (rule.validate && !rule.validate(seenFlags, positionals)) {
    return { ok: false, disallowed: sub };
  }

  return {
    ok: true,
    isVersionQuery: false,
    isConfigQuery: sub === "config",
    globalPrefix,
    subcommandAndArgs: subArgs,
  };
}

type ResolveAndVerifyResult =
  | { ok: true; isVersionResult: true; result: ExecResult }
  | { ok: true; isVersionResult: false; gitBin: string }
  | { ok: false; result: ExecResult };

async function resolveAndVerifyGitBinary(
  cwd: string,
  env: NodeJS.ProcessEnv,
  opts: GitExecOptions,
  isVersionQuery: boolean,
  deadline: number | undefined,
  totalTimeoutMs: number,
  remainingTimeoutMs: () => number,
  failResult: (code: number, stderr: string, errorCode?: string) => ExecResult,
): Promise<ResolveAndVerifyResult> {
  const checkCancel = (): ExecResult | null => {
    if (opts.signal?.aborted) return failResult(1, "Operation aborted.", "ABORT_ERR");
    if (deadline !== undefined && Date.now() >= deadline) {
      return failResult(1, `Process timed out after ${totalTimeoutMs}ms.`, "ETIMEDOUT");
    }
    return null;
  };

  const exeName = process.platform === "win32" ? "git.exe" : "git";
  const baseCwd = cwd || ".";
  const effectivePath = env.PATH ?? (process.platform === "win32" ? "" : "/bin:/usr/bin");
  let sawEacces = false;

  for (const entry of effectivePath.split(delimiter)) {
    const cancelErr = checkCancel();
    if (cancelErr) return { ok: false, result: cancelErr };

    const dir = entry === "" ? baseCwd : isAbsolute(entry) ? entry : joinRawPath(baseCwd, entry);
    const candidate = joinRawPath(dir, exeName);
    const probeState = { cancelled: false };
    const probed = await raceCancellation(probeCandidatePath(candidate, probeState), opts.signal, deadline);
    if (!probed.ok) {
      probeState.cancelled = true;
      return {
        ok: false,
        result:
          probed.reason === "abort"
            ? failResult(1, "Operation aborted.", "ABORT_ERR")
            : failResult(1, `Process timed out after ${totalTimeoutMs}ms.`, "ETIMEDOUT"),
      };
    }
    if (probed.value.kind === "skip") {
      sawEacces ||= probed.value.eacces;
      continue;
    }

    const preSpawnErr = checkCancel();
    if (preSpawnErr) return { ok: false, result: preSpawnErr };

    const versionRes = await runProcess(probed.value.realBin, ["--version"], {
      cwd,
      env: cleanVersionProbeEnv(env),
      signal: opts.signal,
      timeoutMs: remainingTimeoutMs(),
      ...(isVersionQuery ? { stdin: opts.stdin, binary: opts.binary, maxBuffer: opts.maxBuffer } : {}),
    });

    if (versionRes.errorCode === "ABORT_ERR" || versionRes.errorCode === "ETIMEDOUT") {
      return {
        ok: false,
        result: isVersionQuery
          ? versionRes
          : { ...versionRes, stdout: "", ...(opts.binary ? { stdoutBuffer: Buffer.alloc(0) } : {}) },
      };
    }

    if (versionRes.errorCode !== undefined && PATH_SKIP_ERROR_CODES.has(versionRes.errorCode)) {
      if (versionRes.errorCode === "EACCES") sawEacces = true;
      continue;
    }

    if (isVersionQuery) {
      return { ok: true, isVersionResult: true, result: versionRes };
    }
    if (versionRes.errorCode !== undefined || versionRes.code !== 0) {
      return {
        ok: false,
        result: { ...versionRes, stdout: "", ...(opts.binary ? { stdoutBuffer: Buffer.alloc(0) } : {}) },
      };
    }
    if (!isSupportedGitVersion(versionRes.stdout)) {
      return {
        ok: false,
        result: failResult(
          1,
          `Git >= 2.45.1 is required for authoritative GIT_NO_LAZY_FETCH support (found: ${versionRes.stdout.trim() || "unknown"}).`,
          "ENOTSUP",
        ),
      };
    }
    return { ok: true, isVersionResult: false, gitBin: probed.value.realBin };
  }

  const endCancelErr = checkCancel();
  if (endCancelErr) return { ok: false, result: endCancelErr };
  return sawEacces
    ? { ok: false, result: failResult(1, "spawn git EACCES", "EACCES") }
    : { ok: false, result: failResult(1, "spawn git ENOENT", "ENOENT") };
}

/**
 * Execute an allowlisted read-only Git plumbing command using an uncached Git >= 2.45.1
 * executable with callback/lock hardening (`--no-optional-locks`, `diff.autoRefreshIndex=false`,
 * `core.fsmonitor=false`). Native Git index reads (including Git's internal `sharedindex.*` mtime
 * freshening) are preserved without mutating repository bytes or creating temp directories.
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

  const totalTimeoutMs = opts.timeoutMs ?? 20_000;
  const deadline = totalTimeoutMs > 0 ? Date.now() + totalTimeoutMs : undefined;
  const remainingTimeoutMs = (): number => (deadline === undefined ? 0 : Math.max(1, deadline - Date.now()));
  const checkAbortOrTimeout = (): ExecResult | null => {
    if (opts.signal?.aborted) return failResult(1, "Operation aborted.", "ABORT_ERR");
    if (deadline !== undefined && Date.now() >= deadline) {
      return failResult(1, `Process timed out after ${totalTimeoutMs}ms.`, "ETIMEDOUT");
    }
    return null;
  };

  const initialErr = checkAbortOrTimeout();
  if (initialErr) return initialErr;

  const env = mergeEnv(stripRepoLocalGitEnv(process.env), {
    ...opts.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_TEST_COMMIT_GRAPH: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_PAGER: "cat",
  });

  const resolved = await resolveAndVerifyGitBinary(
    cwd,
    env,
    opts,
    validated.isVersionQuery,
    deadline,
    totalTimeoutMs,
    remainingTimeoutMs,
    failResult,
  );
  if (!resolved.ok) return resolved.result;
  if (resolved.isVersionResult) return resolved.result;

  const postVersionErr = checkAbortOrTimeout();
  if (postVersionErr) return postVersionErr;

  const safetyFlags = validated.isConfigQuery ? SAFE_CONFIG_GIT_FLAGS : SAFE_GIT_FLAGS;
  return runProcess(resolved.gitBin, [...safetyFlags, ...validated.globalPrefix, ...validated.subcommandAndArgs], {
    cwd,
    stdin: opts.stdin,
    binary: opts.binary,
    timeoutMs: remainingTimeoutMs(),
    maxBuffer: opts.maxBuffer,
    signal: opts.signal,
    env,
  });
}
