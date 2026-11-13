import { describe, expect, it } from "vitest";
import { SnippetStore, type Location } from "../src/store.js";
import { FakeFiles, sha } from "./fake-files.js";

const G: Location = { scope: "global", dir: "/home/d/skills/.snippets" };
const P: Location = { scope: "project", hostId: "h1", dir: "/repo/.snippets" };
const now = () => new Date("2026-11-13T10:00:00Z");
const file = (title: string, order: number | null, body = "body") => `---\ntitle: ${title}\n${order === null ? "" : `order: ${order}\n`}---\n${body}`;

// Deterministic per-delete suffixes: 00000001, 00000002, ...
const counter = () => {
  let n = 0;
  return () => (++n).toString(16).padStart(8, "0");
};
const T1 = "x~20261113T100000000Z-00000001.md";

function setup(seed: Record<string, string> = {}) {
  const files = new FakeFiles(seed);
  return { files, store: new SnippetStore(files, now, counter()) };
}

describe("SnippetStore", () => {
  it("lists only valid *.md files directly in the folder, in manual order", async () => {
    const { store } = setup({
      [`${G.dir}/b.md`]: file("B", 20),
      [`${G.dir}/a.md`]: file("A", 30),
      [`${G.dir}/c.md`]: file("C", 10),
      [`${G.dir}/notes.txt`]: "x",
      [`${G.dir}/Bad Name.md`]: "x",
      [`${G.dir}/sub/d.md`]: file("D", 1),
    });
    expect((await store.list(G)).map((s) => s.id)).toEqual(["c", "b", "a"]);
  });

  it("treats a missing folder as empty", async () => {
    expect(await setup().store.list(G)).toEqual([]);
  });

  it("creates with a slug id, the next order and timestamps; never clobbers", async () => {
    const { store, files } = setup({ [`${G.dir}/review-this-pr.md`]: file("Old", 10) });
    const r = await store.create(G, { title: "Review this PR", tags: ["Review", "git"], body: "Hi {{x}}" });
    expect(r).toMatchObject({ outcome: "saved", snippet: { id: "review-this-pr-2", order: 20, tags: ["review", "git"], created: "2026-11-13T10:00:00.000Z" } });
    expect(files.files.get(`${G.dir}/review-this-pr-2.md`)).toBe(
      "---\ntitle: Review this PR\ntags: review, git\norder: 20\ncreated: 2026-11-13T10:00:00.000Z\nupdated: 2026-11-13T10:00:00.000Z\n---\nHi {{x}}",
    );
    const again = await store.create(G, { title: "x", tags: [], body: "" }, { id: "review-this-pr" });
    expect(again).toMatchObject({ outcome: "conflict" });
    expect(files.files.get(`${G.dir}/review-this-pr.md`)).toBe(file("Old", 10));
  });

  it("blocks a save that holds a secret and writes nothing", async () => {
    const { store, files } = setup();
    const token = ["ghp", "_", "aB3dE5gH7jK9mN1pQ2sT4vW6xY8zaB3dE5gH7j"].join("");
    const r = await store.create(G, { title: "Deploy", tags: [], body: `use ${token}` });
    expect(r.outcome).toBe("blocked");
    expect(r.outcome === "blocked" && r.reasons[0]).toContain("GitHub token on body line 1");
    expect(r.outcome === "blocked" && r.reasons.join()).not.toContain(token);
    expect(files.writes).toEqual([]);
  });

  it("blocks a save with a CLI-style secret flag", async () => {
    const { store, files } = setup();
    const value = ["aB3dE5gH7jK9mN1p", "Q2sT4vW6xY8zaB3d"].join("");
    for (const flag of ["--token", "--password", "--api-key", "--access-key", "-token"]) {
      const r = await store.create(G, { title: "Deploy", tags: [], body: `run ${flag}=${value}` });
      expect(r.outcome, flag).toBe("blocked");
    }
    expect(files.writes).toEqual([]);
  });

  it("blocks a save with a secret after a flag and a space, quoted or not", async () => {
    const { store, files } = setup();
    const value = ["aB3dE5gH7jK9mN1p", "Q2sT4vW6xY8zaB3d"].join("");
    for (const arg of [`--token ${value}`, `--api-key "${value}"`, `--password '${value}'`, `-token ${value}`, `--verbose --registry-password ${value}`, `--dry-run --token "${value}"`]) {
      const r = await store.create(G, { title: "Deploy", tags: [], body: `run ${arg}` });
      expect(r.outcome, arg).toBe("blocked");
    }
    expect(files.writes).toEqual([]);
    expect(await store.create(G, { title: "Count", tags: [], body: "run --token-count 5 --password-file /etc/pw" })).toMatchObject({ outcome: "saved" });
  });

  it("blocks invalid fields", async () => {
    const r = await setup().store.create(G, { title: " ", tags: ["UPPER!"], body: "x".repeat(17 * 1024) });
    expect(r.outcome === "blocked" && r.reasons.length).toBe(3);
  });

  it("strips invisible characters on save", async () => {
    const { store } = setup();
    const r = await store.create(G, { title: "T\u200B", tags: [], body: "a\u202Eb" });
    expect(r.outcome === "saved" && [r.snippet.title, r.snippet.body]).toEqual(["T", "ab"]);
  });

  it("saves with compare-and-swap and keeps unknown keys", async () => {
    const path = `${G.dir}/x.md`;
    const original = "---\ntitle: X\nowner: d\norder: 10\n---\nold";
    const { store, files } = setup({ [path]: original });
    const r = await store.save(G, "x", { title: "X2", tags: [], body: "new" }, sha(original));
    expect(r.outcome).toBe("saved");
    expect(files.files.get(path)).toBe("---\ntitle: X2\nowner: d\norder: 10\ncreated: 2026-11-13T10:00:00.000Z\nupdated: 2026-11-13T10:00:00.000Z\n---\nnew");
  });

  it("reports a conflict when the file changed on disk, and keeps it", async () => {
    const path = `${G.dir}/x.md`;
    const { store, files } = setup({ [path]: file("Hand edited", 10) });
    const r = await store.save(G, "x", { title: "Mine", tags: [], body: "mine" }, sha(file("X", 10)));
    expect(r).toMatchObject({ outcome: "conflict", current: { title: "Hand edited" } });
    expect(files.files.get(path)).toBe(file("Hand edited", 10));
    files.files.delete(path);
    expect(await store.save(G, "x", { title: "Mine", tags: [], body: "" }, "any")).toMatchObject({ outcome: "conflict", current: null });
  });

  it("duplicates as <id>-copy, then <id>-copy-2", async () => {
    const { store } = setup({ [`${G.dir}/x.md`]: "---\ntitle: X\ntags: a\norder: 10\n---\nbody" });
    expect(await store.duplicate(G, "x")).toMatchObject({ outcome: "saved", snippet: { id: "x-copy", title: "X (copy)", tags: ["a"], body: "body", order: 20 } });
    expect(await store.duplicate(G, "x")).toMatchObject({ snippet: { id: "x-copy-2" } });
  });

  it("deletes into .trash, hides it from the list, and Undo restores the exact bytes", async () => {
    const path = `${G.dir}/x.md`;
    // Unknown keys, a comment and an odd body: none of it may change across delete and Undo.
    const content = "---\ntitle: X\nowner: d\n# hand note\norder: 30\n---\nbody  \n\n";
    const { store, files } = setup({ [path]: content, [`${G.dir}/y.md`]: "---\ntitle: Y\n---\n" });
    expect(await store.remove(G, "x", "stale")).toMatchObject({ outcome: "conflict" });
    expect(files.files.get(path)).toBe(content);
    const r = await store.remove(G, "x", sha(content));
    expect(r).toEqual({ outcome: "removed", trash: T1 });
    expect(files.files.has(path)).toBe(false);
    expect(files.files.get(`${G.dir}/.trash/${T1}`)).toBe(content);
    expect(files.files.get(`${G.dir}/.trash/.gitignore`)).toBe("*\n");
    expect((await store.list(G)).map((s) => s.id)).toEqual(["y"]);
    expect(await store.restore(G, "x", T1)).toEqual({ outcome: "restored" });
    expect(files.files.get(path)).toBe(content);
    // The trash copy stays: Undo writes, it never renames or removes.
    expect(files.files.get(`${G.dir}/.trash/${T1}`)).toBe(content);
    expect((await store.list(G)).map((s) => s.id)).toEqual(["x", "y"]);
  });

  it("Undo restores a snippet the secret scan flags, without scanning it", async () => {
    const token = ["ghp", "_", "aB3dE5gH7jK9mN1pQ2sT4vW6xY8zaB3dE5gH7j"].join("");
    const path = `${G.dir}/leak.md`;
    const content = `---\ntitle: Leak\n---\n${token}`;
    const { store, files } = setup({ [path]: content });
    const r = await store.remove(G, "leak", sha(content));
    expect(await store.restore(G, "leak", r.outcome === "removed" ? r.trash! : "")).toEqual({ outcome: "restored" });
    expect(files.files.get(path)).toBe(content);
  });

  it("Undo refuses to overwrite a snippet created again meanwhile, and keeps the trashed one", async () => {
    const path = `${G.dir}/x.md`;
    const content = "---\ntitle: X\n---\nold";
    const { store, files } = setup({ [path]: content });
    const r = await store.remove(G, "x", sha(content));
    files.files.set(path, "---\ntitle: X\n---\nnew");
    expect(await store.restore(G, "x", r.outcome === "removed" ? r.trash! : "")).toMatchObject({ outcome: "conflict" });
    expect(files.files.get(path)).toBe("---\ntitle: X\n---\nnew");
    expect(files.files.get(`${G.dir}/.trash/${T1}`)).toBe(content);
  });

  it("Undo never replaces a snippet created after its existence check", async () => {
    const path = `${G.dir}/x.md`;
    const content = "---\ntitle: X\n---\nold";
    const { store, files } = setup({ [path]: content });
    const r = await store.remove(G, "x", sha(content));
    // Created after restore's check, right before it puts the bytes back.
    files.hookWrites = true;
    files.beforeNextChange = () => {
      files.files.set(path, "created meanwhile");
    };
    expect(await store.restore(G, "x", r.outcome === "removed" ? r.trash! : "")).toMatchObject({ outcome: "conflict" });
    expect(files.files.get(path)).toBe("created meanwhile");
    expect(files.files.get(`${G.dir}/.trash/${T1}`)).toBe(content);
  });

  it("two deletes of one id in the same millisecond keep both archives", async () => {
    const path = `${G.dir}/x.md`;
    const content = "---\ntitle: X\n---\nfirst";
    const { store, files } = setup({ [path]: content });
    const r1 = await store.remove(G, "x", sha(content));
    expect(await store.restore(G, "x", r1.outcome === "removed" ? r1.trash! : "")).toEqual({ outcome: "restored" });
    const r2 = await store.remove(G, "x", sha(content));
    expect(r2.outcome).toBe("removed");
    const names = [r1, r2].map((r) => (r.outcome === "removed" ? r.trash : null));
    expect(new Set(names).size).toBe(2);
    for (const n of names) expect(files.files.get(`${G.dir}/.trash/${n}`)).toBe(content);
  });

  it("overlapping deletes with identical timestamps never overwrite each other's archive", async () => {
    const path = `${G.dir}/x.md`;
    const original = "---\ntitle: X\n---\noriginal";
    const { store, files } = setup({ [path]: original });
    let second: Awaited<ReturnType<typeof store.remove>> | null = null;
    // Between the first delete's destination check and its rename (the host's lstat/rename gap):
    // a second delete archives x, then someone writes a new x.
    files.beforeNextChange = async () => {
      second = await store.remove(G, "x", sha(original));
      files.files.set(path, "---\ntitle: X\n---\nnewer");
    };
    const first = await store.remove(G, "x", sha(original));
    expect(second).toMatchObject({ outcome: "removed" });
    expect(first).toMatchObject({ outcome: "conflict" });
    const archived = [...files.files.entries()].filter(([p]) => p.startsWith(`${G.dir}/.trash/x~`)).map(([, c]) => c);
    // The original bytes survive in the trash, and the newer file is back in place.
    expect(archived).toContain(original);
    expect(files.files.get(path)).toBe("---\ntitle: X\n---\nnewer");
  });

  it("adds the * rule to an existing .trash/.gitignore that lacks it", async () => {
    const path = `${G.dir}/x.md`;
    const content = "---\ntitle: X\n---\nbody";
    const { store, files } = setup({ [path]: content, [`${G.dir}/.trash/.gitignore`]: "# deleted snippets\n" });
    expect(await store.remove(G, "x", sha(content))).toMatchObject({ outcome: "removed" });
    expect(files.files.get(`${G.dir}/.trash/.gitignore`)).toBe("# deleted snippets\n*\n");
  });

  it.each([
    ["a leading space (Git keeps it, so it is another pattern)", " *\n"],
    ["a later negation that wins", "*\n!*.md\n"],
    ["a trailing tab (Git keeps tabs, unlike spaces)", "*\t\n"],
  ])("appends a final * when the existing rule has %s", async (_why, existing) => {
    const path = `${G.dir}/x.md`;
    const content = "---\ntitle: X\n---\nbody";
    const { store, files } = setup({ [path]: content, [`${G.dir}/.trash/.gitignore`]: existing });
    expect(await store.remove(G, "x", sha(content))).toMatchObject({ outcome: "removed" });
    expect(files.files.get(`${G.dir}/.trash/.gitignore`)).toBe(`${existing}*\n`);
  });

  it("leaves a .trash/.gitignore alone when its last rule is already a bare *", async () => {
    const path = `${G.dir}/x.md`;
    const content = "---\ntitle: X\n---\nbody";
    const existing = "!keep.md\n*  \n# trailing comment\n\n";
    const { store, files } = setup({ [path]: content, [`${G.dir}/.trash/.gitignore`]: existing });
    expect(await store.remove(G, "x", sha(content))).toMatchObject({ outcome: "removed" });
    expect(files.files.get(`${G.dir}/.trash/.gitignore`)).toBe(existing);
  });

  it("does not delete when it cannot make .trash ignored by Git", async () => {
    const path = `${G.dir}/x.md`;
    const content = "---\ntitle: X\n---\nbody";
    const { store, files } = setup({ [path]: content, [`${G.dir}/.trash/.gitignore`]: "# deleted snippets\n" });
    files.hookWrites = true;
    // The .gitignore changes between the store's read and its CAS write.
    files.beforeNextChange = () => void files.files.set(`${G.dir}/.trash/.gitignore`, "# edited\n");
    expect(await store.remove(G, "x", sha(content))).toMatchObject({ outcome: "conflict" });
    expect(files.files.get(path)).toBe(content);
    expect([...files.files.keys()].filter((p) => p.includes(".trash/x~"))).toEqual([]);
  });

  it("Undo rejects a trash name for another id or outside the trash pattern", async () => {
    const { store } = setup();
    await expect(store.restore(G, "x", "y~20261113T100000000Z-00000001.md")).rejects.toThrow("Invalid trash entry");
    await expect(store.restore(G, "x", "../x.md")).rejects.toThrow("Invalid trash entry");
  });

  it("keeps an edit that lands between the delete's hash check and the delete", async () => {
    const path = `${G.dir}/x.md`;
    const content = "---\ntitle: X\n---\nbody";
    const { store, files } = setup({ [path]: content });
    files.beforeNextChange = () => {
      files.files.set(path, "---\ntitle: X\n---\nedited meanwhile");
    };
    const r = await store.remove(G, "x", sha(content));
    expect(r.outcome).toBe("conflict");
    expect(files.files.get(path)).toBe("---\ntitle: X\n---\nedited meanwhile");
  });

  it("keeps an edit that cannot be moved back in .trash and says where", async () => {
    const path = `${G.dir}/x.md`;
    const content = "---\ntitle: X\n---\nbody";
    const { store, files } = setup({ [path]: content });
    files.beforeNextChange = () => {
      files.files.set(path, "---\ntitle: X\n---\nedited meanwhile");
    };
    const realWrite = files.write.bind(files);
    files.write = async (a) => {
      // Putting it back fails: someone created x.md again right before that write.
      if (a.path === path) files.files.set(path, "recreated");
      return realWrite(a);
    };
    const r = await store.remove(G, "x", sha(content));
    expect(r).toMatchObject({ outcome: "conflict", message: expect.stringContaining(`.trash/${T1}`) });
    expect(files.files.get(path)).toBe("recreated");
    expect(files.files.get(`${G.dir}/.trash/${T1}`)).toBe("---\ntitle: X\n---\nedited meanwhile");
  });

  it("moves by rewriting only the order key of the moved file", async () => {
    const { store, files } = setup({
      [`${G.dir}/a.md`]: file("A", 10),
      [`${G.dir}/b.md`]: file("B", 20),
      [`${G.dir}/c.md`]: file("C", 30),
    });
    expect(await store.move(G, "c", 0)).toEqual({ outcome: "moved", writes: 1 });
    expect(files.writes).toEqual([`${G.dir}/c.md`]);
    expect(files.files.get(`${G.dir}/c.md`)).toBe(file("C", 0));
    expect((await store.list(G)).map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("refuses ids that could escape the folder", async () => {
    await expect(setup().store.read(G, "../etc/passwd")).rejects.toThrow("Invalid snippet id");
  });

  it("the fake host refuses a write into a missing folder, like the real one", async () => {
    const files = new FakeFiles({}, ["/repo"]);
    await expect(files.write({ path: "/repo/.snippets/x.md", rootPath: "/repo/.snippets", content: "", createParents: true, expectedSha256: null })).rejects.toThrow(
      "HTTP 404: Path does not exist: /repo/.snippets/x.md",
    );
  });

  it("creates the folder on the first create, project and global", async () => {
    const files = new FakeFiles({}, ["/repo", "/home/d/skills"]);
    const store = new SnippetStore(files, now);
    expect(await store.list(P)).toEqual([]);
    expect(await store.create(P, { title: "New snippet", tags: [], body: "" })).toMatchObject({ outcome: "saved", snippet: { path: "/repo/.snippets/new-snippet.md" } });
    expect(await store.create(G, { title: "New snippet", tags: [], body: "" })).toMatchObject({ outcome: "saved", snippet: { path: "/home/d/skills/.snippets/new-snippet.md" } });
    expect(files.mkdirs).toEqual(["/repo/.snippets", "/home/d/skills/.snippets"]);
    // A second create into the now-existing folder still works (recursive mkdir accepts it).
    expect(await store.create(P, { title: "New snippet", tags: [], body: "" })).toMatchObject({ outcome: "saved", snippet: { id: "new-snippet-2" } });
  });

  it("a project save writes only the snippet file, never a .gitignore", async () => {
    const { store, files } = setup({ "/repo/.cloudroom/.gitignore": "*\n" });
    expect(await store.create(P, { title: "Worker brief", tags: [], body: "x" })).toMatchObject({ outcome: "saved", snippet: { path: "/repo/.snippets/worker-brief.md" } });
    expect(files.writes).toEqual(["/repo/.snippets/worker-brief.md"]);
    expect(files.files.get("/repo/.cloudroom/.gitignore")).toBe("*\n");
  });
});
