import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CLEAN_ENV, findMuse, formatModels, launch } from "../muse-acp.mjs";

const SHIM = fileURLToPath(new URL("../muse-clean", import.meta.url));
const exe = (...paths) => (p) => paths.includes(p);

test("findMuse: MUSE_CODE_EXECUTABLE, then PATH, then ~/.local/bin", () => {
  assert.equal(findMuse({ MUSE_CODE_EXECUTABLE: "/opt/muse", PATH: "/bin" }, "/h", exe()), "/opt/muse");
  assert.equal(findMuse({ MUSE_CODE_EXECUTABLE: SHIM, PATH: "/x" }, "/h", exe("/x/muse")), "/x/muse"); // never the shim itself
  assert.equal(findMuse({ PATH: "/a:/b" }, "/h", exe("/b/muse", "/h/.local/bin/muse")), "/b/muse");
  assert.equal(findMuse({ PATH: "/usr/bin" }, "/h", exe("/h/.local/bin/muse")), "/h/.local/bin/muse");
  assert.equal(findMuse({ PATH: "/usr/bin" }, "/h", exe()), null);
});

test("launch: clean env, muse through the shim, --full only turns the sandbox off", () => {
  const plan = launch([], { PATH: "/b" }, "/h", exe("/b/muse"));
  assert.deepEqual(plan.argv, []);
  assert.deepEqual(plan.env, { ...CLEAN_ENV, MUSE_CODE_EXECUTABLE: SHIM, MUSE_ACP_REAL_MUSE: "/b/muse" });
  assert.equal(CLEAN_ENV.MUSE_CONTRIBUTOR_MODE, "0");
  assert.equal(CLEAN_ENV.MUSE_EXPERIMENTAL_FOREIGN_PERSONAL_CONTEXT_KILL, "1");
  const full = launch(["--full"], { PATH: "/b" }, "/h", exe("/b/muse"));
  assert.deepEqual(full.argv, []);
  assert.equal(full.env.MUSE_ACP_FULL, "1");
});

test("launch: a missing muse fails with the install command, except for --version", () => {
  assert.throws(() => launch([], { PATH: "/usr/bin" }, "/h", exe()), /dev\.meta\.ai\/install\.sh/);
  assert.deepEqual(launch(["--version"], { PATH: "/usr/bin" }, "/h", exe()).argv, ["--version"]);
});

test("formatModels: one `id - name` line per model, contributor variants left out", () => {
  const models = [
    { id: "muse-wonder-full-1.0", name: "muse-wonder-full-1.0" },
    { id: "muse-wonder-full-1.0-contributor", name: "muse-wonder-1.0-contributor" },
    { id: "muse-spark-1.3", name: "Spark" },
  ];
  assert.equal(formatModels(models), "muse-wonder-full-1.0 - Muse Wonder Full 1.0\nmuse-spark-1.3 - Spark\n");
  assert.equal(formatModels(models, "muse-spark-1.3"), "muse-spark-1.3 - Spark\nmuse-wonder-full-1.0 - Muse Wonder Full 1.0\n");
  assert.equal(formatModels(models, "muse-wonder-full-1.0-contributor"), "muse-wonder-full-1.0 - Muse Wonder Full 1.0\nmuse-spark-1.3 - Spark\n");
});

test("muse-clean: serve and exec get contributor mode off, no reminders and no hooks; the rest passes through", () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-clean-"));
  try {
    const fake = join(dir, "muse");
    writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${dir}/args"\n`, { mode: 0o755 });
    const run = (args, extra = {}) => {
      const r = spawnSync(SHIM, args, { env: { PATH: process.env.PATH, MUSE_ACP_REAL_MUSE: fake, ...extra }, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return readFileSync(join(dir, "args"), "utf8").trim().split("\n");
    };
    const clean = ["--contributor-mode", "off", "-c", "run.reminder_roster=[]", "-c", "managed_hooks_path=null", "-c", "hooks={}"];
    assert.deepEqual(run(["serve"]), ["serve", ...clean]);
    assert.deepEqual(run(["exec", "--json", "hi there"]), ["exec", ...clean, "--json", "hi there"]);
    assert.deepEqual(run(["serve", "--help"], { MUSE_ACP_FULL: "1" }), ["serve", ...clean, "--disable-sandbox", "--help"]);
    assert.deepEqual(run(["--version"]), ["--version"]);
    assert.deepEqual(run(["skills", "list", "--json"]), ["skills", "list", "--json"]);
    const r = spawnSync(SHIM, ["serve"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /started by muse-acp/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
