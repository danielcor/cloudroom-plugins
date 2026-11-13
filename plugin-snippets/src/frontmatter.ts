// A strict flat frontmatter subset: `key: value` lines between `---` fences,
// no nesting, no YAML dependency. Unknown keys and lines we cannot read are
// kept in order so a save never drops what a person wrote by hand.

export type FrontmatterLine =
  | { kind: "field"; key: string; value: string }
  | { kind: "raw"; text: string };

export interface ParsedFile {
  /** True when the file opened with a `---` fence that was closed. */
  hasFrontmatter: boolean;
  lines: FrontmatterLine[];
  body: string;
}

const KEY = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/;

export function parseFile(raw: string): ParsedFile {
  const text = raw.replace(/^﻿/u, "").replace(/\r\n?/gu, "\n");
  if (!text.startsWith("---\n")) return { hasFrontmatter: false, lines: [], body: text };
  const end = text.indexOf("\n---", 3);
  // The closing fence must be a whole line: `---` then newline or end of file.
  let close = end;
  while (close !== -1) {
    const after = text.charAt(close + 4);
    if (after === "\n" || after === "") break;
    close = text.indexOf("\n---", close + 1);
  }
  if (close === -1) return { hasFrontmatter: false, lines: [], body: text };
  const head = text.slice(4, close);
  const rest = text.slice(close + 4);
  const body = rest.startsWith("\n") ? rest.slice(1) : rest;
  const lines: FrontmatterLine[] = [];
  for (const line of head === "" ? [] : head.split("\n")) {
    const m = KEY.exec(line);
    if (m) lines.push({ kind: "field", key: m[1]!, value: unquote((m[2] ?? "").trim()) });
    else lines.push({ kind: "raw", text: line });
  }
  return { hasFrontmatter: true, lines, body };
}

export function serializeFile(lines: readonly FrontmatterLine[], body: string): string {
  const head = lines.map((l) => (l.kind === "field" ? `${l.key}: ${quote(l.value)}` : l.text));
  return `---\n${head.join("\n")}${head.length ? "\n" : ""}---\n${body}`;
}

export function getField(lines: readonly FrontmatterLine[], key: string): string | undefined {
  for (const l of lines) if (l.kind === "field" && l.key === key) return l.value;
  return undefined;
}

/** Set (or with `undefined`, remove) a key, keeping its position when it exists. */
export function setField(lines: readonly FrontmatterLine[], key: string, value: string | undefined): FrontmatterLine[] {
  const out: FrontmatterLine[] = [];
  let done = false;
  for (const l of lines) {
    if (l.kind === "field" && l.key === key) {
      if (!done && value !== undefined) out.push({ kind: "field", key, value });
      done = true;
    } else out.push(l);
  }
  if (!done && value !== undefined) out.push({ kind: "field", key, value });
  return out;
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not JSON: keep the text as written.
    }
  }
  return v;
}

function quote(v: string): string {
  // Values are single-line by construction; quote only when a bare value would not round-trip.
  if (v !== v.trim() || v.startsWith('"') || /[\n\r]/u.test(v)) return JSON.stringify(v);
  return v;
}
