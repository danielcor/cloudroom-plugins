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
// Strict rule (Daniel, 2026-11-13): a literal value assigned to a secret-named key
// or flag is a finding, whatever its entropy; see literalOf() for what is not literal.
// The whole name is taken (`API_TOKEN`, `DATABASE_PASSWORD`, `apiKey`), so a `\b`
// cannot hide it behind `_`. All three are zero-width lookaheads, so every name is
// inspected: an earlier match never consumes a later name.
// `NAME=VALUE`, `--NAME=VALUE`, `export NAME="VALUE"`: anywhere on the line.
const ASSIGN_EQ = new RegExp(`(?<![A-Za-z0-9_.-])(?=-*${NAME}["']?[ \\t]*=[ \\t]*${VALUE})`, "dgu");
// `NAME: VALUE`, `"NAME": "VALUE"`: only where a YAML or JSON key can start (line
// start, `- `, `{`, `,`, `[`), so prose such as `the password: it must be long` is not one.
const ASSIGN_COLON = new RegExp(`(?<=^[ \\t]*(?:-[ \\t]+)?["']?|[{,[][ \\t]*["']?)(?=${NAME}["']?[ \\t]*:[ \\t]*${VALUE})`, "dgu");
// `--NAME VALUE`, `-NAME "VALUE"`: a flag, whitespace, then the value.
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

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1);
  return v;
}

const REF = "(?:\\$[A-Za-z_][A-Za-z0-9_]*|\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|%[A-Za-z_][A-Za-z0-9_]*%|\\$?\\{\\{[^}]*\\}\\})";
// Read from elsewhere at run time: `$(cmd)`, `` `cmd` ``, or a template that an
// unquoted value cuts at its first space (`${{ secrets.X }}`, `{{ x }}`).
const RUNTIME_START = /^(?:\$\(|`|\$?\{\{)/u;
// An unquoted shell word ends at shell syntax: `$VAR; echo`, `${VAR}&& deploy`.
const SHELL_END = "(?:[;&|<>)].*)?";
const PLAIN_REF = new RegExp(`^${REF}$`, "su");
const PLAIN_REF_SHELL = new RegExp(`^${REF}${SHELL_END}$`, "su");
const DEFAULT_REF = new RegExp(`^\\$\\{[A-Za-z_][A-Za-z0-9_]*:?[-=?+]([^}]*)\\}$`, "su");
const DEFAULT_REF_SHELL = new RegExp(`^\\$\\{[A-Za-z_][A-Za-z0-9_]*:?[-=?+]([^}]*)\\}${SHELL_END}$`, "su");

/**
 * The literal text a value stands for. A plain reference (`$VAR`, `${VAR}`,
 * `%VAR%`, `{{placeholder}}`) or a run-time value (`$(cmd)`, backticks,
 * `${{ expr }}`) stands for nothing: null. A shell default
 * (`${VAR:-text}`) stands for its text. Anything else stands for itself.
 * `shellWord`: the value was an unquoted shell word, so shell syntax after the
 * reference (`$VAR; echo`) ends it. Inside quotes or URL userinfo it does not:
 * `"${TOKEN};literal"` is literal text.
 */
export function literalOf(v: string, shellWord = false): string | null {
  const t = v.trim();
  if ((shellWord ? PLAIN_REF_SHELL : PLAIN_REF).test(t) || RUNTIME_START.test(t)) return null;
  const d = (shellWord ? DEFAULT_REF_SHELL : DEFAULT_REF).exec(t);
  return d ? d[1]! : t;
}

// YAML/JSON booleans and null are not secrets (`require_password: true`).
const SCALAR = /^(?:true|false|null|yes|no|on|off|~)$/iu;

/**
 * A literal value under the strict rule: not empty, not a reference (see
 * literalOf), not a YAML/JSON boolean or null. `flagValue`: the value follows a
 * flag after a space, so another option (`--verbose`) or a shell operator
 * (`< token.txt`) is not its value.
 */
function isLiteral(v: string | null, flagValue = false): boolean {
  if (v === null || v.trim() === "" || SCALAR.test(v.trim())) return false;
  return !(flagValue && /^[-<>|;&]/u.test(v));
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

/** The finding for the strict rule; the save gate tells the user how to reword it. */
export const LITERAL_KIND = "literal value for a secret-named key";

export function scanSecrets(text: string): SecretFinding[] {
  const found = new Map<string, SecretFinding>();
  const add = (kind: string, line: number) => found.set(`${line}\u0000${kind}`, { kind, line });
  const physical = text.split("\n");

  for (const l of logicalLines(physical)) {
    const at = (m: RegExpMatchArray, group: number) => lineAt(l, m.indices?.[group]?.[0] ?? m.index ?? 0);
    for (const { kind, re } of PATTERNS) for (const m of l.text.matchAll(re)) add(kind, at(m, 0));
    // [match, value group, shell word?, flag value?]. Only an unquoted value after `=`
    // (a shell assignment or `--flag=`) or after a flag is a shell word; `key: value` is YAML/JSON.
    type Named = [RegExpMatchArray, number, boolean, boolean];
    const named: Named[] = [
      ...[...l.text.matchAll(ASSIGN_EQ)].map((m): Named => [m, 2, true, false]),
      // `key: |` / `key: >-` opens a YAML block: its lines are checked below, not the indicator.
      ...[...l.text.matchAll(ASSIGN_COLON)].filter((m) => !/^[|>][+-]?\d?[+-]?$/u.test(m[2]!)).map((m): Named => [m, 2, false, false]),
      ...[...l.text.matchAll(FLAG_SPACED)].map((m): Named => [m, 2, true, true]),
    ];
    for (const [m, group, shell, flagValue] of named) {
      const raw = m[group]!;
      const quoted = raw.startsWith('"') || raw.startsWith("'");
      if (isSecretName(m[1]!) && isLiteral(literalOf(unquote(raw), shell && !quoted), flagValue && !quoted)) add(LITERAL_KIND, at(m, group));
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
    // Any literal line in the block is the value.
    const hit = block.find((b) => isLiteral(literalOf(b.text)));
    if (hit) add(LITERAL_KIND, hit.line);
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
