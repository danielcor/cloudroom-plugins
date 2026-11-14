// Round-4 independent review of 746b3b3: five secret-scan bypasses. Values carry
// punctuation, as real passwords do. Built at runtime so the file holds no
// literal that a provider's scanner would take for a live key.
import { describe, expect, it } from "vitest";
import { findSecrets } from "../src/find-secrets.js";
import { scanSecrets } from "../src/secrets.js";

const PUNCT = ["K7m!Q2s@", "T4v#W6x$", "Y8z%aB3d"].join(""); // 24 chars
const ALNUM = ["aB3dE5gH7jK9mN1p", "Q2sT4vW6xY8zaB3d"].join("");
const B64 = Buffer.from(`deploy:${PUNCT}`).toString("base64");

const lines = (text: string) => scanSecrets(text).map((f) => f.line);

describe("secret scan bypasses (round 4)", () => {
  // Guidance written as a `key: value` assignment was clean under the entropy
  // heuristic; under the strict rule (Daniel, 2026-11-13) it blocks, as decided.
  it.each([
    'password: "Choose a different password for each account"',
    "token: 'Use the API key from your 1Password vault'",
    'password: "Do NOT reuse it across CI and prod"',
    'password: "Do NOT COMMIT PASSWORDS"',
    'token: "Use YOUR OWN API KEY from ENV"',
    "token: 'Paste the token from the dashboard here'",
  ])("strict rule: blocks guidance written as an assignment: %s", (text) => {
    expect(scanSecrets(text).map((f) => f.kind)).toEqual(["literal value for a secret-named key"]);
  });

  it.each([
    ["shell export, single quotes", `export DATABASE_PASSWORD='${PUNCT}'`],
    ["shell export, double quotes", `export DATABASE_PASSWORD="${PUNCT}"`],
    ["JSON", `{"db_password": "${PUNCT}", "user": "app"}`],
    ["YAML, quoted", `password: "${PUNCT}"`],
    ["YAML, unquoted", `password: ${PUNCT}`],
    ["CLI flag, space, quoted", `deploy --token "${PUNCT}" --verbose`],
    ["CLI flag, equals, unquoted", `deploy --api-key=${PUNCT}`],
  ])("(1) catches a punctuated value: %s", (_why, text) => {
    expect(lines(`intro\n${text}`)).toContain(2);
  });

  it.each([
    ["YAML literal block", `config:\n  api_token: |\n    ${PUNCT}\n  user: app`, 3],
    ["YAML folded block split over lines", `api_token: >-\n  ${PUNCT.slice(0, 12)}\n  ${PUNCT.slice(12)}\n`, 2],
    ["shell continuation", `curl https://example.com/api \\\n  --token \\\n  ${PUNCT}\n`, 3],
    ["shell continuation, quoted", `deploy --password \\\n  "${PUNCT}"`, 2],
  ])("(2) catches a multiline value and reports its line: %s", (_why, text, line) => {
    expect(lines(text)).toContain(line);
  });

  it("(3) catches a secret hidden in a placeholder default", () => {
    expect(findSecrets({ title: "t", tags: [], body: `intro\nrun --token {{token|${PUNCT}}}` })).toEqual(["literal value for a secret-named key on body line 2"]);
    expect(findSecrets({ title: "t", tags: [], body: `export API_KEY={{key|${ALNUM}}}` })).toEqual(["literal value for a secret-named key on body line 1"]);
  });

  it.each([`authorization: bearer ${ALNUM}`, `AUTHORIZATION: BEARER ${ALNUM}`, `-H "Authorization: Bearer ${ALNUM}"`])("(4) bearer in any case: %s", (text) => {
    expect(scanSecrets(text).map((f) => f.kind)).toContain("bearer token");
  });

  it.each([
    ["postgres URL", "psql postgres://app:pass@db.example.com:5432/app"],
    ["https URL with a token", `git clone https://deploy:${ALNUM}@github.com/org/repo.git`],
    ["Basic auth header", `curl -H "Authorization: Basic ${B64}" https://x`],
    ["curl -u", "curl -u admin:hunter2 https://example.com"],
    ["curl --user=, punctuated", `curl --user=admin:${PUNCT} https://example.com`],
    ["curl --user, quoted", "curl --user 'admin:hunter2' https://example.com"],
  ])("(5) catches credentials: %s", (_why, text) => {
    expect(lines(text)).toContain(1);
  });

  // Delta review of 2970fc4.
  it.each([
    ["S1 continuation inside an unquoted value", `deploy --token ${ALNUM.slice(0, 12)}\\\n${ALNUM.slice(12)}`, 1],
    ["S4 a literal value with a shell delimiter after it is still a value", `export TOKEN=${ALNUM};echo done`, 1],
    ["S5 shell default after NAME=", `export API_TOKEN=\${API_TOKEN:-${ALNUM}}`, 1],
    ["S5 shell default in URL userinfo", `git clone https://deploy:\${PASS:-hunter2}@github.com/org/repo.git`, 1],
    ["S5 shell default in curl credentials", `curl -u "admin:\${PASS:=hunter2}" https://x`, 1],
    ["S6 empty user name in a URL", "curl https://:hunter2@example.com/api", 1],
    ["S7 curl -u attached", "curl -uadmin:hunter2 https://example.com", 1],
    ["S3 a random word inside quoted text", `password: "use ${PUNCT} for staging"`, 1],
    ["S8 a literal after a reference inside quotes", `export TOKEN="\${TOKEN};${ALNUM}"`, 1],
    ["S8 a literal after a reference in URL userinfo", "git clone https://user:${TOKEN};hunter2@example.com/r.git", 1],
    ["S9 a random value with a space", `export TOKEN='${ALNUM.slice(0, 12)} ${ALNUM.slice(12, 25)}'`, 1],
    ["S10 short Basic credentials", "Authorization: Basic YTpi", 1],
    ["S10 non-ASCII Basic credentials", `Authorization: Basic ${Buffer.from("deploy:pássword123").toString("base64")}`, 1],
    ["S11 a literal after a reference in an unquoted YAML value", `password: \${TOKEN};${ALNUM}`, 1],
    ["S13 Latin-1 Basic credentials (as Requests sends them)", "Authorization: Basic ZGVwbG95OnDhc3N3b3Jk", 1],
  ])("delta: catches %s", (_why, text, line) => {
    expect(lines(text)).toContain(line);
  });

  it.each([
    "Explain Authorization: Basic authentication.",
    "Authorization: Basic auth is weaker than tokens.",
    "export DATABASE_PASSWORD=$DATABASE_PASSWORD_2026; echo done",
    "export API_TOKEN=${API_TOKEN}&& deploy",
    "curl -u admin: https://example.com",
    "curl -uadmin https://example.com",
    "Authorization: Basic YWJj",
  ])("delta: keeps clean: %s", (text) => {
    expect(scanSecrets(text)).toEqual([]);
    expect(findSecrets({ title: "t", tags: [], body: text })).toEqual([]);
  });

  it.each([
    `export DATABASE_PASSWORD="$DB_PASSWORD"`,
    `export DATABASE_PASSWORD=\${DB_PASSWORD}`,
    `deploy --token "\${GITHUB_TOKEN}"`,
    "deploy --token $GITHUB_TOKEN",
    "password: {{password}}",
    "run --token {{token}}",
    "psql postgres://app@db.example.com/app",
    "ssh deploy@build-host.example.com",
    "git clone https://github.com/org/repo.git",
    `git clone https://\${GIT_USER}:\${GIT_TOKEN}@github.com/org/repo.git`,
    `curl -u "$API_USER:$API_PASS" https://example.com`,
    "curl -u admin https://example.com",
    "Authorization: Basic $CREDENTIALS",
    "git push -u origin main",
    "description: |\n  This is a long description of what the snippet does, in plain words.\n",
    "api_token: |\n  ${API_TOKEN}\n",
    "The password must be at least sixteen characters long: pick one with care.",
    "Note: the token budget is about 128000 for this model.",
  ])("keeps clean: %s", (text) => {
    expect(scanSecrets(text)).toEqual([]);
    expect(findSecrets({ title: "t", tags: [], body: text })).toEqual([]);
  });
});
