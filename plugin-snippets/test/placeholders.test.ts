import { describe, expect, it } from "vitest";
import { appendParagraph, prepareInsert } from "../src/compose.js";
import { fillPlaceholders, parsePlaceholders } from "../src/placeholders.js";

describe("placeholders", () => {
  it("lists each name once, in order, with the first default", () => {
    expect(parsePlaceholders("{{a}} {{b|x}} {{a|later}} {{c|}}")).toEqual([
      { name: "a", default: "later" },
      { name: "b", default: "x" },
      { name: "c", default: "" },
    ]);
  });

  it("ignores invalid names and escaped braces", () => {
    expect(parsePlaceholders("{{Bad}} {{1x}} {{ a }} \\{{lit}} {{ok_2}}")).toEqual([{ name: "ok_2", default: null }]);
  });

  it("fills values, then defaults, else leaves the gap visible", () => {
    const body = "Review {{target}} for {{focus|correctness}} and {{other}}. \\{{raw}}";
    expect(fillPlaceholders(body, { target: "PR #128" })).toBe("Review PR #128 for correctness and {{other}}. {{raw}}");
    expect(fillPlaceholders(body, { target: "", focus: "speed", other: "x" })).toBe("Review {{target}} for speed and x. {{raw}}");
  });

  it("uses each occurrence's own default when the field is empty", () => {
    expect(fillPlaceholders("{{a|one}} {{a|two}}", {})).toBe("one two");
    expect(fillPlaceholders("{{a|one}} {{a|two}}", { a: "v" })).toBe("v v");
  });

  it("ignores inherited properties of the values object", () => {
    expect(fillPlaceholders("{{constructor|d}} {{tostring}} {{__proto__}}", {})).toBe("d {{tostring}} {{__proto__}}");
  });

  it("does not re-expand a value that itself looks like a placeholder", () => {
    expect(fillPlaceholders("{{a}} {{b}}", { a: "{{b}}", b: "B" })).toBe("{{b}} B");
  });
});

describe("insert text", () => {
  it("strips invisible characters after filling", () => {
    expect(prepareInsert("a\u200Bb {{x}}", { x: "c\u202Ed" })).toBe("ab cd");
    expect(prepareInsert("a\u061Cb {{x}}", { x: "c\u061Cd" })).toBe("ab cd");
  });

  it("appends as its own paragraph", () => {
    expect(appendParagraph("", "S")).toBe("S");
    expect(appendParagraph("  \n", "S")).toBe("S");
    expect(appendParagraph("Before we merge:  \n", "S")).toBe("Before we merge:\n\nS");
  });
});
