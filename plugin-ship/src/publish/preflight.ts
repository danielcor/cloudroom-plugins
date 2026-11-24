import { findCollisionLabels } from "../github/comments.js";
import { parseGitHubRemoteUrl, type PullRequestSummary, type RepoMeta } from "../github/client.js";
import type { CheckoutInspection } from "../contract.js";
import { isNeverEditPath, isSecretFilename } from "../safety/never-edit.js";

export interface PreflightIssue {
  code: string;
  message: string;
  paths?: string[];
}

export interface PublishPlan {
  repoSlug: string;
  remote: string;
  targetBranch: string;
  createBranch: boolean;
  baseBranch: string;
  filesToStage: string[];
  isPrivate: boolean;
  existingPr: PullRequestSummary | null;
  expectedHeadSha: string;
  aheadCount: number;
}

export interface PreflightResult {
  ok: boolean;
  blockers: PreflightIssue[];
  warnings: PreflightIssue[];
  plan: PublishPlan | null;
}

export interface PreflightInput {
  inspection: CheckoutInspection;
  remoteName: string;
  remoteUrl: string;
  repoMeta: RepoMeta | null;
  existingPr: PullRequestSummary | null;
  aheadCount: number;
  diffSecretFinding: { kind: string; line: number } | null;
  localSecretMatchSource: string | null;
  requestedBranch?: string;
  baseBranch?: string;
  includeFiles?: readonly string[];
  nonInteractive?: boolean;
  allowPublicCommit?: boolean;
}

const VALID_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/u;

export function isValidGitBranchName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || !VALID_BRANCH_RE.test(trimmed)) return false;
  if (
    trimmed.includes("..") ||
    trimmed.includes("@{") ||
    trimmed.includes("//") ||
    trimmed.endsWith("/") ||
    trimmed.endsWith(".") ||
    trimmed.endsWith(".lock") ||
    trimmed.includes("/.lock")
  ) {
    return false;
  }
  const parts = trimmed.split("/");
  return parts.every((p) => p.length > 0 && !p.startsWith(".") && !p.endsWith(".lock"));
}

export function suggestShipBranchName(changedFiles: readonly string[], hint?: string): string {
  const raw = hint?.trim() || changedFiles[0] || "changes";
  const withoutExt = raw.replace(/\.[^/.]+$/u, "");
  const slug = withoutExt
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  const candidate = `ship/${slug || "changes"}`;
  return isValidGitBranchName(candidate) ? candidate : "ship/changes";
}

export function runPreflight(input: PreflightInput): PreflightResult {
  const { inspection, repoMeta, existingPr } = input;
  const blockers: PreflightIssue[] = [];
  const warnings: PreflightIssue[] = [];

  const parsedRemote = parseGitHubRemoteUrl(input.remoteUrl);
  if (!parsedRemote || !repoMeta) {
    blockers.push({
      code: "non_github_remote",
      message: input.remoteUrl
        ? `Remote "${input.remoteName}" (${input.remoteUrl}) is not a supported GitHub.com repository.`
        : `No GitHub remote found for "${input.remoteName}".`,
    });
  }

  if (inspection.isDetached || !inspection.branch || !inspection.headSha) {
    blockers.push({
      code: "detached_head",
      message: "Checkout is on a detached HEAD or has no initial commit; check out a branch first.",
    });
  }

  if (inspection.inProgressOp !== null) {
    blockers.push({
      code: "in_progress_op",
      message: `A git ${inspection.inProgressOp} operation is currently in progress; finish or abort it first.`,
    });
  }

  if (inspection.gitDirLinkIssue !== null) {
    blockers.push({
      code: "git_dir_symlink",
      message: `Refusing checkout because git control file is a symlink or invalid: ${inspection.gitDirLinkIssue}`,
    });
  }

  if (repoMeta?.isFork) {
    blockers.push({
      code: "fork_repo",
      message: repoMeta.parentSlug
        ? `Repository ${repoMeta.slug} is a fork of ${repoMeta.parentSlug}; fork publishing is blocked.`
        : `Repository ${repoMeta.slug} is a fork; fork publishing is blocked.`,
    });
  }

  if (existingPr) {
    const collisionLabels = findCollisionLabels(existingPr.labels);
    if (collisionLabels.length > 0) {
      blockers.push({
        code: "steward_label_collision",
        message: `PR #${existingPr.number} carries active steward collision label(s): ${collisionLabels.join(", ")}`,
      });
    }
  }

  const defaultBranch = repoMeta?.defaultBranch || "main";
  const effectiveBase = input.baseBranch?.trim() || existingPr?.baseRefName || defaultBranch;
  if (!isValidGitBranchName(effectiveBase)) {
    blockers.push({
      code: "invalid_base_branch",
      message: `Base branch "${effectiveBase}" is not a valid git branch name.`,
    });
  }

  const filesToStage = input.includeFiles ? [...input.includeFiles] : [...inspection.changedFiles];
  const requested = input.requestedBranch?.trim() || "";
  const onDefaultOrBase =
    inspection.branch !== null && (inspection.branch === defaultBranch || inspection.branch === effectiveBase);

  let targetBranch = inspection.branch ?? "";
  let createBranch = false;

  if (onDefaultOrBase) {
    createBranch = true;
    if (requested) {
      if (!isValidGitBranchName(requested)) {
        blockers.push({
          code: "invalid_branch_name",
          message: `Requested branch "${requested}" is not a valid git branch name.`,
        });
      } else if (requested === defaultBranch || requested === effectiveBase) {
        blockers.push({
          code: "cannot_publish_default_branch",
          message: `Refusing to push directly to default/base branch "${requested}".`,
        });
      } else {
        targetBranch = requested;
      }
    } else {
      targetBranch = suggestShipBranchName(filesToStage);
      warnings.push({
        code: "create_branch_from_default",
        message: `Currently on "${inspection.branch}"; creating branch "${targetBranch}" targeting "${effectiveBase}".`,
      });
    }
  } else if (requested && requested !== inspection.branch) {
    createBranch = true;
    if (!isValidGitBranchName(requested)) {
      blockers.push({
        code: "invalid_branch_name",
        message: `Requested branch "${requested}" is not a valid git branch name.`,
      });
    } else if (requested === defaultBranch || requested === effectiveBase) {
      blockers.push({
        code: "cannot_publish_default_branch",
        message: `Refusing to push directly to default/base branch "${requested}".`,
      });
    } else {
      targetBranch = requested;
    }
  }

  if (filesToStage.length === 0 && input.aheadCount === 0 && !existingPr) {
    blockers.push({
      code: "nothing_to_ship",
      message: "Working tree is clean and branch has no unpushed commits ahead of the base branch.",
    });
  }

  const fileSet = new Set(filesToStage);
  const hardlinkHits = input.includeFiles
    ? inspection.hardLinks.filter((p) => fileSet.has(p))
    : inspection.hardLinks;
  if (hardlinkHits.length > 0) {
    blockers.push({
      code: "hardlink_changed_file",
      message: `Changed file(s) have multiple hard links (nlink > 1): ${hardlinkHits.join(", ")}`,
      paths: hardlinkHits,
    });
  }

  const submoduleHits = input.includeFiles
    ? inspection.submodules.filter((p) => fileSet.has(p) || fileSet.has(p.replace(/\/+$/u, "")))
    : inspection.submodules;
  if (submoduleHits.length > 0) {
    blockers.push({
      code: "submodule_changed",
      message: `Dirty or modified submodule(s) present: ${submoduleHits.join(", ")}`,
      paths: submoduleHits,
    });
  }

  const secretFiles = filesToStage.filter((f) => isSecretFilename(f));
  if (secretFiles.length > 0) {
    blockers.push({
      code: "secret_filename",
      message: `Refusing to stage secret/credential filename(s): ${secretFiles.join(", ")}`,
      paths: secretFiles,
    });
  }

  const neverEditFiles = filesToStage.filter((f) => isNeverEditPath(f));
  if (neverEditFiles.length > 0) {
    blockers.push({
      code: "never_edit_path",
      message: `Refusing to auto-stage protected config/CI path(s): ${neverEditFiles.join(", ")}`,
      paths: neverEditFiles,
    });
  }

  if (input.diffSecretFinding || input.localSecretMatchSource) {
    const detail = input.localSecretMatchSource
      ? `local credential match (${input.localSecretMatchSource})`
      : `${input.diffSecretFinding!.kind} (line ${input.diffSecretFinding!.line})`;
    blockers.push({
      code: "secret_content_detected",
      message: `Potential secret detected in changes: ${detail}`,
    });
  }

  if (repoMeta && !repoMeta.isPrivate && filesToStage.length > 0 && input.nonInteractive && !input.allowPublicCommit) {
    blockers.push({
      code: "public_repo_auto_commit_refused",
      message: `Refusing non-interactive auto-commit of ${filesToStage.length} file(s) on public repository ${repoMeta.slug}. Pass --allow-public-commit or confirm interactively.`,
      paths: filesToStage,
    });
  }

  if (blockers.length > 0 || !parsedRemote || !repoMeta || !inspection.headSha || !targetBranch) {
    return { ok: false, blockers, warnings, plan: null };
  }

  return {
    ok: true,
    blockers: [],
    warnings,
    plan: {
      repoSlug: repoMeta.slug,
      remote: input.remoteName,
      targetBranch,
      createBranch,
      baseBranch: effectiveBase,
      filesToStage,
      isPrivate: repoMeta.isPrivate,
      existingPr,
      expectedHeadSha: inspection.headSha,
      aheadCount: input.aheadCount,
    },
  };
}
