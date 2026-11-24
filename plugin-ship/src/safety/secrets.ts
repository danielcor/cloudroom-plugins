import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAlias, isNode, isPair, isScalar, parseAllDocuments, visit, type Alias, type Document, type Node } from "yaml";
import { isNeverEditPath, stripInvisible } from "./never-edit.js";

export interface SecretFinding {
  kind: string;
  line: number;
}

export interface LocalSecret {
  name: string;
  value: string;
}

export const LITERAL_KIND = "literal value for a secret-named key";
export const UNSCANNABLE_KIND = "content nested too deeply to check for secrets";

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

const VALUE =
  String.raw`((?:"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|\$\([^)\n]*\)|` + "`[^`\\n]*`" + String.raw`|\$?\{\{[^}\n]*\}\}|[^\s"'])+)`;
const NAME = "([A-Za-z_][A-Za-z0-9_.-]*)";
const YAML_QUOTED = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\n]|'')*'`;

const ASSIGN_EQ = new RegExp(`(?<![A-Za-z0-9_.-])(?=-*${NAME}["']?[ \\t]*=[ \\t]*${VALUE})`, "dgu");
const ASSIGN_COLON_LINE = new RegExp(
  String.raw`(?<=^[ \t]*(?:-[ \t]+)*["']?)(?=${NAME}["']?[ \t]*:[ \t]*(?:(${YAML_QUOTED})[ \t]*,?|([^\n]*?))(?:[ \t]+#.*)?[ \t]*$)`,
  "dgu",
);
const ASSIGN_COLON_FLOW = new RegExp(String.raw`(?<=[{,[][ \t]*["']?)(?=${NAME}["']?[ \t]*:[ \t]*(${YAML_QUOTED}|[^,}\]\n]*))`, "dgu");
const FLAG_SPACED = new RegExp(`(?<![A-Za-z0-9_.-])(?=--?${NAME}[ \\t]+${VALUE})`, "dgu");
const URL_USERINFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:([^\s/?#@]+)@/dgiu;
const BASIC_AUTH = /\bauthorization\s*:\s*basic\s+([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])/dgiu;
const CURL_USER = new RegExp(`(?<![A-Za-z0-9_-])(?:-u[ \\t]*|--user(?:[ \\t]+|=))${VALUE}`, "dgu");
const CURL_HEADER = new RegExp(`(?<![A-Za-z0-9_-])(?:-H[ \\t]*|--header(?:[ \\t]+|=))${VALUE}`, "dgu");
const YAML_BLOCK = /^([ \t]*)(?:-[ \t]+)?["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?[ \t]*:[ \t]*[|>][+-]?\d?[+-]?[ \t]*(?:#.*)?$/u;

const SECRET_ENDINGS = ["token", "secret", "password", "passwd", "passphrase", "credential", "credentials"];
const SECRET_WORDS = new Set(["key", "pwd", "auth", "pat", "apikey", "accesskey", "secretkey", "privatekey", "clientkey", "signingkey"]);

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
const REF_EXACT = new RegExp(`^${REF}$`, "su");
const RUNTIME_EXACT = /^(?:\$\([^)]*\)|`[^`]*`)$/su;
const DEFAULT_EXACT = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?[-=?+]([^}]*)\}$/su;
const ATOMIC = /^(?:\$\([^)\n]*\)|`[^`\n]*`|\$?\{\{[^}\n]*\}\})/u;
const SHELL_DELIM = /[;&|<>)]/u;
const HEADER_NAME = /^(?:[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)$/u;
const SCALAR = /^(?:true|false|null|yes|no|on|off|~)$/iu;

type SegmentKind = "plain" | "double" | "single" | "escaped";
interface Segment {
  text: string;
  kind: SegmentKind;
}

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

export function referenceLiteral(text: string): string | null {
  if (text === "" || REF_EXACT.test(text)) return null;
  const d = DEFAULT_EXACT.exec(text);
  if (d) return d[1] === "" ? null : d[1]!;
  return text;
}

function literalText(segs: readonly Segment[], runtime: boolean): string | null {
  let lit = "";
  for (const s of segs) {
    if (s.text === "") continue;
    if (s.kind === "single" || s.kind === "escaped") lit += s.text;
    else if (!(runtime && RUNTIME_EXACT.test(s.text))) lit += referenceLiteral(s.text) ?? "";
  }
  return lit === "" ? null : lit;
}

function scalarLiteral(raw: string): string | null {
  const t = raw.trim();
  const quoted = t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")));
  if (quoted) return referenceLiteral(t.slice(1, -1));
  if (SCALAR.test(t) || /^[|>][+-]?\d?[+-]?$/u.test(t)) return null;
  return referenceLiteral(t);
}

function splitFirstColon(segs: readonly Segment[]): [string, Segment[]] | null {
  let before = "";
  for (let k = 0; k < segs.length; k++) {
    const idx = segs[k]!.text.indexOf(":");
    if (idx !== -1) {
      return [before + segs[k]!.text.slice(0, idx), [{ ...segs[k]!, text: segs[k]!.text.slice(idx + 1) }, ...segs.slice(k + 1)]];
    }
    before += segs[k]!.text;
  }
  return null;
}

function afterFirstColon(segs: readonly Segment[]): Segment[] | null {
  return splitFirstColon(segs)?.[1] ?? null;
}

const KEY_ONLY = /^([ \t]*)(?:-[ \t]+)*(["']?)([A-Za-z_][A-Za-z0-9_.-]*)["']?[ \t]*:[ \t]*(?:#.*)?$/u;
const KEY_AT_END = /[{,][ \t]*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?[ \t]*:[ \t]*$/u;
const LEADING_QUOTED = new RegExp(`^(${YAML_QUOTED})`, "u");
const MAPPING_KEY = new RegExp(`^(?:${YAML_QUOTED}|[A-Za-z_][A-Za-z0-9_.-]*)[ \\t]*:(?:[ \\t]|$)`, "u");

function opensIndentedBlock(physical: readonly string[], lineNo: number): boolean {
  const next = physical.slice(lineNo).find((p) => p.trim() !== "");
  return next !== undefined && next.length - next.trimStart().length > 0;
}

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
  if (t.startsWith("[") || (t.startsWith("{") && !t.startsWith("{{"))) return null;
  const q = LEADING_QUOTED.exec(t);
  if (q) return q[1]!;
  if (!flow && next.length - next.trimStart().length <= keyIndent) return null;
  return flow ? t.replace(/[,}\]].*$/u, "") : t.replace(/[ \t]+#.*$/u, "");
}

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

interface LogicalLine {
  text: string;
  starts: { offset: number; line: number }[];
}

function logicalLines(physical: readonly string[]): LogicalLine[] {
  const out: LogicalLine[] = [];
  let current: LogicalLine | null = null;
  physical.forEach((raw, i) => {
    const continued = /(?:^|[^\\])(?:\\\\)*\\$/u.test(raw);
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
        lit = referenceLiteral(raw.trim());
      } else if (mode === "scalar" || mode === "line") lit = scalarLiteral(raw);
      else if (mode === "flag" && /^[-<>|;&]/u.test(raw)) lit = null;
      else lit = literalText(segments(raw), true);
      if (lit !== null) add(LITERAL_KIND, at(m, group));
    }
    for (const m of l.text.matchAll(URL_USERINFO)) if (referenceLiteral(m[1]!) !== null) add("password in a URL", at(m, 1));
    for (const m of l.text.matchAll(BASIC_AUTH)) if (isBasicCredentials(m[1]!)) add("Basic auth credentials", at(m, 1));
    for (const m of l.text.matchAll(CURL_HEADER)) {
      const split = splitFirstColon(segments(m[1]!));
      if (!split || !isSecretName(split[0].trim())) continue;
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

  physical.forEach((raw, i) => {
    const line = KEY_ONLY.exec(raw);
    const end = line ? null : KEY_AT_END.exec(raw);
    const name = line?.[3] ?? end?.[1];
    if (name === undefined || !isSecretName(name)) return;
    const j = physical.findIndex((p, k) => k > i && p.trim() !== "" && !p.trim().startsWith("#"));
    if (j === -1) return;
    const keyIndent = line ? line[1]!.length : raw.length - raw.trimStart().length;
    const flow = end !== null || insideBraces(physical, i);
    const value = continuedScalar(keyIndent, flow, physical[j]!);
    if (value !== null && scalarLiteral(value) !== null) add(LITERAL_KIND, j + 1);
  });

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
    const hit = block.find((b) => referenceLiteral(b.text) !== null);
    if (hit) add(LITERAL_KIND, hit.line);
  });

  return [...found.values()].sort((a, b) => a.line - b.line);
}

interface Region {
  text: string;
  startLine: number;
}

const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
const FENCE = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)*(`{3,}|~{3,})/u;
const QUOTED_LINE = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)*>/u;
const CONTAINERS = /^(?:[ \t]*(?:>|(?:[-*+]|\d+[.)])(?=[ \t]))[ \t]*)+/u;
const ONE_QUOTE = /^[ \t]*>[ \t]?/u;
const MAX_QUOTE_DEPTH = 8;

function expandLeadingTabs(line: string): string {
  const lead = /^[ \t]*/u.exec(line)![0];
  let col = 0;
  for (const ch of lead) col = ch === "\t" ? col + 4 - (col % 4) : col + 1;
  return " ".repeat(col) + line.slice(lead.length);
}

function dedent(lines: readonly string[]): string {
  const nonBlank = lines.filter((l) => l.trim() !== "");
  if (nonBlank.length === 0) return lines.join("\n");
  const width = (l: string) => l.length - l.trimStart().length;
  const cut = Math.min(...nonBlank.map(width));
  return lines.map((l) => l.slice(Math.min(cut, width(l)))).join("\n");
}

function regions(text: string, startLine = 1, depth = 0): Region[] {
  const lines = text.split("\n").map(expandLeadingTabs);
  const out: Region[] = [{ text: lines.join("\n"), startLine }];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]!);
    if (!open) continue;
    const marker = open[1]!;
    let j = i + 1;
    while (j < lines.length && !lines[j]!.trimStart().startsWith(marker)) j++;
    out.push({ text: dedent(lines.slice(i + 1, j)), startLine: startLine + i + 1 });
    i = j;
  }
  const indented = (l: string) => /^ {4}/u.test(l);
  for (let i = 0; i < lines.length; i++) {
    if (!indented(lines[i]!) || lines[i]!.trim() === "" || (i > 0 && lines[i - 1]!.trim() !== "")) continue;
    let j = i;
    while (j < lines.length && (indented(lines[j]!) || lines[j]!.trim() === "")) j++;
    out.push({ text: dedent(lines.slice(i, j)), startLine: startLine + i });
    i = j - 1;
  }
  for (let i = 0; i < lines.length; i++) {
    if (!QUOTED_LINE.test(lines[i]!)) continue;
    let j = i;
    while (j < lines.length && QUOTED_LINE.test(lines[j]!)) j++;
    const run = lines.slice(i, j);
    out.push(...regions(run.map((l) => l.replace(CONTAINERS, "")).join("\n"), startLine + i, MAX_QUOTE_DEPTH));
    if (depth < MAX_QUOTE_DEPTH) out.push(...regions(run.map((l) => l.replace(ONE_QUOTE, "")).join("\n"), startLine + i, depth + 1));
    i = j - 1;
  }
  return out;
}

function scalarIsLiteral(node: Node): boolean {
  if (!isScalar(node)) return false;
  const v = node.value;
  if (v === null || typeof v === "boolean") return false;
  let text = typeof v === "string" ? v : String(v);
  if (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED") text = text.replace(/\n+$/u, "");
  return referenceLiteral(text) !== null;
}

function anchorIndex(doc: Document.Parsed): (alias: Alias) => Node | undefined {
  const byName = new Map<string, { at: number; node: Node }[]>();
  visit(doc, {
    Node(_key, node) {
      if (isNode(node) && !isAlias(node) && node.anchor && node.range) {
        const list = byName.get(node.anchor) ?? [];
        list.push({ at: node.range[0], node });
        byName.set(node.anchor, list);
      }
    },
  });
  return (alias) => {
    const list = byName.get(alias.source);
    if (!list || !alias.range) return undefined;
    let lo = 0;
    let hi = list.length - 1;
    let found: Node | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.at < alias.range[0]) {
        found = list[mid]!.node;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
}

function scanParsed(region: Region): SecretFinding[] {
  const out: SecretFinding[] = [];
  let docs: Document.Parsed[];
  try {
    const parsed = parseAllDocuments(region.text, { strict: false, uniqueKeys: false, prettyErrors: false });
    docs = Array.isArray(parsed) ? parsed : [];
  } catch {
    return [{ kind: UNSCANNABLE_KIND, line: region.startLine }];
  }
  const lineOfOffset = (offset: number) => region.startLine + (region.text.slice(0, offset).match(/\n/gu)?.length ?? 0);
  for (const doc of docs) {
    if (doc.errors.some((e) => e.code === "RESOURCE_EXHAUSTION")) out.push({ kind: UNSCANNABLE_KIND, line: region.startLine });
    const resolve = anchorIndex(doc);
    visit(doc, {
      Pair(_key, pair) {
        if (!isPair(pair) || !isScalar(pair.key) || pair.value === null) return;
        const name = String(pair.key.value);
        if (!KEY_NAME.test(name) || !isSecretName(name)) return;
        const at = pair.value as Node;
        const value = isAlias(at) ? resolve(at) : at;
        if (value && scalarIsLiteral(value) && at.range) out.push({ kind: LITERAL_KIND, line: lineOfOffset(at.range[0]) });
      },
    });
  }
  return out;
}

/** Run both the line scanner and YAML/JSON region parser over `text` (strips invisibles). */
export function findSecrets(text: string): SecretFinding[] {
  const clean = stripInvisible(text);
  const all = [...scanSecrets(clean), ...regions(clean).flatMap(scanParsed)];
  const deduped = new Map<string, SecretFinding>();
  for (const f of all) deduped.set(`${f.line}\u0000${f.kind}`, f);
  return [...deduped.values()].sort((a, b) => a.line - b.line);
}

async function readTextBounded(filePath: string, maxBytes = 1_000_000): Promise<string> {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
  } catch {
    return "";
  }
}

function parseDotenvLine(line: string): { key: string; value: string } | null {
  const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/u.exec(line);
  if (!m) return null;
  const key = m[1]!;
  const rhs = m[2]!;
  const commentAt = rhs.search(/\s#/u);
  const quoted = /^(["'])(.*?)\1/u.exec(rhs);
  const value = quoted ? quoted[2]! : (commentAt === -1 ? rhs : rhs.slice(0, commentAt)).trim();
  return { key, value };
}

/**
 * Collect local credential values on the host machine (`.env*` in `root`,
 * `gh` `hosts.yml`, `GH_TOKEN`/`GITHUB_TOKEN`, and `~/.git-credentials`).
 * Never return or log these raw values outside the host process.
 */
export async function collectLocalSecrets(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<LocalSecret[]> {
  const out: LocalSecret[] = [];
  const xdgConfig = env.XDG_CONFIG_HOME ?? join(home, ".config");
  const ghConfigDir = env.GH_CONFIG_DIR ?? join(xdgConfig, "gh");

  const entries = await readdir(root).catch(() => [] as string[]);
  const envFiles = entries.filter((name) => /^\.env/iu.test(name) && isNeverEditPath(name));
  const envContents = await Promise.all(envFiles.map(async (f) => ({ f, text: await readTextBounded(join(root, f)) })));
  for (const { f, text } of envContents) {
    for (const line of text.split(/\r?\n/u)) {
      const parsed = parseDotenvLine(line);
      if (parsed) out.push({ name: `${parsed.key} in ${f}`, value: parsed.value });
    }
  }

  const hostsYml = await readTextBounded(join(ghConfigDir, "hosts.yml"));
  for (const m of hostsYml.matchAll(/^[ \t]*oauth_token:[ \t]*(\S+)/gmu)) {
    out.push({ name: "gh oauth_token", value: m[1]! });
  }

  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const) {
    const v = env[key];
    if (v) out.push({ name: key, value: v });
  }

  const credTexts = await Promise.all([
    readTextBounded(join(home, ".git-credentials")),
    readTextBounded(join(xdgConfig, "git", "credentials")),
  ]);
  for (const text of credTexts) {
    for (const line of text.split(/\r?\n/u)) {
      const pass = /^\w+:\/\/[^:@/]*:([^@/]+)@/u.exec(line)?.[1];
      if (!pass) continue;
      out.push({ name: "git credential", value: pass });
      try {
        const decoded = decodeURIComponent(pass);
        if (decoded !== pass) out.push({ name: "git credential", value: decoded });
      } catch {
        // Malformed escape; keep raw.
      }
    }
  }

  return out.filter(({ value }) => value.length >= 8 && !/^[A-Za-z_-]+$/u.test(value));
}

/**
 * Returns only the human-readable source name (e.g. `"API_KEY in .env"`) if any
 * collected local secret appears in `text`, or `null`. Never exposes the secret value.
 */
export function findLocalSecretMatch(text: string, localSecrets: readonly LocalSecret[]): string | null {
  const clean = stripInvisible(text);
  for (const s of localSecrets) {
    if (text.includes(s.value) || clean.includes(s.value)) {
      return s.name;
    }
  }
  return null;
}
