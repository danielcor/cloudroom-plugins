import { posix } from "node:path";

// Zero-width and joiner characters, bidi marks (including U+061C ARABIC LETTER MARK),
// embeddings, overrides, isolates, BOM, soft hyphen, Mongolian vowel separator, and tag block.
const INVISIBLE_SOURCE =
  "[\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u{E0000}-\\u{E007F}]";

export function stripInvisible(text: string): string {
  return text.replace(new RegExp(INVISIBLE_SOURCE, "gu"), "");
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
export function normalizePathForCheck(input: string, convertBackslashes = true): string {
  const stripped = stripInvisible(input);
  const slashed = convertBackslashes ? stripped.replace(/\\/gu, "/") : stripped;
  const cleaned = stripTrailingDotsAndSpacesPerSegment(
    slashed
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
    // Runtime / package-manager config filenames
    String.raw`(?:^|\/)(?:codeowners|jenkinsfile|action\.ya?ml|cloudbuild\.ya?ml|buildspec[\w.-]*\.ya?ml|appspec\.(?:ya?ml|json)|\.build\.ya?ml|\.?appveyor\.yml|\.cirrus\.yml|codemagic\.yaml|netlify\.toml|vercel\.json|\.scrutinizer\.yml|buddy\.yml|\.?mise(?:\.[\w.-]+)?\.toml|\.rtx\.toml|\.tool-versions|\.woodpecker\.ya?ml|\.?renovate(?:rc)?(?:\.json5?)?|bitbucket-pipelines\.yml|\.travis\.yml|\.drone\.yml|claude(?:\.local)?\.md|agents\.md|gemini\.md|\.cursorrules|\.windsurfrules|\.devcontainer\.json|\.pnp\.(?:cjs|js|data\.json|loader\.mjs)|pyrightconfig\.json|\.lfsconfig|\.?lefthook[\w-]*\.(?:ya?ml|toml|json)|\.huskyrc[\w.]*|husky\.config\.\w+|\.lintstagedrc[\w.]*|lint-staged\.config\.\w+|\.commitlintrc[\w.]*|commitlint\.config\.\w+|\.mergify\.yml|\.gitignore|\.?azure-pipelines[^/]*\.ya?ml|\.vsts-ci\.ya?ml|\.mcp\.json|\.gitmodules|\.gitattributes|\.git-credentials|\.pre-commit-config\.yaml|[^/]*gitlab-ci\.ya?ml|\.envrc|\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs|bunfig\.toml|[\w.-]*\.bazelrc(?:\.[\w-]+)?|\.bazelversion|\.bazeliskrc|gradle\.properties|(?:gradlew|mvnw)(?:\.(?:bat|cmd|exe|ps1))?)$`,
    // Review / security policy markdown files
    String.raw`(?:^|\/)(?:review|(?:claude-)?security)\.md$`,
  ].join("|"),
  "u",
);

/**
 * Returns true if a normalized path basename is a `.env*` secret file rather
 * than an explicit `.example`, `.sample`, or `.template` fixture.
 */
export function isSecretEnvBasename(normalizedBasename: string): boolean {
  return normalizedBasename.startsWith(".env") && !/\.(?:example|sample|template)$/u.test(normalizedBasename);
}

function matchesNeverEditVariant(relPath: string, convertBackslashes: boolean): boolean {
  const norm = normalizePathForCheck(relPath, convertBackslashes);
  if (norm === "" || norm === "." || norm === ".." || norm.startsWith("../")) return true;
  // Check both normalized and pre-collapse string (with dots/slashes normalized) so
  // traversal into a protected folder cannot hide behind uncollapsed segments.
  const stripped = stripInvisible(relPath);
  const rawSlashed = convertBackslashes ? stripped.replace(/\\/gu, "/") : stripped;
  const rawFolded = stripTrailingDotsAndSpacesPerSegment(
    rawSlashed
      .toLowerCase()
      .toUpperCase()
      .toLowerCase(),
  )
    .normalize("NFC")
    .replace(/^\/+/u, "");
  const normBase = norm.split("/").at(-1) ?? "";
  const rawBase = rawFolded.split("/").at(-1) ?? "";
  return (
    NEVER_EDIT_REGEX.test(norm) ||
    NEVER_EDIT_REGEX.test(rawFolded) ||
    isSecretEnvBasename(normBase) ||
    isSecretEnvBasename(rawBase)
  );
}

/**
 * Returns true if `relPath` is a CI config, git/Claude/MCP control file,
 * agent instructions file, build wrapper, or secret-bearing `.env*` file.
 */
export function isNeverEditPath(relPath: string): boolean {
  return matchesNeverEditVariant(relPath, true) || matchesNeverEditVariant(relPath, false);
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

export function foldConfusables(input: string, decodePercent = true): string {
  let decoded = input;
  if (decodePercent) {
    try {
      decoded = decodeURIComponent(input);
    } catch {
      // Keep original if malformed percent-encoding.
    }
  }
  return decoded
    .normalize("NFKD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .replace(/[\uFF01-\uFF5E]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/./gu, (ch) => CONFUSABLE_MAP[ch] ?? ch);
}

const BACKUP_SUFFIX_RE = /(?:[-_.](?:bak|old|orig|backup|copy)|~)$/iu;
const TMP_SUFFIX_RE = /\.tmp\.(?:[0-9a-f]{8}|\d+\.[0-9a-f]{12})$/iu;

function stripFileSuffixVariants(segment: string): string[] {
  const out = new Set<string>([segment]);
  let curr = segment;
  while (true) {
    let next = curr.replace(TMP_SUFFIX_RE, "");
    if (next === curr) {
      next = curr.replace(BACKUP_SUFFIX_RE, "");
    }
    if (next !== curr && next !== "." && next !== "..") {
      next = next.replace(/[. ]+$/u, "");
    }
    if (next.length >= curr.length || next === "" || next === "." || next === "..") break;
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
  ".git-credentials",
  "sftp-config.json",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
]);

const SECRET_FILE_REGEX =
  /^(?:.*firebase-adminsdk.*\.json|.*\.(?:pem|key|p12|pfx|keystore|jks)|\.claude(?:\.[a-z0-9_-]+)?\.json(?:\..*)?)$/su;

function matchesNormalizedSecretPath(folded: string, convertBackslashes: boolean): boolean {
  if (folded === "" || folded.includes("\0")) return true;

  const segments = folded.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === "..")) return true;
  const base = segments.at(-1);
  if (base === undefined) return true;

  const parentPrefix = segments.length > 1 ? `${segments.slice(0, -1).join("/")}/` : "";
  for (const baseVariant of stripFileSuffixVariants(base)) {
    const variantPath = normalizePathForCheck(`${parentPrefix}${baseVariant}`, convertBackslashes);
    const variantBase = variantPath.split("/").at(-1) ?? "";
    if (/(?:^|\/)\.?anthropic\/credentials\/.*\.json$/su.test(variantPath)) return true;
    if (variantPath === ".vscode/sftp.json" || variantPath.endsWith("/.vscode/sftp.json")) return true;
    if (isSecretEnvBasename(variantBase) || SECRET_FILE_EXACT.has(variantBase) || SECRET_FILE_REGEX.test(variantBase)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if `relPath` looks like a secret, key, or credential file even
 * under Unicode confusable characters, invisible chars, or backup/temp suffixes.
 */
export function isSecretFilename(relPath: string): boolean {
  const variants = new Set([relPath, foldConfusables(relPath, false), foldConfusables(relPath, true)]);
  for (const convertBackslashes of [true, false]) {
    const seen = new Set<string>();
    for (const v of variants) {
      const candidate = normalizePathForCheck(v, convertBackslashes);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (matchesNormalizedSecretPath(candidate, convertBackslashes)) return true;
    }
  }
  return false;
}
