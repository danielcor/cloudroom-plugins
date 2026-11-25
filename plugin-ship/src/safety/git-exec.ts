import { execFile } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  errorCode?: string;
}

export type GitExec = (cwd: string, args: readonly string[]) => Promise<ExecResult>;

export const SAFE_GIT_FLAGS = [
  "-c",
  "safe.bareRepository=explicit",
  "--no-replace-objects",
  "-c",
  "core.commitGraph=false",
  "-c",
  "core.multiPackIndex=false",
  "--literal-pathspecs",
  "--no-optional-locks",
] as const;

export function runProcess(
  command: string,
  args: readonly string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxBuffer?: number;
    stdin?: string;
  } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      [...args],
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs ?? 20_000,
        maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
          return;
        }
        const anyErr = err as NodeJS.ErrnoException & { status?: number; code?: string | number };
        const code = typeof anyErr.code === "number" ? anyErr.code : typeof anyErr.status === "number" ? anyErr.status : 1;
        const errorCode = typeof anyErr.code === "string" ? anyErr.code : undefined;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "", ...(errorCode ? { errorCode } : {}) });
      },
    );
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.end(opts.stdin);
    }
  });
}

export function defaultGitExec(cwd: string, args: readonly string[]): Promise<ExecResult> {
  return runProcess("git", [...SAFE_GIT_FLAGS, ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_TEST_COMMIT_GRAPH: "0",
      GIT_NO_LAZY_FETCH: "1",
    },
  });
}
