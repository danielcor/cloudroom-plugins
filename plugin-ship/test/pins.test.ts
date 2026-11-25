import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { computeCheckoutPins, diffPins } from "../src/safety/pins.js";

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

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ship-pins-"));
  dirs.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Test Author");
  await git(root, "config", "user.email", "test@example.com");
  await writeFile(join(root, "README.md"), "hi\n", "utf8");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "init");
  return root;
}

describe("checkout tamper pins", () => {
  it("detects drift when .claude/settings.json, git hooks, or git config changes", async () => {
    const root = await initRepo();
    const snap0 = await computeCheckoutPins(root, { ghConfigDir: join(root, ".gh-none") });
    expect(snap0.ok).toBe(true);
    if (!snap0.ok) return;

    const same = await computeCheckoutPins(root, { ghConfigDir: join(root, ".gh-none") });
    expect(same.ok).toBe(true);
    if (same.ok) expect(diffPins(snap0.pins, same.pins)).toBeNull();

    // 1. Modify .claude/settings.json
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, ".claude", "settings.json"), '{"permissions":{}}\n', "utf8");
    const snap1 = await computeCheckoutPins(root, { ghConfigDir: join(root, ".gh-none") });
    expect(snap1.ok).toBe(true);
    if (snap1.ok) {
      const drift = diffPins(snap0.pins, snap1.pins);
      expect(drift?.driftedKey).toContain(".claude/settings.json");
    }

    // 2. Add an active git hook (non-.sample)
    await mkdir(join(root, ".git", "hooks"), { recursive: true });
    await writeFile(join(root, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 0\n", "utf8");
    const snap2 = await computeCheckoutPins(root, { ghConfigDir: join(root, ".gh-none") });
    expect(snap2.ok).toBe(true);
    if (snap1.ok && snap2.ok) {
      const drift = diffPins(snap1.pins, snap2.pins);
      expect(drift).not.toBeNull();
    }

    // 3. Mutate local git config
    await git(root, "config", "user.name", "Changed Author");
    const snap3 = await computeCheckoutPins(root, { ghConfigDir: join(root, ".gh-none") });
    expect(snap3.ok).toBe(true);
    if (snap2.ok && snap3.ok) {
      const drift = diffPins(snap2.pins, snap3.pins);
      expect(drift).not.toBeNull();
      expect(drift?.driftedKey).toMatch(/\.git\/config$|^git:config$/);
    }
  });
});
