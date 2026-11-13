// Secret-shape scan and invisible-character handling. A hit blocks a save;
// findings name the kind and line only, never the matched value.

export interface SecretFinding {
  kind: string;
  line: number;
}

const PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: "private key block", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/u },
  { kind: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/u },
  { kind: "API key (sk-…)", re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/u },
  { kind: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/u },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { kind: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u },
  { kind: "bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/u },
];

// `NAME = 7f9c…`: a long random-looking value assigned to a name whose last word is
// secret-ish. The whole name is taken (`API_TOKEN`, `DATABASE_PASSWORD`, `apiKey`,
// `stripe.secretKey`), so a `\b` before the secret word cannot hide it behind `_`.
// Leading CLI hyphens are skipped: `--token=…`, `--api-key=…`, `-token=…`.
const ASSIGNED = /(?<![A-Za-z0-9_.-])-*([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([A-Za-z0-9/+_.=-]{16,})/gu;
// A last word that ends in one of these is secret-ish (`dbpassword`, `clientsecret`, `authtoken`).
const SECRET_ENDINGS = ["token", "secret", "password", "passwd", "passphrase", "credential", "credentials"];
// These only as the whole last word: `monkey` must not count as a key.
const SECRET_WORDS = new Set(["key", "pwd", "auth", "pat", "apikey", "accesskey", "secretkey", "privatekey", "clientkey", "signingkey"]);

/**
 * The name's last word is secret-ish. Words split on `_`, `.`, `-`, camelCase
 * and acronyms (`APIToken` → API Token, `DBPassword` → DB Password).
 */
export function isSecretName(name: string): boolean {
  const words = name
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[\s_.-]+/u)
    .filter(Boolean);
  const last = words.at(-1)?.toLowerCase();
  if (last === undefined) return false;
  return SECRET_WORDS.has(last) || SECRET_ENDINGS.some((e) => last.endsWith(e));
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksRandom(v: string): boolean {
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u].filter((r) => r.test(v)).length;
  return classes >= 2 && entropy(v) >= 3.5;
}

export function scanSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  text.split("\n").forEach((line, i) => {
    for (const { kind, re } of PATTERNS) if (re.test(line)) findings.push({ kind, line: i + 1 });
    for (const m of line.matchAll(ASSIGNED)) {
      if (isSecretName(m[1]!) && looksRandom(m[2]!)) findings.push({ kind: "secret-looking value", line: i + 1 });
    }
  });
  return findings;
}

/**
 * Scan a snippet's parts and describe each hit in plain words (no values).
 * Scans with invisible characters removed: insert and the CLI strip them, so a
 * token split by a zero-width space must still count.
 */
export function findSecrets(parts: { title: string; tags: readonly string[]; body: string }): string[] {
  const scan = (t: string) => scanSecrets(stripInvisible(t));
  return [
    ...scan(parts.title).map((f) => `${f.kind} in the title`),
    ...scan(parts.tags.join(", ")).map((f) => `${f.kind} in the tags`),
    ...scan(parts.body).map((f) => `${f.kind} on body line ${f.line}`),
  ];
}

// Zero-width and joiner characters, bidi marks (including U+061C ARABIC LETTER
// MARK), embeddings, overrides and isolates, invisible operators, BOM, soft
// hyphen, Mongolian vowel separator and the Unicode tag block.
const INVISIBLE_SOURCE = "[\\u00AD\\u061C\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u{E0000}-\\u{E007F}]";

export function countInvisible(text: string): number {
  return text.match(new RegExp(INVISIBLE_SOURCE, "gu"))?.length ?? 0;
}

export function stripInvisible(text: string): string {
  return text.replace(new RegExp(INVISIBLE_SOURCE, "gu"), "");
}

/** Replace each invisible character with a visible `⟦U+XXXX⟧` marker for previews. */
export function markInvisible(text: string): string {
  return text.replace(new RegExp(INVISIBLE_SOURCE, "gu"), (c) => `⟦U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟧`);
}
