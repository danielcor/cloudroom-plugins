import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { collectLocalSecrets, findLocalSecretMatch } from "../src/safety/local-secrets.js";

const execFileAsync = promisify(execFile);

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

describe("local secret collection and matching", () => {
  it("collects .env and env tokens and reports only source name on match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-sec-"));
    dirs.push(dir);
    const dotenvSecret = ["super_", "local_", "secret_987654"].join("");
    const ghEnvSecret = ["ghp_", "z9".repeat(18)].join("");
    await writeFile(join(dir, ".env"), `STRIPE_KEY="${dotenvSecret}"\nSHORT=abc\n`, "utf8");
    await writeFile(join(dir, ".env.example"), "STRIPE_KEY=example_placeholder_123456\n", "utf8");

    const res = await collectLocalSecrets(
      dir,
      { GH_TOKEN: ghEnvSecret, PATH: process.env.PATH },
      dir,
    );

    expect(res.incomplete).toBe(false);
    expect(res.incompleteReasons).toEqual([]);
    expect(findLocalSecretMatch(`Leaked ${dotenvSecret} here`, res.secrets)).toBe("STRIPE_KEY in .env");
    expect(findLocalSecretMatch(`Leaked ghp_\u200B${"z9".repeat(18)}`, res.secrets)).toBe("GH_TOKEN");
    expect(findLocalSecretMatch("example_placeholder_123456", res.secrets)).toBeNull();
    expect(findLocalSecretMatch("normal status message", res.secrets)).toBeNull();
  });

  it("keeps alphabetic, short, and scalar passwords from explicit credential sources while filtering .env noise", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-sec-alpha-"));
    dirs.push(dir);
    const homeDir = await mkdtemp(join(tmpdir(), "ship-sec-home-"));
    dirs.push(homeDir);

    await mkdir(join(homeDir, ".config", "gh"), { recursive: true });
    await writeFile(
      join(homeDir, ".config", "gh", "hosts.yml"),
      "github.com:\n  oauth_token: alphabeticghtoken\nenterprise.local:\n  oauth_token: true\n",
      "utf8",
    );
    await writeFile(
      join(homeDir, ".git-credentials"),
      "https://user:alphabeticgitpass@github.com\nhttps://a:false@example.com\nhttps://b:pw@example.org\n",
      "utf8",
    );
    await writeFile(
      join(dir, ".env"),
      "DB_PASSWORD=alphabeticenvpass\nAPP_ENV=production\nREQUIRE_PASSWORD=true\n",
      "utf8",
    );

    const res1 = await collectLocalSecrets(
      dir,
      { GH_TOKEN: "alphabeticgithubtoken", PATH: process.env.PATH },
      homeDir,
    );
    expect(res1.incomplete).toBe(false);
    expect(findLocalSecretMatch("alphabeticgithubtoken", res1.secrets)).toBe("GH_TOKEN");
    expect(findLocalSecretMatch("alphabeticghtoken", res1.secrets)).toBe("gh oauth_token");
    expect(findLocalSecretMatch("alphabeticgitpass", res1.secrets)).toBe("git credential");
    expect(findLocalSecretMatch("alphabeticenvpass", res1.secrets)).toBe("DB_PASSWORD in .env");
    expect(findLocalSecretMatch("false", res1.secrets)).toBe("git credential");
    expect(findLocalSecretMatch("pw", res1.secrets)).toBe("git credential");
    expect(findLocalSecretMatch("true", res1.secrets)).toBe("gh oauth_token");
    expect(findLocalSecretMatch("production", res1.secrets)).toBeNull();

    const res2 = await collectLocalSecrets(
      dir,
      { GH_TOKEN: "no", PATH: process.env.PATH },
      homeDir,
    );
    expect(findLocalSecretMatch("no", res2.secrets)).toBe("GH_TOKEN");
  });

  it("reports incomplete status when files exceed the 1MB read cap or contain FIFOs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-sec-fifo-"));
    dirs.push(dir);
    const homeDir = await mkdtemp(join(tmpdir(), "ship-sec-fifo-home-"));
    dirs.push(homeDir);

    const earlySecret = "early_token_12345";
    const lateSecret = "late_token_987654";
    const bigEnv = `EARLY_SECRET=${earlySecret}\n` + "#".repeat(1_150_000) + `\nLATE_SECRET=${lateSecret}\n`;
    await writeFile(join(dir, ".env"), bigEnv, "utf8");
    await execFileAsync("mkfifo", [join(dir, ".env.fifo")]);
    await execFileAsync("mkfifo", [join(homeDir, ".git-credentials")]);

    const res = await collectLocalSecrets(dir, { PATH: process.env.PATH }, homeDir);
    expect(res.incomplete).toBe(true);
    expect(res.incompleteReasons).toEqual(
      expect.arrayContaining(["truncated:.env", "non_regular:.env.fifo", "non_regular:.git-credentials"]),
    );
    expect(findLocalSecretMatch(earlySecret, res.secrets)).toBe("EARLY_SECRET in .env");
    expect(findLocalSecretMatch(lateSecret, res.secrets)).toBeNull();
  });

  it("parses .env* copy filenames, multiline/inline dotenv, escaped hosts.yml, relative GH_CONFIG_DIR, and reports parse errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-sec-formats-"));
    dirs.push(dir);
    const homeDir = await mkdtemp(join(tmpdir(), "ship-sec-formats-home-"));
    dirs.push(homeDir);

    await mkdir(join(dir, ".gh-rel"), { recursive: true });
    await writeFile(
      join(dir, ".gh-rel", "hosts.yml"),
      [
        "github.com:",
        '  oauth_token: "tok\\"en\\\\1"',
        "  users:",
        "    alice:",
        "      oauth_token: 'it''s-secret'",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(dir, ".env.local (copy)"),
      [
        'MULTI_SECRET="line1',
        'line2_secret"',
        "SINGLE_SECRET='partA",
        "partB_secret'",
        "INLINE_SECRET=realvalue123#comment",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(dir, ".env.example"), "MULTI_SECRET=placeholder_example_1234\n", "utf8");

    const okRes = await collectLocalSecrets(
      dir,
      { GH_CONFIG_DIR: ".gh-rel", PATH: process.env.PATH },
      homeDir,
    );
    expect(okRes.incomplete).toBe(false);
    expect(findLocalSecretMatch('tok"en\\1', okRes.secrets)).toBe("gh oauth_token");
    expect(findLocalSecretMatch("it's-secret", okRes.secrets)).toBe("gh oauth_token");
    expect(findLocalSecretMatch("line1\nline2_secret", okRes.secrets)).toBe("MULTI_SECRET in .env.local (copy)");
    expect(findLocalSecretMatch("partA\r\npartB_secret", okRes.secrets)).toBe("SINGLE_SECRET in .env.local (copy)");
    expect(findLocalSecretMatch("realvalue123", okRes.secrets)).toBe("INLINE_SECRET in .env.local (copy)");
    expect(findLocalSecretMatch("placeholder_example_1234", okRes.secrets)).toBeNull();

    const badDir = await mkdtemp(join(tmpdir(), "ship-sec-bad-"));
    dirs.push(badDir);
    const badHome = await mkdtemp(join(tmpdir(), "ship-sec-bad-home-"));
    dirs.push(badHome);
    await writeFile(join(badDir, ".env"), 'UNCLOSED="abc\n', "utf8");
    await mkdir(join(badHome, ".config", "gh"), { recursive: true });
    await writeFile(join(badHome, ".config", "gh", "hosts.yml"), "github.com:\n  oauth_token: [1, 2\n", "utf8");
    await writeFile(join(badHome, ".git-credentials"), "not-a-valid-url\n", "utf8");

    const badRes = await collectLocalSecrets(badDir, { PATH: process.env.PATH }, badHome);
    expect(badRes.incomplete).toBe(true);
    expect(badRes.incompleteReasons).toEqual(
      expect.arrayContaining(["parse_error:.env", "parse_error:gh hosts.yml", "parse_error:.git-credentials"]),
    );
  });

  it("preserves unknown dotenv escapes and uncoerced YAML plain scalars in hosts.yml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-sec-esc-"));
    dirs.push(dir);
    const homeDir = await mkdtemp(join(tmpdir(), "ship-sec-esc-home-"));
    dirs.push(homeDir);

    await mkdir(join(homeDir, ".config", "gh"), { recursive: true });
    await writeFile(
      join(homeDir, ".config", "gh", "hosts.yml"),
      "github.com:\n  oauth_token: FALSE\nenterprise.local:\n  oauth_token: 01234\n",
      "utf8",
    );
    await writeFile(
      join(dir, ".env"),
      'DB_PASSWORD="alpha\\qbeta"\nESC_SECRET="line1\\nline2"\n',
      "utf8",
    );

    const res = await collectLocalSecrets(dir, { PATH: process.env.PATH }, homeDir);
    expect(res.incomplete).toBe(false);
    expect(findLocalSecretMatch("alpha\\qbeta", res.secrets)).toBe("DB_PASSWORD in .env");
    expect(findLocalSecretMatch("line1\nline2", res.secrets)).toBe("ESC_SECRET in .env");
    expect(findLocalSecretMatch("line1\\nline2", res.secrets)).toBe("ESC_SECRET in .env");
    expect(findLocalSecretMatch("FALSE", res.secrets)).toBe("gh oauth_token");
    expect(findLocalSecretMatch("01234", res.secrets)).toBe("gh oauth_token");
  });

  it("collects DB_KEY and quoted dotenv literal references while skipping unquoted pure refs and empty values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-sec-dotenv-quote-"));
    dirs.push(dir);
    const homeDir = await mkdtemp(join(tmpdir(), "ship-sec-dotenv-quote-home-"));
    dirs.push(homeDir);

    await writeFile(
      join(dir, ".env"),
      [
        "DB_KEY=abc123",
        "DB_PASSWORD='$word'",
        'API_TOKEN="$tok"',
        "SIGNING_SECRET=`$sig`",
        "UNQUOTED_TOKEN=$OTHER_VAR",
        "EMPTY_DEF_TOKEN=${OTHER:-}",
        "",
      ].join("\n"),
      "utf8",
    );

    const res = await collectLocalSecrets(dir, { PATH: process.env.PATH }, homeDir);
    expect(res.incomplete).toBe(false);
    expect(findLocalSecretMatch("abc123", res.secrets)).toBe("DB_KEY in .env");
    expect(findLocalSecretMatch("$word", res.secrets)).toBe("DB_PASSWORD in .env");
    expect(findLocalSecretMatch("$tok", res.secrets)).toBe("API_TOKEN in .env");
    expect(findLocalSecretMatch("$sig", res.secrets)).toBe("SIGNING_SECRET in .env");
    expect(findLocalSecretMatch("$OTHER_VAR", res.secrets)).toBeNull();
    expect(findLocalSecretMatch("${OTHER:-}", res.secrets)).toBeNull();
    expect(findLocalSecretMatch("any text", [{ name: "empty", value: "" }])).toBeNull();
  });

  it("collects bash-escaped unquoted dotenv secrets and quoted scalar literals (S6/S7)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-sec-shell-"));
    dirs.push(dir);
    const homeDir = await mkdtemp(join(tmpdir(), "ship-sec-shell-home-"));
    dirs.push(homeDir);

    await writeFile(
      join(dir, ".env"),
      [
        "DB_PASSWORD=alpha\\#beta",
        "SPACE_SECRET=alpha\\ beta",
        "ESCAPED_REF_SECRET=\\$word",
        'BOOL_PASSWORD="true"',
        'ZERO_PASSWORD="0"',
        "SINGLE_SECRET='false'",
        'EMPTY_QUOTED_PASSWORD=""',
        "",
      ].join("\n"),
      "utf8",
    );

    const res = await collectLocalSecrets(dir, { PATH: process.env.PATH }, homeDir);
    expect(res.incomplete).toBe(false);
    expect(findLocalSecretMatch("alpha#beta", res.secrets)).toBe("DB_PASSWORD in .env");
    expect(findLocalSecretMatch("alpha beta", res.secrets)).toBe("SPACE_SECRET in .env");
    expect(findLocalSecretMatch("$word", res.secrets)).toBe("ESCAPED_REF_SECRET in .env");
    expect(findLocalSecretMatch("true", res.secrets)).toBe("BOOL_PASSWORD in .env");
    expect(findLocalSecretMatch("0", res.secrets)).toBe("ZERO_PASSWORD in .env");
    expect(findLocalSecretMatch("false", res.secrets)).toBe("SINGLE_SECRET in .env");
    expect(res.secrets.some((s) => s.value === "")).toBe(false);
  });

  it("enforces aggregate byte and file-count budgets across .env* files (S8)", async () => {
    const dirBytes = await mkdtemp(join(tmpdir(), "ship-sec-budget-bytes-"));
    dirs.push(dirBytes);
    const homeBytes = await mkdtemp(join(tmpdir(), "ship-sec-budget-bytes-home-"));
    dirs.push(homeBytes);

    const pad = "#".repeat(900_000);
    for (let i = 1; i <= 5; i++) {
      await writeFile(join(dirBytes, `.env.part${i}`), `EARLY_${i}=part${i}_secret_val\n${pad}\n`, "utf8");
    }
    const bytesRes = await collectLocalSecrets(dirBytes, { PATH: process.env.PATH }, homeBytes);
    expect(bytesRes.incomplete).toBe(true);
    expect(bytesRes.incompleteReasons.some((r) => r.startsWith("budget_exceeded:"))).toBe(true);
    expect(findLocalSecretMatch("part1_secret_val", bytesRes.secrets)).toBe("EARLY_1 in .env.part1");

    const dirCount = await mkdtemp(join(tmpdir(), "ship-sec-budget-cnt-"));
    dirs.push(dirCount);
    const homeCount = await mkdtemp(join(tmpdir(), "ship-sec-budget-cnt-home-"));
    dirs.push(homeCount);
    for (let i = 0; i < 70; i++) {
      const padded = String(i).padStart(2, "0");
      await writeFile(join(dirCount, `.env.f${padded}`), `KEY_${padded}=secret_${padded}\n`, "utf8");
    }
    const countRes = await collectLocalSecrets(dirCount, { PATH: process.env.PATH }, homeCount);
    expect(countRes.incomplete).toBe(true);
    expect(countRes.incompleteReasons).toContain("budget_exceeded:env_files");
    expect(findLocalSecretMatch("secret_00", countRes.secrets)).toBe("KEY_00 in .env.f00");
    expect(findLocalSecretMatch("secret_69", countRes.secrets)).toBeNull();

    const dirEntries = await mkdtemp(join(tmpdir(), "ship-sec-budget-entries-"));
    dirs.push(dirEntries);
    const homeEntries = await mkdtemp(join(tmpdir(), "ship-sec-budget-entries-home-"));
    dirs.push(homeEntries);
    for (let i = 0; i < 4100; i++) {
      const h = await open(join(dirEntries, `f${i}`), "w");
      await h.close();
    }
    const entriesRes = await collectLocalSecrets(dirEntries, { PATH: process.env.PATH }, homeEntries);
    expect(entriesRes.incomplete).toBe(true);
    expect(entriesRes.incompleteReasons).toContain("budget_exceeded:dir_entries");
  });

  it("marks ENOTDIR GH_CONFIG_DIR and missing root directory as incomplete (S9)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-sec-enotdir-"));
    dirs.push(dir);
    const homeDir = await mkdtemp(join(tmpdir(), "ship-sec-enotdir-home-"));
    dirs.push(homeDir);
    const regularFile = join(dir, "gh-config-file");
    await writeFile(regularFile, "not a directory\n", "utf8");

    const enotdirRes = await collectLocalSecrets(dir, { GH_CONFIG_DIR: regularFile, PATH: process.env.PATH }, homeDir);
    expect(enotdirRes.incomplete).toBe(true);
    expect(enotdirRes.incompleteReasons).toContain("unreadable:gh hosts.yml");

    const missingRoot = join(dir, "does-not-exist");
    const missingRootRes = await collectLocalSecrets(missingRoot, { PATH: process.env.PATH }, homeDir);
    expect(missingRootRes.incomplete).toBe(true);
    expect(missingRootRes.incompleteReasons).toContain(`unreadable_dir:${missingRoot}`);
  });

  it("tracks unescaped shell word boundaries for # comments and flags dangling .env* symlinks (S13/S15)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-sec-shell-hash-"));
    dirs.push(dir);
    const homeDir = await mkdtemp(join(tmpdir(), "ship-sec-shell-hash-home-"));
    dirs.push(homeDir);

    await writeFile(
      join(dir, ".env"),
      [
        "API_TOKEN=\\ #synthetic",
        "DB_PASSWORD=#synthetic",
        "COMMENT_PASSWORD= #notasecret",
        "MID_SPACE_SECRET=alpha\\ #midtoken",
        "HASH_COMMENT_SECRET=alpha#beta # trailing comment",
        "",
      ].join("\n"),
      "utf8",
    );

    const res = await collectLocalSecrets(dir, { PATH: process.env.PATH }, homeDir);
    expect(res.incomplete).toBe(false);
    expect(findLocalSecretMatch("ordinary prose with spaces", res.secrets)).toBeNull();
    expect(findLocalSecretMatch(" #synthetic", res.secrets)).toBe("API_TOKEN in .env");
    expect(findLocalSecretMatch("#synthetic", res.secrets)).toBe("DB_PASSWORD in .env");
    expect(findLocalSecretMatch("#notasecret", res.secrets)).toBeNull();
    expect(findLocalSecretMatch("alpha #midtoken", res.secrets)).toBe("MID_SPACE_SECRET in .env");
    expect(findLocalSecretMatch("alpha#beta", res.secrets)).toBe("HASH_COMMENT_SECRET in .env");
    expect(findLocalSecretMatch("# trailing comment", res.secrets)).toBeNull();

    await symlink(join(dir, "missing-target"), join(dir, ".env.dangling"));
    const danglingRes = await collectLocalSecrets(dir, { PATH: process.env.PATH }, homeDir);
    expect(danglingRes.incomplete).toBe(true);
    expect(danglingRes.incompleteReasons).toContain("unreadable:.env.dangling");
  });

  it("collects literal POSIX dotenv filenames containing backslashes (S19)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-sec-posix-bs-"));
    dirs.push(dir);
    const homeDir = await mkdtemp(join(tmpdir(), "ship-sec-posix-bs-home-"));
    dirs.push(homeDir);

    await writeFile(join(dir, ".env.local\\..\\backup"), "POSIX_KEY=backslash_dotdot_secret\n", "utf8");
    await writeFile(join(dir, ".env.local\\backup"), "POSIX_TOKEN=backslash_secret\n", "utf8");

    const res = await collectLocalSecrets(dir, { PATH: process.env.PATH }, homeDir);
    expect(res.incomplete).toBe(false);
    expect(findLocalSecretMatch("backslash_dotdot_secret", res.secrets)).toBe("POSIX_KEY in .env.local\\..\\backup");
    expect(findLocalSecretMatch("backslash_secret", res.secrets)).toBe("POSIX_TOKEN in .env.local\\backup");
  });

  it("scales linearly on long uppercase keys and handles S2/S3/S4/S5/S6/S7/S9/S10 edge cases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ship-sec-r2-"));
    dirs.push(dir);
    const homeDir = await mkdtemp(join(tmpdir(), "ship-sec-r2-home-"));
    dirs.push(homeDir);

    const ghDir = join(homeDir, ".config", "gh");
    await mkdir(ghDir, { recursive: true });
    await writeFile(
      join(ghDir, "hosts.yml"),
      "github.com:\n  oauth_token: !!binary Z2hwX3Rlc3R0b2tlbg==\n  user: testuser\n",
      "utf8",
    );

    await writeFile(
      join(homeDir, ".git-credentials"),
      "https://ghp_user%2Btok:x-oauth-basic@github.com\nhttps://alice:X-OAUTH-BASIC@github.com\n",
      "utf8",
    );

    const longUpperKey = `${"A".repeat(25_000)}_KEY`;
    await writeFile(
      join(dir, ".env"),
      [
        `${longUpperKey}=fast_key_val`,
        'DOUBLE_BS_SECRET="a\\\\nb"',
        'CR_SECRET="part1\\rpart2"',
        'DQ_CR_SECRET="left\rright"',
        "SQ_CR_SECRET='sleft\rsright'",
        "UNQ_CR_SECRET=uleft\ruright",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(dir, "\uFF0Eenv"), "FW_SECRET=fullwidth_dot_env_secret\n", "utf8");
    await writeFile(join(dir, ".\u0435nv"), "CYR_SECRET=cyrillic_e_env_secret\n", "utf8");
    await writeFile(join(dir, "\uFF0Eenv.example"), "FW_EX=fullwidth_example_ignored\n", "utf8");
    await writeFile(join(dir, ".\u0435nv.example"), "CYR_EX=cyrillic_example_ignored\n", "utf8");

    const t0 = performance.now();
    const res = await collectLocalSecrets(dir, { PATH: process.env.PATH }, homeDir);
    const elapsedMs = performance.now() - t0;

    expect(res.incomplete).toBe(false);
    expect(elapsedMs).toBeLessThan(500);
    expect(findLocalSecretMatch("fast_key_val", res.secrets)).toBe(`${longUpperKey} in .env`);
    expect(findLocalSecretMatch("ghp_user%2Btok", res.secrets)).toBe("git credential");
    expect(findLocalSecretMatch("ghp_user+tok", res.secrets)).toBe("git credential");
    expect(findLocalSecretMatch("x-oauth-basic", res.secrets)).toBeNull();
    expect(findLocalSecretMatch("X-OAUTH-BASIC", res.secrets)).toBe("git credential");
    expect(findLocalSecretMatch("alice", res.secrets)).toBeNull();
    expect(findLocalSecretMatch("a\\\nb", res.secrets)).toBe("DOUBLE_BS_SECRET in .env");
    expect(findLocalSecretMatch("a\\nb", res.secrets)).toBe("DOUBLE_BS_SECRET in .env");
    expect(findLocalSecretMatch("part1\rpart2", res.secrets)).toBe("CR_SECRET in .env");
    expect(findLocalSecretMatch("part1\npart2", res.secrets)).toBe("CR_SECRET in .env");
    expect(findLocalSecretMatch("part1\r\npart2", res.secrets)).toBe("CR_SECRET in .env");
    expect(findLocalSecretMatch("leftright", res.secrets)).toBe("DQ_CR_SECRET in .env");
    expect(findLocalSecretMatch("left\rright", res.secrets)).toBe("DQ_CR_SECRET in .env");
    expect(findLocalSecretMatch("left\nright", res.secrets)).toBe("DQ_CR_SECRET in .env");
    expect(res.secrets.some((s) => s.value === "left\rright")).toBe(true);
    expect(findLocalSecretMatch("sleftsright", res.secrets)).toBe("SQ_CR_SECRET in .env");
    expect(findLocalSecretMatch("sleft\nsright", res.secrets)).toBe("SQ_CR_SECRET in .env");
    expect(res.secrets.some((s) => s.value === "sleft\rsright")).toBe(true);
    expect(findLocalSecretMatch("ulefturight", res.secrets)).toBe("UNQ_CR_SECRET in .env");
    expect(findLocalSecretMatch("uleft\ruright", res.secrets)).toBe("UNQ_CR_SECRET in .env");
    expect(findLocalSecretMatch("uleft\nuright", res.secrets)).toBe("UNQ_CR_SECRET in .env");
    expect(res.secrets.some((s) => s.value === "ulefturight")).toBe(true);
    expect(res.secrets.some((s) => s.value === "uleft\ruright")).toBe(true);
    expect(findLocalSecretMatch("fullwidth_dot_env_secret", res.secrets)).toBe("FW_SECRET in \uFF0Eenv");
    expect(findLocalSecretMatch("cyrillic_e_env_secret", res.secrets)).toBe("CYR_SECRET in .\u0435nv");
    expect(findLocalSecretMatch("fullwidth_example_ignored", res.secrets)).toBeNull();
    expect(findLocalSecretMatch("cyrillic_example_ignored", res.secrets)).toBeNull();
    expect(findLocalSecretMatch("Z2hwX3Rlc3R0b2tlbg==", res.secrets)).toBe("gh oauth_token");
    expect(findLocalSecretMatch("plain text", [{ name: "inv", value: "\u200B" }])).toBeNull();
    expect(findLocalSecretMatch("a\u200Bb", [{ name: "inv", value: "\u200B" }])).toBe("inv");

    // S4: dangling hosts.yml, .git-credentials, and ~/.config ancestor symlinks must report incomplete
    const symlinkHome = await mkdtemp(join(tmpdir(), "ship-sec-symlink-home-"));
    dirs.push(symlinkHome);
    await mkdir(join(symlinkHome, ".config", "gh"), { recursive: true });
    await symlink(join(symlinkHome, "missing-hosts"), join(symlinkHome, ".config", "gh", "hosts.yml"));
    await symlink(join(symlinkHome, "missing-creds"), join(symlinkHome, ".git-credentials"));
    const symlinkRes = await collectLocalSecrets(dir, { PATH: process.env.PATH }, symlinkHome);
    expect(symlinkRes.incomplete).toBe(true);
    expect(symlinkRes.incompleteReasons).toEqual(
      expect.arrayContaining(["unreadable:gh hosts.yml", "unreadable:.git-credentials"]),
    );

    const cfgSymHome = await mkdtemp(join(tmpdir(), "ship-sec-cfg-sym-home-"));
    dirs.push(cfgSymHome);
    await symlink(join(cfgSymHome, "missing-config"), join(cfgSymHome, ".config"));
    const cfgSymRes = await collectLocalSecrets(dir, { PATH: process.env.PATH }, cfgSymHome);
    expect(cfgSymRes.incomplete).toBe(true);
    expect(cfgSymRes.incompleteReasons).toEqual(
      expect.arrayContaining(["unreadable:gh hosts.yml", "unreadable:git/credentials"]),
    );
  });

  it("handles bare CR before quotes, CR-delimited files, literal-CR candidates, and malformed CR files (S12/S13)", async () => {
    const crQuoteDir = await mkdtemp(join(tmpdir(), "ship-sec-cr-quote-"));
    dirs.push(crQuoteDir);
    const crQuoteHome = await mkdtemp(join(tmpdir(), "ship-sec-cr-quote-home-"));
    dirs.push(crQuoteHome);
    await writeFile(
      join(crQuoteDir, ".env"),
      'API_TOKEN=\r"fixture_al#pha42"\nKEY_CR_SECRET\r="fixture_key_cr"\n',
      "utf8",
    );
    const crQuoteRes = await collectLocalSecrets(crQuoteDir, { PATH: process.env.PATH }, crQuoteHome);
    expect(crQuoteRes.incomplete).toBe(false);
    expect(findLocalSecretMatch("fixture_al#pha42", crQuoteRes.secrets)).toBe("API_TOKEN in .env");
    expect(crQuoteRes.secrets.some((s) => s.value === "fixture_al#pha42")).toBe(true);
    expect(findLocalSecretMatch("fixture_key_cr", crQuoteRes.secrets)).toBe("KEY_CR_SECRET in .env");

    const crDelimDir = await mkdtemp(join(tmpdir(), "ship-sec-cr-delim-"));
    dirs.push(crDelimDir);
    const crDelimHome = await mkdtemp(join(tmpdir(), "ship-sec-cr-delim-home-"));
    dirs.push(crDelimHome);
    await writeFile(
      join(crDelimDir, ".env"),
      "# header comment\rFIRST_SECRET=cr_first_val\rSECOND_SECRET=cr_second_val\r",
      "utf8",
    );
    const crDelimRes = await collectLocalSecrets(crDelimDir, { PATH: process.env.PATH }, crDelimHome);
    expect(crDelimRes.incomplete).toBe(false);
    expect(findLocalSecretMatch("cr_first_val", crDelimRes.secrets)).toBe("FIRST_SECRET in .env");
    expect(findLocalSecretMatch("cr_second_val", crDelimRes.secrets)).toBe("SECOND_SECRET in .env");

    const crQuotedDelimDir = await mkdtemp(join(tmpdir(), "ship-sec-cr-qdelim-"));
    dirs.push(crQuotedDelimDir);
    const crQuotedDelimHome = await mkdtemp(join(tmpdir(), "ship-sec-cr-qdelim-home-"));
    dirs.push(crQuotedDelimHome);
    await writeFile(
      join(crQuotedDelimDir, ".env"),
      'FIRST_Q_SECRET="cr_q_first"\rSECOND_Q_SECRET="cr_q_second"\r',
      "utf8",
    );
    const crQuotedDelimRes = await collectLocalSecrets(crQuotedDelimDir, { PATH: process.env.PATH }, crQuotedDelimHome);
    expect(crQuotedDelimRes.incomplete).toBe(false);
    expect(findLocalSecretMatch("cr_q_first", crQuotedDelimRes.secrets)).toBe("FIRST_Q_SECRET in .env");
    expect(findLocalSecretMatch("cr_q_second", crQuotedDelimRes.secrets)).toBe("SECOND_Q_SECRET in .env");

    const badCrDir = await mkdtemp(join(tmpdir(), "ship-sec-bad-cr-"));
    dirs.push(badCrDir);
    const badCrHome = await mkdtemp(join(tmpdir(), "ship-sec-bad-cr-home-"));
    dirs.push(badCrHome);
    await writeFile(
      join(badCrDir, ".env"),
      'FIRST_SECRET=cr_first_val\rUNCLOSED_SECRET="abc\rHIDDEN_SECRET=cr_hidden_val\r',
      "utf8",
    );
    const badCrRes = await collectLocalSecrets(badCrDir, { PATH: process.env.PATH }, badCrHome);
    expect(badCrRes.incomplete).toBe(true);
    expect(badCrRes.incompleteReasons).toContain("parse_error:.env");

    const badLfCrDir = await mkdtemp(join(tmpdir(), "ship-sec-bad-lf-cr-"));
    dirs.push(badLfCrDir);
    const badLfCrHome = await mkdtemp(join(tmpdir(), "ship-sec-bad-lf-cr-home-"));
    dirs.push(badLfCrHome);
    await writeFile(join(badLfCrDir, ".env"), 'API_TOKEN=\r"unclosed\n', "utf8");
    const badLfCrRes = await collectLocalSecrets(badLfCrDir, { PATH: process.env.PATH }, badLfCrHome);
    expect(badLfCrRes.incomplete).toBe(true);
    expect(badLfCrRes.incompleteReasons).toContain("parse_error:.env");
  });
});
