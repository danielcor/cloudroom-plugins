import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  hostContract,
  type CheckoutInspection,
  type InspectPublishContextOutput,
  type InspectReviewContextOutput,
  type PolledCheckRunOutput,
  type PollPrStateOutput,
  type PublishChangesOutput,
} from "./src/contract.js";
import {
  defaultAuthorGitExec,
  defaultGhExec,
  ghFetchRepoMeta,
  ghFindOpenPr,
  parseGitHubRemoteUrl,
  type GhExec,
  type PullRequestSummary,
  type RepoMeta,
} from "./src/github/client.js";
import { fetchPrDiscussion, truncateUtf8, type FilteredPrDiscussion } from "./src/github/comments.js";
import { isValidGitBranchName } from "./src/publish/preflight.js";
import { defaultGitExec, runProcess, SAFE_GIT_FLAGS, type ExecResult, type GitExec } from "./src/safety/git-exec.js";
import { checkGitDirPlain, checkMergeSafe } from "./src/safety/merge-guard.js";
import { isNeverEditPath, isSecretFilename, normalizePathForCheck, stripInvisible } from "./src/safety/never-edit.js";
import { validateCommitMessage } from "./src/safety/outbound-text.js";
import { computeCheckoutPins, diffPins } from "./src/safety/pins.js";
import { collectLocalSecrets, findLocalSecretMatch, findSecrets } from "./src/safety/secrets.js";

const MAX_DIFF_TEXT_BYTES = 65_536;

export interface HostDeps {
  execGit?: GitExec;
  execGh?: GhExec;
}

function parsePorcelainV2Z(stdout: string): {
  changedFiles: string[];
  untrackedFiles: string[];
  submodules: string[];
} {
  const tokens = stdout.split("\0");
  const changed = new Set<string>();
  const untracked = new Set<string>();
  const submodules = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok) continue;
    if (tok.startsWith("? ")) {
      const p = tok.slice(2);
      if (p) {
        changed.add(p);
        untracked.add(p);
        if (p.endsWith("/")) submodules.add(p);
      }
    } else if (tok.startsWith("1 ")) {
      const parts = tok.split(" ");
      const sub = parts[2] ?? "";
      const p = parts.slice(8).join(" ");
      if (p) {
        changed.add(p);
        if (sub.startsWith("S") || p.endsWith("/")) submodules.add(p);
      }
    } else if (tok.startsWith("u ")) {
      const parts = tok.split(" ");
      const sub = parts[2] ?? "";
      const p = parts.slice(10).join(" ");
      if (p) {
        changed.add(p);
        if (sub.startsWith("S") || p.endsWith("/")) submodules.add(p);
      }
    } else if (tok.startsWith("2 ")) {
      const parts = tok.split(" ");
      const sub = parts[2] ?? "";
      const p = parts.slice(9).join(" ");
      if (p) {
        changed.add(p);
        if (sub.startsWith("S") || p.endsWith("/")) submodules.add(p);
      }
      i += 1;
    }
  }

  return { changedFiles: [...changed], untrackedFiles: [...untracked], submodules: [...submodules] };
}

function parseRemotes(stdout: string): CheckoutInspection["remotes"] {
  const out: CheckoutInspection["remotes"] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(\S+)\t(.+) \((fetch|push)\)(?: \[[^\]]*\])?$/u.exec(line.trimEnd());
    if (m) {
      out.push({ name: m[1]!, url: m[2]!, kind: m[3]! as "fetch" | "push" });
    }
  }
  return out;
}

async function detectInProgressOp(gitDir: string): Promise<string | null> {
  const ops: readonly { marker: string; label: string }[] = [
    { marker: "MERGE_HEAD", label: "merge" },
    { marker: "REBASE_HEAD", label: "rebase" },
    { marker: "rebase-merge", label: "rebase" },
    { marker: "rebase-apply", label: "rebase" },
    { marker: "CHERRY_PICK_HEAD", label: "cherry-pick" },
    { marker: "REVERT_HEAD", label: "revert" },
    { marker: "sequencer", label: "sequencer" },
  ];
  for (const op of ops) {
    const exists = await lstat(join(gitDir, op.marker)).then(
      () => true,
      () => false,
    );
    if (exists) return op.label;
  }
  return null;
}

export async function inspectCheckoutAt(root: string, execGit: GitExec = defaultGitExec): Promise<CheckoutInspection> {
  const topRes = await execGit(root, ["rev-parse", "--show-toplevel"]);
  if (topRes.code !== 0 || topRes.stdout.trim() === "") {
    throw new Error(`Not a git repository: ${topRes.stderr.trim() || root}`);
  }
  const topRoot = topRes.stdout.trim();

  const [gitDirRes, commonDirRes, headRes, symRefRes, statusRes, remoteRes] = await Promise.all([
    execGit(topRoot, ["rev-parse", "--path-format=absolute", "--git-dir"]),
    execGit(topRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    execGit(topRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
    execGit(topRoot, ["symbolic-ref", "--quiet", "HEAD"]),
    execGit(topRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames"]),
    execGit(topRoot, ["remote", "-v"]),
  ]);

  if (gitDirRes.code !== 0 || commonDirRes.code !== 0 || statusRes.code !== 0) {
    throw new Error("git inspection failed inside checkout");
  }

  const gitDir = gitDirRes.stdout.trim();
  const commonDir = commonDirRes.stdout.trim();
  const headSha = headRes.code === 0 && headRes.stdout.trim() !== "" ? headRes.stdout.trim() : null;
  const rawSym = symRefRes.code === 0 ? symRefRes.stdout.trim() : "";
  const branch = rawSym.startsWith("refs/heads/") ? rawSym.slice("refs/heads/".length) : null;
  const { changedFiles, submodules } = parsePorcelainV2Z(statusRes.stdout);

  const [inProgressOp, gitDirLinkIssue, hardLinkFlags] = await Promise.all([
    detectInProgressOp(gitDir),
    checkGitDirPlain(gitDir, commonDir),
    Promise.all(
      changedFiles.map((rel) =>
        lstat(join(topRoot, rel)).then(
          (st) => st.isFile() && st.nlink > 1,
          () => false,
        ),
      ),
    ),
  ]);

  const hardLinks = changedFiles.filter((_, idx) => hardLinkFlags[idx]);

  return {
    root: topRoot,
    gitDir,
    commonDir,
    headSha,
    branch,
    isDetached: branch === null,
    isClean: changedFiles.length === 0,
    inProgressOp,
    remotes: parseRemotes(remoteRes.stdout),
    changedFiles,
    hardLinks,
    submodules,
    gitDirLinkIssue,
  };
}

function selectRemote(
  remotes: CheckoutInspection["remotes"],
  requestedRemote?: string,
): { name: string; url: string } {
  const wanted = requestedRemote?.trim();
  if (wanted) {
    const push = remotes.find((r) => r.name === wanted && r.kind === "push");
    const fetch = remotes.find((r) => r.name === wanted && r.kind === "fetch");
    return { name: wanted, url: push?.url ?? fetch?.url ?? "" };
  }
  const originPush = remotes.find((r) => r.name === "origin" && r.kind === "push");
  const originFetch = remotes.find((r) => r.name === "origin" && r.kind === "fetch");
  if (originPush || originFetch) {
    return { name: "origin", url: (originPush ?? originFetch)!.url };
  }
  const first = remotes[0];
  return first ? { name: first.name, url: first.url } : { name: "origin", url: "" };
}

function extractAddedDiffContent(unifiedDiff: string): string {
  const added: string[] = [];
  for (const line of unifiedDiff.split(/\r?\n/u)) {
    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      added.push(line.slice(1));
    }
  }
  return added.join("\n");
}

async function resolveBaseRefSha(
  root: string,
  remoteName: string,
  baseBranch: string,
  execGit: GitExec,
): Promise<string | null> {
  const candidates = [`${remoteName}/${baseBranch}`, `refs/remotes/${remoteName}/${baseBranch}`, baseBranch];
  for (const ref of candidates) {
    const res = await execGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
    const sha = res.stdout.trim();
    if (res.code === 0 && /^[0-9a-f]{40}$/u.test(sha)) {
      return sha;
    }
  }
  return null;
}

export async function inspectPublishContextAt(
  input: { root: string; remote?: string; baseBranch?: string },
  deps: HostDeps = {},
): Promise<InspectPublishContextOutput> {
  const execGit = deps.execGit ?? defaultGitExec;
  const execGh = deps.execGh ?? defaultGhExec;
  const inspection = await inspectCheckoutAt(input.root, execGit);
  const selected = selectRemote(inspection.remotes, input.remote);
  const parsedRemote = parseGitHubRemoteUrl(selected.url);

  let repoMeta: RepoMeta | null = null;
  let existingPr: PullRequestSummary | null = null;

  if (parsedRemote) {
    repoMeta = await ghFetchRepoMeta(inspection.root, parsedRemote.owner, parsedRemote.name, execGh);
    if (!inspection.isDetached && inspection.branch && inspection.branch !== repoMeta.defaultBranch) {
      existingPr = await ghFindOpenPr(inspection.root, repoMeta.slug, inspection.branch, execGh);
    }
  }

  const baseBranch = input.baseBranch?.trim() || existingPr?.baseRefName || repoMeta?.defaultBranch || "main";
  const baseSha = inspection.headSha ? await resolveBaseRefSha(inspection.root, selected.name, baseBranch, execGit) : null;

  let aheadCount = 0;
  let commitSubjects: string[] = [];
  const diffChunks: string[] = [];

  if (baseSha && inspection.headSha) {
    const [countRes, logRes, committedDiffRes] = await Promise.all([
      execGit(inspection.root, ["rev-list", "--count", `${baseSha}..HEAD`]),
      execGit(inspection.root, ["log", "--format=%s", "-n", "20", `${baseSha}..HEAD`]),
      execGit(inspection.root, ["diff", "--unified=2", "--no-color", `${baseSha}..HEAD`]),
    ]);
    if (countRes.code === 0) {
      const parsedCount = Number.parseInt(countRes.stdout.trim(), 10);
      if (Number.isFinite(parsedCount) && parsedCount >= 0) aheadCount = parsedCount;
    }
    if (logRes.code === 0 && logRes.stdout.trim()) {
      commitSubjects = logRes.stdout.trim().split("\n").filter(Boolean);
    }
    if (committedDiffRes.code === 0 && committedDiffRes.stdout) {
      diffChunks.push(committedDiffRes.stdout);
    }
  }

  const wtDiffRes = inspection.headSha
    ? await execGit(inspection.root, ["diff", "--unified=2", "--no-color", "HEAD"])
    : await execGit(inspection.root, ["diff", "--unified=2", "--no-color"]);
  if (wtDiffRes.code === 0 && wtDiffRes.stdout) {
    diffChunks.push(wtDiffRes.stdout);
  }

  const statusZ = await execGit(inspection.root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames"]);
  const untracked = statusZ.code === 0 ? parsePorcelainV2Z(statusZ.stdout).untrackedFiles : [];

  for (const rel of untracked.slice(0, 40)) {
    if (isSecretFilename(rel) || isNeverEditPath(rel)) continue;
    try {
      const st = await lstat(join(inspection.root, rel));
      if (!st.isFile() || st.size > 65_536) continue;
      const raw = await readFile(join(inspection.root, rel));
      if (raw.includes(0)) continue;
      const text = raw.toString("utf8");
      const prefixed = text
        .split(/\r?\n/u)
        .map((l) => `+${l}`)
        .join("\n");
      diffChunks.push(`+++ b/${rel}\n${prefixed}`);
    } catch {
      // Skip unreadable file during inspection.
    }
  }

  const combinedDiff = diffChunks.join("\n");
  const boundedDiff = truncateUtf8(combinedDiff, MAX_DIFF_TEXT_BYTES).text;
  const addedContent = extractAddedDiffContent(combinedDiff);

  const diffSecretFinding = findSecrets(addedContent)[0] ?? null;
  const localSecrets = await collectLocalSecrets(inspection.root);
  const localSecretMatchSource = findLocalSecretMatch(addedContent, localSecrets);

  return {
    inspection,
    remoteName: selected.name,
    remoteUrl: selected.url,
    repoMeta,
    existingPr,
    aheadCount,
    commitSubjects,
    diffText: diffSecretFinding || localSecretMatchSource ? "" : boundedDiff,
    diffSecretFinding,
    localSecretMatchSource,
  };
}

function failPublish(branch: string, headSha: string | null, error: string): PublishChangesOutput {
  return {
    ok: false,
    branch,
    headSha,
    committed: false,
    pushed: false,
    prNumber: null,
    prUrl: null,
    prCreated: false,
    error,
  };
}

export async function publishChangesAt(
  input: {
    root: string;
    remote: string;
    repoSlug: string;
    targetBranch: string;
    createBranch: boolean;
    baseBranch: string;
    filesToStage: string[];
    commitMessage: string;
    prTitle: string;
    prBody: string;
    draft: boolean;
    createPr: boolean;
    expectedHeadSha: string;
  },
  deps: HostDeps = {},
): Promise<PublishChangesOutput> {
  const execGit = deps.execGit ?? defaultAuthorGitExec;
  const execGh = deps.execGh ?? defaultGhExec;

  const topRes = await execGit(input.root, ["rev-parse", "--show-toplevel"]);
  if (topRes.code !== 0 || topRes.stdout.trim() === "") {
    return failPublish(input.targetBranch, null, `Not a git repository: ${topRes.stderr.trim() || input.root}`);
  }
  const topRoot = topRes.stdout.trim();

  const [gitDirRes, commonDirRes, headRes] = await Promise.all([
    execGit(topRoot, ["rev-parse", "--path-format=absolute", "--git-dir"]),
    execGit(topRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    execGit(topRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
  ]);
  const currentHead = headRes.code === 0 ? headRes.stdout.trim() : null;
  if (gitDirRes.code !== 0 || commonDirRes.code !== 0 || !currentHead) {
    return failPublish(input.targetBranch, currentHead, "Failed to verify git HEAD and control directories.");
  }
  if (currentHead !== input.expectedHeadSha) {
    return failPublish(
      input.targetBranch,
      currentHead,
      `HEAD moved since preflight (expected ${input.expectedHeadSha}, found ${currentHead}).`,
    );
  }

  const [inProgressOp, gitDirLinkIssue] = await Promise.all([
    detectInProgressOp(gitDirRes.stdout.trim()),
    checkGitDirPlain(gitDirRes.stdout.trim(), commonDirRes.stdout.trim()),
  ]);
  if (inProgressOp) {
    return failPublish(input.targetBranch, currentHead, `Active git ${inProgressOp} operation blocks publishing.`);
  }
  if (gitDirLinkIssue) {
    return failPublish(input.targetBranch, currentHead, `Invalid git control file link: ${gitDirLinkIssue}`);
  }

  if (!isValidGitBranchName(input.targetBranch) || input.targetBranch === input.baseBranch) {
    return failPublish(input.targetBranch, currentHead, `Invalid target branch "${input.targetBranch}".`);
  }

  const rootAbs = resolve(topRoot);
  for (const rel of input.filesToStage) {
    if (isAbsolute(rel)) {
      return failPublish(input.targetBranch, currentHead, `Refusing non-relative path "${rel}".`);
    }
    const relFromRoot = relative(rootAbs, resolve(rootAbs, rel)).replace(/\\/gu, "/");
    if (!relFromRoot || relFromRoot.startsWith("../") || normalizePathForCheck(rel).startsWith("../")) {
      return failPublish(input.targetBranch, currentHead, `Refusing path outside repository root "${rel}".`);
    }
    if (isSecretFilename(rel) || isNeverEditPath(rel)) {
      return failPublish(input.targetBranch, currentHead, `Refusing protected or secret file "${rel}".`);
    }
    try {
      const st = await lstat(join(rootAbs, rel));
      if (st.isFile() && st.nlink > 1) {
        return failPublish(input.targetBranch, currentHead, `Refusing hard-linked file "${rel}" (nlink=${st.nlink}).`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return failPublish(input.targetBranch, currentHead, `Could not stat file "${rel}".`);
      }
    }
  }

  if (input.filesToStage.length > 0) {
    const commitCheck = validateCommitMessage(input.commitMessage);
    if (!commitCheck.ok) {
      return failPublish(input.targetBranch, currentHead, `Invalid commit message: ${commitCheck.reason}`);
    }
  }

  const outboundText = [input.filesToStage.length > 0 ? input.commitMessage : "", input.prTitle, input.prBody].join("\n");
  const secretHit = findSecrets(outboundText)[0];
  if (secretHit) {
    return failPublish(
      input.targetBranch,
      currentHead,
      `Refused outbound publish text: potential ${secretHit.kind} detected.`,
    );
  }
  const localSecrets = await collectLocalSecrets(topRoot);
  const localMatch = findLocalSecretMatch(outboundText, localSecrets);
  if (localMatch) {
    return failPublish(
      input.targetBranch,
      currentHead,
      `Refused outbound publish text: matches local credential (${localMatch}).`,
    );
  }

  if (input.createBranch) {
    const existsRes = await execGit(topRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${input.targetBranch}`]);
    if (existsRes.code === 0) {
      return failPublish(input.targetBranch, currentHead, `Branch "${input.targetBranch}" already exists.`);
    }
    const checkoutRes = await execGit(topRoot, ["checkout", "-b", input.targetBranch]);
    if (checkoutRes.code !== 0) {
      return failPublish(
        input.targetBranch,
        currentHead,
        `Failed to create branch "${input.targetBranch}": ${checkoutRes.stderr.trim() || checkoutRes.stdout.trim()}`,
      );
    }
  }

  let committed = false;
  if (input.filesToStage.length > 0) {
    const addRes = await execGit(topRoot, ["add", "--", ...input.filesToStage]);
    if (addRes.code !== 0) {
      return failPublish(
        input.targetBranch,
        currentHead,
        `git add failed: ${addRes.stderr.trim() || addRes.stdout.trim()}`,
      );
    }
    const commitRes = await execGit(topRoot, ["commit", "-m", input.commitMessage]);
    if (commitRes.code !== 0) {
      return failPublish(
        input.targetBranch,
        currentHead,
        `git commit failed: ${commitRes.stderr.trim() || commitRes.stdout.trim()}`,
      );
    }
    committed = true;
  }

  const finalHeadRes = await execGit(topRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const headSha = finalHeadRes.stdout.trim();
  if (finalHeadRes.code !== 0 || !/^[0-9a-f]{40}$/u.test(headSha)) {
    return failPublish(input.targetBranch, null, "Could not resolve HEAD after commit.");
  }

  const pushRes = await execGit(topRoot, [
    "push",
    "--porcelain",
    "--no-follow-tags",
    "--recurse-submodules=check",
    "-u",
    input.remote,
    `refs/heads/${input.targetBranch}:refs/heads/${input.targetBranch}`,
  ]);
  if (pushRes.code !== 0) {
    return {
      ok: false,
      branch: input.targetBranch,
      headSha,
      committed,
      pushed: false,
      prNumber: null,
      prUrl: null,
      prCreated: false,
      error: `git push failed: ${pushRes.stderr.trim() || pushRes.stdout.trim()}`,
    };
  }

  const lsRemoteRes = await execGit(topRoot, ["ls-remote", "--heads", input.remote, `refs/heads/${input.targetBranch}`]);
  const remoteShaMatch = /^([0-9a-f]{40})\s/mu.exec(lsRemoteRes.stdout);
  if (lsRemoteRes.code !== 0 || !remoteShaMatch || remoteShaMatch[1] !== headSha) {
    return {
      ok: false,
      branch: input.targetBranch,
      headSha,
      committed,
      pushed: true,
      prNumber: null,
      prUrl: null,
      prCreated: false,
      error: `Remote ref SHA mismatch after push (local ${headSha}, remote ${remoteShaMatch?.[1] ?? "missing"}).`,
    };
  }

  if (!input.createPr) {
    return {
      ok: true,
      branch: input.targetBranch,
      headSha,
      committed,
      pushed: true,
      prNumber: null,
      prUrl: null,
      prCreated: false,
      error: null,
    };
  }

  const prCreateArgs = [
    "pr",
    "create",
    "--repo",
    input.repoSlug,
    "--base",
    input.baseBranch,
    "--head",
    input.targetBranch,
    "--title",
    input.prTitle,
    "--body-file",
    "-",
    ...(input.draft ? ["--draft"] : []),
  ];
  const createRes = await execGh(topRoot, prCreateArgs, input.prBody);
  if (createRes.code !== 0) {
    return {
      ok: false,
      branch: input.targetBranch,
      headSha,
      committed,
      pushed: true,
      prNumber: null,
      prUrl: null,
      prCreated: false,
      error: `gh pr create failed: ${createRes.stderr.trim() || createRes.stdout.trim()}`,
    };
  }

  const createdUrlMatch = /https:\/\/github\.com\/[^\s]+\/pull\/\d+/u.exec(createRes.stdout);
  const viewTarget = createdUrlMatch?.[0] ?? input.targetBranch;
  const viewRes = await execGh(topRoot, [
    "pr",
    "view",
    viewTarget,
    "--repo",
    input.repoSlug,
    "--json",
    "number,url,headRefOid",
  ]);
  if (viewRes.code !== 0) {
    return {
      ok: false,
      branch: input.targetBranch,
      headSha,
      committed,
      pushed: true,
      prNumber: null,
      prUrl: createdUrlMatch?.[0] ?? null,
      prCreated: true,
      error: `gh pr view verification failed: ${viewRes.stderr.trim() || viewRes.stdout.trim()}`,
    };
  }

  const viewed = JSON.parse(viewRes.stdout) as { number: number; url: string; headRefOid: string };
  if (viewed.headRefOid !== headSha) {
    return {
      ok: false,
      branch: input.targetBranch,
      headSha,
      committed,
      pushed: true,
      prNumber: viewed.number,
      prUrl: viewed.url,
      prCreated: true,
      error: `GitHub PR headRefOid (${viewed.headRefOid}) does not match local HEAD (${headSha}).`,
    };
  }

  return {
    ok: true,
    branch: input.targetBranch,
    headSha,
    committed,
    pushed: true,
    prNumber: viewed.number,
    prUrl: viewed.url,
    prCreated: true,
    error: null,
  };
}

export async function readPrDiscussionAt(
  input: {
    root: string;
    repo: string;
    prNumber: number;
    trustedBots?: readonly string[];
    authorLogin?: string;
  },
  deps: HostDeps = {},
): Promise<FilteredPrDiscussion> {
  const execGh = deps.execGh ?? defaultGhExec;
  return fetchPrDiscussion({
    repo: input.repo,
    prNumber: input.prNumber,
    trustedBots: input.trustedBots,
    authorLogin: input.authorLogin,
    runGraphql: async (query, vars) => {
      const res = await execGh(input.root, [
        "api",
        "graphql",
        "-F",
        `owner=${vars.owner}`,
        "-F",
        `name=${vars.name}`,
        "-F",
        `number=${vars.number}`,
        "-f",
        `query=${query}`,
      ]);
      if (res.code !== 0) {
        throw new Error(`gh api graphql PR discussion failed: ${res.stderr.trim() || `exit ${res.code}`}`);
      }
      const parsed = JSON.parse(res.stdout) as {
        data?: unknown;
        errors?: Array<{ message?: string }>;
      };
      if (parsed.errors && parsed.errors.length > 0) {
        throw new Error(`GitHub GraphQL error: ${parsed.errors.map((e) => e.message ?? "unknown").join("; ")}`);
      }
      return (parsed.data ?? {}) as never;
    },
    fetchCollaboratorPermission: async (repoSlug, username) => {
      const [owner, name] = repoSlug.split("/");
      const res = await execGh(input.root, [
        "api",
        `repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/collaborators/${encodeURIComponent(username)}/permission`,
      ]);
      if (res.code !== 0) return "none";
      const parsed = JSON.parse(res.stdout) as { permission?: string };
      return (parsed.permission ?? "none").toLowerCase();
    },
  });
}

const WORKTREE_INCLUDE_UNSAFE_RE =
  /(?:^|\/|\.)env\b|\*\.(?:pem|key|p12|pfx|keystore|jks)|token\.json|auth\.json|credentials|hosts\.yml|id_rsa|id_ed25519|secret|^\s*(?:\*+|\.\*)\s*$/iu;

function parseLsTreeZ(stdout: string): Array<{ mode: string; type: string; oid: string; path: string }> {
  const out: Array<{ mode: string; type: string; oid: string; path: string }> = [];
  for (const tok of stdout.split("\0")) {
    if (!tok) continue;
    const m = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/u.exec(tok);
    if (m) {
      out.push({ mode: m[1]!, type: m[2]!, oid: m[3]!, path: m[4]! });
    }
  }
  return out;
}

export async function inspectReviewContextAt(
  input: { root: string; baseRef?: string; priorReviewedSha?: string },
  deps: HostDeps = {},
): Promise<InspectReviewContextOutput> {
  const execGit = deps.execGit ?? defaultGitExec;
  const inspection = await inspectCheckoutAt(input.root, execGit);
  if (!inspection.headSha || !/^[0-9a-f]{40}$/u.test(inspection.headSha)) {
    throw new Error("Review requires HEAD to resolve to a committed revision.");
  }
  const headSha = inspection.headSha;
  const topRoot = inspection.root;
  const selected = selectRemote(inspection.remotes);
  const parsedRemote = parseGitHubRemoteUrl(selected.url);
  const repoSlug = parsedRemote?.slug ?? null;

  let baseSha: string | null = null;
  if (input.baseRef && /^[0-9a-f]{40}$/iu.test(input.baseRef.trim())) {
    const verify = await execGit(topRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${input.baseRef.trim()}^{commit}`,
    ]);
    if (verify.code === 0 && /^[0-9a-f]{40}$/u.test(verify.stdout.trim())) {
      baseSha = verify.stdout.trim();
    }
  }
  if (!baseSha) {
    const candidates = [
      ...(input.baseRef ? [`origin/${input.baseRef}`, input.baseRef] : []),
      "origin/main",
      "main",
      "origin/master",
      "master",
    ];
    for (const cand of candidates) {
      const candRes = await execGit(topRoot, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${cand}^{commit}`,
      ]);
      if (candRes.code !== 0) continue;
      const candSha = candRes.stdout.trim();
      const mbRes = await execGit(topRoot, ["merge-base", headSha, candSha]);
      baseSha = mbRes.code === 0 && /^[0-9a-f]{40}$/u.test(mbRes.stdout.trim()) ? mbRes.stdout.trim() : candSha;
      break;
    }
  }
  if (!baseSha) {
    const parentRes = await execGit(topRoot, ["rev-parse", "--verify", "--quiet", `${headSha}^`]);
    baseSha =
      parentRes.code === 0 && /^[0-9a-f]{40}$/u.test(parentRes.stdout.trim())
        ? parentRes.stdout.trim()
        : headSha;
  }

  let priorReviewedIsAncestor = false;
  if (input.priorReviewedSha && /^[0-9a-f]{40}$/u.test(input.priorReviewedSha)) {
    const ancRes = await execGit(topRoot, ["merge-base", "--is-ancestor", input.priorReviewedSha, headSha]);
    priorReviewedIsAncestor = ancRes.code === 0;
  }

  const [namesRes, diffRes, hookTreeRes, allTreeRes] = await Promise.all([
    execGit(topRoot, ["diff", "--name-only", `${baseSha}..${headSha}`]),
    execGit(topRoot, ["diff", "--unified=3", "--no-color", `${baseSha}..${headSha}`]),
    execGit(topRoot, [
      "ls-tree",
      "-z",
      headSha,
      "--",
      ".worktreeinclude",
      ".bb-env-setup.sh",
      ".bb-env-teardown.sh",
    ]),
    execGit(topRoot, ["ls-tree", "-r", "-z", headSha]),
  ]);

  const committedFiles = namesRes.code === 0 ? namesRes.stdout.split("\n").filter(Boolean) : [];
  const rawDiff = diffRes.code === 0 ? diffRes.stdout : "";
  const boundedDiff = truncateUtf8(rawDiff, MAX_DIFF_TEXT_BYTES).text;

  // Check worktree hook files at headSha for credential exposure or symlink risks.
  let unsafeWorktreeHooks = false;
  let worktreeHookReason: string | null = null;
  if (hookTreeRes.code !== 0) {
    unsafeWorktreeHooks = true;
    worktreeHookReason = "Failed to inspect worktree hook files at HEAD.";
  } else {
    const hookEntries = parseLsTreeZ(hookTreeRes.stdout);
    for (const entry of hookEntries) {
      if (entry.mode === "120000") {
        unsafeWorktreeHooks = true;
        worktreeHookReason = `Hook file ${entry.path} is a tracked symlink at HEAD.`;
        break;
      }
      const showRes = await execGit(topRoot, ["show", `${headSha}:${entry.path}`]);
      if (showRes.code !== 0) {
        unsafeWorktreeHooks = true;
        worktreeHookReason = `Could not read ${entry.path} at HEAD.`;
        break;
      }
      if (entry.path === ".worktreeinclude") {
        const riskyLine = showRes.stdout
          .split(/\r?\n/u)
          .map((l) => l.trim())
          .find((l) => l !== "" && !l.startsWith("#") && !l.startsWith("!") && WORKTREE_INCLUDE_UNSAFE_RE.test(l));
        if (riskyLine) {
          unsafeWorktreeHooks = true;
          worktreeHookReason = `.worktreeinclude matches sensitive/credential pattern "${riskyLine}".`;
          break;
        }
      } else {
        if (/\bln\s+-s\b|\bsymlink\b/u.test(showRes.stdout)) {
          unsafeWorktreeHooks = true;
          worktreeHookReason = `${entry.path} creates symlinks during environment setup.`;
          break;
        }
      }
    }
  }

  // Check all tracked symlinks at headSha (escaping targets or unreadable blobs).
  let hasEscapingSymlinks = false;
  let symlinkReason: string | null = null;
  const allEntries = allTreeRes.code === 0 ? parseLsTreeZ(allTreeRes.stdout) : [];
  if (allTreeRes.code !== 0) {
    hasEscapingSymlinks = true;
    symlinkReason = "Failed to enumerate tracked tree entries at HEAD.";
  } else {
    for (const entry of allEntries) {
      if (entry.mode !== "120000") continue;
      const catRes = await execGit(topRoot, ["cat-file", "-p", entry.oid]);
      if (catRes.code !== 0) {
        hasEscapingSymlinks = true;
        symlinkReason = `Could not inspect symlink target for ${entry.path}.`;
        break;
      }
      const target = catRes.stdout.trim();
      if (target.startsWith("/") || /(?:^|\/)\.\.(?:\/|$)/u.test(target)) {
        hasEscapingSymlinks = true;
        symlinkReason = `Tracked symlink ${entry.path} resolves to unsafe target "${target}".`;
        break;
      }
    }
  }

  // Scan diff added content + any committed `.env*` blobs at headSha against secret rules & local secrets.
  const localSecrets = await collectLocalSecrets(topRoot);
  const addedContent = extractAddedDiffContent(rawDiff);
  let secretBlockedReason: string | null = null;
  const diffSecret = findSecrets(addedContent)[0];
  if (diffSecret) {
    secretBlockedReason = `Potential ${diffSecret.kind} detected in committed diff (line ${diffSecret.line}).`;
  } else {
    const localHit = findLocalSecretMatch(addedContent, localSecrets);
    if (localHit) {
      secretBlockedReason = `Committed diff matches local secret (${localHit}).`;
    }
  }

  if (!secretBlockedReason) {
    const committedEnvPaths = allEntries
      .map((e) => e.path)
      .filter((p) => /(?:^|\/)\.env/iu.test(p) && isSecretFilename(p));
    for (const envPath of committedEnvPaths) {
      const showRes = await execGit(topRoot, ["show", `${headSha}:${envPath}`]);
      if (showRes.code !== 0) {
        secretBlockedReason = `Could not inspect committed ${envPath} blob at HEAD.`;
        break;
      }
      const envHit = findSecrets(showRes.stdout)[0];
      if (envHit) {
        secretBlockedReason = `Committed ${envPath} contains ${envHit.kind}.`;
        break;
      }
      const envLocalHit = findLocalSecretMatch(showRes.stdout, localSecrets);
      if (envLocalHit) {
        secretBlockedReason = `Committed ${envPath} matches local credential (${envLocalHit}).`;
        break;
      }
    }
  }

  return {
    root: topRoot,
    repoSlug,
    branch: inspection.branch,
    headSha,
    baseSha,
    priorReviewedIsAncestor,
    changedFiles: committedFiles,
    committedFiles,
    diffText: secretBlockedReason ? "" : boundedDiff,
    unsafeWorktreeHooks,
    worktreeHookReason,
    hasEscapingSymlinks,
    symlinkReason,
    secretBlockedReason,
  };
}

/** Git runner used by automated PR Steward operations: always disables repository hooks. */
export function defaultStewardGitExec(cwd: string, args: readonly string[]): Promise<ExecResult> {
  return runProcess("git", [...SAFE_GIT_FLAGS, "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    timeoutMs: 60_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_TEST_COMMIT_GRAPH: "0",
    },
  });
}

async function verifyExpectedPinsAt(
  root: string,
  expectedPins: Readonly<Record<string, string>>,
): Promise<{ ok: boolean; reason: string | null }> {
  const snap = await computeCheckoutPins(root);
  if (!snap.ok) {
    return { ok: false, reason: snap.error ?? "failed to verify checkout pins" };
  }
  const drift = diffPins(expectedPins, snap.pins);
  if (drift) {
    return { ok: false, reason: drift.reason };
  }
  return { ok: true, reason: null };
}

export async function pollPrStateAt(
  input: {
    root: string;
    repo: string;
    prNumber: number;
    trustedBots?: readonly string[];
    authorLogin?: string;
  },
  deps: HostDeps = {},
): Promise<PollPrStateOutput> {
  const execGh = deps.execGh ?? defaultGhExec;
  const discussion = await readPrDiscussionAt(input, { execGh });
  const [owner, name] = input.repo.split("/");
  const checkRes = await execGh(input.root, [
    "api",
    `repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/commits/${encodeURIComponent(discussion.pr.headRefOid)}/check-runs?per_page=100`,
  ]);

  let checkRuns: PolledCheckRunOutput[] = [];
  if (checkRes.code === 0 && checkRes.stdout.trim()) {
    try {
      const parsed = JSON.parse(checkRes.stdout) as {
        check_runs?: Array<{
          id: number;
          name: string;
          status: string;
          conclusion: string | null;
          details_url?: string | null;
          html_url?: string | null;
        }>;
      };
      checkRuns = (parsed.check_runs ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion ?? null,
        detailsUrl: r.details_url ?? r.html_url ?? null,
      }));
    } catch {
      checkRuns = [];
    }
  }

  return { discussion, checkRuns };
}

const MAX_REPO_SKILL_BYTES = 32_768;

export async function readRepoStewardSkillAt(input: { root: string }): Promise<{
  found: boolean;
  sourcePath: string | null;
  content: string | null;
  truncated: boolean;
}> {
  let rootReal: string;
  try {
    rootReal = await realpath(input.root);
  } catch {
    return { found: false, sourcePath: null, content: null, truncated: false };
  }

  for (const rel of [".claude/skills/steward/SKILL.md", ".claude/skills/babysit/SKILL.md"] as const) {
    const abs = join(input.root, rel);
    try {
      await lstat(abs);
    } catch {
      continue;
    }
    try {
      const resolved = await realpath(abs);
      const fromRoot = relative(rootReal, resolved);
      if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
        continue;
      }
      const raw = await readFile(resolved, "utf8");
      const clean = stripInvisible(raw);
      const bounded = truncateUtf8(clean, MAX_REPO_SKILL_BYTES);
      return {
        found: true,
        sourcePath: rel,
        content: bounded.text,
        truncated: bounded.truncated,
      };
    } catch {
      continue;
    }
  }

  return { found: false, sourcePath: null, content: null, truncated: false };
}

export async function stewardFetchAndCheckBaseAt(
  input: {
    root: string;
    baseRemote: string;
    baseBranch: string;
    expectedPins: Record<string, string>;
  },
  deps: HostDeps = {},
): Promise<{
  ok: boolean;
  pinsOk: boolean;
  driftReason: string | null;
  fetchedSha: string | null;
  safe: boolean;
  alreadyMerged: boolean;
  blockedPaths: string[];
  noticePaths: string[];
  reason: string | null;
}> {
  const execGit = deps.execGit ?? defaultStewardGitExec;
  const pinCheck = await verifyExpectedPinsAt(input.root, input.expectedPins);
  if (!pinCheck.ok) {
    return {
      ok: false,
      pinsOk: false,
      driftReason: pinCheck.reason,
      fetchedSha: null,
      safe: false,
      alreadyMerged: false,
      blockedPaths: [],
      noticePaths: [],
      reason: pinCheck.reason,
    };
  }

  const fetchRes = await execGit(input.root, ["fetch", "--no-tags", "--", input.baseRemote, input.baseBranch]);
  if (fetchRes.code !== 0) {
    return {
      ok: false,
      pinsOk: true,
      driftReason: null,
      fetchedSha: null,
      safe: false,
      alreadyMerged: false,
      blockedPaths: [],
      noticePaths: [],
      reason: `git fetch failed: ${fetchRes.stderr.trim() || fetchRes.stdout.trim()}`,
    };
  }

  const revRes = await execGit(input.root, ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"]);
  const fetchedSha = revRes.stdout.trim();
  if (revRes.code !== 0 || !/^[0-9a-f]{40}$/u.test(fetchedSha)) {
    return {
      ok: false,
      pinsOk: true,
      driftReason: null,
      fetchedSha: null,
      safe: false,
      alreadyMerged: false,
      blockedPaths: [],
      noticePaths: [],
      reason: "Could not resolve FETCH_HEAD after base fetch.",
    };
  }

  const mergeCheck = await checkMergeSafe(input.root, fetchedSha, {
    mode: "base",
    expectedTipSha: fetchedSha,
    execGit,
  });

  return {
    ok: mergeCheck.safe,
    pinsOk: true,
    driftReason: null,
    fetchedSha,
    safe: mergeCheck.safe,
    alreadyMerged: mergeCheck.alreadyMerged,
    blockedPaths: mergeCheck.blockedPaths,
    noticePaths: mergeCheck.noticePaths,
    reason: mergeCheck.reason,
  };
}

export async function stewardMergeBaseAt(
  input: {
    root: string;
    baseRemote: string;
    baseBranch: string;
    headRemote?: string;
    headBranch?: string;
    expectedBaseSha: string;
    expectedPins: Record<string, string>;
  },
  deps: HostDeps = {},
): Promise<{
  ok: boolean;
  headSha: string | null;
  pushed: boolean;
  noticePaths: string[];
  reason: string | null;
}> {
  const execGit = deps.execGit ?? defaultStewardGitExec;
  const pinCheck = await verifyExpectedPinsAt(input.root, input.expectedPins);
  if (!pinCheck.ok) {
    return { ok: false, headSha: null, pushed: false, noticePaths: [], reason: pinCheck.reason };
  }

  const inspection = await inspectCheckoutAt(input.root, execGit);
  if (inspection.inProgressOp || inspection.gitDirLinkIssue) {
    return {
      ok: false,
      headSha: inspection.headSha,
      pushed: false,
      noticePaths: [],
      reason: inspection.gitDirLinkIssue
        ? `Invalid git control file: ${inspection.gitDirLinkIssue}`
        : `Active git ${inspection.inProgressOp} blocks automated merge.`,
    };
  }
  if (input.headBranch && (inspection.isDetached || inspection.branch !== input.headBranch)) {
    return {
      ok: false,
      headSha: inspection.headSha,
      pushed: false,
      noticePaths: [],
      reason: `Expected branch "${input.headBranch}", found "${inspection.branch ?? "(detached)"}".`,
    };
  }

  const fetchRes = await execGit(input.root, ["fetch", "--no-tags", "--", input.baseRemote, input.baseBranch]);
  if (fetchRes.code !== 0) {
    return {
      ok: false,
      headSha: inspection.headSha,
      pushed: false,
      noticePaths: [],
      reason: `git fetch failed: ${fetchRes.stderr.trim() || fetchRes.stdout.trim()}`,
    };
  }
  const revRes = await execGit(input.root, ["rev-parse", "--verify", "--quiet", "FETCH_HEAD^{commit}"]);
  const fetchedSha = revRes.stdout.trim();
  if (revRes.code !== 0 || fetchedSha !== input.expectedBaseSha) {
    return {
      ok: false,
      headSha: inspection.headSha,
      pushed: false,
      noticePaths: [],
      reason: `Base tip moved (expected ${input.expectedBaseSha}, got ${fetchedSha || "none"}).`,
    };
  }

  const safeCheck = await checkMergeSafe(input.root, input.expectedBaseSha, {
    mode: "base",
    expectedTipSha: input.expectedBaseSha,
    execGit,
  });
  if (!safeCheck.safe) {
    return {
      ok: false,
      headSha: inspection.headSha,
      pushed: false,
      noticePaths: safeCheck.noticePaths,
      reason: safeCheck.reason,
    };
  }
  if (safeCheck.alreadyMerged) {
    return {
      ok: true,
      headSha: inspection.headSha,
      pushed: false,
      noticePaths: safeCheck.noticePaths,
      reason: null,
    };
  }

  const mergeRes = await execGit(input.root, ["merge", "--no-edit", input.expectedBaseSha]);
  if (mergeRes.code !== 0) {
    await execGit(input.root, ["merge", "--abort"]).catch(() => undefined);
    return {
      ok: false,
      headSha: inspection.headSha,
      pushed: false,
      noticePaths: safeCheck.noticePaths,
      reason: `git merge had conflicts or failed: ${mergeRes.stderr.trim() || mergeRes.stdout.trim()}`,
    };
  }

  const newHead = await execGit(input.root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const newHeadSha = newHead.stdout.trim();
  if (newHead.code !== 0 || !/^[0-9a-f]{40}$/u.test(newHeadSha)) {
    return {
      ok: false,
      headSha: null,
      pushed: false,
      noticePaths: safeCheck.noticePaths,
      reason: "Could not resolve HEAD after base merge.",
    };
  }

  let pushed = false;
  if (input.headRemote && input.headBranch) {
    const pushRes = await execGit(input.root, [
      "push",
      "--porcelain",
      "--no-follow-tags",
      "--recurse-submodules=check",
      input.headRemote,
      `refs/heads/${input.headBranch}:refs/heads/${input.headBranch}`,
    ]);
    if (pushRes.code !== 0) {
      return {
        ok: false,
        headSha: newHeadSha,
        pushed: false,
        noticePaths: safeCheck.noticePaths,
        reason: `git push failed after merge: ${pushRes.stderr.trim() || pushRes.stdout.trim()}`,
      };
    }

    const lsRemoteRes = await execGit(input.root, [
      "ls-remote",
      "--heads",
      input.headRemote,
      `refs/heads/${input.headBranch}`,
    ]);
    const remoteSha = /^([0-9a-f]{40})\s/mu.exec(lsRemoteRes.stdout)?.[1] ?? "";
    if (lsRemoteRes.code !== 0 || remoteSha !== newHeadSha) {
      return {
        ok: false,
        headSha: newHeadSha,
        pushed: true,
        noticePaths: safeCheck.noticePaths,
        reason: `Remote SHA mismatch after merge push (${remoteSha || "missing"} !== ${newHeadSha}).`,
      };
    }
    pushed = true;
  }

  return {
    ok: true,
    headSha: newHeadSha,
    pushed,
    noticePaths: safeCheck.noticePaths,
    reason: null,
  };
}

export async function stewardCommitAndPushAt(
  input: {
    root: string;
    headRemote: string;
    headBranch: string;
    files: string[];
    commitMessage: string;
    expectedPins: Record<string, string>;
  },
  deps: HostDeps = {},
): Promise<{
  ok: boolean;
  headSha: string | null;
  committed: boolean;
  pushed: boolean;
  error: string | null;
}> {
  const execGit = deps.execGit ?? defaultStewardGitExec;
  const fail = (error: string, headSha: string | null = null, committed = false, pushed = false) => ({
    ok: false,
    headSha,
    committed,
    pushed,
    error,
  });

  const pinCheck = await verifyExpectedPinsAt(input.root, input.expectedPins);
  if (!pinCheck.ok) {
    return fail(pinCheck.reason ?? "tamper pins drifted");
  }

  const inspection = await inspectCheckoutAt(input.root, execGit);
  if (inspection.isDetached || inspection.branch !== input.headBranch) {
    return fail(`Expected branch "${input.headBranch}", found "${inspection.branch ?? "(detached)"}".`, inspection.headSha);
  }
  if (inspection.inProgressOp || inspection.gitDirLinkIssue) {
    return fail(
      inspection.gitDirLinkIssue
        ? `Invalid git control file: ${inspection.gitDirLinkIssue}`
        : `Active git ${inspection.inProgressOp} blocks commit.`,
      inspection.headSha,
    );
  }

  const rootAbs = resolve(inspection.root);
  for (const rel of input.files) {
    if (isAbsolute(rel)) return fail(`Refusing non-relative path "${rel}".`, inspection.headSha);
    const relFromRoot = relative(rootAbs, resolve(rootAbs, rel)).replace(/\\/gu, "/");
    if (!relFromRoot || relFromRoot.startsWith("../") || normalizePathForCheck(rel).startsWith("../")) {
      return fail(`Refusing path outside repository root "${rel}".`, inspection.headSha);
    }
    if (isSecretFilename(rel) || isNeverEditPath(rel)) {
      return fail(`Refusing protected or secret file "${rel}".`, inspection.headSha);
    }
    try {
      const st = await lstat(join(rootAbs, rel));
      if (st.isFile() && st.nlink > 1) {
        return fail(`Refusing hard-linked file "${rel}" (nlink=${st.nlink}).`, inspection.headSha);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return fail(`Could not stat file "${rel}".`, inspection.headSha);
      }
    }
  }

  const msgCheck = validateCommitMessage(input.commitMessage);
  if (!msgCheck.ok) {
    return fail(`Invalid commit message: ${msgCheck.reason}`, inspection.headSha);
  }
  const localSecrets = await collectLocalSecrets(rootAbs);
  const msgLocalHit = findLocalSecretMatch(input.commitMessage, localSecrets);
  if (msgLocalHit) {
    return fail(`Commit message matches local secret (${msgLocalHit}).`, inspection.headSha);
  }

  const addRes = await execGit(rootAbs, ["add", "--", ...input.files]);
  if (addRes.code !== 0) {
    return fail(`git add failed: ${addRes.stderr.trim() || addRes.stdout.trim()}`, inspection.headSha);
  }

  const cachedDiffRes = await execGit(rootAbs, ["diff", "--cached", "--unified=0", "--no-color"]);
  const stagedAdded = cachedDiffRes.code === 0 ? extractAddedDiffContent(cachedDiffRes.stdout) : "";
  const stagedSecret = findSecrets(stagedAdded)[0];
  const stagedLocalSecret = findLocalSecretMatch(stagedAdded, localSecrets);
  if (stagedSecret || stagedLocalSecret) {
    await execGit(rootAbs, ["reset", "-q", "HEAD", "--", ...input.files]).catch(() => undefined);
    return fail(
      stagedSecret
        ? `Refused to commit staged secret (${stagedSecret.kind} on line ${stagedSecret.line}).`
        : `Refused to commit staged local credential (${stagedLocalSecret}).`,
      inspection.headSha,
    );
  }

  const commitRes = await execGit(rootAbs, ["commit", "-m", input.commitMessage]);
  if (commitRes.code !== 0) {
    return fail(`git commit failed: ${commitRes.stderr.trim() || commitRes.stdout.trim()}`, inspection.headSha);
  }

  const newHeadRes = await execGit(rootAbs, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const newHeadSha = newHeadRes.stdout.trim();
  if (newHeadRes.code !== 0 || !/^[0-9a-f]{40}$/u.test(newHeadSha)) {
    return fail("Could not resolve HEAD after commit.", null, true, false);
  }

  const pushRes = await execGit(rootAbs, [
    "push",
    "--porcelain",
    "--no-follow-tags",
    "--recurse-submodules=check",
    input.headRemote,
    `refs/heads/${input.headBranch}:refs/heads/${input.headBranch}`,
  ]);
  if (pushRes.code !== 0) {
    return fail(`git push failed: ${pushRes.stderr.trim() || pushRes.stdout.trim()}`, newHeadSha, true, false);
  }

  const lsRemoteRes = await execGit(rootAbs, ["ls-remote", "--heads", input.headRemote, `refs/heads/${input.headBranch}`]);
  const remoteSha = /^([0-9a-f]{40})\s/mu.exec(lsRemoteRes.stdout)?.[1] ?? "";
  if (lsRemoteRes.code !== 0 || remoteSha !== newHeadSha) {
    return fail(`Remote SHA mismatch after push (${remoteSha || "missing"} !== ${newHeadSha}).`, newHeadSha, true, true);
  }

  return { ok: true, headSha: newHeadSha, committed: true, pushed: true, error: null };
}

export async function stewardRerunJobAt(
  input: {
    root: string;
    repo: string;
    jobId: number;
    expectedPins: Record<string, string>;
  },
  deps: HostDeps = {},
): Promise<{ ok: boolean; error: string | null }> {
  const execGh = deps.execGh ?? defaultGhExec;
  const pinCheck = await verifyExpectedPinsAt(input.root, input.expectedPins);
  if (!pinCheck.ok) {
    return { ok: false, error: pinCheck.reason };
  }
  const res = await execGh(input.root, [
    "run",
    "rerun",
    "--repo",
    input.repo,
    "--job",
    String(input.jobId),
  ]);
  if (res.code !== 0) {
    return { ok: false, error: res.stderr.trim() || res.stdout.trim() || `gh run rerun exited ${res.code}` };
  }
  return { ok: true, error: null };
}

const LOG_SECRET_PATTERNS_RE =
  /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})|\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}|\bxox[abposr]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|\bbearer\s+[A-Za-z0-9._~+/-]{24,}=*)/giu;

export async function stewardFetchJobLogsAt(
  input: {
    root: string;
    repo: string;
    jobId: number;
    maxBytes?: number;
  },
  deps: HostDeps = {},
): Promise<{
  ok: boolean;
  logs: string;
  truncated: boolean;
  redactedCount: number;
  error: string | null;
}> {
  const execGh = deps.execGh ?? defaultGhExec;
  const maxBytes = input.maxBytes ?? 16_384;
  const res = await execGh(input.root, [
    "run",
    "view",
    "--repo",
    input.repo,
    "--job",
    String(input.jobId),
    "--log-failed",
  ]);
  if (res.code !== 0) {
    return {
      ok: false,
      logs: "",
      truncated: false,
      redactedCount: 0,
      error: res.stderr.trim() || res.stdout.trim() || `gh run view exited ${res.code}`,
    };
  }

  let redactedCount = 0;
  let cleaned = stripInvisible(res.stdout);
  const localSecrets = await collectLocalSecrets(input.root);
  for (const s of localSecrets) {
    if (cleaned.includes(s.value)) {
      const parts = cleaned.split(s.value);
      redactedCount += parts.length - 1;
      cleaned = parts.join("[REDACTED]");
    }
  }
  cleaned = cleaned.replace(LOG_SECRET_PATTERNS_RE, () => {
    redactedCount += 1;
    return "[REDACTED]";
  });

  const remainingFindings = findSecrets(cleaned);
  if (remainingFindings.length > 0) {
    const flaggedLines = new Set(remainingFindings.map((f) => f.line));
    const lines = cleaned.split(/\r?\n/u);
    cleaned = lines
      .map((line, idx) => {
        if (flaggedLines.has(idx + 1)) {
          redactedCount += 1;
          return "[REDACTED POTENTIAL SECRET LINE]";
        }
        return line;
      })
      .join("\n");
  }

  const bounded = truncateUtf8(cleaned, maxBytes);
  return {
    ok: true,
    logs: bounded.text,
    truncated: bounded.truncated,
    redactedCount,
    error: null,
  };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    inspectCheckout: async ({ root }) => inspectCheckoutAt(root),
    computePins: async ({ root }) => {
      const snap = await computeCheckoutPins(root);
      return snap.ok ? { ok: true, pins: snap.pins, error: null } : { ok: false, pins: {}, error: snap.error };
    },
    verifyPins: async ({ root, expectedPins }) => {
      const snap = await computeCheckoutPins(root);
      if (!snap.ok) {
        return { ok: false, driftedKey: "pins:unreadable", reason: snap.error };
      }
      const drift = diffPins(expectedPins, snap.pins);
      return drift
        ? { ok: false, driftedKey: drift.driftedKey, reason: drift.reason }
        : { ok: true, driftedKey: null, reason: null };
    },
    checkMergeSafe: async ({ root, targetRef, mode, expectedTipSha }) =>
      checkMergeSafe(root, targetRef, { mode, expectedTipSha }),
    scanOutboundForLocalSecrets: async ({ root, text }) => {
      const secrets = await collectLocalSecrets(root);
      const matchedSource = findLocalSecretMatch(text, secrets);
      return { ok: matchedSource === null, matchedSource };
    },
    inspectPublishContext: async (input) => inspectPublishContextAt(input),
    publishChanges: async (input) => publishChangesAt(input),
    readPrDiscussion: async (input) => readPrDiscussionAt(input),
    inspectReviewContext: async (input) => inspectReviewContextAt(input),
    pollPrState: async (input) => pollPrStateAt(input),
    readRepoStewardSkill: async (input) => readRepoStewardSkillAt(input),
    stewardFetchAndCheckBase: async (input) => stewardFetchAndCheckBaseAt(input),
    stewardMergeBase: async (input) => stewardMergeBaseAt(input),
    stewardCommitAndPush: async (input) => stewardCommitAndPushAt(input),
    stewardRerunJob: async (input) => stewardRerunJobAt(input),
    stewardFetchJobLogs: async (input) => stewardFetchJobLogsAt(input),
  },
});
