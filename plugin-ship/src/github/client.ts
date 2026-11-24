import { runProcess, SAFE_GIT_FLAGS, type ExecResult } from "../safety/git-exec.js";

export type GhExec = (cwd: string, args: readonly string[], stdin?: string) => Promise<ExecResult>;

export function defaultGhExec(cwd: string, args: readonly string[], stdin?: string): Promise<ExecResult> {
  return runProcess("gh", args, {
    cwd,
    stdin,
    timeoutMs: 60_000,
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

export function defaultAuthorGitExec(cwd: string, args: readonly string[]): Promise<ExecResult> {
  return runProcess("git", [...SAFE_GIT_FLAGS, ...args], {
    cwd,
    timeoutMs: 60_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_TEST_COMMIT_GRAPH: "0",
    },
  });
}

export interface ParsedGitHubRemote {
  host: "github.com";
  owner: string;
  name: string;
  slug: string;
}

const VALID_GH_PART_RE = /^[A-Za-z0-9._-]+$/u;

function cleanOwnerRepo(ownerRaw: string, nameRaw: string): ParsedGitHubRemote | null {
  const owner = ownerRaw.trim();
  let name = nameRaw.trim().replace(/\/+$/u, "");
  if (name.endsWith(".git")) {
    name = name.slice(0, -4);
  }
  if (!owner || !name || owner === "." || owner === ".." || name === "." || name === "..") {
    return null;
  }
  if (!VALID_GH_PART_RE.test(owner) || !VALID_GH_PART_RE.test(name)) {
    return null;
  }
  return { host: "github.com", owner, name, slug: `${owner}/${name}` };
}

/**
 * Parse a GitHub.com remote URL (`git@github.com:owner/repo`, `ssh://git@github.com/owner/repo`,
 * or `https://(user@)?github.com/owner/repo(.git)`). Returns null for non-GitHub remotes.
 */
export function parseGitHubRemoteUrl(url: string): ParsedGitHubRemote | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  const scpMatch = /^(?:[A-Za-z0-9._-]+@)?github\.com:([^/]+)\/([^/\s]+?)\/?$/iu.exec(trimmed);
  if (scpMatch) {
    return cleanOwnerRepo(scpMatch[1]!, scpMatch[2]!);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "ssh:") {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") {
    return null;
  }
  const parts = parsed.pathname.replace(/^\/+|\/+$/gu, "").split("/");
  if (parts.length !== 2) return null;
  return cleanOwnerRepo(parts[0]!, parts[1]!);
}

export interface RepoMeta {
  slug: string;
  owner: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
  isFork: boolean;
  parentSlug: string | null;
  viewerLogin: string;
  viewerPermission: string;
}

export interface PullRequestSummary {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
  authorLogin: string;
  labels: string[];
  mergeStateStatus: string;
  isCrossRepository: boolean;
}

const REPO_META_GRAPHQL = `query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    isPrivate
    isFork
    viewerPermission
    defaultBranchRef { name }
    parent { nameWithOwner }
  }
}`;

interface RepoMetaGraphqlPayload {
  data?: {
    viewer?: { login?: string | null } | null;
    repository?: {
      nameWithOwner?: string;
      isPrivate?: boolean;
      isFork?: boolean;
      viewerPermission?: string | null;
      defaultBranchRef?: { name?: string | null } | null;
      parent?: { nameWithOwner?: string | null } | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

export async function ghFetchRepoMeta(
  cwd: string,
  owner: string,
  name: string,
  execGh: GhExec = defaultGhExec,
): Promise<RepoMeta> {
  const res = await execGh(cwd, [
    "api",
    "graphql",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-f",
    `query=${REPO_META_GRAPHQL}`,
  ]);
  if (res.code !== 0) {
    throw new Error(`gh api graphql repo lookup failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  const parsed = JSON.parse(res.stdout) as RepoMetaGraphqlPayload;
  if (parsed.errors && parsed.errors.length > 0) {
    throw new Error(`GitHub GraphQL error: ${parsed.errors.map((e) => e.message ?? "unknown").join("; ")}`);
  }
  const repo = parsed.data?.repository;
  if (!repo) {
    throw new Error(`GitHub repository ${owner}/${name} was not found or is inaccessible.`);
  }
  return {
    slug: repo.nameWithOwner || `${owner}/${name}`,
    owner,
    name,
    defaultBranch: repo.defaultBranchRef?.name || "main",
    isPrivate: Boolean(repo.isPrivate),
    isFork: Boolean(repo.isFork),
    parentSlug: repo.parent?.nameWithOwner ?? null,
    viewerLogin: parsed.data?.viewer?.login ?? "",
    viewerPermission: (repo.viewerPermission ?? "READ").toLowerCase(),
  };
}

interface RawGhPrListItem {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
  author?: { login?: string | null } | null;
  labels?: Array<{ name?: string | null }>;
  mergeStateStatus?: string;
  isCrossRepository?: boolean;
}

export async function ghFindOpenPr(
  cwd: string,
  slug: string,
  headBranch: string,
  execGh: GhExec = defaultGhExec,
): Promise<PullRequestSummary | null> {
  const res = await execGh(cwd, [
    "pr",
    "list",
    "--repo",
    slug,
    "--head",
    headBranch,
    "--state",
    "open",
    "--json",
    "number,url,title,state,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,author,labels,mergeStateStatus,isCrossRepository",
    "--limit",
    "5",
  ]);
  if (res.code !== 0) {
    throw new Error(`gh pr list failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  }
  const items = JSON.parse(res.stdout) as RawGhPrListItem[];
  const pr = items[0];
  if (!pr) return null;
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    isDraft: Boolean(pr.isDraft),
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    baseRefName: pr.baseRefName,
    baseRefOid: pr.baseRefOid,
    authorLogin: pr.author?.login ?? "",
    labels: (pr.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
    mergeStateStatus: pr.mergeStateStatus ?? "UNKNOWN",
    isCrossRepository: Boolean(pr.isCrossRepository),
  };
}
