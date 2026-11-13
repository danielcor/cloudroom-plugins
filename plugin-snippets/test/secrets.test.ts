import { describe, expect, it } from "vitest";
import { countInvisible, findSecrets, markInvisible, scanSecrets, stripInvisible } from "../src/secrets.js";

// Built at runtime so this file holds no secret-shaped literal.
const fake = (prefix: string, n: number, alphabet = "aB3dE5gH7jK9mN1pQ2sT4vW6xY8z") =>
  prefix + Array.from({ length: n }, (_, i) => alphabet[(i * 5) % alphabet.length]).join("");

describe("secret scan", () => {
  it.each([
    ["private key block", `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`],
    ["AWS access key id", fake("AKIA", 16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")],
    ["GitHub token", fake("ghp_", 36)],
    ["API key (sk-…)", fake("sk-ant-", 40)],
    ["Slack token", fake("xoxb-", 24)],
    ["Google API key", fake("AIza", 35)],
    ["JSON Web Token", `${fake("eyJ", 20)}.${fake("eyJ", 20)}.${fake("", 20)}`],
    ["bearer token", `Authorization: Bearer ${fake("", 32)}`],
    ["secret-looking value", `api_key = "${fake("", 32)}"`],
  ])("flags %s", (kind, text) => {
    expect(scanSecrets(`line one\n${text}`)).toContainEqual({ kind, line: 2 });
  });

  it.each([
    "Use $GITHUB_TOKEN from the environment.",
    "password: {{password}}",
    "token = aaaaaaaaaaaaaaaaaaaa",
    "Ask for the sk- key with room-cli secret request.",
    "Review {{target}} as a strict senior reviewer.",
  ])("does not flag %s", (text) => {
    expect(scanSecrets(text)).toEqual([]);
  });

  it("catches a token split by invisible characters, which insert would join", () => {
    const token = fake("ghp_", 36);
    const split = `${token.slice(0, 10)}\u200B${token.slice(10)}`;
    expect(scanSecrets(split)).toEqual([]);
    expect(findSecrets({ title: "ok", tags: [], body: split })).toEqual(["GitHub token on body line 1"]);
  });

  it("describes where, never the value", () => {
    const token = fake("ghp_", 36);
    const out = findSecrets({ title: "ok", tags: [], body: `a\n${token}` });
    expect(out).toEqual(["GitHub token on body line 2"]);
    expect(out.join()).not.toContain(token);
    expect(findSecrets({ title: token, tags: [], body: "" })).toEqual(["GitHub token in the title"]);
  });
});

describe("invisible characters", () => {
  const sneaky = "ok​ ‮evil‬ \u{E0041}﻿";
  it("counts, strips and marks zero-width, bidi, tag and BOM characters", () => {
    expect(countInvisible(sneaky)).toBe(5);
    expect(stripInvisible(sneaky)).toBe("ok evil ");
    expect(markInvisible("a​b")).toBe("a⟦U+200B⟧b");
    expect(markInvisible("\u{E0041}")).toBe("⟦U+E0041⟧");
  });

  it("leaves ordinary text and emoji alone", () => {
    expect(stripInvisible("héllo — 👍 {{x}}")).toBe("héllo — 👍 {{x}}");
  });
});
