// Strict rule for secret-named keys (Daniel, 2026-11-13): any literal value
// assigned to a secret-named key or flag blocks the save, whatever its entropy,
// unless it is a reference ($VAR, ${VAR}, %VAR%, {{x}}) or empty.
import { describe, expect, it } from "vitest";
import { scanSecrets } from "../src/secrets.js";

const LITERAL = "literal value for a secret-named key";
const kinds = (text: string) => scanSecrets(text).map((f) => `${f.line}:${f.kind}`);

describe("strict rule for secret-named keys", () => {
  it.each([
    ["S14: random all-caps word plus a mixed word", "export PASSWORD='DQLXMFRTVZNP aB3dE5gH7jK9'", 1],
    ["guidance written as an assignment (expected under this rule)", 'password: "choose a new one"', 1],
    ["a short password", "password: hunter2", 1],
    ["a low-entropy value", "token = aaaaaaaaaaaaaaaaaaaa", 1],
    ["a flag with a spaced value", "deploy --token aaaaaaaaaaaaaaaaaaaa", 1],
    ["a flag with =", "deploy --password=x", 1],
    ["a numeric PIN", "DB_PASSWORD=1234", 1],
    ["JSON", '{"user": "app", "api_key": "abc"}', 1],
    ["a YAML list item", "accounts:\n  - token: short", 2],
    ["a YAML block of words", "api_token: |\n  plain words here\n", 2],
    ["a shell default", "export API_TOKEN=${API_TOKEN:-dev}", 1],
    ["a quoted reference with a literal suffix", 'export TOKEN="${TOKEN}x"', 1],
  ])("blocks %s", (_why, text, line) => {
    expect(kinds(text)).toContain(`${line}:${LITERAL}`);
  });

  it.each([
    "export PASSWORD=$PASSWORD",
    "export PASSWORD=${PASSWORD}",
    'export PASSWORD="${PASSWORD}"',
    "set PASSWORD=%PASSWORD%",
    "password: {{password}}",
    "run --token {{token}}",
    'password: ""',
    "password: ''",
    "TOKEN=$(gh auth token)",
    "TOKEN=`gh auth token`",
    "password: ${{ secrets.DB_PASSWORD }}",
    "require_password: true",
    "use_token: false",
    "client_secret: null",
    "Remember the password: it must be long.",
    "Use $GITHUB_TOKEN from the environment.",
    "The token budget is large, so keep the prompt short.",
    "deploy --password-file /etc/deploy/pw",
    "deploy --token-count 5",
    "gh auth login --with-token < token.txt",
    "deploy --token --verbose",
    "Note: the token budget is about 128000.",
  ])("keeps clean: %s", (text) => {
    expect(scanSecrets(text)).toEqual([]);
  });
});
