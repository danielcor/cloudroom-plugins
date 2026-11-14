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

// A whole value: one shell word, made of "double-quoted", 'single-quoted' and unquoted
// segments (`""hunter2`, `"$PASSWORD"hunter2`), with `$(cmd)`, backticks and
// `{{ … }}` taken whole even when they hold spaces. Punctuation stays inside.
const VALUE =
  String.raw`((?:"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|\$\([^)\n]*\)|` + "`[^`\\n]*`" + String.raw`|\$?\{\{[^}\n]*\}\}|[^\s"'])+)`;
const NAME = "([A-Za-z_][A-Za-z0-9_.-]*)";
// Strict rule (Daniel, 2026-11-13): a literal value assigned to a secret-named key
// or flag is a finding, whatever its entropy; see literalText() for what is not literal.
// The whole name is taken (`API_TOKEN`, `DATABASE_PASSWORD`, `apiKey`), so a `\b`
// cannot hide it behind `_`. All three are zero-width lookaheads, so every name is
// inspected: an earlier match never consumes a later name.
// `NAME=VALUE`, `--NAME=VALUE`, `export NAME="VALUE"`: anywhere on the line.
const ASSIGN_EQ = new RegExp(`(?<![A-Za-z0-9_.-])(?=-*${NAME}["']?[ \\t]*=[ \\t]*${VALUE})`, "dgu");
// `NAME: VALUE`, `"NAME": "VALUE"` (YAML/JSON): only where a key can start, so prose such
// as `the password: it must be long` is not one. The value is a YAML/JSON scalar, not a
// shell word: a "double-quoted" or 'single-quoted' string, or plain text.
const YAML_QUOTED = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\n]|'')*'`;
// At line start (after one or more `- `): the scalar runs to the end of the line, without
// a ` # comment`. A quoted scalar may be followed by `,` (a line of a multi-line JSON
// object); a plain scalar keeps its comma (`password: true,` is the string "true,").
// Group 2 is a quoted scalar, group 3 a plain one.
const ASSIGN_COLON_LINE = new RegExp(
  String.raw`(?<=^[ \t]*(?:-[ \t]+)*["']?)(?=${NAME}["']?[ \t]*:[ \t]*(?:(${YAML_QUOTED})[ \t]*,?|([^\n]*?))(?:[ \t]+#.*)?[ \t]*$)`,
  "dgu",
);
// Inside a flow mapping or JSON object (after `{`, `,`, `[`): the scalar ends at `,` `}` `]`.
const ASSIGN_COLON_FLOW = new RegExp(String.raw`(?<=[{,[][ \t]*["']?)(?=${NAME}["']?[ \t]*:[ \t]*(${YAML_QUOTED}|[^,}\]\n]*))`, "dgu");
// `--NAME VALUE`, `-NAME "VALUE"`: a flag, whitespace, then the value.
const FLAG_SPACED = new RegExp(`(?<![A-Za-z0-9_.-])(?=--?${NAME}[ \\t]+${VALUE})`, "dgu");
// scheme://user:password@host (the user name may be empty: https://:password@host)
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:([^\s/?#@]+)@/dgiu;
// Authorization: Basic <base64>; isBasicCredentials() checks it decodes to user:password.
const BASIC_AUTH = /\bauthorization\s*:\s*basic\s+([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])/dgiu;
// curl -u user:password, -uuser:password, --user user:password, --user=user:password
const CURL_USER = new RegExp(`(?<![A-Za-z0-9_-])(?:-u[ \\t]*|--user(?:[ \\t]+|=))${VALUE}`, "dgu");
// curl -H "Name: value", -H"…", --header '…', --header=…: a secret-named header (X-API-Key,
// X-Auth-Token, Private-Token) falls under the strict rule. Bare `Name: value` lines are
// YAML-style `key: value` lines and are covered by ASSIGN_COLON_LINE.
const CURL_HEADER = new RegExp(`(?<![A-Za-z0-9_-])(?:-H[ \\t]*|--header(?:[ \\t]+|=))${VALUE}`, "dgu");
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

const REF = "(?:\\$[A-Za-z_][A-Za-z0-9_]*|\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|%[A-Za-z_][A-Za-z0-9_]*%|\\$?\\{\\{[^}]*\\}\\})";
// A reference: `$VAR`, `${VAR}`, `%VAR%`, `{{placeholder}}`, `${{ expr }}`.
const REF_EXACT = new RegExp(`^${REF}$`, "su");
// Read at run time: a whole `$(cmd)` or backtick command.
const RUNTIME_EXACT = /^(?:\$\([^)]*\)|`[^`]*`)$/su;
// A shell default: `${VAR:-text}` (also :=, :?, :+) stands for `text`.
const DEFAULT_EXACT = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?[-=?+]([^}]*)\}$/su;
// Taken whole while splitting a word, so their `)` or spaces do not end it.
const ATOMIC = /^(?:\$\([^)\n]*\)|`[^`\n]*`|\$?\{\{[^}\n]*\}\})/u;
// Unquoted shell syntax ends a shell word: `$VAR; echo`, `${VAR}&& deploy`.
const SHELL_DELIM = /[;&|<>)]/u;
// An HTTP header name: capitalized (`ApiKey`, `X-API-Key`, `Private-Token`) or lowercase
// with hyphens (`x-api-key`). A `Name: value` line is the same text in YAML and HTTP, so a
// line counts as a header only when it is unindented, its name is unquoted and
// header-shaped, and its value does not open a YAML block (`api-token: |` + indented
// lines). Then the value is header text, with no YAML exemptions. `apiKey: true`,
// `require_password: true` and any indented key stay YAML.
const HEADER_NAME = /^(?:[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)$/u;
// Unquoted YAML/JSON booleans and null are not secrets (`require_password: true`).
// Only for a plain YAML/JSON scalar: `PASSWORD=true` or `password: "null"` is literal.
const SCALAR = /^(?:true|false|null|yes|no|on|off|~)$/iu;

/**
 * Where a piece of a shell word came from. Single-quoted text and a
 * backslash-escaped character are never expanded by the shell, so they are
 * always literal (`'$PASSWORD'`, `"\$x"`); plain and double-quoted text may be
 * a reference or a command substitution.
 */
type SegmentKind = "plain" | "double" | "single" | "escaped";
interface Segment {
  text: string;
  kind: SegmentKind;
}

/** Split a captured shell word into segments. An unquoted `;&|<>)` ends it. */
function segments(word: string): Segment[] {
  const out: Segment[] = [];
  let plain = "";
  const flush = () => {
    if (plain !== "") out.push({ text: plain, kind: "plain" });
    plain = "";
  };
  let i = 0;
  while (i < word.length) {
    const c = word[i]!;
    const atomic = ATOMIC.exec(word.slice(i));
    if (atomic) {
      flush();
      out.push({ text: atomic[0], kind: "plain" });
      i += atomic[0].length;
    } else if (c === "\\" && i + 1 < word.length) {
      flush();
      out.push({ text: word[i + 1]!, kind: "escaped" });
      i += 2;
    } else if (c === "'") {
      flush();
      const end = word.indexOf("'", i + 1);
      const stop = end === -1 ? word.length : end;
      out.push({ text: word.slice(i + 1, stop), kind: "single" });
      i = stop + 1;
    } else if (c === '"') {
      flush();
      let j = i + 1;
      let text = "";
      while (j < word.length && word[j] !== '"') {
        // In double quotes, `\` escapes only $ ` " \ ; the escaped character stays literal.
        if (word[j] === "\\" && j + 1 < word.length && '$`"\\'.includes(word[j + 1]!)) {
          out.push({ text, kind: "double" });
          out.push({ text: word[j + 1]!, kind: "escaped" });
          text = "";
          j += 2;
        } else text += word[j++];
      }
      out.push({ text, kind: "double" });
      i = j + 1;
    } else if (SHELL_DELIM.test(c)) {
      break;
    } else {
      plain += c;
      i++;
    }
  }
  flush();
  return out;
}

/** Text that is empty or a reference stands for nothing (null); a shell default for its text. */
function referenceLiteral(text: string): string | null {
  if (text === "" || REF_EXACT.test(text)) return null;
  const d = DEFAULT_EXACT.exec(text);
  if (d) return d[1] === "" ? null : d[1]!;
  return text;
}

/**
 * The literal text of a shell word, or null when it holds none. Single-quoted
 * and escaped pieces are literal. A plain or double-quoted piece that is empty,
 * a reference, or (with `runtime`) a whole `$(cmd)` or backtick command adds
 * nothing; a shell default adds its text; anything else adds itself. So
 * `""hunter2`, `"$PASSWORD"hunter2`, `'$(echo x)'` and `"   "` are literal.
 */
function literalText(segs: readonly Segment[], runtime: boolean): string | null {
  let lit = "";
  for (const s of segs) {
    if (s.text === "") continue;
    if (s.kind === "single" || s.kind === "escaped") lit += s.text;
    else if (!(runtime && RUNTIME_EXACT.test(s.text))) lit += referenceLiteral(s.text) ?? "";
  }
  return lit === "" ? null : lit;
}

/**
 * The literal text of a YAML/JSON scalar, or null. Quoted: its content, unless
 * empty or a reference. Plain: also null for a block indicator (`|`, `>-`) or an
 * unquoted boolean or null. `$(cmd)` is not run in YAML/JSON, so it is literal.
 */
function scalarLiteral(raw: string): string | null {
  const t = raw.trim();
  const quoted = t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")));
  if (quoted) return referenceLiteral(t.slice(1, -1));
  if (SCALAR.test(t) || /^[|>][+-]?\d?[+-]?$/u.test(t)) return null;
  return referenceLiteral(t);
}

/**
 * The part of a word after its first `:` as the program receives it (an escaped
 * `\:` is a colon too), keeping each later piece's provenance (curl `user:password`).
 */
function afterFirstColon(segs: readonly Segment[]): Segment[] | null {
  return splitFirstColon(segs)?.[1] ?? null;
}

/** [the text before the first `:`, the pieces after it]; null without a colon. */
function splitFirstColon(segs: readonly Segment[]): [string, Segment[]] | null {
  let before = "";
  for (let k = 0; k < segs.length; k++) {
    const idx = segs[k]!.text.indexOf(":");
    if (idx !== -1) return [before + segs[k]!.text.slice(0, idx), [{ ...segs[k]!, text: segs[k]!.text.slice(idx + 1) }, ...segs.slice(k + 1)]];
    before += segs[k]!.text;
  }
  return null;
}

// A key whose value is on a later line: `password:` (YAML or a JSON line, at line
// start) or `, "password":` / `{"password":` at the end of a line (JSON/flow).
const KEY_ONLY = /^([ \t]*)(?:-[ \t]+)*(["']?)([A-Za-z_][A-Za-z0-9_.-]*)["']?[ \t]*:[ \t]*(?:#.*)?$/u;
const KEY_AT_END = /[{,][ \t]*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?[ \t]*:[ \t]*$/u;
const LEADING_QUOTED = new RegExp(`^(${YAML_QUOTED})`, "u");
// The next line opens a nested mapping (`user: app`, `"user": "app"`), not a scalar.
const MAPPING_KEY = new RegExp(`^(?:${YAML_QUOTED}|[A-Za-z_][A-Za-z0-9_.-]*)[ \\t]*:(?:[ \\t]|$)`, "u");

/**
 * The scalar a key with no value on its own line takes from the next line that
 * is not blank or a `#` comment, or null when that line is not one: a nested
 * mapping or list, a flow collection, or (YAML, plain) a line that is not
 * indented deeper than the key. `flow`: JSON/flow context (inside an unclosed
 * `{`, or a key after `{` or `,`), where indentation does not matter. Quoted: the leading
 * quoted string. Plain: up to ` # comment`, and in JSON/flow up to `,` `}` `]`.
 */
/** Whether the line after 1-based line `lineNo` (skipping blanks) is indented: a YAML block follows. */
function opensIndentedBlock(physical: readonly string[], lineNo: number): boolean {
  const next = physical.slice(lineNo).find((p) => p.trim() !== "");
  return next !== undefined && next.length - next.trimStart().length > 0;
}

/**
 * Whether line `i` sits inside a `{` left open on earlier lines (JSON or a YAML
 * flow mapping). Braces in quoted strings ("…" with `\` escapes, '…' with
 * `''`), in `#` comments and in `{{placeholders}}` do not count.
 */
function insideBraces(physical: readonly string[], i: number): boolean {
  let depth = 0;
  for (let k = 0; k < i; k++) {
    const text = physical[k]!.replace(/\{\{[^}]*\}\}/gu, "");
    let quote = "";
    for (let c = 0; c < text.length; c++) {
      const ch = text[c]!;
      if (quote === '"') {
        if (ch === "\\") c++;
        else if (ch === '"') quote = "";
      } else if (quote === "'") {
        if (ch === "'" && text[c + 1] === "'") c++;
        else if (ch === "'") quote = "";
      } else if (ch === "#" && (c === 0 || /\s/u.test(text[c - 1]!))) break;
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
  }
  return depth > 0;
}

function continuedScalar(keyIndent: number, flow: boolean, next: string): string | null {
  const t = next.trim();
  if (t === "" || MAPPING_KEY.test(t) || t === "-" || t.startsWith("- ")) return null;
  // A flow mapping or list (`{user: app}`, `[one, two]`), not a `{{placeholder}}`, is not a scalar.
  if (t.startsWith("[") || (t.startsWith("{") && !t.startsWith("{{"))) return null;
  const q = LEADING_QUOTED.exec(t);
  if (q) return q[1]!;
  if (!flow && next.length - next.trimStart().length <= keyIndent) return null;
  return flow ? t.replace(/[,}\]].*$/u, "") : t.replace(/[ \t]+#.*$/u, "");
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
    // Shell words after `=` and flags; YAML/JSON scalars after `:`.
    // [match, mode, value group].
    type Named = [RegExpMatchArray, "shell" | "flag" | "scalar" | "line", number];
    const named: Named[] = [
      ...[...l.text.matchAll(ASSIGN_EQ)].map((m): Named => [m, "shell", 2]),
      ...[...l.text.matchAll(ASSIGN_COLON_LINE)].map((m): Named => [m, "line", m[2] !== undefined ? 2 : 3]),
      ...[...l.text.matchAll(ASSIGN_COLON_FLOW)].map((m): Named => [m, "scalar", 2]),
      ...[...l.text.matchAll(FLAG_SPACED)].map((m): Named => [m, "flag", 2]),
    ];
    for (const [m, mode, group] of named) {
      if (!isSecretName(m[1]!)) continue;
      const raw = m[group]!;
      let lit: string | null;
      const headerLine =
        mode === "line" &&
        m.indices?.[1]?.[0] === 0 &&
        HEADER_NAME.test(m[1]!) &&
        !(/^[|>][+-]?\d?[+-]?$/u.test(raw.trim()) && opensIndentedBlock(physical, lineAt(l, 0)));
      if (headerLine) {
        // A bare header line (`X-API-Key: value`): the value is header text.
        lit = referenceLiteral(raw.trim());
      } else if (mode === "scalar" || mode === "line") lit = scalarLiteral(raw);
      // After a spaced flag, another option or a shell operator is not its value.
      else if (mode === "flag" && /^[-<>|;&]/u.test(raw)) lit = null;
      else lit = literalText(segments(raw), true);
      if (lit !== null) add(LITERAL_KIND, at(m, group));
    }
    for (const m of l.text.matchAll(URL_USERINFO)) if (referenceLiteral(m[1]!) !== null) add("password in a URL", at(m, 1));
    for (const m of l.text.matchAll(BASIC_AUTH)) if (isBasicCredentials(m[1]!)) add("Basic auth credentials", at(m, 1));
    for (const m of l.text.matchAll(CURL_HEADER)) {
      const split = splitFirstColon(segments(m[1]!));
      if (!split || !isSecretName(split[0].trim())) continue;
      // curl drops the spaces before a header value, across quoted pieces (`"X-API-Key:"" $KEY"`).
      const value = [...split[1]];
      while (value.length > 0 && /^[ \t]*$/u.test(value[0]!.text)) value.shift();
      if (value.length > 0) value[0] = { ...value[0]!, text: value[0]!.text.replace(/^[ \t]+/u, "") };
      if (literalText(value, true) !== null) add(LITERAL_KIND, at(m, 1));
    }
    for (const m of l.text.matchAll(CURL_USER)) {
      const password = afterFirstColon(segments(m[1]!));
      if (password && literalText(password, false) !== null) add("password in -u/--user", at(m, 1));
    }
  }

  // A secret-named key with no value on its line takes the scalar on the next non-blank line.
  physical.forEach((raw, i) => {
    const line = KEY_ONLY.exec(raw);
    const end = line ? null : KEY_AT_END.exec(raw);
    const name = line?.[3] ?? end?.[1];
    if (name === undefined || !isSecretName(name)) return;
    // Skip blank lines and YAML `#` comment lines.
    const j = physical.findIndex((p, k) => k > i && p.trim() !== "" && !p.trim().startsWith("#"));
    if (j === -1) return;
    const keyIndent = line ? line[1]!.length : raw.length - raw.trimStart().length;
    const flow = end !== null || insideBraces(physical, i);
    const value = continuedScalar(keyIndent, flow, physical[j]!);
    if (value !== null && scalarLiteral(value) !== null) add(LITERAL_KIND, j + 1);
  });

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
    // Block text is literal as written: `true` there is a string.
    const hit = block.find((b) => referenceLiteral(b.text) !== null);
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
