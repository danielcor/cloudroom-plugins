import { spawn, type ChildProcess } from "node:child_process";

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
  "status.submoduleSummary=false",
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
]);

const GIT_CONFIG_INDEXED_RE = /^GIT_CONFIG_(?:KEY|VALUE)_/u;
const SAFE_SUBSECTION_RE = /^[A-Za-z0-9._-]+$/u;

function stripRepoLocalGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || REPO_LOCAL_GIT_ENV_KEYS.has(k) || GIT_CONFIG_INDEXED_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

type StopReason = "timeout" | "abort" | "maxBuffer";

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

  return new Promise((resolve) => {
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
    let onAbort: (() => void) | undefined;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
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
          const t = setTimeout(r, 5);
          t.unref?.();
        });
      }
    };

    const startTermination = (reason: StopReason, graceMs: number) => {
      if (settled || stopReason !== undefined) return;
      stopReason = reason;
      if (reason === "maxBuffer" || graceMs <= 0) {
        signalTree("SIGKILL");
        return;
      }
      signalTree("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) signalTree("SIGKILL");
      }, graceMs);
      killTimer.unref?.();
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
      resolve(buildResult(1, Buffer.alloc(0), anyErr.message, anyErr.code));
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
      resolve(buildResult(1, Buffer.alloc(0), err.message, err.code));
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();

      if (child.stdin && !stdinFinished && !child.stdin.writableFinished) {
        child.stdin.destroy();
      }

      void (async () => {
        if (stopReason !== undefined) {
          await waitForGroupExit(200);
        }

        const stdoutBuf = Buffer.concat(stdoutChunks);
        const stderrText = Buffer.concat(stderrChunks).toString("utf8");

        if (stopReason === "abort") {
          resolve(buildResult(1, stdoutBuf, stderrText || "Operation aborted.", "ABORT_ERR"));
          return;
        }
        if (stopReason === "timeout") {
          const timeoutMsg = `Process timed out after ${timeoutMs}ms.`;
          resolve(buildResult(1, stdoutBuf, stderrText ? `${stderrText}\n${timeoutMsg}` : timeoutMsg, "ETIMEDOUT"));
          return;
        }
        if (stopReason === "maxBuffer") {
          const overflowMsg = `maxBuffer length (${maxBuffer}) exceeded.`;
          resolve(
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
            resolve(buildResult(1, stdoutBuf, stderrText ? `${stderrText}\n${msg}` : msg, stdinErr?.code ?? "EPIPE"));
            return;
          }
          resolve(buildResult(0, stdoutBuf, stderrText));
          return;
        }

        resolve(buildResult(code ?? 1, stdoutBuf, stderrText, stdinErr?.code));
      })();
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
  needsMergeDriverCheck?: boolean;
  needsWorktreeFilterCheck?: boolean;
  needsWorktreeFilterWhen?: Set<string>;
  validate?: (flags: string[], positionals: string[]) => boolean;
}

const COMMIT_LOG_SHOW_RULE: SubcommandRule = {
  exact: new Set([
    "-p",
    "-u",
    "-s",
    "--no-patch",
    "--stat",
    "--numstat",
    "--name-only",
    "--name-status",
    "--raw",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--submodule=short",
    "--ignore-submodules=none",
    "--ignore-submodules=all",
    "--ignore-submodules=dirty",
    "--ignore-submodules=untracked",
    "--binary",
    "--full-index",
    "--abbrev",
    "--no-color",
    "--oneline",
    "--no-merges",
    "--merges",
    "--first-parent",
    "--reverse",
    "--ancestry-path",
    "--left-right",
    "--cherry-pick",
    "--no-walk",
    "--end-of-options",
    "--",
  ]),
  valueFlags: new Map([
    ["-n", /^[0-9]+$/u],
    ["--max-count", /^[0-9]+$/u],
  ]),
  patterns: [/^-[0-9]+$/u, /^--max-count=[0-9]+$/u, /^-U[0-9]+$/u, /^--unified=[0-9]+$/u, /^--abbrev=[0-9]+$/u, /^--format=/u, /^--pretty=/u],
  inject: ["--no-ext-diff", "--no-textconv", "--submodule=short"],
};

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
      exact: new Set(["-z", "--merged", "--no-merged", "--end-of-options", "--"]),
      valueFlags: new Map([
        ["--format", undefined],
        ["--sort", undefined],
      ]),
      patterns: [/^--count=[0-9]+$/u, /^--format=/u, /^--sort=/u, /^--points-at=/u],
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
      needsMergeDriverCheck: true,
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
  [
    "ls-files",
    {
      exact: new Set([
        "-z",
        "-c",
        "--cached",
        "-o",
        "--others",
        "-d",
        "--deleted",
        "-m",
        "--modified",
        "-s",
        "--stage",
        "-u",
        "--unmerged",
        "--exclude-standard",
        "--error-unmatch",
        "--full-name",
        "--end-of-options",
        "--",
      ]),
      needsWorktreeFilterWhen: new Set(["-m", "--modified"]),
    },
  ],
  ["show", COMMIT_LOG_SHOW_RULE],
  ["log", COMMIT_LOG_SHOW_RULE],
  [
    "diff",
    {
      exact: new Set([
        "--cached",
        "--staged",
        "--name-only",
        "--name-status",
        "--numstat",
        "--stat",
        "--raw",
        "-z",
        "--no-renames",
        "-M",
        "--find-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--submodule=short",
        "--ignore-submodules=dirty",
        "--ignore-submodules=all",
        "--no-patch",
        "-s",
        "-p",
        "-u",
        "--binary",
        "--full-index",
        "--abbrev",
        "--no-color",
        "--quiet",
        "--exit-code",
        "--check",
        "--end-of-options",
        "--",
      ]),
      patterns: [/^-(?:U|M)[0-9]+$/u, /^--unified=[0-9]+$/u, /^--abbrev=[0-9]+$/u],
      inject: ["--no-ext-diff", "--no-textconv", "--submodule=short", "--ignore-submodules=dirty"],
      needsWorktreeFilterCheck: true,
    },
  ],
  [
    "status",
    {
      exact: new Set([
        "--short",
        "-s",
        "--porcelain",
        "--porcelain=v1",
        "--porcelain=v2",
        "--branch",
        "-b",
        "-z",
        "--untracked-files=no",
        "--untracked-files=normal",
        "--untracked-files=all",
        "-uno",
        "-unormal",
        "-uall",
        "--ignored",
        "--ignored=traditional",
        "--ignored=no",
        "--ignored=matching",
        "--ignore-submodules=dirty",
        "--ignore-submodules=all",
        "--no-renames",
        "--end-of-options",
        "--",
      ]),
      inject: ["--ignore-submodules=dirty"],
      needsWorktreeFilterCheck: true,
    },
  ],
]);

type ValidatedGitArgs =
  | {
      ok: true;
      globalPrefix: string[];
      subcommandAndArgs: string[];
      needsWorktreeFilterCheck: boolean;
      needsMergeDriverCheck: boolean;
    }
  | { ok: false; disallowed: string };

function validateAndHardenGitArgs(args: readonly string[]): ValidatedGitArgs {
  if (args.length === 0) {
    return { ok: false, disallowed: "(empty)" };
  }
  if (args.length === 1 && args[0] === "--version") {
    return {
      ok: true,
      globalPrefix: [],
      subcommandAndArgs: ["--version"],
      needsWorktreeFilterCheck: false,
      needsMergeDriverCheck: false,
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
  let needsWorktreeFilterCheck = rule.needsWorktreeFilterCheck === true;

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
    if (rule.needsWorktreeFilterWhen?.has(arg)) {
      needsWorktreeFilterCheck = true;
    }
    subArgs.push(arg);
  }

  if (rule.validate && !rule.validate(seenFlags, positionals)) {
    return { ok: false, disallowed: sub };
  }

  return {
    ok: true,
    globalPrefix,
    subcommandAndArgs: subArgs,
    needsWorktreeFilterCheck,
    needsMergeDriverCheck: rule.needsMergeDriverCheck === true,
  };
}

function parseNullConfigRecords(stdout: string): Array<{ key: string; value?: string }> {
  const out: Array<{ key: string; value?: string }> = [];
  for (const rec of stdout.split("\0")) {
    if (rec === "") continue;
    const nl = rec.indexOf("\n");
    if (nl === -1) {
      out.push({ key: rec });
    } else {
      out.push({ key: rec.slice(0, nl), value: rec.slice(nl + 1) });
    }
  }
  return out;
}

const FILTER_KEY_RE = /^filter\.(.*)\.(clean|smudge|process)$/u;

type PreflightConfigResult =
  | { status: "empty" }
  | { status: "ok"; records: Array<{ key: string; value?: string }> }
  | { status: "error"; result: ExecResult };

async function queryPreflightConfig(
  cwd: string,
  env: NodeJS.ProcessEnv,
  globalPrefix: readonly string[],
  pattern: string,
  opts: { signal?: AbortSignal; timeoutMs: number; binary?: boolean },
): Promise<PreflightConfigResult> {
  const cfgRes = await runProcess(
    "git",
    [...SAFE_GIT_FLAGS, ...globalPrefix, "config", "--null", "--get-regexp", pattern],
    {
      cwd,
      env,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    },
  );
  if (cfgRes.errorCode !== undefined || (cfgRes.code !== 0 && cfgRes.code !== 1)) {
    return {
      status: "error",
      result: opts.binary ? { ...cfgRes, stdout: "", stdoutBuffer: Buffer.alloc(0) } : cfgRes,
    };
  }
  if (cfgRes.code === 1) {
    return { status: "empty" };
  }
  return { status: "ok", records: parseNullConfigRecords(cfgRes.stdout) };
}

/**
 * Execute an allowlisted read-only Git command with repository-local config, callback,
 * external diff/textconv, filter, and merge-driver safeguards enabled.
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
    GIT_TERMINAL_PROMPT: "0",
    GIT_TEST_COMMIT_GRAPH: "0",
    GIT_NO_LAZY_FETCH: "1",
    ...opts.env,
  });

  const totalTimeoutMs = opts.timeoutMs ?? 20_000;
  const deadline = totalTimeoutMs > 0 ? Date.now() + totalTimeoutMs : undefined;
  const remainingTimeoutMs = (): number => {
    if (deadline === undefined) return 0;
    return Math.max(1, deadline - Date.now());
  };

  const extraConfigFlags: string[] = [];

  if (validated.needsWorktreeFilterCheck) {
    const preflight = await queryPreflightConfig(
      cwd,
      env,
      validated.globalPrefix,
      String.raw`^filter\..*\.(clean|smudge|process)$`,
      { signal: opts.signal, timeoutMs: remainingTimeoutMs(), binary: opts.binary },
    );
    if (preflight.status === "error") return preflight.result;
    if (preflight.status === "ok") {
      const drivers = new Set<string>();
      for (const rec of preflight.records) {
        if (rec.value === "") continue;
        const m = FILTER_KEY_RE.exec(rec.key);
        const subsection = m?.[1];
        if (!subsection || !SAFE_SUBSECTION_RE.test(subsection)) {
          return failResult(1, "Refusing git worktree command: non-overridable filter configuration detected.", "EPERM");
        }
        drivers.add(subsection);
      }
      for (const drv of drivers) {
        extraConfigFlags.push(
          "-c",
          `filter.${drv}.clean=`,
          "-c",
          `filter.${drv}.smudge=`,
          "-c",
          `filter.${drv}.process=`,
          "-c",
          `filter.${drv}.required=false`,
        );
      }
    }
  }

  if (validated.needsMergeDriverCheck) {
    const preflight = await queryPreflightConfig(
      cwd,
      env,
      validated.globalPrefix,
      String.raw`^merge\..*\.driver$`,
      { signal: opts.signal, timeoutMs: remainingTimeoutMs(), binary: opts.binary },
    );
    if (preflight.status === "error") return preflight.result;
    if (preflight.status === "ok") {
      for (const rec of preflight.records) {
        if (rec.value !== "") {
          return failResult(1, "Refusing git merge-tree: custom merge driver configured.", "EPERM");
        }
      }
    }
  }

  if (deadline !== undefined && Date.now() >= deadline) {
    return failResult(1, `Process timed out after ${totalTimeoutMs}ms.`, "ETIMEDOUT");
  }

  return runProcess(
    "git",
    [...SAFE_GIT_FLAGS, ...extraConfigFlags, ...validated.globalPrefix, ...validated.subcommandAndArgs],
    {
      cwd,
      stdin: opts.stdin,
      binary: opts.binary,
      timeoutMs: remainingTimeoutMs(),
      maxBuffer: opts.maxBuffer,
      signal: opts.signal,
      env,
    },
  );
}
