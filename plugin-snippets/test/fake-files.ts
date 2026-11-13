// An in-memory `bb.sdk.files` with real sha256 compare-and-swap, for tests.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { FilesPort } from "../src/store.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const enoent = (p: string) => new Error(`ENOENT: no such file or directory, open '${p}'`);

export class FakeFiles implements FilesPort {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];

  constructor(seed: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(seed)) this.files.set(p, c);
  }

  private confine(path: string, rootPath?: string): void {
    if (rootPath && !(path === rootPath || path.startsWith(`${rootPath}/`))) throw new Error(`path escapes root: ${path}`);
  }

  async read({ path, rootPath }: { path: string; rootPath?: string }) {
    this.confine(path, rootPath);
    const content = this.files.get(path);
    if (content === undefined) throw enoent(path);
    return { content, contentEncoding: "utf8" as const, sha256: sha(content), modifiedAtMs: 1_700_000_000_000 };
  }

  async write({ path, rootPath, content, expectedSha256 }: Parameters<FilesPort["write"]>[0]) {
    this.confine(path, rootPath);
    const current = this.files.get(path);
    if (expectedSha256 !== undefined) {
      const currentSha = current === undefined ? null : sha(current);
      if (currentSha !== expectedSha256) return { outcome: "conflict" as const, currentSha256: currentSha };
    }
    this.files.set(path, content);
    this.writes.push(path);
    return { outcome: "written" as const, sha256: sha(content) };
  }

  // Like the host's file finder: recursive, absolute paths.
  async list({ path }: { path: string }) {
    const prefix = `${path}/`;
    const files = [...this.files.keys()].filter((p) => p.startsWith(prefix)).map((p) => ({ name: posix.basename(p), path: p }));
    if (files.length === 0 && ![...this.files.keys()].some((p) => p.startsWith(prefix))) throw enoent(path);
    return { files, truncated: false };
  }

  async remove({ path, rootPath }: { path: string; rootPath?: string }) {
    this.confine(path, rootPath);
    if (!this.files.delete(path)) throw enoent(path);
    return { ok: true as const };
  }
}

export { sha };
