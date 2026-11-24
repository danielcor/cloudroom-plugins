import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { defaultGitExec, type GitExec } from "./git-exec.js";
import { isNeverEditPath, isProtectedMergePath, normalizePathForCheck } from "./never-edit.js";

const SHA_RE = /^[0-9a-f]{40}$/u;
const DANGEROUS_GIT_CONFIG_RE = /^(?:merge\.(?:.*\.driver|renormalize)|branch\..*\.mergeoptions|pull\.twohead|hook\..*\.command)$/u;

export interface MergeCheckOptions {
  mode: "base" | "head";
  expectedTipSha?: string;
  gitIncludedConfigs?: readonly string[];
  execGit?: GitExec;
}

export interface MergeCheckResult {
  safe: boolean;
  alreadyMerged: boolean;
  reason: string | null;
  blockedPaths: string[];
  noticePaths: string[];
  touchedPaths: string[];
}

interface DiffTreeEntry {
  oldMode: string;
  newMode: string;
  path: string;
}

function failResult(reason: string, partial: Partial<MergeCheckResult> = {}): MergeCheckResult {
  return {
    safe: false,
    alreadyMerged: false,
    reason,
    blockedPaths: partial.blockedPaths ?? [],
    noticePaths: partial.noticePaths ?? [],
    touchedPaths: partial.touchedPaths ?? [],
  };
}

/** Parse NUL-delimited `git diff-tree -r -z --no-renames` records into mode + path entries. */
export function parseRawDiffTreeZ(stdout: string): DiffTreeEntry[] {
  const tokens = stdout.split("\0");
  const out: DiffTreeEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const header = tokens[i]!;
    if (!header.startsWith(":")) continue;
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]\d*$/u.exec(header);
    const path = tokens[i + 1];
    if (!match || path === undefined || path === "") continue;
    out.push({ oldMode: match[1]!, newMode: match[2]!, path });
    i += 1;
  }
  return out;
}

interface ScopedConfigEntry {
  scope: string;
  origin: string;
  key: string;
  value: string;
}

async function readScopedGitConfig(root: string, execGit: GitExec): Promise<ScopedConfigEntry[] | null> {
  const res = await execGit(root, ["config", "--show-scope", "--show-origin", "--null", "--list"]);
  if (res.code !== 0) return null;
  const tokens = res.stdout.split("\0");
  const out: ScopedConfigEntry[] = [];
  for (let i = 0; i + 2 < tokens.length; i += 3) {
    const scope = tokens[i]!;
    const origin = tokens[i + 1]!;
    const kv = tokens[i + 2]!;
    const nl = kv.indexOf("\n");
    const key = (nl === -1 ? kv : kv.slice(0, nl)).trim().toLowerCase();
    const value = nl === -1 ? "" : kv.slice(nl + 1).trim();
    out.push({ scope, origin, key, value });
  }
  return out;
}

function collectRepoGitIncludedPaths(entries: readonly ScopedConfigEntry[], root: string): string[] {
  const rootAbs = resolve(root);
  const rels = new Set<string>();
  for (const { scope, origin, key, value } of entries) {
    if ((scope === "local" || scope === "worktree") && (key === "include.path" || /^includeif\..*\.path$/u.test(key))) {
      if (value) {
        const baseDir = origin.startsWith("file:") ? resolve(rootAbs, origin.slice(5), "..") : rootAbs;
        const abs = isAbsolute(value) ? resolve(value) : resolve(baseDir, value);
        const rel = relative(rootAbs, abs).replace(/\\/gu, "/");
        if (rel !== "" && !rel.startsWith("../") && !isAbsolute(rel)) rels.add(rel);
      }
    }
    if (origin.startsWith("file:")) {
      const abs = resolve(rootAbs, origin.slice(5));
      const rel = relative(rootAbs, abs).replace(/\\/gu, "/");
      if (rel !== "" && !rel.startsWith("../") && !isAbsolute(rel) && !/^\.git(?:\/|$)/iu.test(rel)) {
        rels.add(rel);
      }
    }
  }
  return [...rels];
}

function findDangerousGitConfigReason(entries: readonly ScopedConfigEntry[]): string | null {
  for (const { scope, key } of entries) {
    // Cloudroom injects `hook.cloudroom-strip-ai-co-authors.command` at `command` scope when
    // stripAiCoAuthorsEnabled is on; allow only that known host hook while blocking all others.
    if (scope === "command" && key === "hook.cloudroom-strip-ai-co-authors.command") {
      continue;
    }
    if (DANGEROUS_GIT_CONFIG_RE.test(key)) {
      return `dangerous git config setting "${key}" is present; leaving merge to user`;
    }
    if ((scope === "local" || scope === "worktree") && (key === "include.path" || key.startsWith("includeif."))) {
      return `local/worktree git config "${key}" could alter settings during merge`;
    }
  }
  return null;
}

/**
 * Simulate a git merge in memory using `git merge-tree --write-tree` and enforce
 * `never-edit` / protected-config / symlink / base-tip safety checks before running `git merge`.
 */
export async function checkMergeSafe(root: string, targetRef: string, opts: MergeCheckOptions): Promise<MergeCheckResult> {
  const execGit = opts.execGit ?? defaultGitExec;

  const [replaceRes, gitPathRes, mergeHeadRes, configEntries] = await Promise.all([
    execGit(root, ["for-each-ref", "--count=1", "refs/replace"]),
    execGit(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/grafts"]),
    execGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", "MERGE_HEAD^{commit}"]),
    readScopedGitConfig(root, execGit),
  ]);

  if (replaceRes.code !== 0 || replaceRes.stdout.trim() !== "") {
    return failResult("repository holds git replace refs; leaving merge to user");
  }
  if (gitPathRes.code === 0 && gitPathRes.stdout.trim() !== "") {
    const graftsOk = await stat(gitPathRes.stdout.trim()).then(
      (s) => !s.isFile() || s.size === 0,
      () => true,
    );
    if (!graftsOk) {
      return failResult("repository holds .git/info/grafts; leaving merge to user");
    }
  }
  if (mergeHeadRes.code === 0 && mergeHeadRes.stdout.trim() !== "") {
    return failResult("a merge is already open in this checkout (MERGE_HEAD exists)");
  }
  if (configEntries === null) return failResult("git config --show-origin could not be read");
  const configErr = findDangerousGitConfigReason(configEntries);
  if (configErr) return failResult(configErr);
  const repoIncludes = opts.gitIncludedConfigs
    ? [...opts.gitIncludedConfigs]
    : collectRepoGitIncludedPaths(configEntries, root);

  const [headRes, targetRes] = await Promise.all([
    execGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"]),
    execGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${targetRef}^{commit}`]),
  ]);
  const headSha = headRes.stdout.trim();
  const targetSha = targetRes.stdout.trim();

  if (headRes.code !== 0 || !SHA_RE.test(headSha)) {
    return failResult("HEAD does not resolve to a commit");
  }
  if (targetRes.code !== 0 || !SHA_RE.test(targetSha)) {
    return failResult(`target ref "${targetRef}" does not resolve to a fetched commit`);
  }
  if (opts.expectedTipSha !== undefined && targetSha !== opts.expectedTipSha) {
    return failResult(`fetched tip ${targetSha} does not match expected GitHub tip ${opts.expectedTipSha}`);
  }

  const ancRes = await execGit(root, ["merge-base", "--is-ancestor", targetSha, headSha]);
  if (ancRes.code === 0) {
    return {
      safe: true,
      alreadyMerged: true,
      reason: null,
      blockedPaths: [],
      noticePaths: [],
      touchedPaths: [],
    };
  }

  const mergeTreeRes = await execGit(root, ["merge-tree", "--write-tree", headSha, targetSha]);
  const treeSha = mergeTreeRes.stdout.split("\n")[0]?.trim() ?? "";
  if (![0, 1].includes(mergeTreeRes.code) || !SHA_RE.test(treeSha)) {
    return failResult(
      `git merge-tree could not simulate merge (${mergeTreeRes.stderr.trim() || `exit ${mergeTreeRes.code}`})`,
    );
  }

  const diffRes = await execGit(root, [
    "diff-tree",
    "-r",
    "-z",
    "--no-renames",
    "--ignore-submodules=none",
    headSha,
    treeSha,
  ]);
  if (diffRes.code !== 0) {
    return failResult(`git diff-tree failed after merge-tree (${diffRes.stderr.trim()})`);
  }

  const entries = parseRawDiffTreeZ(diffRes.stdout);
  const touchedPaths = entries.map((e) => e.path);
  const includedNorms = new Set(repoIncludes.map(normalizePathForCheck));
  const blockedPaths: string[] = [];
  const noticePaths: string[] = [];

  for (const entry of entries) {
    const norm = normalizePathForCheck(entry.path);
    const isSymlink = entry.oldMode === "120000" || entry.newMode === "120000";
    const isIncludedConfig = [...includedNorms].some((inc) => norm === inc || inc.startsWith(`${norm}/`));
    if (isProtectedMergePath(entry.path) || isIncludedConfig) {
      blockedPaths.push(entry.path);
      continue;
    }
    if (opts.mode === "head") {
      if (isNeverEditPath(entry.path) || isSymlink) {
        blockedPaths.push(entry.path);
      }
      continue;
    }
    // Base merge: non-protected never-edit paths trigger an audit notice,
    // while symlinks colliding with protected prefixes are blocked.
    if (isSymlink && isNeverEditPath(entry.path)) {
      blockedPaths.push(entry.path);
    } else if (isNeverEditPath(entry.path)) {
      noticePaths.push(entry.path);
    }
  }

  if (blockedPaths.length > 0) {
    return failResult(
      `merge of ${targetRef} would modify protected path(s): ${blockedPaths.join(", ")}`,
      { blockedPaths, noticePaths, touchedPaths },
    );
  }

  return {
    safe: true,
    alreadyMerged: false,
    reason: null,
    blockedPaths: [],
    noticePaths,
    touchedPaths,
  };
}

/** Check whether `.git/` contains symlinks on critical files where git might traverse outside. */
export async function checkGitDirPlain(gitDir: string, commonDir: string): Promise<string | null> {
  const candidates = [
    join(gitDir, "index"),
    join(gitDir, "COMMIT_EDITMSG"),
    join(gitDir, "logs", "HEAD"),
    join(commonDir, "packed-refs"),
  ];
  for (const filePath of candidates) {
    const ok = await statOrMissingPlain(filePath);
    if (!ok) return filePath;
  }
  return null;
}

async function statOrMissingPlain(filePath: string): Promise<boolean> {
  const { lstat } = await import("node:fs/promises");
  try {
    const st = await lstat(filePath);
    return !st.isSymbolicLink() && st.isFile();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT";
  }
}
