import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { checkMergeSafe, parseRawDiffTreeZ } from "../src/safety/merge-guard.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function initRepo(): Promise<{ root: string; mainSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "ship-mg-"));
  dirs.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Test Author");
  await git(root, "config", "user.email", "test@example.com");
  await writeFile(join(root, "app.ts"), "export const x = 1;\n", "utf8");
  await git(root, "add", "app.ts");
  await git(root, "commit", "-m", "initial");
  const mainSha = await git(root, "rev-parse", "HEAD");
  return { root, mainSha };
}

async function commitFile(root: string, rel: string, content: string, msg: string): Promise<string> {
  const full = join(root, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
  await git(root, "add", rel);
  await git(root, "commit", "-m", msg);
  return git(root, "rev-parse", "HEAD");
}

describe("parseRawDiffTreeZ and checkMergeSafe", () => {
  it("parses raw NUL-delimited diff-tree output", () => {
    const raw =
      ":100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb M\0src/a.ts\0" +
      ":000000 120000 0000000000000000000000000000000000000000 cccccccccccccccccccccccccccccccccccccccc A\0link\0";
    expect(parseRawDiffTreeZ(raw)).toEqual([
      { oldMode: "100644", newMode: "100644", path: "src/a.ts" },
      { oldMode: "000000", newMode: "120000", path: "link" },
    ]);
  });

  it("allows clean base merge on normal files and reports alreadyMerged", async () => {
    const { root } = await initRepo();
    await git(root, "checkout", "-b", "feat/work");
    await commitFile(root, "feat.ts", "export const y = 2;\n", "feature commit");

    await git(root, "checkout", "main");
    const baseTip = await commitFile(root, "other.ts", "export const z = 3;\n", "base advance");
    await git(root, "checkout", "feat/work");

    const res = await checkMergeSafe(root, "main", { mode: "base", expectedTipSha: baseTip });
    expect(res).toMatchObject({
      safe: true,
      alreadyMerged: false,
      blockedPaths: [],
      noticePaths: [],
    });
    expect(res.touchedPaths).toContain("other.ts");

    const anc = await checkMergeSafe(root, "feat/work", { mode: "base" });
    expect(anc).toMatchObject({ safe: true, alreadyMerged: true });
  });

  it("refuses base merge touching .claude/settings.json or .mcp.json", async () => {
    const { root } = await initRepo();
    await git(root, "checkout", "-b", "feat/work");
    await commitFile(root, "feat.ts", "export const y = 2;\n", "feature commit");

    await git(root, "checkout", "main");
    const baseTip = await commitFile(root, ".claude/settings.json", '{"hooks":{}}\n', "add claude settings");
    await git(root, "checkout", "feat/work");

    const res = await checkMergeSafe(root, "main", { mode: "base", expectedTipSha: baseTip });
    expect(res.safe).toBe(false);
    expect(res.blockedPaths).toContain(".claude/settings.json");
  });

  it("reports non-protected CI files in noticePaths on base merge, but blocks them on head merge", async () => {
    const { root } = await initRepo();
    await git(root, "checkout", "-b", "feat/work");
    await commitFile(root, "feat.ts", "export const y = 2;\n", "feature commit");

    await git(root, "checkout", "main");
    const baseTip = await commitFile(root, ".github/workflows/ci.yml", "name: CI\n", "update workflow");
    await git(root, "checkout", "feat/work");

    const baseRes = await checkMergeSafe(root, "main", { mode: "base", expectedTipSha: baseTip });
    expect(baseRes.safe).toBe(true);
    expect(baseRes.noticePaths).toContain(".github/workflows/ci.yml");

    const headRes = await checkMergeSafe(root, "main", { mode: "head", expectedTipSha: baseTip });
    expect(headRes.safe).toBe(false);
    expect(headRes.blockedPaths).toContain(".github/workflows/ci.yml");
  });

  it("blocks head merge introducing a symlink", async () => {
    const { root } = await initRepo();
    await git(root, "checkout", "-b", "feat/work");
    await commitFile(root, "feat.ts", "export const y = 2;\n", "feature commit");

    await git(root, "checkout", "main");
    await symlink("/etc/passwd", join(root, "innocent.txt"));
    await git(root, "add", "innocent.txt");
    await git(root, "commit", "-m", "add symlink");
    await git(root, "checkout", "feat/work");

    const res = await checkMergeSafe(root, "main", { mode: "head" });
    expect(res.safe).toBe(false);
    expect(res.blockedPaths).toContain("innocent.txt");
  });

  it("refuses expectedTipSha mismatch and dangerous merge driver config", async () => {
    const { root } = await initRepo();
    await git(root, "checkout", "-b", "feat/work");
    await commitFile(root, "feat.ts", "export const y = 2;\n", "feature commit");
    await git(root, "checkout", "main");
    await commitFile(root, "base.ts", "export const b = 1;\n", "base commit");
    await git(root, "checkout", "feat/work");

    const mismatch = await checkMergeSafe(root, "main", {
      mode: "base",
      expectedTipSha: "0".repeat(40),
    });
    expect(mismatch.safe).toBe(false);
    expect(mismatch.reason).toContain("does not match");

    await git(root, "config", "merge.evil.driver", "true");
    const driverErr = await checkMergeSafe(root, "main", { mode: "base" });
    expect(driverErr.safe).toBe(false);
    expect(driverErr.reason).toContain("merge.evil.driver");

    await git(root, "config", "--unset", "merge.evil.driver");
    await git(root, "config", "hook.evil.command", "true");
    const hookErr = await checkMergeSafe(root, "main", { mode: "base" });
    expect(hookErr.safe).toBe(false);
    expect(hookErr.reason).toContain("hook.evil.command");
  });
});
