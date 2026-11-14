// Server-only: the secret scan a save runs, and the scan on load. It joins the
// line scanner (secrets.ts) with a YAML/JSON parse (Daniel, option C): JSON is a
// YAML subset, so every map in the body, in each fenced code block and in each
// indented block is walked, and the strict rule applies to each secret-named key
// whose value is a scalar. The parse only adds findings; the line scanner keeps
// all of its own (shell, header, URL, curl, text that does not parse).
// Not imported by the app, so `yaml` stays out of the app bundle.
import { isAlias, isPair, isScalar, parseAllDocuments, visit, type Document, type Node } from "yaml";
import { fillPlaceholders } from "./placeholders.js";
import { isSecretName, LITERAL_KIND, referenceLiteral, scanSecrets, stripInvisible, type SecretFinding } from "./secrets.js";

/** A region to parse: its text and the body line its first line is on. */
interface Region {
  text: string;
  startLine: number;
}

// A key the strict rule applies to: a plain name, as in the line scanner (not prose with spaces).
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
const FENCE = /^[ \t]*(`{3,}|~{3,})/u;

/** The whole text, each fenced code block's content, and each indented (4+ spaces or tab) block, dedented. */
export function regions(text: string): Region[] {
  const lines = text.split("\n");
  const out: Region[] = [{ text, startLine: 1 }];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]!);
    if (!open) continue;
    const marker = open[1]!;
    let j = i + 1;
    while (j < lines.length && !lines[j]!.trimStart().startsWith(marker)) j++;
    out.push({ text: lines.slice(i + 1, j).join("\n"), startLine: i + 2 });
    i = j;
  }
  const indented = (l: string) => /^(?: {4}|\t)/u.test(l);
  for (let i = 0; i < lines.length; i++) {
    if (!indented(lines[i]!) || lines[i]!.trim() === "" || (i > 0 && lines[i - 1]!.trim() !== "")) continue;
    let j = i;
    while (j < lines.length && (indented(lines[j]!) || lines[j]!.trim() === "")) j++;
    const block = lines.slice(i, j);
    const cut = Math.min(...block.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length));
    out.push({ text: block.map((l) => l.slice(Math.min(cut, l.length - l.trimStart().length))).join("\n"), startLine: i + 1 });
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

/** Findings from a YAML/JSON parse of one region, with body line numbers. */
export function scanParsed(region: Region): SecretFinding[] {
  const out: SecretFinding[] = [];
  let docs: Document.Parsed[];
  try {
    const parsed = parseAllDocuments(region.text, { strict: false, uniqueKeys: false, prettyErrors: false });
    docs = Array.isArray(parsed) ? parsed : [];
  } catch {
    return out;
  }
  const lineOfOffset = (offset: number) => region.startLine + (region.text.slice(0, offset).match(/\n/gu)?.length ?? 0);
  for (const doc of docs) {
    visit(doc, {
      Pair(_key, pair) {
        if (!isPair(pair) || !isScalar(pair.key) || pair.value === null) return;
        const name = String(pair.key.value);
        if (!KEY_NAME.test(name) || !isSecretName(name)) return;
        const at = pair.value as Node;
        const value = isAlias(at) ? at.resolve(doc) : at;
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
