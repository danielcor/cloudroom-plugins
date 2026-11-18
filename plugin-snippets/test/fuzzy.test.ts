import { describe, expect, it } from "vitest";
import { fuzzyScore, rank } from "../src/fuzzy.js";

const s = (id: string, title: string, tags: string[] = [], body = "") => ({ id, title, tags, body });

describe("fuzzy", () => {
  it("matches subsequences case-insensitively and rejects non-matches", () => {
    expect(fuzzyScore("rvw", "Review")).not.toBeNull();
    expect(fuzzyScore("xyz", "Review")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("prefers a substring, then a word-start substring, then an early one", () => {
    const sub = fuzzyScore("rev", "pre-review")!;
    const scattered = fuzzyScore("rev", "r_e_v")!;
    const wordStart = fuzzyScore("rev", "a review")!;
    const midWord = fuzzyScore("rev", "prevent")!;
    expect(sub).toBeGreaterThan(scattered);
    expect(wordStart).toBeGreaterThan(midWord);
  });

  it("weights title over tags over id over body", () => {
    const items = [s("b1", "Other", [], "mentions deploy"), s("deploy-id", "Other"), s("t", "Other", ["deploy"]), s("x", "Deploy now")];
    expect(rank(items, "deploy").map((i) => i.id)).toEqual(["x", "t", "deploy-id", "b1"]);
  });

  it("requires every word to match some field", () => {
    const items = [s("a", "Review this PR", ["git"]), s("b", "Review docs")];
    expect(rank(items, "rev git").map((i) => i.id)).toEqual(["a"]);
  });

  it("keeps manual order for ties and for an empty query", () => {
    const items = [s("one", "Alpha"), s("two", "Alpha"), s("three", "Alpha")];
    expect(rank(items, "alpha").map((i) => i.id)).toEqual(["one", "two", "three"]);
    expect(rank(items, "  ").map((i) => i.id)).toEqual(["one", "two", "three"]);
  });
});
