import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectLocalSecrets, findLocalSecretMatch, findSecrets } from "../src/safety/secrets.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

describe("secret scanner and local secret matching", () => {
  it("flags known token patterns and literal secret assignments without returning values", () => {
    const aws = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    const gh = ["ghp_", "a".repeat(36)].join("");
    const ant = ["sk-ant-", "x".repeat(24)].join("");

    const text = [
      `const a = "${aws}";`,
      `const b = "${gh}";`,
      `const c = "${ant}";`,
      `password: "hunter2"`,
      `API_TOKEN='literal-value'`,
      `require_password: true`,
      `TOKEN=$MY_ENV_VAR`,
    ].join("\n");

    const findings = findSecrets(text);
    const lines = findings.map((f) => f.line);
    expect(lines).toEqual([1, 2, 3, 4, 5]);
    expect(JSON.stringify(findings)).not.toContain(aws);
    expect(JSON.stringify(findings)).not.toContain(gh);
    expect(JSON.stringify(findings)).not.toContain("hunter2");
  });

  it("catches secrets split by invisible characters and inside nested code blocks", () => {
    const splitToken = ["AKIA", "\u200B", "ABCDEFGHIJKLMNOP"].join("");
    const text = ["```yaml", "  api_key: supersecret", "```", splitToken].join("\n");
    const findings = findSecrets(text);
    expect(findings.map((f) => f.line)).toEqual([2, 4]);
  });

  it("collects .env and env tokens and reports only source name on match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-sec-"));
    dirs.push(dir);
    const dotenvSecret = ["super_", "local_", "secret_987654"].join("");
    const ghEnvSecret = ["ghp_", "z9".repeat(18)].join("");
    await writeFile(join(dir, ".env"), `STRIPE_KEY="${dotenvSecret}"\nSHORT=abc\n`, "utf8");
    await writeFile(join(dir, ".env.example"), "STRIPE_KEY=example_placeholder_123456\n", "utf8");

    const secrets = await collectLocalSecrets(
      dir,
      { GH_TOKEN: ghEnvSecret, PATH: process.env.PATH },
      dir,
    );

    expect(findLocalSecretMatch(`Leaked ${dotenvSecret} here`, secrets)).toBe("STRIPE_KEY in .env");
    expect(findLocalSecretMatch(`Leaked ghp_\u200B${"z9".repeat(18)}`, secrets)).toBe("GH_TOKEN");
    expect(findLocalSecretMatch("example_placeholder_123456", secrets)).toBeNull();
    expect(findLocalSecretMatch("normal status message", secrets)).toBeNull();
  });
});
