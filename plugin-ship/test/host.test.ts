import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const harnesses: ReturnType<typeof experimental_createHostEntryHarness>[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.experimental_dispose();
  }
  for (const d of dirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function setupRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ship-host-"));
  dirs.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Test Author");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "remote", "add", "origin", "https://github.com/octocat/hello-world.git");
  await writeFile(join(root, "index.ts"), "export const v = 1;\n", "utf8");
  await git(root, "add", "index.ts");
  await git(root, "commit", "-m", "initial");
  return root;
}

describe("host entry RPC handlers", () => {
  it("inspects checkout, detects hard links and .git symlinks, and never leaks .env values", async () => {
    const root = await setupRepo();
    const harness = experimental_createHostEntryHarness(hostEntry);
    harnesses.push(harness);

    await git(root, "checkout", "-b", "feat/demo");
    const targetOutside = join(root, "seed.txt");
    await writeFile(targetOutside, "seed\n", "utf8");
    await git(root, "add", "seed.txt");
    await git(root, "commit", "-m", "add seed");
    await link(targetOutside, join(root, "hardlink-copy.txt"));

    const secretVal = ["ship_secret_", "xyz987654"].join("");
    await writeFile(join(root, ".env"), `API_SECRET=${secretVal}\n`, "utf8");

    const info = await harness.experimental_call("inspectCheckout", { root });
    expect(info.branch).toBe("feat/demo");
    expect(info.isDetached).toBe(false);
    expect(info.isClean).toBe(false);
    expect(info.remotes).toEqual([
      { name: "origin", url: "https://github.com/octocat/hello-world.git", kind: "fetch" },
      { name: "origin", url: "https://github.com/octocat/hello-world.git", kind: "push" },
    ]);
    expect(info.hardLinks).toContain("hardlink-copy.txt");
    expect(info.gitDirLinkIssue).toBeNull();

    // Verify outbound local secret scan reports source name ONLY, never the secret value
    const scanHit = await harness.experimental_call("scanOutboundForLocalSecrets", {
      root,
      text: `oops ${secretVal}`,
    });
    expect(scanHit).toEqual({ ok: false, matchedSource: "API_SECRET in .env" });
    expect(JSON.stringify(scanHit)).not.toContain(secretVal);

    const scanClean = await harness.experimental_call("scanOutboundForLocalSecrets", {
      root,
      text: "Fixed failing parser test",
    });
    expect(scanClean).toEqual({ ok: true, matchedSource: null });

    // Compute and verify pins, then trigger drift
    const snap = await harness.experimental_call("computePins", { root });
    expect(snap.ok).toBe(true);
    expect(await harness.experimental_call("verifyPins", { root, expectedPins: snap.pins })).toEqual({
      ok: true,
      driftedKey: null,
      reason: null,
    });

    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, ".claude", "settings.json"), "{}\n", "utf8");
    const drifted = await harness.experimental_call("verifyPins", { root, expectedPins: snap.pins });
    expect(drifted.ok).toBe(false);
    expect(drifted.driftedKey).toContain(".claude/settings.json");

    // Detect .git/COMMIT_EDITMSG symlink tampering
    await rm(join(root, ".git", "COMMIT_EDITMSG"), { force: true });
    await symlink("/tmp/outside-msg", join(root, ".git", "COMMIT_EDITMSG"));
    const infoWithLink = await harness.experimental_call("inspectCheckout", { root });
    expect(infoWithLink.gitDirLinkIssue).toContain("COMMIT_EDITMSG");
  });

  it("simulates safe vs protected merges through checkMergeSafe", async () => {
    const root = await setupRepo();
    const harness = experimental_createHostEntryHarness(hostEntry);
    harnesses.push(harness);

    await git(root, "checkout", "-b", "feat/work");
    await writeFile(join(root, "work.ts"), "export const w = 1;\n", "utf8");
    await git(root, "add", "work.ts");
    await git(root, "commit", "-m", "work");

    await git(root, "checkout", "main");
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, ".claude", "settings.local.json"), '{"x":1}\n', "utf8");
    await git(root, "add", ".claude/settings.local.json");
    await git(root, "commit", "-m", "settings change");
    await git(root, "checkout", "feat/work");

    const check = await harness.experimental_call("checkMergeSafe", {
      root,
      targetRef: "main",
      mode: "base",
    });
    expect(check.safe).toBe(false);
    expect(check.blockedPaths).toContain(".claude/settings.local.json");
  });
});
