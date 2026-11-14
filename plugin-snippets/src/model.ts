import { getField, parseFile, serializeFile, setField, type FrontmatterLine } from "./frontmatter.js";
import { parsePlaceholders, type Placeholder } from "./placeholders.js";
import { findSecrets } from "./find-secrets.js";
import { countInvisible } from "./secrets.js";
import { parseTags } from "./tags.js";

export { parseTags };

export type Scope = "global" | "project";

export const LIMITS = {
  titleMax: 80,
  bodyBytesMax: 16 * 1024,
  tagsMax: 8,
  tagMax: 32,
  perScope: 500,
} as const;

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** One snippet as the app sees it. Everything here is JSON. */
export interface SnippetView {
  id: string;
  scope: Scope;
  title: string;
  tags: string[];
  order: number | null;
  body: string;
  created: string | null;
  updated: string | null;
  modifiedAtMs: number | null;
  /** Content hash of the file as read; the compare-and-swap guard for writes. */
  sha256: string;
  path: string;
  placeholders: Placeholder[];
  /** Secret-shaped hits found when the file was read, in plain words. */
  secrets: string[];
  invisible: number;
  /** A project snippet with the same id hides this global one. */
  shadowed: boolean;
}

export interface SnippetFields {
  title: string;
  tags: string[];
  body: string;
}

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/u, "");
  return s === "" ? "snippet" : s;
}

/** `base`, else `base-2`, `base-3`, … whichever is free. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, 64 - suffix.length).replace(/-+$/u, "")}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

/** Problems that block a save, in plain words. Empty means valid. */
export function validateFields(f: SnippetFields): string[] {
  const problems: string[] = [];
  const title = f.title.trim();
  if (title.length < 1 || title.length > LIMITS.titleMax) problems.push(`Title must be 1 to ${LIMITS.titleMax} characters.`);
  if (/[\n\r]/u.test(f.title)) problems.push("Title must be one line.");
  if (new TextEncoder().encode(f.body).length > LIMITS.bodyBytesMax) problems.push("Body is over 16 KB.");
  if (f.tags.length > LIMITS.tagsMax) problems.push(`At most ${LIMITS.tagsMax} tags.`);
  for (const t of f.tags) {
    if (!/^[a-z0-9][a-z0-9 _.-]*$/u.test(t) || t.length > LIMITS.tagMax) problems.push(`Tag "${t}" must be lowercase letters, digits, space, dot, dash or underscore, up to ${LIMITS.tagMax} characters.`);
  }
  return problems;
}

export interface ReadFile {
  id: string;
  scope: Scope;
  path: string;
  content: string;
  sha256: string;
  modifiedAtMs: number | null;
}

export function toView(file: ReadFile): SnippetView {
  const parsed = parseFile(file.content);
  const title = getField(parsed.lines, "title")?.trim() || file.id;
  const tags = parseTags(getField(parsed.lines, "tags") ?? "");
  const orderRaw = getField(parsed.lines, "order");
  const order = orderRaw !== undefined && /^-?\d+$/u.test(orderRaw.trim()) ? Number(orderRaw) : null;
  return {
    id: file.id,
    scope: file.scope,
    title,
    tags,
    order,
    body: parsed.body,
    created: getField(parsed.lines, "created") ?? null,
    updated: getField(parsed.lines, "updated") ?? null,
    modifiedAtMs: file.modifiedAtMs,
    sha256: file.sha256,
    path: file.path,
    placeholders: parsePlaceholders(parsed.body),
    secrets: findSecrets({ title, tags, body: parsed.body }),
    invisible: countInvisible(`${title}\n${parsed.body}`),
    shadowed: false,
  };
}

/**
 * Render a snippet file. `previous` is the file's current text, whose unknown
 * keys and hand-written lines are kept in place.
 */
export function renderFile(
  previous: string | null,
  fields: SnippetFields,
  meta: { order?: number | null; created?: string; updated: string },
): string {
  let lines: FrontmatterLine[] = previous === null ? [] : parseFile(previous).lines;
  lines = setField(lines, "title", fields.title.trim());
  lines = setField(lines, "tags", fields.tags.length ? fields.tags.join(", ") : undefined);
  if (meta.order !== undefined) lines = setField(lines, "order", meta.order === null ? undefined : String(meta.order));
  if (getField(lines, "created") === undefined) lines = setField(lines, "created", meta.created ?? meta.updated);
  lines = setField(lines, "updated", meta.updated);
  return serializeFile(lines, fields.body);
}

/** Rewrite only the `order` key of an existing file. */
export function withOrder(previous: string, order: number): string {
  const parsed = parseFile(previous);
  return serializeFile(setField(parsed.lines, "order", String(order)), parsed.body);
}
