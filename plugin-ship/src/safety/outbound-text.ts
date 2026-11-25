import { findSecrets } from "./secrets.js";

export const SHIP_MARKER_PREFIX = "<!-- cloudroom-ship";
export const MAX_OUTBOUND_CHARS = 8000;

export interface TextValidationResult {
  ok: boolean;
  reason?: string;
}

const MARKER_LINE_RE = /^<!-- cloudroom-ship(?: reviewed=[0-9a-f]{40})? -->\n/u;
const AT_OR_BOT_CMD_RE = /^\s*(?:\/|(?:bors|atlantis|homu)\b|(?:re)?test this please|ok to test|add to whitelist)|(?:^|[^A-Za-z0-9_])@[A-Za-z0-9]/imu;
const URL_HTML_IMAGE_RE = /[a-z][a-z0-9+.-]*:[\\/]{2}|(?:^|[\s"'=(<])[\\/]{2}[\w-]|!\[|\]\(|^ {0,3}\[[^\]\n]+\]:|\bwww\.|\b(?:src|srcset|href|poster|cite|longdesc|background)\s*=/imu;
const CLOSING_KEYWORD_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:(?:[\w.-]+\/[\w.-]+)?#|GH-|https?:\/\/\S+\/(?:issues|pull)\/)\d/iu;
const CI_SKIP_RE = /\[(?:skip|no)[ -][\w .-]+\]|\[[\w .-]+[ -]skip\]|\*\*\*NO_CI\*\*\*|^skip-checks:/imu;

function checkCommonLengthAndSecrets(text: string): string | null {
  if (text.trim() === "") return "text is empty";
  if (text.length > MAX_OUTBOUND_CHARS) return `text exceeds ${MAX_OUTBOUND_CHARS} characters`;
  if (/\\$/mu.test(text)) return "line ends with a trailing backslash";
  const secretFindings = findSecrets(text);
  if (secretFindings.length > 0) {
    return `potential secret detected (${secretFindings[0]!.kind} on line ${secretFindings[0]!.line})`;
  }
  return null;
}

/** Validate a PR comment or review reply before posting to GitHub. */
export function validateCommentText(
  text: string,
  opts: { requireMarker?: boolean; requireReviewedSha?: boolean } = {},
): TextValidationResult {
  const commonErr = checkCommonLengthAndSecrets(text);
  if (commonErr) return { ok: false, reason: commonErr };

  if (opts.requireMarker !== false) {
    if (!MARKER_LINE_RE.test(text)) {
      return { ok: false, reason: `comment must start with "${SHIP_MARKER_PREFIX} -->" or "${SHIP_MARKER_PREFIX} reviewed=<40-hex> -->"` };
    }
    if (opts.requireReviewedSha && !/^<!-- cloudroom-ship reviewed=[0-9a-f]{40} -->\n/u.test(text)) {
      return { ok: false, reason: "review marker must include full 40-character commit SHA" };
    }
    if (text.slice(4).includes("<!--")) {
      return { ok: false, reason: "comment must not contain extra HTML comment openers" };
    }
  }

  if (AT_OR_BOT_CMD_RE.test(text)) {
    return { ok: false, reason: "comment must not contain @mentions, leading /slash commands, or bot trigger phrases" };
  }
  if (URL_HTML_IMAGE_RE.test(text)) {
    return { ok: false, reason: "comment must not contain URLs, markdown links, images, or HTML link attributes" };
  }
  return { ok: true };
}

/** Validate a commit message generated or submitted by a Steward worker. */
export function validateCommitMessage(text: string): TextValidationResult {
  const commonErr = checkCommonLengthAndSecrets(text);
  if (commonErr) return { ok: false, reason: commonErr };

  if (AT_OR_BOT_CMD_RE.test(text)) {
    return { ok: false, reason: "commit message must not contain @mentions, leading /slash commands, or bot trigger phrases" };
  }
  if (CLOSING_KEYWORD_RE.test(text)) {
    return { ok: false, reason: "commit message must not contain issue-closing keywords (fixes/closes/resolves #N)" };
  }
  if (CI_SKIP_RE.test(text)) {
    return { ok: false, reason: "commit message must not contain CI skip directives" };
  }
  return { ok: true };
}

function wordTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
}

/**
 * Returns true if `candidateText` shares any sequence of `n` consecutive alphanumeric
 * words with `sourceText` (default n = 8, matching Claude Code's 8-gram diff-injection check).
 */
export function hasNgramOverlap(sourceText: string, candidateText: string, n = 8): boolean {
  if (n <= 0) return false;
  const sourceTokens = wordTokens(sourceText);
  const candTokens = wordTokens(candidateText);
  if (sourceTokens.length < n || candTokens.length < n) return false;

  const grams = new Set<string>();
  for (let i = 0; i <= sourceTokens.length - n; i++) {
    grams.add(sourceTokens.slice(i, i + n).join(" "));
  }
  for (let i = 0; i <= candTokens.length - n; i++) {
    if (grams.has(candTokens.slice(i, i + n).join(" "))) return true;
  }
  return false;
}

const PR_TITLE_ASCII_RE = /^[A-Z][A-Za-z0-9 ,.:_/+!?-]{0,99}$/u;
const PR_SUMMARY_ASCII_RE = /^## Summary\n\n?(?:- [A-Za-z0-9 ,.:_/+!?-]{1,300}(?:\n|$)){1,5}$/u;
const PR_FORBIDDEN_TEXT_RE =
  /\/\/|www\.|(?:^|[^a-z0-9])gh-\d|(?:^|[^a-z])(?:clos|fix|resolv|complet)\w*[^a-z0-9]+[a-z]\w*-\d|^[-+\d. ]*\/|(?:^|[^a-z0-9])[a-f0-9]{7,}(?![a-z0-9])|\S{40}/imu;

/**
 * Deterministic validator for diff-synthesized PR title & body (`ho`/`Ar` equivalent).
 * Blocks prompt injections lifted from diffs via strict character classes, token checks,
 * and an 8-word n-gram overlap filter against `diffText`.
 */
export function validateGeneratedPrText(title: string, body: string, diffText?: string): TextValidationResult {
  if (!PR_TITLE_ASCII_RE.test(title)) {
    return { ok: false, reason: "generated PR title failed strict ASCII format check" };
  }
  const normalizedBody = body.trimEnd();
  if (!PR_SUMMARY_ASCII_RE.test(normalizedBody)) {
    return { ok: false, reason: "generated PR body failed strict ## Summary ASCII bullet format check" };
  }
  if (PR_FORBIDDEN_TEXT_RE.test(title) || PR_FORBIDDEN_TEXT_RE.test(normalizedBody)) {
    return { ok: false, reason: "generated PR text contains forbidden URL, SHA, issue reference, or long token" };
  }
  if (AT_OR_BOT_CMD_RE.test(title) || AT_OR_BOT_CMD_RE.test(normalizedBody) || CLOSING_KEYWORD_RE.test(`${title}\n${normalizedBody}`)) {
    return { ok: false, reason: "generated PR text contains @mention, closing keyword, or slash directive" };
  }
  const secretFindings = findSecrets(`${title}\n${normalizedBody}`);
  if (secretFindings.length > 0) {
    return { ok: false, reason: `generated PR text contains potential secret (${secretFindings[0]!.kind})` };
  }
  if (diffText !== undefined && hasNgramOverlap(diffText, `${title}\n${normalizedBody}`, 8)) {
    return { ok: false, reason: "generated PR text reproduces 8+ consecutive words from the diff" };
  }
  return { ok: true };
}
