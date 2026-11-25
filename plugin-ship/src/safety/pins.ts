import { createHash } from "node:crypto";
import { access, lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { defaultGitExec, type GitExec } from "./git-exec.js";

const MAX_PIN_FILE_BYTES = 1_000_000;
const MAX_HOOK_FILES_PER_DIR = 500;

export type PinSnapshotResult =
  | { ok: true; pins: Record<string, string> }
  | { ok: false; error: string };

export interface PinDrift {
  driftedKey: string;
  reason: string;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sha256Buffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function hashFileContent(filePath: string): Promise<string> {
  try {
    const lst = await lstat(filePath);
    if (lst.isSymbolicLink()) {
      const target = await realpath(filePath).catch(() => "broken-symlink");
      const st = await stat(filePath).catch(() => null);
      if (!st || !st.isFile()) return `symlink:${target}`;
      if (st.size > MAX_PIN_FILE_BYTES) return `oversize:${st.size}`;
      const buf = await readFile(filePath);
      return `symlink:${target}:${sha256Buffer(buf)}`;
    }
    if (!lst.isFile()) return "none";
    if (lst.size > MAX_PIN_FILE_BYTES) return `oversize:${lst.size}`;
    const buf = await readFile(filePath);
    return sha256Buffer(buf);
  } catch {
    return "none";
  }
}

async function statBinaryMeta(binPath: string): Promise<string> {
  try {
    const resolved = await realpath(binPath);
    const st = await stat(resolved);
    if (!st.isFile()) return "none";
    return `${resolved} ${st.size} ${st.mtimeMs} ${st.ctimeMs} ${st.ino}`;
  } catch {
    return "none";
  }
}

async function findExecutableOnPath(name: string, pathEnv: string): Promise<string | null> {
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep scanning PATH
    }
  }
  return null;
}

async function listDirFilesBounded(dirPath: string, cap: number): Promise<{ files: string[]; overflow: boolean }> {
  const files: string[] = [];
  try {
    const dir = await opendir(dirPath, { recursive: true });
    for await (const entry of dir) {
      if (entry.isDirectory()) continue;
      files.push(join(entry.parentPath, entry.name));
      if (files.length > cap) {
        return { files, overflow: true };
      }
    }
  } catch {
    // Missing hooks directory is normal.
  }
  return { files: files.sort(), overflow: false };
}

function collectGitConfigFiles(originStdout: string, includeStdout: string, root: string): string[] {
  const files = new Set<string>();
  const originTokens = originStdout.split("\0");
  for (let i = 0; i + 1 < originTokens.length; i += 2) {
    const origin = originTokens[i]!;
    if (origin.startsWith("file:")) {
      const p = origin.slice(5);
      files.add(isAbsolute(p) ? p : resolve(root, p));
    }
  }
  const incTokens = includeStdout.split("\0");
  for (let i = 0; i + 1 < incTokens.length; i += 2) {
    const origin = incTokens[i]!;
    const kv = incTokens[i + 1]!;
    const nl = kv.indexOf("\n");
    const target = nl === -1 ? "" : kv.slice(nl + 1).trim();
    if (!target) continue;
    const base = origin.startsWith("file:") ? dirname(resolve(root, origin.slice(5))) : root;
    files.add(isAbsolute(target) ? target : resolve(base, target));
  }
  return [...files].sort();
}

/**
 * Snapshot tamper-detection fingerprints across git config, git hooks, `.claude/`
 * settings/skills, `.mcp.json`, `gh` config, and resolved `git`/`gh` binaries.
 */
export async function computeCheckoutPins(
  root: string,
  opts: {
    ghConfigDir?: string;
    env?: NodeJS.ProcessEnv;
    home?: string;
    execGit?: GitExec;
  } = {},
): Promise<PinSnapshotResult> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const execGit = opts.execGit ?? defaultGitExec;
  const ghConfigDir = opts.ghConfigDir ?? env.GH_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "gh");

  const [cfgOrigin, cfgNames, cfgIncludes, commonDirRes] = await Promise.all([
    execGit(root, ["config", "--list", "--show-origin"]),
    execGit(root, ["config", "--show-origin", "-z", "--name-only", "--list"]),
    execGit(root, ["config", "--show-origin", "-z", "--type=path", "--get-regexp", String.raw`^include(if\..*)?\.path$`]),
    execGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ]);

  if (cfgOrigin.code !== 0 || cfgNames.code !== 0 || commonDirRes.code !== 0 || ![0, 1].includes(cfgIncludes.code)) {
    return { ok: false, error: "git config or git-common-dir could not be read while pinning checkout" };
  }

  const commonDir = commonDirRes.stdout.trim();
  const hooksDirs = new Set<string>([join(commonDir, "hooks")]);
  for (const m of cfgOrigin.stdout.matchAll(/\tcore\.hookspath=(.+)$/gimu)) {
    const rawHookDir = m[1]!.trim();
    if (!rawHookDir) continue;
    const expanded = rawHookDir.startsWith("~/") ? join(home, rawHookDir.slice(2)) : rawHookDir === "~" ? home : rawHookDir;
    hooksDirs.add(isAbsolute(expanded) ? expanded : resolve(root, expanded));
  }

  const pins: Record<string, string> = {
    "git:config": sha256Text(cfgOrigin.stdout),
  };

  for (const hookDir of [...hooksDirs].sort()) {
    const listed = await listDirFilesBounded(hookDir, MAX_HOOK_FILES_PER_DIR);
    if (listed.overflow) {
      return { ok: false, error: `too_many_hooks:${hookDir}` };
    }
    const activeHooks = listed.files.filter((f) => !f.endsWith(".sample"));
    pins[`hooks:count:${hookDir}`] = String(activeHooks.length);
    for (const file of activeHooks) {
      pins[`file:${file}`] = await hashFileContent(file);
    }
  }

  const watchedFiles = new Set<string>([
    ...collectGitConfigFiles(cfgNames.stdout, cfgIncludes.stdout, root),
    join(commonDir, "info", "attributes"),
    join(ghConfigDir, "config.yml"),
    join(ghConfigDir, "hosts.yml"),
    join(root, ".claude", "settings.json"),
    join(root, ".claude", "settings.local.json"),
    join(root, ".mcp.json"),
    join(root, ".claude", "skills", "steward", "SKILL.md"),
    join(root, ".claude", "skills", "babysit", "SKILL.md"),
  ]);

  const hashedFiles = await Promise.all(
    [...watchedFiles].sort().map(async (f) => [`file:${f}`, await hashFileContent(f)] as const),
  );
  for (const [k, v] of hashedFiles) {
    pins[k] = v;
  }

  const pathEnv = env.PATH ?? "";
  for (const bin of ["git", "gh"] as const) {
    const binPath = await findExecutableOnPath(bin, pathEnv);
    pins[`bin:${bin}`] = binPath ? await statBinaryMeta(binPath) : "none";
  }

  return { ok: true, pins };
}

/** Compare two pin snapshots and return the first drifted key, or null if identical. */
export function diffPins(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): PinDrift | null {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...allKeys].sort()) {
    const prev = before[key] ?? "none";
    const next = after[key] ?? "none";
    if (prev !== next) {
      const label = key.startsWith("file:")
        ? key.slice(5)
        : key.startsWith("hooks:count:")
          ? `hook file count in ${key.slice(12)}`
          : key.startsWith("bin:")
            ? `executable ${key.slice(4)}`
            : key;
      return {
        driftedKey: key,
        reason: `${label} changed since watch started`,
      };
    }
  }
  return null;
}
