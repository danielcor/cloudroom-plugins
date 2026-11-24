import { posix } from "node:path";

// Zero-width and joiner characters, bidi marks (including U+061C ARABIC LETTER MARK),
// embeddings, overrides, isolates, BOM, soft hyphen, Mongolian vowel separator, and tag block.
const INVISIBLE_SOURCE =
  "[\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u{E0000}-\\u{E007F}]";

export function countInvisible(text: string): number {
  return text.match(new RegExp(INVISIBLE_SOURCE, "gu"))?.length ?? 0;
}

export function stripInvisible(text: string): string {
  return text.replace(new RegExp(INVISIBLE_SOURCE, "gu"), "");
}

/** Replace each invisible character with a visible `⟦U+XXXX⟧` marker for diagnostics. */
export function markInvisible(text: string): string {
  return text.replace(
    new RegExp(INVISIBLE_SOURCE, "gu"),
    (c) => `⟦U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟧`,
  );
}

function stripTrailingDotsAndSpacesPerSegment(pathStr: string): string {
  return pathStr
    .split("/")
    .map((seg) => (seg === "." || seg === ".." ? seg : seg.replace(/[. ]+$/u, "")))
    .join("/");
}

/**
 * Normalize a relative path before security pattern matching:
 * backslashes to slashes, invisible chars stripped, case-folded, trailing
 * dots/spaces per segment stripped (Windows/VFAT evasion), and NFC normalized.
 */
export function normalizePathForCheck(input: string): string {
  const cleaned = stripTrailingDotsAndSpacesPerSegment(
    stripInvisible(input)
      .replace(/\\/gu, "/")
      .toLowerCase()
      .toUpperCase()
      .toLowerCase(),
  ).normalize("NFC");
  // Collapse redundant ./ and inner ../ while preserving leading slash semantics if given.
  const withoutLeadingDot = cleaned.replace(/^(?:\.\/)+/u, "");
  return posix.normalize(withoutLeadingDot).replace(/^\/+/u, "");
}

const NEVER_EDIT_REGEX = new RegExp(
  [
    // Sensitive / hook / CI / IDE directories anywhere in the path
    String.raw`(?:^|\/)\.(?:git|claude|husky|githooks|lefthook(?:-local)?|clinerules|circleci|buildkite|vscode|idea|devcontainer|github|gitlab|gitlab-ci(?:\.d)?|azure-pipelines|azuredevops|vsts-ci|builds|codecatalyst|mergify|woodpecker|semaphore|teamcity|mise|cargo|yarn|mvn)(?:\/|$)`,
    String.raw`(?:^|\/)\.(?:gitea|forgejo)\/workflows(?:\/|$)`,
    String.raw`(?:^|\/)(?:mise|gradle\/wrapper)\/`,
    String.raw`(?:^|\/)tools\/bazel(?:\.(?:bat|cmd|exe|ps1|rc))?$`,
    // CI, build, agent-instruction, and runtime-config filenames
    String.raw`(?:^|\/)(?:codeowners|jenkinsfile|action\.ya?ml|cloudbuild\.ya?ml|buildspec[\w.-]*\.ya?ml|appspec\.(?:ya?ml|json)|\.build\.ya?ml|\.?appveyor\.yml|\.cirrus\.yml|codemagic\.yaml|netlify\.toml|vercel\.json|\.scrutinizer\.yml|buddy\.yml|\.?mise(?:\.[\w.-]+)?\.toml|\.rtx\.toml|\.tool-versions|\.woodpecker\.ya?ml|\.?renovate(?:rc)?(?:\.json5?)?|bitbucket-pipelines\.yml|\.travis\.yml|\.drone\.yml|claude(?:\.local)?\.md|agents\.md|gemini\.md|\.cursorrules|\.windsurfrules|\.devcontainer\.json|\.pnp\.(?:cjs|js|data\.json|loader\.mjs)|pyrightconfig\.json|\.lfsconfig|\.?lefthook[\w-]*\.(?:ya?ml|toml|json)|\.huskyrc[\w.]*|husky\.config\.\w+|\.lintstagedrc[\w.]*|lint-staged\.config\.\w+|\.commitlintrc[\w.]*|commitlint\.config\.\w+|\.mergify\.yml|\.gitignore|\.?azure-pipelines[^/]*\.ya?ml|\.vsts-ci\.ya?ml|\.mcp\.json|\.gitmodules|\.gitattributes|\.pre-commit-config\.yaml|[^/]*gitlab-ci\.ya?ml|\.envrc|\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs|bunfig\.toml|[\w.-]*\.bazelrc(?:\.[\w-]+)?|\.bazelversion|\.bazeliskrc|gradle\.properties|(?:gradlew|mvnw)(?:\.(?:bat|cmd|exe|ps1))?)$`,
    // .env* files except explicit example/sample/template variants
    String.raw`(?:^|\/)\.env(?![\w.-]*\.(?:example|sample|template)$)[\w.-]*$`,
    // Review / security policy markdown files
    String.raw`(?:^|\/)(?:review|(?:claude-)?security)\.md$`,
  ].join("|"),
  "u",
);

/**
 * Returns true if `relPath` is a CI config, git/Claude/MCP control file,
 * agent instructions file, build wrapper, or secret-bearing `.env*` file.
 */
export function isNeverEditPath(relPath: string): boolean {
  const norm = normalizePathForCheck(relPath);
  if (norm === "" || norm === "." || norm === ".." || norm.startsWith("../")) return true;
  // Check both normalized and pre-collapse string (with dots/slashes normalized) so
  // traversal into a protected folder cannot hide behind uncollapsed segments.
  const rawFolded = stripTrailingDotsAndSpacesPerSegment(
    stripInvisible(relPath)
      .replace(/\\/gu, "/")
      .toLowerCase()
      .toUpperCase()
      .toLowerCase(),
  )
    .normalize("NFC")
    .replace(/^\/+/u, "");
  return NEVER_EDIT_REGEX.test(norm) || NEVER_EDIT_REGEX.test(rawFolded);
}

const PROTECTED_MERGE_BASES = new Set([
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".mcp.json",
  ".claude/scheduled_tasks.json",
  ".claude/loop.md",
]);

const PROTECTED_REVIEW_SKILL_RE = /(?:^|\/)\.claude\/(?:skills|commands)\/(?:code-review|ship|steward)(?:[/.]|$)/u;

/**
 * Subset of paths that MUST unconditionally refuse automated git merges because
 * merging them changes Claude Code, Cloudroom, or MCP runtime behavior.
 */
export function isProtectedMergePath(relPath: string): boolean {
  const norm = normalizePathForCheck(relPath);
  if (PROTECTED_MERGE_BASES.has(norm)) return true;
  for (const suffix of PROTECTED_MERGE_BASES) {
    if (norm.endsWith(`/${suffix}`)) return true;
  }
  return PROTECTED_REVIEW_SKILL_RE.test(norm);
}

// Common Unicode homoglyphs (Cyrillic, Greek, Fullwidth ASCII) mapped to ASCII equivalents
// so confusable filenames like `.еnv` (Cyrillic е) or `．env` still trip secret-file checks.
const CONFUSABLE_MAP: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u0456": "i", "\u043E": "o", "\u0440": "p",
  "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0455": "s", "\u0458": "j",
  "\u04CF": "l", "\u03B1": "a", "\u03B5": "e", "\u03B9": "i", "\u03BF": "o",
  "\u03C1": "p", "\u03BD": "v", "\u03BA": "k", "\u2024": ".", "\uFF0E": ".",
  "\uFF0F": "/",
};

function foldConfusables(input: string): string {
  let decoded = input;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    // Keep original if malformed percent-encoding.
  }
  return decoded
    .normalize("NFKD")
    .replace(/\p{Mn}/gu, "")
    .replace(/[\uFF01-\uFF5E]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/./gu, (ch) => CONFUSABLE_MAP[ch] ?? ch);
}

const BACKUP_SUFFIX_RE = /(?:[-_](?:bak|old|orig|backup|copy)|\.copy)$/iu;
const TMP_SUFFIX_RE = /\.tmp\.(?:[0-9a-f]{8}|\d+\.[0-9a-f]{12})$/iu;

function stripFileSuffixVariants(segment: string): string[] {
  const out = new Set<string>([segment]);
  let curr = segment;
  for (let i = 0; i < 4; i++) {
    const next = curr.replace(TMP_SUFFIX_RE, "").replace(BACKUP_SUFFIX_RE, "");
    if (next === curr || next === "" || next === "." || next === "..") break;
    out.add(next);
    curr = next;
  }
  return [...out];
}

const SECRET_FILE_EXACT = new Set([
  "token.json",
  "auth.json",
  "gcp-key.json",
  "password.txt",
  "credentials",
  "sftp-config.json",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
]);

const SECRET_FILE_REGEX =
  /^(?:\.env(?![\w.-]*\.(?:example|sample|template)$)[\w.-]*|.*firebase-adminsdk.*\.json|.*\.(?:pem|key|p12|pfx|keystore|jks)|\.claude(?:\.[a-z0-9_-]+)?\.json(?:\..*)?)$/u;

const ALLOWED_CLAUDE_CONFIG = new Set([".claude/settings.json", ".claude/settings.local.json", ".mcp.json"]);

/**
 * Returns true if `relPath` looks like a secret, key, or credential file even
 * under Unicode confusable characters, invisible chars, or backup/temp suffixes.
 */
export function isSecretFilename(relPath: string): boolean {
  const folded = normalizePathForCheck(foldConfusables(relPath));
  if (folded === "" || folded.includes("\0")) return true;
  if (ALLOWED_CLAUDE_CONFIG.has(folded) || [...ALLOWED_CLAUDE_CONFIG].some((p) => folded.endsWith(`/${p}`))) {
    return false;
  }
  if (/(?:^|\/)\.?anthropic\/credentials\/.*\.json$/u.test(folded)) return true;
  if (folded === ".vscode/sftp.json" || folded.endsWith("/.vscode/sftp.json")) return true;

  const segments = folded.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === "..")) return true;
  const base = segments.at(-1);
  if (base === undefined) return true;

  for (const variant of stripFileSuffixVariants(base)) {
    if (SECRET_FILE_EXACT.has(variant) || SECRET_FILE_REGEX.test(variant)) {
      return true;
    }
  }
  return false;
}
