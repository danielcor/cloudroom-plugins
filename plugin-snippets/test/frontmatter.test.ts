import { describe, expect, it } from "vitest";
import { getField, parseFile, serializeFile, setField } from "../src/frontmatter.js";
import { renderFile, toView, withOrder } from "../src/model.js";

const FILE = `---
title: Review this PR
tags: review, git
order: 10
owner: daniel
# a comment kept as written
created: 2026-11-12T09:30:00Z
---
Review {{target}} as a strict senior reviewer.
Focus on {{focus|correctness}}.
`;

describe("frontmatter", () => {
  it("parses flat key: value lines and the body verbatim", () => {
    const p = parseFile(FILE);
    expect(p.hasFrontmatter).toBe(true);
    expect(getField(p.lines, "title")).toBe("Review this PR");
    expect(getField(p.lines, "order")).toBe("10");
    expect(p.body).toBe("Review {{target}} as a strict senior reviewer.\nFocus on {{focus|correctness}}.\n");
  });

  it("round-trips unknown keys and unreadable lines in place", () => {
    const p = parseFile(FILE);
    expect(serializeFile(p.lines, p.body)).toBe(FILE);
    const next = setField(p.lines, "title", "New: title");
    expect(serializeFile(next, p.body)).toContain("title: New: title\ntags: review, git\norder: 10\nowner: daniel\n# a comment kept as written\n");
  });

  it("treats a file without a closed fence as all body", () => {
    expect(parseFile("just text\n")).toEqual({ hasFrontmatter: false, lines: [], body: "just text\n" });
    expect(parseFile("---\ntitle: x\nno close").hasFrontmatter).toBe(false);
    expect(parseFile("---\ntitle: x\n----\nbody").hasFrontmatter).toBe(false);
  });

  it("accepts CRLF, a BOM, an empty head and a fence at end of file", () => {
    expect(parseFile("﻿---\r\ntitle: A\r\n---\r\nline\r\n").body).toBe("line\n");
    expect(parseFile("---\n---\nbody").body).toBe("body");
    expect(parseFile("---\ntitle: T\n---").body).toBe("");
  });

  it("quotes values that would not round-trip and unquotes JSON strings", () => {
    const lines = setField([], "title", ' padded "quote" ');
    const text = serializeFile(lines, "");
    expect(text).toBe('---\ntitle: " padded \\"quote\\" "\n---\n');
    expect(getField(parseFile(text).lines, "title")).toBe(' padded "quote" ');
  });

  it("setField removes a key with undefined", () => {
    const lines = setField(parseFile(FILE).lines, "owner", undefined);
    expect(getField(lines, "owner")).toBeUndefined();
  });
});

describe("snippet files", () => {
  it("reads a snippet view: tags, order, placeholders", () => {
    const v = toView({ id: "review-pr", scope: "global", path: "/g/review-pr.md", content: FILE, sha256: "s", modifiedAtMs: null });
    expect(v).toMatchObject({ title: "Review this PR", tags: ["review", "git"], order: 10, created: "2026-11-12T09:30:00Z", secrets: [], invisible: 0 });
    expect(v.placeholders).toEqual([
      { name: "target", default: null },
      { name: "focus", default: "correctness" },
    ]);
  });

  it("falls back to the id as title and accepts [a, b] tags", () => {
    const v = toView({ id: "x", scope: "project", path: "/p/x.md", content: "---\ntags: [A, b]\norder: nope\n---\nhi", sha256: "s", modifiedAtMs: 5 });
    expect(v).toMatchObject({ title: "x", tags: ["a", "b"], order: null, body: "hi" });
  });

  it("renders a save keeping unknown keys and created, updating updated", () => {
    const out = renderFile(FILE, { title: "T2", tags: [], body: "B" }, { updated: "2026-11-13T00:00:00Z" });
    const p = parseFile(out);
    expect(getField(p.lines, "tags")).toBeUndefined();
    expect(getField(p.lines, "owner")).toBe("daniel");
    expect(getField(p.lines, "created")).toBe("2026-11-12T09:30:00Z");
    expect(getField(p.lines, "updated")).toBe("2026-11-13T00:00:00Z");
    expect(p.body).toBe("B");
  });

  it("withOrder rewrites only the order key", () => {
    const out = withOrder(FILE, 15);
    expect(out).toBe(FILE.replace("order: 10", "order: 15"));
  });
});
