import { describe, expect, it } from "vitest";
import { SnippetStore, type Location } from "../src/store.js";
import { FakeFiles, sha } from "./fake-files.js";

const G: Location = { scope: "global", dir: "/home/d/skills/.snippets" };
const P: Location = { scope: "project", hostId: "h1", dir: "/repo/.snippets" };
const now = () => new Date("2026-11-13T10:00:00Z");
const file = (title: string, order: number | null, body = "body") => `---\ntitle: ${title}\n${order === null ? "" : `order: ${order}\n`}---\n${body}`;

function setup(seed: Record<string, string> = {}) {
  const files = new FakeFiles(seed);
  return { files, store: new SnippetStore(files, now) };
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

  it("blocks invalid fields", async () => {
    const r = await setup().store.create(G, { title: " ", tags: ["UPPER!"], body: "x".repeat(17 * 1024) });
    expect(r.outcome === "blocked" && r.reasons.length).toBe(3);
  });

  it("strips invisible characters on save", async () => {
    const { store } = setup();
    const r = await store.create(G, { title: "T​", tags: [], body: "a‮b" });
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

  it("removes with a hash check; Undo re-creates the same file name and order", async () => {
    const path = `${G.dir}/x.md`;
    const content = "---\ntitle: X\norder: 30\ncreated: 2026-01-01T00:00:00Z\n---\nbody";
    const { store, files } = setup({ [path]: content });
    expect(await store.remove(G, "x", "stale")).toMatchObject({ outcome: "conflict" });
    expect(await store.remove(G, "x", sha(content))).toEqual({ outcome: "removed" });
    expect(files.files.has(path)).toBe(false);
    const undo = await store.create(G, { title: "X", tags: [], body: "body" }, { id: "x", order: 30, created: "2026-01-01T00:00:00Z" });
    expect(undo).toMatchObject({ outcome: "saved", snippet: { id: "x", order: 30, created: "2026-01-01T00:00:00Z" } });
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

  it("a project save writes only the snippet file, never a .gitignore", async () => {
    const { store, files } = setup({ "/repo/.cloudroom/.gitignore": "*\n" });
    expect(await store.create(P, { title: "Worker brief", tags: [], body: "x" })).toMatchObject({ outcome: "saved", snippet: { path: "/repo/.snippets/worker-brief.md" } });
    expect(files.writes).toEqual(["/repo/.snippets/worker-brief.md"]);
    expect(files.files.get("/repo/.cloudroom/.gitignore")).toBe("*\n");
  });
});
