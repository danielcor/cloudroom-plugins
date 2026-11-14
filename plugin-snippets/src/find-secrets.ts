// Server-only: the secret scan a save runs, and the scan on load. It joins the
// line scanner (secrets.ts) with a YAML/JSON parse (Daniel, option C): JSON is a
// YAML subset, so every map in the body, in each fenced code block and in each
// indented block is walked, and the strict rule applies to each secret-named key
// whose value is a scalar. The parse only adds findings; the line scanner keeps
// all of its own (shell, header, URL, curl, text that does not parse).
// Not imported by the app, so `yaml` stays out of the app bundle.
import { isAlias, isNode, isPair, isScalar, parseAllDocuments, visit, type Alias, type Document, type Node } from "yaml";
import { fillPlaceholders } from "./placeholders.js";
import { isSecretName, LITERAL_KIND, referenceLiteral, scanSecrets, stripInvisible, type SecretFinding } from "./secrets.js";

/** A region to parse: its text and the body line its first line is on. */
interface Region {
  text: string;
  startLine: number;
}

// A key the strict rule applies to: a plain name, as in the line scanner (not prose with spaces).
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
// A fence, also on a (nested) list item's marker line (`1. ```yaml`, `- - ```json`).
const FENCE = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)*(`{3,}|~{3,})/u;
// A line inside a blockquote, also after list markers (`> …`, `- > …`).
const QUOTED_LINE = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)*>/u;
// The whole leading container prefix of such a line: every `>` and list marker, in any
// mix and depth (`> - > `). Removing it gives one normalized view of the content.
const CONTAINERS = /^(?:[ \t]*(?:>|(?:[-*+]|\d+[.)])(?=[ \t]))[ \t]*)+/u;
// One quote level, for the intermediate views (searched again, up to MAX_QUOTE_DEPTH).
const ONE_QUOTE = /^[ \t]*>[ \t]?/u;
const MAX_QUOTE_DEPTH = 8;
export const UNSCANNABLE_KIND = "content nested too deeply to check for secrets";

/** Leading tabs as spaces, to Markdown's 4-column tab stops (YAML does not allow tab indentation). */
function expandLeadingTabs(line: string): string {
  const lead = /^[ \t]*/u.exec(line)![0];
  let col = 0;
  for (const ch of lead) col = ch === "\t" ? col + 4 - (col % 4) : col + 1;
  return " ".repeat(col) + line.slice(lead.length);
}

/** Remove the common indentation (in columns) of the non-blank lines. */
function dedent(lines: readonly string[]): string {
  const width = (l: string) => l.length - l.trimStart().length;
  const cut = Math.min(...lines.filter((l) => l.trim() !== "").map(width));
  return lines.map((l) => l.slice(Math.min(cut, width(l)))).join("\n");
}

/**
 * The regions to parse: the whole text, each fenced code block, each indented
 * (4+ columns) block, and for each blockquote run two views, each searched
 * again: all leading quote and list containers removed (any depth and mix,
 * `> - > `), and one `>` level removed (the intermediate structure, to a
 * bounded depth). Leading tabs are expanded.
 */
export function regions(text: string, startLine = 1, depth = 0): Region[] {
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
    // Fully normalized: no container prefix is left, so this view does not recurse further.
    out.push(...regions(run.map((l) => l.replace(CONTAINERS, "")).join("\n"), startLine + i, MAX_QUOTE_DEPTH));
    if (depth < MAX_QUOTE_DEPTH) out.push(...regions(run.map((l) => l.replace(ONE_QUOTE, "")).join("\n"), startLine + i, depth + 1));
    i = j - 1;
  }
  return out;
}

/** The strict rule on a parsed scalar: null and booleans are not literal, block scalars lose their final newlines. */
function scalarIsLiteral(node: Node): boolean {
  if (!isScalar(node)) return false;
  const v = node.value;
  if (v === null || typeof v === "boolean") return false;
  let text = typeof v === "string" ? v : String(v);
  if (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED") text = text.replace(/\n+$/u, "");
  return referenceLiteral(text) !== null;
}

/**
 * The node an alias stands for: the nearest anchor of that name before it. The
 * anchors are indexed once per document (yaml's own `resolve()` walks the whole
 * document for every alias).
 */
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

/** Findings from a YAML/JSON parse of one region, with body line numbers. */
export function scanParsed(region: Region): SecretFinding[] {
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
    // The parser gave up on a part (nesting too deep): that part was not checked, so it may not pass.
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

/** Line scanner plus parse over every region of `text`. */
function scanAll(text: string): SecretFinding[] {
  return [...scanSecrets(text), ...regions(text).flatMap(scanParsed)];
}

/**
 * Scan a snippet's parts and describe each hit in plain words (no values).
 * Scans with invisible characters removed: insert and the CLI strip them, so a
 * token split by a zero-width space must still count. The body is also scanned
 * with every placeholder default filled in, as Insert would leave it when the
 * fields are empty (`--token {{token|VALUE}}`). Filling defaults keeps every
 * line where it is: a default is copied from the body, so each newline in the
 * filled text is a body newline, and a finding's line is its body line either
 * way. Used on create, save and load.
 */
export function findSecrets(parts: { title: string; tags: readonly string[]; body: string }): string[] {
  const scan = (t: string) => scanSecrets(stripInvisible(t));
  const body = stripInvisible(parts.body);
  const bodyHits = [...scanAll(body), ...scanAll(fillPlaceholders(body, {}))]
    .sort((a, b) => a.line - b.line)
    .map((f) => `${f.kind} on body line ${f.line}`);
  return [
    ...scan(parts.title).map((f) => `${f.kind} in the title`),
    ...scan(parts.tags.join(", ")).map((f) => `${f.kind} in the tags`),
    ...new Set(bodyHits),
  ];
}
