#!/usr/bin/env node
// muse-acp: the pinned @bex-co/muse-code-acp ACP adapter, launched so that Muse
// sessions started from Cloudroom stay clean: contributor mode off, no foreign
// personal rules or skills (Claude Code / Codex), and muse itself run through
// muse-clean (no reminder observers, no hooks). `--full` also turns Muse's OS
// sandbox off. `--list-models [--first ID]` prints Muse's live model catalog, one
// `id - name` line per model, ID first, without contributor variants (the adapter
// only learns the catalog after its first session starts a Muse host).
// Muse keeps its own login (or META_API_KEY); nothing here reads it.

import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLEAN_ENV = {
  MUSE_CONTRIBUTOR_MODE: "0",
  MUSE_EXPERIMENTAL_FOREIGN_PERSONAL_CONTEXT_KILL: "1",
};
const SHIM = fileURLToPath(new URL("./muse-clean", import.meta.url));

const isExecutable = (path) => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

// The real muse: $MUSE_CODE_EXECUTABLE, then muse on PATH, then ~/.local/bin/muse (the installer's default).
export function findMuse(env = process.env, home = homedir(), executable = isExecutable) {
  if (env.MUSE_CODE_EXECUTABLE && env.MUSE_CODE_EXECUTABLE !== SHIM) return env.MUSE_CODE_EXECUTABLE;
  const dirs = [...(env.PATH ?? "").split(delimiter), join(home, ".local", "bin")];
  return dirs.filter(Boolean).map((dir) => join(dir, "muse")).find(executable) ?? null;
}

// Returns the adapter's argv and the env changes; throws when muse is missing.
export function launch(argv, env = process.env, home = homedir(), executable = isExecutable) {
  const passthrough = argv.includes("--version") || argv.includes("-v");
  const muse = findMuse(env, home, executable);
  if (!muse && !passthrough) {
    throw new Error("muse not found: install it with `curl -fsSL https://dev.meta.ai/install.sh | sh` or set MUSE_CODE_EXECUTABLE");
  }
  const full = argv.includes("--full");
  return {
    argv: argv.filter((a) => a !== "--full"),
    env: { ...CLEAN_ENV, MUSE_CODE_EXECUTABLE: SHIM, MUSE_ACP_REAL_MUSE: muse ?? "", ...(full ? { MUSE_ACP_FULL: "1" } : {}) },
  };
}

const isContributor = (id) => id.endsWith("-contributor");

// Muse labels most models with their id; "muse-wonder-full-1.0" reads better as "Muse Wonder Full 1.0".
const label = (m) => (m.name === m.id ? m.id.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") : m.name);

// The first line is the client's default (Cloudroom's bridge makes it so).
export function formatModels(models, first) {
  const rows = models.filter((m) => !isContributor(m.id));
  rows.sort((a, b) => (b.id === first) - (a.id === first));
  return rows.map((m) => `${m.id} - ${label(m)}\n`).join("");
}

async function listModels(first) {
  const { MuseModelDiscovery } = await import("@bex-co/muse-code-acp/dist/model-discovery.js");
  const discovery = new MuseModelDiscovery({ env: process.env, logger: { log: (m) => console.error(m) }, timeoutMs: 25_000 });
  const catalog = await discovery.discover(process.cwd());
  await discovery.dispose();
  if (catalog.status !== "available") throw new Error(catalog.reason);
  // A signed-out muse lists nothing; this wording makes Cloudroom show its sign-in hint.
  if (catalog.models.length === 0) throw new Error("Authentication required: Muse listed no models; run `muse login` on this machine or set META_API_KEY");
  process.stdout.write(formatModels(catalog.models, first));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === (await import("node:fs")).realpathSync(process.argv[1])) {
  let plan;
  try {
    plan = launch(process.argv.slice(2));
  } catch (error) {
    console.error(`muse-acp: ${error.message}`);
    process.exit(1);
  }
  if (plan.env.MUSE_ACP_FULL !== "1") delete process.env.MUSE_ACP_FULL;
  Object.assign(process.env, plan.env);
  if (plan.argv.includes("--list-models")) {
    const at = plan.argv.indexOf("--first");
    await listModels(at >= 0 ? plan.argv[at + 1] : undefined).catch((error) => {
      console.error(`muse-acp: ${error.message}`);
      process.exitCode = 1;
    });
  } else {
    process.argv = [process.argv[0], process.argv[1], ...plan.argv];
    await import("@bex-co/muse-code-acp/dist/index.js");
  }
}
