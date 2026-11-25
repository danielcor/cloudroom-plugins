import { isAbsolute, relative, resolve } from "node:path";
import type { ShipStore } from "../db.js";
import type { ShipInteractionResolution, ShipPendingInteraction } from "../review/types.js";
import { isNeverEditPath, isSecretFilename } from "../safety/never-edit.js";

const SHELL_META_RE = /[;&|`$<>()\r\n\0]/u;
const CREDENTIAL_ARG_RE =
  /(?:^|[\\/])(?:\.env(?:\.|$)|\.ssh(?:\/|$)|\.aws(?:\/|$)|\.gnupg(?:\/|$)|hosts\.yml$|git-credentials$|token\.json$|auth\.json$|credentials$)/iu;

const FORBIDDEN_BINS = new Set([
  "git",
  "gh",
  "glab",
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  "nc",
  "ncat",
  "socat",
  "sudo",
  "su",
  "chmod",
  "chown",
  "ln",
  "rm",
  "rmdir",
  "mv",
  "cp",
  "env",
  "printenv",
  "bash",
  "sh",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "pwsh",
  "powershell",
  "python",
  "python3",
  "perl",
  "ruby",
]);

const SAFE_READ_BINS = new Set(["ls", "cat", "head", "tail", "wc", "nl", "grep", "rg"]);
const SAFE_TEST_RUNNERS = new Set(["cargo", "dotnet", "pytest", "go", "vitest", "tsc", "jest", "eslint"]);
const SAFE_PKG_SUBCMDS = new Set(["test", "run", "vitest", "tsc", "lint", "typecheck", "check", "build"]);
const SAFE_NPX_BINS = new Set(["vitest", "tsc", "eslint", "jest", "prettier"]);
const SAFE_STEWARD_TOOLS = new Set([
  "read",
  "edit",
  "write",
  "patch",
  "str_replace",
  "grep",
  "glob",
  "list_dir",
  "ctx_read",
  "ctx_search",
  "ctx_glob",
  "ctx_tree",
]);

function splitSimpleArgs(command: string): string[] | null {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let tokenStarted = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"') {
        if (i + 1 >= command.length) return null;
        current += command[++i]!;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (tokenStarted) {
        args.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= command.length) return null;
      current += command[++i]!;
      tokenStarted = true;
      continue;
    }
    current += ch;
    tokenStarted = true;
  }

  if (quote) return null;
  if (tokenStarted) args.push(current);
  return args;
}

function isSafeWorkerPathArg(arg: string, worktreePath: string | null): boolean {
  if (!arg) return true;
  const flagValue = /^--?[a-zA-Z0-9_-]+=(.+)$/u.exec(arg);
  if (flagValue) {
    return isSafeWorkerPathArg(flagValue[1]!, worktreePath);
  }
  if (arg === ".." || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(arg) || arg.startsWith("~")) {
    return false;
  }
  if (CREDENTIAL_ARG_RE.test(arg) || isSecretFilename(arg) || isNeverEditPath(arg)) {
    return false;
  }
  if (isAbsolute(arg)) {
    if (!worktreePath) return false;
    const rootAbs = resolve(worktreePath);
    const targetAbs = resolve(arg);
    const rel = relative(rootAbs, targetAbs);
    if (rel === "") return true;
    if (rel.startsWith("..") || isAbsolute(rel)) return false;
    if (CREDENTIAL_ARG_RE.test(rel) || isSecretFilename(rel) || isNeverEditPath(rel)) return false;
  }
  return true;
}

function isSafeWriteScopePath(writeScope: string | null, worktreePath: string | null): boolean {
  if (!writeScope) return false;
  if (writeScope === ".." || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(writeScope) || writeScope.startsWith("~")) {
    return false;
  }
  if (isAbsolute(writeScope)) {
    if (!worktreePath) return false;
    const rel = relative(resolve(worktreePath), resolve(writeScope)).replace(/\\/gu, "/");
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
    return !CREDENTIAL_ARG_RE.test(rel) && !isSecretFilename(rel) && !isNeverEditPath(rel);
  }
  return !CREDENTIAL_ARG_RE.test(writeScope) && !isSecretFilename(writeScope) && !isNeverEditPath(writeScope);
}

export function isAllowedStewardWorkerCommand(command: string, worktreePath: string | null): boolean {
  if (!command || SHELL_META_RE.test(command)) return false;
  const args = splitSimpleArgs(command);
  if (!args || args.length === 0) return false;

  const bin = args[0]!.split("/").pop()!.toLowerCase();
  if (FORBIDDEN_BINS.has(bin)) return false;

  for (let i = 1; i < args.length; i++) {
    if (!isSafeWorkerPathArg(args[i]!, worktreePath)) return false;
  }

  if (bin === "sed") {
    return args.length === 4 && args[1] === "-n" && /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/u.test(args[2]!);
  }

  if (SAFE_READ_BINS.has(bin)) {
    if (bin === "rg" && args.some((a) => a === "--pre" || a.startsWith("--pre="))) return false;
    return true;
  }

  if (bin === "npm" || bin === "pnpm" || bin === "yarn") {
    const sub = args[1]?.toLowerCase();
    return Boolean(sub && SAFE_PKG_SUBCMDS.has(sub));
  }

  if (bin === "npx") {
    const toolArg = args[1]?.toLowerCase();
    return Boolean(toolArg && SAFE_NPX_BINS.has(toolArg));
  }

  if (SAFE_TEST_RUNNERS.has(bin)) {
    return true;
  }

  return false;
}

export class StewardWorkerGatekeeper {
  constructor(private readonly store: ShipStore) {}

  evaluateInteraction(interaction: ShipPendingInteraction): ShipInteractionResolution | null {
    const watch = this.store.getWatchByWorkerThreadId(interaction.threadId);
    if (!watch) return null;

    if (interaction.payload.kind !== "approval") {
      return null;
    }

    const subj = interaction.payload.subject;
    switch (subj.kind) {
      case "permission_grant":
      case "plan":
        return { decision: "deny" };
      case "file_change":
        return isSafeWriteScopePath(subj.writeScope, watch.worktreePath)
          ? { decision: "allow_once", grantedPermissions: null }
          : { decision: "deny" };
      case "tool_use": {
        const lower = subj.tool.toLowerCase();
        if (lower.startsWith("ship_steward_") || SAFE_STEWARD_TOOLS.has(lower)) {
          return { decision: "allow_once", grantedPermissions: null };
        }
        return { decision: "deny" };
      }
      case "command": {
        const actionsOk = subj.actions.every((a) => {
          if (a.type === "read") return isSafeWorkerPathArg(a.path, watch.worktreePath);
          if (a.type === "listFiles" || a.type === "search") {
            return !a.path || isSafeWorkerPathArg(a.path, watch.worktreePath);
          }
          return true;
        });
        if (!actionsOk) return { decision: "deny" };
        return isAllowedStewardWorkerCommand(subj.command, watch.worktreePath)
          ? { decision: "allow_once", grantedPermissions: null }
          : { decision: "deny" };
      }
    }
  }
}
