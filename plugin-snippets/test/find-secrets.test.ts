// YAML/JSON parse (Daniel, option C): the strict rule over every map in the body,
// each fenced code block and each indented block. The line scanner still runs.
import { describe, expect, it } from "vitest";
import { findSecrets } from "../src/find-secrets.js";

const find = (body: string) => findSecrets({ title: "t", tags: [], body });
const at = (line: number) => `literal value for a secret-named key on body line ${line}`;

describe("YAML/JSON parse", () => {
  it.each([
    ["S8: a brace inside a multi-line single-quoted string", "note: 'first\n  {\n  last'\npassword:\n  $PASSWORD,literal", 5],
    ["S10: an apostrophe inside a flow mapping", "note: {label: don't}\npassword:\n  $PASSWORD,literal", 3],
    ["an alias to an anchored literal", "base: &pw hunter2\ndb:\n  password: *pw", 3],
    ["the second document", "user: a\n---\npassword: hunter2\n", 3],
    ["a multi-line flow map", "db: {\n  user: app,\n  password:\n    hunter2\n}", 4],
    ["a JSON value after a blank line", '{\n  "token":\n\n  "abc"\n}', 4],
    ["a nested JSON object", '{"db": {"auth": {"api_key": "abc"}}}', 1],
    ["a quoted boolean", 'password: "true"', 1],
    ["a number", "pin_password: 123456", 1],
    ["a fenced YAML block in prose", "Use this config:\n\n```yaml\nnote: 'a\n  {\n  b'\npassword:\n  $PASSWORD,x\n```\n", 8],
    ["an indented code block in prose", "Example:\n\n    note: {label: don't}\n    password:\n      $PASSWORD,x\n\nDone.", 5],
  ])("blocks %s", (_why, body, line) => {
    expect(find(body)).toContain(at(line));
  });

  // Delta review round 1 on d4d4898.
  it.each([
    ["S1 a fence in a blockquote", "> ```yaml\n> password: hunter2\n> ```", 2],
    ["S1 a fence in a nested blockquote", "> > ```\n> > password: hunter2\n> > ```", 2],
    ["S1 a fence on a list item's marker line", "1. ```yaml\n   password: hunter2\n   ```", 2],
    ["S2 a tab-indented block mixed with spaces", 'Example:\n\n\tnote: x\n    "pass\\u0077ord": hunter2', 4],
  ])("blocks %s", (_why, body, line) => {
    expect(find(body)).toContain(at(line));
  });

  it("S3 blocks input too deeply nested to parse, instead of passing it", () => {
    const body = "[".repeat(7000) + '{"pass\\u0077ord":"hunter2"}' + "]".repeat(7000);
    expect(body.length).toBeLessThan(16 * 1024);
    expect(find(body).join(" ")).toContain("nested too deeply to check for secrets");
  });

  it("S4 resolves many aliases without re-walking the document each time", () => {
    const body = "base: &p x\n" + "password: *p\n".repeat(1200);
    const t0 = performance.now();
    const hits = find(body);
    expect(performance.now() - t0).toBeLessThan(400);
    expect(hits).toContain(at(2));
    expect(hits).toContain(at(1201));
  });

  it("reports the body line of a secret inside a multi-line placeholder default", () => {
    // Filling the default keeps every line in place: `password` is on body line 3.
    expect(find("intro\n{{cfg|note: x\npassword: hunter2}}\nend")).toEqual([at(3)]);
    expect(find("intro\n{{cfg|note: x\npassword:\n  hunter2}}\nend")).toEqual([at(4)]);
  });

  it.each([
    "api_token: |\n  ${API_TOKEN}\n",
    "password: true",
    "password:",
    'password: ""',
    "password: {{password}}",
    'password: "{{password}}"',
    "password: ${{ secrets.DB_PASSWORD }}",
    "password:\n  {user: app}",
    "tokens:\n  - a\n  - b",
    '{"password":"$PASSWORD"}',
    '{\n  "password":\n  null,\n  "user": "app"\n}',
    "Remember the password: it must be long.",
    "Note: the token budget is about 128000.",
    "# Title\n\nSome prose.\n\n---\n\nMore prose with a colon: here.",
    "```sh\nexport PASSWORD=$PASSWORD\ncurl -H \"X-API-Key: $API_KEY\" https://x\n```",
    "base: &cfg {user: app}\nprod:\n  <<: *cfg\n  password: ${DB_PASSWORD}",
  ])("keeps clean: %s", (body) => {
    expect(find(body)).toEqual([]);
  });
});
