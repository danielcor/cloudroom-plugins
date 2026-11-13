import { fillPlaceholders } from "./placeholders.js";

// Secret-shape scan and invisible-character handling. A hit blocks a save;
// findings name the kind and line only, never the matched value.

export interface SecretFinding {
  kind: string;
  line: number;
}

// Known token shapes, matched anywhere (case-insensitive where the scheme is).
const PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: "private key block", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/dgu },
  { kind: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/dgu },
  { kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/dgu },
  { kind: "API key (sk-…)", re: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/dgu },
  { kind: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/dgu },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/dgu },
  { kind: "JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/dgu },
  { kind: "bearer token", re: /\bbearer\s+[A-Za-z0-9._~+/-]{24,}=*/dgiu },
];

// A whole value: a "double-quoted" or 'single-quoted' string (quotes kept, for
// unquote()), or an unquoted run up to whitespace. Punctuation stays inside.
const VALUE = `("(?:[^"\\\\\\n]|\\\\.)*"|'[^'\\n]*'|[^\\s"']+)`;
const NAME = "([A-Za-z_][A-Za-z0-9_.-]*)";
// `NAME = VALUE`, `NAME: VALUE`, `"NAME": "VALUE"`, `--NAME=VALUE`. The whole name is taken
// (`API_TOKEN`, `DATABASE_PASSWORD`, `apiKey`), so a `\b` cannot hide it behind `_`.
// `--NAME VALUE`, `-NAME "VALUE"`: a flag, whitespace, then the value.
// Both are zero-width lookaheads, so every name is inspected: an earlier match
// never consumes a later name (`--verbose --registry-password VALUE`).
const ASSIGNED = new RegExp(`(?<![A-Za-z0-9_.-])(?=-*${NAME}["']?[ \\t]*([:=])[ \\t]*${VALUE})`, "dgu");
const FLAG_SPACED = new RegExp(`(?<![A-Za-z0-9_.-])(?=--?${NAME}[ \\t]+${VALUE})`, "dgu");
// scheme://user:password@host (the user name may be empty: https://:password@host)
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:([^\s/?#@]+)@/dgiu;
// Authorization: Basic <base64>; isBasicCredentials() checks it decodes to user:password.
const BASIC_AUTH = /\bauthorization\s*:\s*basic\s+([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])/dgiu;
// curl -u user:password, -uuser:password, --user user:password, --user=user:password
const CURL_USER = new RegExp(`(?<![A-Za-z0-9_-])(?:-u[ \\t]*|--user(?:[ \\t]+|=))${VALUE}`, "dgu");
// A YAML block scalar under a key: `api_token: |`, `>-`, `|2`.
const YAML_BLOCK = /^([ \t]*)(?:-[ \t]+)?["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?[ \t]*:[ \t]*[|>][+-]?\d?[+-]?[ \t]*(?:#.*)?$/u;

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
  return v.length >= 16 && classes >= 2 && entropy(v) >= 3.5;
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

const REF = "(?:\\$[A-Za-z_][A-Za-z0-9_]*|\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|\\$?\\{\\{[^}]*\\}\\})";
// An unquoted shell word ends at shell syntax: `$VAR; echo`, `${VAR}&& deploy`.
const SHELL_END = "(?:[;&|<>)].*)?";
const PLAIN_REF = new RegExp(`^${REF}$`, "su");
const PLAIN_REF_SHELL = new RegExp(`^${REF}${SHELL_END}$`, "su");
const DEFAULT_REF = new RegExp(`^\\$\\{[A-Za-z_][A-Za-z0-9_]*:?[-=?+]([^}]*)\\}$`, "su");
const DEFAULT_REF_SHELL = new RegExp(`^\\$\\{[A-Za-z_][A-Za-z0-9_]*:?[-=?+]([^}]*)\\}${SHELL_END}$`, "su");

/**
 * The literal text a value stands for. A plain reference (`$VAR`, `${VAR}`,
 * `${{ expr }}`, `{{placeholder}}`) stands for nothing: null. A shell default
 * (`${VAR:-text}`) stands for its text. Anything else stands for itself.
 * `shellWord`: the value was an unquoted shell word, so shell syntax after the
 * reference (`$VAR; echo`) ends it. Inside quotes or URL userinfo it does not:
 * `"${TOKEN};literal"` is literal text.
 */
export function literalOf(v: string, shellWord = false): string | null {
  const t = v.trim();
  if ((shellWord ? PLAIN_REF_SHELL : PLAIN_REF).test(t)) return null;
  const d = (shellWord ? DEFAULT_REF_SHELL : DEFAULT_REF).exec(t);
  return d ? d[1]! : t;
}

/** An ordinary word, maybe with punctuation: `Choose`, `account.`, or all caps for emphasis and acronyms (`NOT`, `API`). */
const PROSE_WORD = /^[("'`]*(?:[A-Za-z][a-z]+|[A-Z]{2,})[.,;:!?'"`)]*$/u;

/**
 * Random-looking. A value with spaces is prose when at least half its words are
 * ordinary words: then only a random word counts (`use <token> for staging`).
 * Otherwise the whole value counts too, spaces removed (`aB3dE5gH7jK9 mN1pQ2sT4vW6x`).
 */
function isSecretValue(v: string | null): boolean {
  if (v === null) return false;
  if (!/\s/u.test(v)) return looksRandom(v);
  const words = v.split(/\s+/u).filter(Boolean);
  if (words.some((w) => looksRandom(w))) return true;
  const prose = words.filter((w) => PROSE_WORD.test(w)).length;
  return prose * 2 < words.length && looksRandom(words.join(""));
}

/**
 * Padded base64 that decodes to `user:password` with a non-empty password and
 * no control characters, read as UTF-8 or as Latin-1 (what Requests sends).
 */
function isBasicCredentials(b64: string): boolean {
  if (b64.length % 4 !== 0) return false;
  let latin1: string;
  try {
    latin1 = atob(b64);
  } catch {
    return false;
  }
  const shape = /^[^:\p{Cc}]*:[^\p{Cc}]+$/u;
  if (shape.test(latin1)) return true;
  try {
    return shape.test(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(latin1, (c) => c.charCodeAt(0))));
  } catch {
    return false;
  }
}

/** A physical line joined with its shell `\` continuations, and a map back to line numbers. */
interface LogicalLine {
  text: string;
  /** Start offset of each physical line in `text`, with its 1-based number. */
  starts: { offset: number; line: number }[];
}

function logicalLines(physical: readonly string[]): LogicalLine[] {
  const out: LogicalLine[] = [];
  let current: LogicalLine | null = null;
  physical.forEach((raw, i) => {
    const continued = /(?:^|[^\\])(?:\\\\)*\\$/u.test(raw);
    // Shell drops the backslash and the newline and inserts nothing: `ab\` + `cd` is `abcd`.
    const piece = continued ? raw.slice(0, -1) : raw;
    if (current === null) current = { text: "", starts: [] };
    current.starts.push({ offset: current.text.length, line: i + 1 });
    current.text += piece;
    if (!continued) {
      out.push(current);
      current = null;
    }
  });
  if (current !== null) out.push(current);
  return out;
}

function lineAt(l: LogicalLine, offset: number): number {
  let line = l.starts[0]!.line;
  for (const s of l.starts) if (s.offset <= offset) line = s.line;
  return line;
}

export function scanSecrets(text: string): SecretFinding[] {
  const found = new Map<string, SecretFinding>();
  const add = (kind: string, line: number) => found.set(`${line}\u0000${kind}`, { kind, line });
  const physical = text.split("\n");

  for (const l of logicalLines(physical)) {
    const at = (m: RegExpMatchArray, group: number) => lineAt(l, m.indices?.[group]?.[0] ?? m.index ?? 0);
    for (const { kind, re } of PATTERNS) for (const m of l.text.matchAll(re)) add(kind, at(m, 0));
    // [match, value group, shell word?]. Only an unquoted value after `=` (a shell
    // assignment or `--flag=`) or after a flag is a shell word; `key: value` is YAML/JSON.
    const named: [RegExpMatchArray, number, boolean][] = [
      ...[...l.text.matchAll(ASSIGNED)].map((m): [RegExpMatchArray, number, boolean] => [m, 3, m[2] === "="]),
      ...[...l.text.matchAll(FLAG_SPACED)].map((m): [RegExpMatchArray, number, boolean] => [m, 2, true]),
    ];
    for (const [m, group, shell] of named) {
      const raw = m[group]!;
      const quoted = raw.startsWith('"') || raw.startsWith("'");
      if (isSecretName(m[1]!) && isSecretValue(literalOf(unquote(raw), shell && !quoted))) add("secret-looking value", at(m, group));
    }
    for (const m of l.text.matchAll(URL_USERINFO)) if (literalOf(m[1]!)) add("password in a URL", at(m, 1));
    for (const m of l.text.matchAll(BASIC_AUTH)) if (isBasicCredentials(m[1]!)) add("Basic auth credentials", at(m, 1));
    for (const m of l.text.matchAll(CURL_USER)) {
      const raw = m[1]!;
      const value = unquote(raw);
      const colon = value.indexOf(":");
      const shellWord = !(raw.startsWith('"') || raw.startsWith("'"));
      if (colon !== -1 && literalOf(value.slice(colon + 1), shellWord)) add("password in -u/--user", at(m, 1));
    }
  }

  // YAML block scalars under a secret-named key: the value sits on the indented lines below.
  physical.forEach((raw, i) => {
    const m = YAML_BLOCK.exec(raw);
    if (!m || !isSecretName(m[2]!)) return;
    const indent = m[1]!.length;
    const block: { text: string; line: number }[] = [];
    for (let j = i + 1; j < physical.length; j++) {
      const next = physical[j]!;
      if (next.trim() === "") continue;
      if (next.length - next.trimStart().length <= indent) break;
      block.push({ text: next.trim(), line: j + 1 });
    }
    if (block.length === 0) return;
    const hit = block.find((b) => isSecretValue(literalOf(b.text)));
    // A value folded over several lines: join them when each line is one word.
    const joined = block.every((b) => !/\s/u.test(b.text)) ? block.map((b) => b.text).join("") : "";
    if (hit) add("secret-looking value", hit.line);
    else if (joined && isSecretValue(literalOf(joined))) add("secret-looking value", block[0]!.line);
  });

  return [...found.values()].sort((a, b) => a.line - b.line);
}

/**
 * Scan a snippet's parts and describe each hit in plain words (no values).
 * Scans with invisible characters removed: insert and the CLI strip them, so a
 * token split by a zero-width space must still count. The body is also scanned
 * with every placeholder default filled in, as Insert would leave it when the
 * fields are empty (`--token {{token|VALUE}}`). Used on create, save and load.
 */
export function findSecrets(parts: { title: string; tags: readonly string[]; body: string }): string[] {
  const scan = (t: string) => scanSecrets(stripInvisible(t));
  const body = stripInvisible(parts.body);
  const bodyHits = [...scanSecrets(body), ...scanSecrets(fillPlaceholders(body, {}))].map((f) => `${f.kind} on body line ${f.line}`);
  return [
    ...scan(parts.title).map((f) => `${f.kind} in the title`),
    ...scan(parts.tags.join(", ")).map((f) => `${f.kind} in the tags`),
    ...new Set(bodyHits),
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
