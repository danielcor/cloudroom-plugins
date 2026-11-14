// Final independent review of 118a3ae: two strict-rule bypasses.
import { describe, expect, it } from "vitest";
import { scanSecrets } from "../src/secrets.js";

const LITERAL = "literal value for a secret-named key";
const KEY = ["aB3dE5gH7jK9", "mN1pQ2sT4vW6"].join("");
const kinds = (text: string) => scanSecrets(text).map((f) => `${f.line}:${f.kind}`);

describe("(1) secret-named HTTP headers", () => {
  it.each([
    ["curl -H, double quotes", `curl -H "X-API-Key: ${KEY}" https://api.example.com`, 1],
    ["curl --header, single quotes", `curl --header 'X-Auth-Token: ${KEY}' https://api.example.com`, 1],
    ["curl --header=", `curl --header="Api-Key: ${KEY}" https://x`, 1],
    ["curl -H attached", `curl -H"Private-Token: ${KEY}" https://x`, 1],
    ["a short literal value", 'curl -H "X-API-Key: abc" https://x', 1],
    ["a bare header line", `GET /v1/items\nX-API-Key: ${KEY}`, 2],
    ["a bare header line, other name", `Private-Token: ${KEY}`, 1],
    // Delta review round 1 on 351de14.
    ["S1 a bare header line with a boolean word", "X-API-Key: true", 1],
    ["S1 a bare header line with null", "Private-Token: null", 1],
  ])("blocks %s", (_why, text, line) => {
    expect(kinds(text)).toContain(`${line}:${LITERAL}`);
  });

  it.each([
    'curl -H "X-API-Key: $API_KEY" https://x',
    "curl -H \"X-Auth-Token: ${TOKEN}\" https://x",
    'curl -H "X-API-Key: {{api_key}}" https://x',
    'curl -H "X-API-Key: $(get-key)" https://x',
    'curl -H "Content-Type: application/json" https://x',
    'curl -H "Accept: */*" -H "X-Request-Id: 42" https://x',
    "X-API-Key: $API_KEY",
    'curl -H "X-API-Key:"" $API_KEY" https://x',
    "require_password: true",
  ])("keeps clean: %s", (text) => {
    expect(scanSecrets(text)).toEqual([]);
  });
});

describe("(2) a value on the line after its key", () => {
  it.each([
    ["JSON", `{\n  "password":\n    "${KEY}"\n}`, 3],
    ["JSON with a trailing comma", `{\n  "password":\n  "${KEY}",\n  "user": "app"\n}`, 3],
    ["JSON key after a comma", `{"user": "app", "api_key":\n  "${KEY}"}`, 2],
    ["YAML plain scalar indented below", `db:\n  password:\n    ${KEY}\n`, 3],
    ["YAML plain scalar, short", "password:\n  hunter2", 2],
    ["YAML quoted scalar below", "token:\n  'abc def'", 2],
    ["S2 a comment line between key and value", "password:\n# set by hand\n  hunter2", 3],
    ["S3 a JSON number on the next line, not indented deeper", '{\n  "password":\n  123456\n}', 3],
  ])("blocks %s", (_why, text, line) => {
    expect(kinds(text)).toContain(`${line}:${LITERAL}`);
  });

  it.each([
    "password:\n  $PASSWORD",
    "password:\n  {{password}}",
    'password:\n  ""',
    "password:\nuser: app",
    "db:\n  password:\n  user: app",
    "password:\n  nested: value",
    "tokens:\n  - a\n  - b",
    "password:\n  - one",
    '{\n  "password":\n  "$PASSWORD"\n}',
    'password:\n"user": app',
    "password:\n  # from the vault\n  $PASSWORD",
    '{\n  "password":\n  null,\n  "user": "app"\n}',
    "password:\n  {user: app}",
    "password:\n  [one, two]",
    "password:\n  {{password}}",
  ])("keeps clean: %s", (text) => {
    expect(scanSecrets(text)).toEqual([]);
  });
});
