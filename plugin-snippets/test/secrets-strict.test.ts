// Strict rule for secret-named keys (Daniel, 2026-11-13): any literal value
// assigned to a secret-named key or flag blocks the save, whatever its entropy,
// unless it is a reference ($VAR, ${VAR}, %VAR%, {{x}}) or empty.
import { describe, expect, it } from "vitest";
import { scanSecrets } from "../src/secrets.js";

const LITERAL = "literal value for a secret-named key";
const kinds = (text: string) => scanSecrets(text).map((f) => `${f.line}:${f.kind}`);

describe("strict rule for secret-named keys", () => {
  it.each([
    ["URL userinfo with a command substitution", "git clone https://user:$(hunter2)@example.com/r.git"],
    ["curl credentials with a command substitution", "curl -u 'user:$(hunter2)' https://example.com"],
    ["S6 curl credentials with an escaped dollar", 'curl -u "admin:\\$hunter2" https://example.com'],
  ])("S2 keeps URL and curl checks without a runtime exemption: %s", (_why, text) => {
    expect(scanSecrets(text)).not.toEqual([]);
  });

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
    // Delta review round 1 on 82c5a84.
    ["S1 a boolean word after = is a literal string", "PASSWORD=true", 1],
    ["S1 a boolean word after a flag", "deploy --password no", 1],
    ["S1 a quoted null", 'password: "null"', 1],
    ["S1 block text that says true", "api_token: |\n  true\n", 2],
    ["S2 a literal after a command substitution", 'TOKEN="$(echo)hunter2"', 1],
    ["S2 a literal after a placeholder", 'password: "{{x}}hunter2"', 1],
    ["S3 a nested YAML sequence", "- - password: aB3dE5gH7jK9mN1pQ2sT4vW6x", 1],
    ["S4 a literal after an empty quoted segment", 'PASSWORD=""hunter2', 1],
    ["S4 a literal after a quoted reference", 'PASSWORD="$PASSWORD"hunter2', 1],
    ["S5 quoted whitespace", 'password: "   "', 1],
    // Delta review round 2 on 483e5c1.
    ["S1 a YAML scalar that only starts with true", "password: true hunter2", 1],
    ["S1 a JSON-ish line value with a comment", 'password: "x" # set by hand', 1],
    ["S2 single quotes: command text is literal", "PASSWORD='$(echo hunter2)'", 1],
    ["S2 single quotes: a reference is literal text in the shell", "PASSWORD='$PASSWORD'", 1],
    ["S2 a command in a YAML value is not run", "password: $(cat pw)", 1],
    ["S6 an escaped dollar in double quotes", 'PASSWORD="\\$hunter2"', 1],
    ["S6 an escaped dollar unquoted", "PASSWORD=\\$hunter2", 1],
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
    "TOKEN=$(gh auth token) deploy",
    'TOKEN="$(gh auth token)"',
    "password: ${{ secrets.DB_PASSWORD }} # from CI",
    "- - password: $PASSWORD",
    'PASSWORD="$PASSWORD"',
    "PASSWORD=$PASSWORD;echo ok",
    '{"password":"$PASSWORD"}',
    '{"password":""}',
    '{"user": "app", "password": "${DB_PASSWORD}"}',
    '  "password": "$PASSWORD",',
    "password: true # set below",
    'PASSWORD="$(echo $PASSWORD)"',
  ])("keeps clean: %s", (text) => {
    expect(scanSecrets(text)).toEqual([]);
  });
});
