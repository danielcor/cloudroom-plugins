// An in-memory `bb.sdk.files` with real sha256 compare-and-swap, for tests.
// It follows the host daemon (bb-app 0.49.0, host-daemon/dist/daemon-bundle.mjs):
// a `rootPath` must exist, or read/write/remove fail with "Path does not exist:
// <path>" (HTTP 404 through the SDK) before `createParents` is looked at; a
// write whose parent folder is missing needs `createParents`; `mkdir` with
// `recursive` creates every missing folder and accepts an existing one.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { FilesPort } from "../src/store.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const notFound = (p: string) => new Error(`HTTP 404: Path does not exist: ${p}`);

export class FakeFiles implements FilesPort {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>(["/"]);
  readonly writes: string[] = [];
  readonly mkdirs: string[] = [];
  /** Runs once, just before the next remove or move: an edit that lands between a check and the act. */
  beforeNextChange: (() => void | Promise<void>) | null = null;
  /** Also run `beforeNextChange` before a write (off by default: most tests hook the delete). */
  hookWrites = false;

  private async changing(): Promise<void> {
    const hook = this.beforeNextChange;
    this.beforeNextChange = null;
    await hook?.();
  }

  constructor(seed: Record<string, string> = {}, dirs: string[] = []) {
    for (const [p, c] of Object.entries(seed)) {
      this.files.set(p, c);
      this.addDirs(posix.dirname(p));
    }
    for (const d of dirs) this.addDirs(d);
  }

  private addDirs(dir: string): void {
    for (let d = dir; !this.dirs.has(d); d = posix.dirname(d)) this.dirs.add(d);
  }

  private root(path: string, rootPath?: string): void {
    if (rootPath === undefined) return;
    if (!this.dirs.has(rootPath)) throw notFound(path);
    if (!(path === rootPath || path.startsWith(`${rootPath}/`))) throw new Error(`Path "${path}" escapes write root`);
  }

  async read({ path, rootPath }: { path: string; rootPath?: string }) {
    this.root(path, rootPath);
    const content = this.files.get(path);
    if (content === undefined) throw notFound(path);
    return { content, contentEncoding: "utf8" as const, sha256: sha(content), modifiedAtMs: 1_700_000_000_000 };
  }

  async write({ path, rootPath, content, expectedSha256, createParents }: Parameters<FilesPort["write"]>[0]) {
    this.root(path, rootPath);
    if (this.hookWrites) await this.changing();
    if (!this.dirs.has(posix.dirname(path))) {
      if (!createParents) throw notFound(posix.dirname(path));
      this.addDirs(posix.dirname(path));
    }
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
    if (!this.dirs.has(path)) throw notFound(path);
    const prefix = `${path}/`;
    const files = [...this.files.keys()].filter((p) => p.startsWith(prefix)).map((p) => ({ name: posix.basename(p), path: p }));
    return { files, truncated: false };
  }

  async remove({ path, rootPath }: { path: string; rootPath?: string }) {
    this.root(path, rootPath);
    await this.changing();
    if (!this.files.delete(path)) throw notFound(path);
    return { ok: true as const };
  }

  // host.move_path, step for step: lstat refuses an existing destination, then
  // rename(2), which replaces a destination created in between (the hook runs there).
  async move({ sourcePath, destinationPath, rootPath }: { sourcePath: string; destinationPath: string; rootPath?: string }) {
    this.root(sourcePath, rootPath);
    this.root(destinationPath, rootPath);
    if (!this.files.has(sourcePath)) throw notFound(sourcePath);
    if (this.files.has(destinationPath)) throw new Error(`Destination already exists: ${destinationPath}`);
    if (!this.dirs.has(posix.dirname(destinationPath))) throw notFound(destinationPath);
    await this.changing();
    const content = this.files.get(sourcePath)!;
    this.files.delete(sourcePath);
    this.files.set(destinationPath, content);
    return { ok: true as const };
  }

  async mkdir({ path, recursive }: { path: string; recursive?: boolean }) {
    if (!recursive && !this.dirs.has(posix.dirname(path))) throw notFound(path);
    this.addDirs(path);
    this.mkdirs.push(path);
    return { ok: true as const };
  }
}

export { sha };
