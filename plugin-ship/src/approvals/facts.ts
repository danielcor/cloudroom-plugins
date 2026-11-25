import type { InspectApprovalContextOutput, PolledCheckRunOutput } from "../contract.js";
import { isNeverEditPath, isSecretFilename, normalizePathForCheck } from "../safety/never-edit.js";
import type { ApprovalWhen } from "./parser.js";

const PASSING_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export type ApprovalPrInfo = NonNullable<InspectApprovalContextOutput["pr"]>;

export interface ApprovalFacts {
  changedPaths: string[];
  totalChangedFiles: number;
  totalChangedLines: number;
  baseBranch: string;
  authorLogin: string;
  authorAssociation: string;
  labels: string[];
  collisionLabels: string[];
  isDraft: boolean;
  touchedNeverEditPaths: string[];
  failingChecks: number;
  pendingChecks: number;
  totalChecks: number;
  ciGreen: boolean;
}

function matchSingleSegment(pattern: string, segment: string): boolean {
  // Iterative DP wildcard matcher (* matches 0+ chars, ? matches 1 char) — linear-time, no ReDoS.
  const m = pattern.length;
  const n = segment.length;
  let prev = new Array<boolean>(n + 1).fill(false);
  let curr = new Array<boolean>(n + 1).fill(false);
  prev[0] = true;

  for (let i = 1; i <= m; i++) {
    const pch = pattern[i - 1]!;
    curr.fill(false);
    if (pch === "*") {
      curr[0] = prev[0]!;
      for (let j = 1; j <= n; j++) {
        curr[j] = prev[j]! || curr[j - 1]!;
      }
    } else {
      for (let j = 1; j <= n; j++) {
        if (pch === "?" || pch === segment[j - 1]!) {
          curr[j] = prev[j - 1]!;
        }
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n]!;
}

/**
 * Deterministic, ReDoS-safe POSIX glob matcher supporting `**`, `*`, and `?` over normalized paths.
 */
export function matchGlobPath(globPattern: string, filePath: string): boolean {
  const normPattern = normalizePathForCheck(globPattern).replace(/^\.\//u, "").replace(/\/+/gu, "/");
  const normPath = normalizePathForCheck(filePath).replace(/^\.\//u, "").replace(/\/+/gu, "/");
  if (!normPattern || !normPath) return false;

  const pSegs = normPattern.split("/").filter((s) => s.length > 0);
  const fSegs = normPath.split("/").filter((s) => s.length > 0);
  const m = pSegs.length;
  const n = fSegs.length;

  let prev = new Array<boolean>(n + 1).fill(false);
  let curr = new Array<boolean>(n + 1).fill(false);
  prev[0] = true;

  for (let i = 1; i <= m; i++) {
    const pat = pSegs[i - 1]!;
    curr.fill(false);
    if (pat === "**") {
      curr[0] = prev[0]!;
      for (let j = 1; j <= n; j++) {
        curr[j] = prev[j]! || curr[j - 1]!;
      }
    } else {
      for (let j = 1; j <= n; j++) {
        if (prev[j - 1]! && matchSingleSegment(pat, fSegs[j - 1]!)) {
          curr[j] = true;
        }
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n]!;
}

/**
 * Derive free, deterministic facts about a PR before any LLM classifier runs.
 */
export function buildApprovalFacts(
  pr: ApprovalPrInfo,
  checkRuns: readonly PolledCheckRunOutput[],
): ApprovalFacts {
  const changedPaths = pr.changedFiles.map((f) => f.path);
  const totalChangedLines = pr.changedFiles.reduce((acc, f) => acc + f.additions + f.deletions, 0);
  const touchedNeverEditPaths = changedPaths.filter((p) => isNeverEditPath(p) || isSecretFilename(p));

  const pendingChecks = checkRuns.filter(
    (c) => c.conclusion === null || c.status.toLowerCase() !== "completed",
  ).length;
  const failingChecks = checkRuns.filter(
    (c) =>
      c.status.toLowerCase() === "completed" &&
      c.conclusion !== null &&
      !PASSING_CHECK_CONCLUSIONS.has(c.conclusion.toLowerCase()),
  ).length;
  const totalChecks = checkRuns.length;

  return {
    changedPaths,
    totalChangedFiles: changedPaths.length,
    totalChangedLines,
    baseBranch: pr.baseBranch,
    authorLogin: pr.authorLogin,
    authorAssociation: pr.authorAssociation,
    labels: pr.labels,
    collisionLabels: pr.collisionLabels,
    isDraft: pr.isDraft,
    touchedNeverEditPaths,
    failingChecks,
    pendingChecks,
    totalChecks,
    ciGreen:
      totalChecks > 0 &&
      pendingChecks === 0 &&
      checkRuns.every(
        (c) => c.conclusion !== null && PASSING_CHECK_CONCLUSIONS.has(c.conclusion.toLowerCase()),
      ),
  };
}

/**
 * Evaluate free deterministic `when` conditions; a failing check prevents any classifier invocation.
 */
export function evaluateDeterministicWhen(
  when: ApprovalWhen,
  facts: ApprovalFacts,
): { matched: boolean; failedReasons: string[] } {
  const failedReasons: string[] = [];

  if (when.all_paths_match) {
    if (facts.changedPaths.length === 0) {
      failedReasons.push("all_paths_match: PR has no changed file paths");
    } else {
      const nonMatching = facts.changedPaths.filter(
        (file) => !when.all_paths_match!.some((pat) => matchGlobPath(pat, file)),
      );
      if (nonMatching.length > 0) {
        failedReasons.push(`all_paths_match: ${nonMatching.slice(0, 3).join(", ")} outside allowed globs`);
      }
    }
  }

  if (when.any_path_matches) {
    const anyHit = facts.changedPaths.some((file) =>
      when.any_path_matches!.some((pat) => matchGlobPath(pat, file)),
    );
    if (!anyHit) {
      failedReasons.push("any_path_matches: no changed file matched");
    }
  }

  if (when.no_path_matches) {
    const blocked = facts.changedPaths.filter((file) =>
      when.no_path_matches!.some((pat) => matchGlobPath(pat, file)),
    );
    if (blocked.length > 0) {
      failedReasons.push(`no_path_matches: excluded file(s) touched (${blocked.slice(0, 3).join(", ")})`);
    }
  }

  if (when.max_changed_files !== undefined && facts.totalChangedFiles > when.max_changed_files) {
    failedReasons.push(`max_changed_files: ${facts.totalChangedFiles} > ${when.max_changed_files}`);
  }

  if (when.max_changed_lines !== undefined && facts.totalChangedLines > when.max_changed_lines) {
    failedReasons.push(`max_changed_lines: ${facts.totalChangedLines} > ${when.max_changed_lines}`);
  }

  if (when.base_branches) {
    const baseLower = facts.baseBranch.toLowerCase();
    if (!when.base_branches.some((b) => b.toLowerCase() === baseLower)) {
      failedReasons.push(`base_branches: "${facts.baseBranch}" not in [${when.base_branches.join(", ")}]`);
    }
  }

  if (when.authors) {
    const authorLower = facts.authorLogin.toLowerCase();
    if (!when.authors.some((a) => a.toLowerCase() === authorLower)) {
      failedReasons.push(`authors: "${facts.authorLogin}" not allowlisted`);
    }
  }

  if (when.author_associations) {
    const assocUpper = facts.authorAssociation.toUpperCase();
    if (!when.author_associations.some((a) => a.toUpperCase() === assocUpper)) {
      failedReasons.push(`author_associations: "${facts.authorAssociation}" not in allowlist`);
    }
  }

  if (when.labels_include) {
    const labelSet = new Set(facts.labels.map((l) => l.toLowerCase()));
    const missing = when.labels_include.filter((req) => !labelSet.has(req.toLowerCase()));
    if (missing.length > 0) {
      failedReasons.push(`labels_include: missing [${missing.join(", ")}]`);
    }
  }

  if (when.labels_exclude) {
    const excludedSet = new Set(when.labels_exclude.map((l) => l.toLowerCase()));
    const present = facts.labels.filter((l) => excludedSet.has(l.toLowerCase()));
    if (present.length > 0) {
      failedReasons.push(`labels_exclude: disallowed label(s) [${present.join(", ")}]`);
    }
  }

  if (when.is_draft !== undefined && facts.isDraft !== when.is_draft) {
    failedReasons.push(`is_draft: expected ${when.is_draft}, got ${facts.isDraft}`);
  }

  if (when.ci_green !== undefined && facts.ciGreen !== when.ci_green) {
    failedReasons.push(
      `ci_green: expected ${when.ci_green}, got ${facts.ciGreen} (total=${facts.totalChecks}, failing=${facts.failingChecks}, pending=${facts.pendingChecks})`,
    );
  }

  if (when.no_never_edit_paths && facts.touchedNeverEditPaths.length > 0) {
    failedReasons.push(
      `no_never_edit_paths: protected/secret files touched (${facts.touchedNeverEditPaths.slice(0, 3).join(", ")})`,
    );
  }

  return {
    matched: failedReasons.length === 0,
    failedReasons,
  };
}
