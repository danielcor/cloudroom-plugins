// Snippet storage over `bb.sdk.files`. One Markdown file per snippet; every
// write carries `expectedSha256` (null = must not exist yet), so a file changed
// on disk since the app read it is reported as a conflict, never overwritten.
import { posix } from "node:path";
import { compareOrder, nextOrder, planMove } from "./order.js";
import { findSecrets, stripInvisible } from "./secrets.js";
import {
  LIMITS,
  isValidId,
  renderFile,
  slugify,
  toView,
  uniqueId,
  validateFields,
  withOrder,
  type ReadFile,
  type Scope,
  type SnippetFields,
  type SnippetView,
} from "./model.js";

/** The subset of `bb.sdk.files` the store uses. */
export interface FilesPort {
  read(args: { hostId?: string; path: string; rootPath?: string }): Promise<{
    content: string;
    contentEncoding: "base64" | "utf8";
    sha256: string;
    modifiedAtMs?: number;
  }>;
  write(args: {
    hostId?: string;
    path: string;
    rootPath?: string;
    content: string;
    createParents?: boolean;
    expectedSha256?: string | null;
  }): Promise<{ outcome: "written"; sha256: string } | { outcome: "conflict"; currentSha256: string | null }>;
  list(args: { hostId?: string; path: string; includeHidden?: boolean; limit?: number }): Promise<{
    files: { name: string; path: string }[];
    truncated: boolean;
  }>;
  remove(args: { hostId?: string; path: string; rootPath?: string }): Promise<unknown>;
}

/** Where one scope's files live. */
export interface Location {
  scope: Scope;
  /** Undefined means the machine the Cloudroom server runs on. */
  hostId?: string;
  /** Absolute snippets folder. */
  dir: string;
  /** Project checkout root, for the `.cloudroom/.gitignore` guard. */
  projectRoot?: string;
}

export type WriteOutcome =
  | { outcome: "saved"; snippet: SnippetView; note?: string }
  | { outcome: "blocked"; reasons: string[] }
  | { outcome: "conflict"; current: SnippetView | null; message: string };

const MISSING = /ENOENT|not[ _-]?found|no such file|does not exist|404/iu;

export function isMissing(error: unknown): boolean {
  return MISSING.test(error instanceof Error ? error.message : String(error));
}

const pathOf = (loc: Location, id: string) => posix.join(loc.dir, `${id}.md`);

export class SnippetStore {
  constructor(
    private readonly files: FilesPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(loc: Location, id: string): Promise<ReadFile | null> {
    if (!isValidId(id)) throw new Error(`Invalid snippet id "${id}".`);
    const path = pathOf(loc, id);
    try {
      const r = await this.files.read({ hostId: loc.hostId, path, rootPath: loc.dir });
      const content = r.contentEncoding === "base64" ? Buffer.from(r.content, "base64").toString("utf8") : r.content;
      return { id, scope: loc.scope, path, content, sha256: r.sha256, modifiedAtMs: r.modifiedAtMs ?? null };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** Ids of the `*.md` files directly in the folder; a missing folder is empty. */
  async ids(loc: Location): Promise<string[]> {
    let listed: { name: string; path: string }[];
    try {
      listed = (await this.files.list({ hostId: loc.hostId, path: loc.dir, includeHidden: true, limit: 5000 })).files;
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const ids = new Set<string>();
    for (const f of listed) {
      // The host may answer with absolute or folder-relative paths; keep direct children only.
      const rel = posix.isAbsolute(f.path) ? posix.relative(loc.dir, f.path) : f.path;
      if (rel.includes("/") || !rel.endsWith(".md")) continue;
      const id = rel.slice(0, -3);
      if (isValidId(id)) ids.add(id);
    }
    return [...ids].sort();
  }

  async list(loc: Location): Promise<SnippetView[]> {
    const ids = (await this.ids(loc)).slice(0, LIMITS.perScope);
    const read = await Promise.all(ids.map((id) => this.read(loc, id)));
    return read
      .filter((f): f is ReadFile => f !== null)
      .map(toView)
      .sort(compareOrder);
  }

  async create(
    loc: Location,
    input: SnippetFields,
    opts: { id?: string; order?: number; created?: string } = {},
  ): Promise<WriteOutcome> {
    const fields = clean(input);
    const blocked = check(fields);
    if (blocked) return blocked;
    const existing = await this.list(loc);
    if (existing.length >= LIMITS.perScope) return { outcome: "blocked", reasons: [`This scope already has ${LIMITS.perScope} snippets.`] };
    const taken = new Set(existing.map((s) => s.id));
    let id: string;
    if (opts.id !== undefined) {
      if (!isValidId(opts.id)) return { outcome: "blocked", reasons: [`Invalid snippet id "${opts.id}".`] };
      if (taken.has(opts.id)) return { outcome: "conflict", current: existing.find((s) => s.id === opts.id) ?? null, message: `A snippet named ${opts.id} already exists.` };
      id = opts.id;
    } else id = uniqueId(slugify(fields.title), taken);
    const stamp = this.now().toISOString();
    const content = renderFile(null, fields, { order: opts.order ?? nextOrder(existing), created: opts.created ?? stamp, updated: stamp });
    return this.put(loc, id, content, null);
  }

  async save(loc: Location, id: string, input: SnippetFields, expectedSha256: string): Promise<WriteOutcome> {
    const fields = clean(input);
    const blocked = check(fields);
    if (blocked) return blocked;
    const current = await this.read(loc, id);
    if (current === null) return { outcome: "conflict", current: null, message: "The file was deleted on disk." };
    if (current.sha256 !== expectedSha256) return { outcome: "conflict", current: toView(current), message: "The file changed on disk." };
    const content = renderFile(current.content, fields, { updated: this.now().toISOString() });
    return this.put(loc, id, content, current.sha256);
  }

  async duplicate(loc: Location, id: string): Promise<WriteOutcome> {
    const source = await this.read(loc, id);
    if (source === null) return { outcome: "conflict", current: null, message: "The file was deleted on disk." };
    const view = toView(source);
    const existing = await this.list(loc);
    const copyId = uniqueId(`${id.slice(0, 59).replace(/-+$/u, "")}-copy`, new Set(existing.map((s) => s.id)));
    const title = `${view.title.slice(0, LIMITS.titleMax - 7)} (copy)`;
    return this.create(loc, { title, tags: view.tags, body: view.body }, { id: copyId });
  }

  async remove(loc: Location, id: string, expectedSha256: string): Promise<{ outcome: "removed" } | Extract<WriteOutcome, { outcome: "conflict" }>> {
    const current = await this.read(loc, id);
    if (current === null) return { outcome: "removed" };
    if (current.sha256 !== expectedSha256) return { outcome: "conflict", current: toView(current), message: "The file changed on disk." };
    await this.files.remove({ hostId: loc.hostId, path: pathOf(loc, id), rootPath: loc.dir });
    return { outcome: "removed" };
  }

  /** Move `id` to `toIndex` within its scope. Rewrites only the `order` key. */
  async move(loc: Location, id: string, toIndex: number): Promise<{ outcome: "moved"; writes: number } | Extract<WriteOutcome, { outcome: "conflict" }>> {
    const items = await this.list(loc);
    const writes = planMove(items, id, toIndex);
    for (const w of writes) {
      const item = items.find((i) => i.id === w.id)!;
      const current = await this.read(loc, w.id);
      if (current === null || current.sha256 !== item.sha256) return { outcome: "conflict", current: current && toView(current), message: `${w.id} changed on disk.` };
      const r = await this.files.write({ hostId: loc.hostId, path: current.path, rootPath: loc.dir, content: withOrder(current.content, w.order), expectedSha256: current.sha256 });
      if (r.outcome === "conflict") return { outcome: "conflict", current: null, message: `${w.id} changed on disk.` };
    }
    return { outcome: "moved", writes: writes.length };
  }

  private async put(loc: Location, id: string, content: string, expectedSha256: string | null): Promise<WriteOutcome> {
    const path = pathOf(loc, id);
    const r = await this.files.write({ hostId: loc.hostId, path, rootPath: loc.dir, content, createParents: true, expectedSha256 });
    if (r.outcome === "conflict") {
      const current = await this.read(loc, id);
      return { outcome: "conflict", current: current && toView(current), message: expectedSha256 === null ? `A snippet named ${id} already exists.` : "The file changed on disk." };
    }
    const snippet = toView({ id, scope: loc.scope, path, content, sha256: r.sha256, modifiedAtMs: this.now().getTime() });
    const note = loc.projectRoot ? await this.ensureCommittable(loc) : undefined;
    return note ? { outcome: "saved", snippet, note } : { outcome: "saved", snippet };
  }

  /**
   * Cloudroom writes `.cloudroom/.gitignore` containing `*`, which would keep
   * project snippets out of Git. Re-include `snippets/*.md` when that file
   * exists and does not already do so. Best effort: a failure is reported, not thrown.
   */
  async ensureCommittable(loc: Location): Promise<string | undefined> {
    if (!loc.projectRoot) return undefined;
    const path = posix.join(loc.projectRoot, ".cloudroom", ".gitignore");
    const rootPath = posix.join(loc.projectRoot, ".cloudroom");
    try {
      const r = await this.files.read({ hostId: loc.hostId, path, rootPath });
      const text = r.contentEncoding === "base64" ? Buffer.from(r.content, "base64").toString("utf8") : r.content;
      const lines = text.split(/\r?\n/u).map((l) => l.trim());
      if (!lines.includes("*") || lines.includes("!snippets/")) return undefined;
      const content = `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}!snippets/\n!snippets/*.md\n`;
      const w = await this.files.write({ hostId: loc.hostId, path, rootPath, content, expectedSha256: r.sha256 });
      return w.outcome === "written" ? "Added !snippets/ to .cloudroom/.gitignore so project snippets can be committed." : undefined;
    } catch (error) {
      if (isMissing(error)) return undefined;
      return `Could not check .cloudroom/.gitignore: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

function clean(f: SnippetFields): SnippetFields {
  return {
    title: stripInvisible(f.title).trim(),
    tags: [...new Set(f.tags.map((t) => stripInvisible(t).trim().toLowerCase()).filter(Boolean))],
    body: stripInvisible(f.body).replace(/\r\n?/gu, "\n"),
  };
}

function check(f: SnippetFields): Extract<WriteOutcome, { outcome: "blocked" }> | null {
  const reasons = validateFields(f);
  const secrets = findSecrets(f);
  if (secrets.length) {
    reasons.push(
      `Looks like a secret (${secrets.join("; ")}). ` +
        "Name the environment variable instead of pasting its value; use `room-cli secret request` for real credentials.",
    );
  }
  return reasons.length ? { outcome: "blocked", reasons } : null;
}
