import { validateCommitMessage, validateGeneratedPrText } from "../safety/outbound-text.js";

export const CLOUDROOM_PR_FOOTER = "Built with [Cloudroom](https://cloudroom.dev)";

export interface CommitMessageSynthesisResult {
  ok: boolean;
  message: string;
  fromHint: boolean;
  reason?: string;
}

export interface PrTextSynthesisResult {
  title: string;
  body: string;
  usedFallback: boolean;
  fallbackReason: string | null;
}

function sanitizeAsciiTokens(input: string, maxLen: number): string {
  const cleaned = input
    .replace(/[^\x20-\x7E]/gu, " ")
    .replace(/[@[\]`"'<>\\]/gu, " ")
    .replace(/\/{2,}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.slice(0, maxLen).trim();
}

function summarizeAreas(changedFiles: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const file of changedFiles) {
    const segs = file.split("/").filter(Boolean);
    const key = segs.length > 1 ? `${segs[0]}/${segs[1]}` : (segs[0] ?? "root");
    const safeKey =
      key
        .replace(/[^A-Za-z0-9._-]/gu, "-")
        .replace(/(?:^|[^a-z0-9])[a-f0-9]{7,}(?![a-z0-9])/giu, "-area")
        .replace(/^-+|-+$/gu, "")
        .slice(0, 28) || "root";
    counts.set(safeKey, (counts.get(safeKey) ?? 0) + 1);
  }
  return [...counts.entries()]
    .slice(0, 3)
    .map(([area, count]) => `${area} ${count}`);
}

export function synthesizeCommitMessage(opts: {
  branch: string;
  changedFiles: readonly string[];
  hint?: string;
}): CommitMessageSynthesisResult {
  if (opts.hint !== undefined && opts.hint.trim() !== "") {
    const trimmed = opts.hint.trim();
    const check = validateCommitMessage(trimmed);
    if (!check.ok) {
      return { ok: false, message: trimmed, fromHint: true, reason: check.reason };
    }
    return { ok: true, message: trimmed, fromHint: true };
  }

  const areas = summarizeAreas(opts.changedFiles);
  const safeBranch = sanitizeAsciiTokens(opts.branch.replace(/\//gu, "-"), 40) || "changes";
  const count = opts.changedFiles.length;
  const candidate =
    areas.length > 0
      ? `ship: update ${count} file${count === 1 ? "" : "s"} (${areas.join(", ")})`
      : `ship: update changes on ${safeBranch}`;

  const check = validateCommitMessage(candidate);
  if (check.ok) {
    return { ok: true, message: candidate, fromHint: false };
  }
  return { ok: true, message: "ship: update working tree changes", fromHint: false };
}

function cleanPrLineFragment(text: string): string {
  return text
    .replace(/[^\x20-\x7E]/gu, " ")
    .replace(/https?:\/\/\S+/giu, "")
    .replace(/@[A-Za-z0-9_-]+/gu, "")
    .replace(/^[-+/*\s]+/u, "")
    .replace(/\b[a-f0-9]{7,}\b/giu, "ref")
    .replace(/[^A-Za-z0-9 ,.:_/+!?-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function buildAutoTitle(branch: string, commitSubjects: readonly string[], changedFiles: readonly string[]): string {
  const fromSubject = commitSubjects[0] ? cleanPrLineFragment(commitSubjects[0]) : "";
  const raw =
    fromSubject ||
    (branch
      ? `Update ${cleanPrLineFragment(branch.replace(/\//gu, " "))}`
      : `Update ${changedFiles.length || "project"} files`);
  const capped = raw.slice(0, 96).trim();
  const normalized = capped ? `${capped[0]!.toUpperCase()}${capped.slice(1)}` : "Update project changes";
  return /^[A-Z]/u.test(normalized) ? normalized : `Update ${normalized}`.slice(0, 96);
}

function buildAutoBody(branch: string, commitSubjects: readonly string[], changedFiles: readonly string[]): string {
  const bullets: string[] = [];
  for (const subj of commitSubjects.slice(0, 4)) {
    const clean = cleanPrLineFragment(subj).slice(0, 260).trim();
    if (clean && !clean.startsWith("/")) {
      bullets.push(`- ${clean}`);
    }
  }
  if (bullets.length === 0) {
    const areas = summarizeAreas(changedFiles);
    const safeBranch = cleanPrLineFragment(branch.replace(/\//gu, "-")).slice(0, 40) || "feature";
    bullets.push(
      `- Update ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} on branch ${safeBranch}`,
    );
    if (areas.length > 0) {
      bullets.push(`- Touch areas: ${areas.join(", ")}`);
    }
  }
  return `## Summary\n\n${bullets.join("\n")}`;
}

function buildSafeFallback(branch: string, changedFiles: readonly string[]): { title: string; body: string } {
  const safeBranch =
    branch
      .replace(/[^A-Za-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .replace(/\b[a-f0-9]{7,}\b/giu, "topic")
      .slice(0, 32) || "topic";
  const areas = summarizeAreas(changedFiles);
  const title = `Ship updates from ${safeBranch}`.slice(0, 96);
  const bullets = [
    `- Update ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} on branch ${safeBranch}`,
    ...(areas.length > 0 ? [`- Areas updated: ${areas.join(", ")}`] : []),
  ];
  return {
    title,
    body: `## Summary\n\n${bullets.join("\n")}`,
  };
}

function normalizeCandidateBody(bodyHint: string): string {
  const trimmed = bodyHint.trim();
  if (/^## Summary\n/u.test(trimmed)) {
    return trimmed;
  }
  const lines = trimmed
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((l) => (l.startsWith("- ") ? l : `- ${l}`));
  return `## Summary\n\n${lines.join("\n")}`;
}

export function synthesizePrTexts(opts: {
  branch: string;
  commitSubjects: readonly string[];
  changedFiles: readonly string[];
  diffText?: string;
  titleHint?: string;
  bodyHint?: string;
  includeFooter?: boolean;
}): PrTextSynthesisResult {
  const candidateTitle =
    opts.titleHint !== undefined && opts.titleHint.trim() !== ""
      ? opts.titleHint.trim()
      : buildAutoTitle(opts.branch, opts.commitSubjects, opts.changedFiles);

  const candidateBody =
    opts.bodyHint !== undefined && opts.bodyHint.trim() !== ""
      ? normalizeCandidateBody(opts.bodyHint)
      : buildAutoBody(opts.branch, opts.commitSubjects, opts.changedFiles);

  const check = validateGeneratedPrText(candidateTitle, candidateBody, opts.diffText);
  let title = candidateTitle;
  let coreBody = candidateBody;
  let usedFallback = false;
  let fallbackReason: string | null = null;

  if (!check.ok) {
    usedFallback = true;
    fallbackReason = check.reason ?? "validation failed";
    const fb = buildSafeFallback(opts.branch, opts.changedFiles);
    const fbCheck = validateGeneratedPrText(fb.title, fb.body, opts.diffText);
    if (fbCheck.ok) {
      title = fb.title;
      coreBody = fb.body;
    } else {
      title = "Update project changes";
      coreBody = "## Summary\n\n- Publish repository updates";
    }
  }

  const finalBody = opts.includeFooter === false ? coreBody : `${coreBody}\n\n${CLOUDROOM_PR_FOOTER}`;
  return {
    title,
    body: finalBody,
    usedFallback,
    fallbackReason,
  };
}
