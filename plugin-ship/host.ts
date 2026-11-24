import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, type CheckoutInspection } from "./src/contract.js";
import { defaultGitExec } from "./src/safety/git-exec.js";
import { checkGitDirPlain, checkMergeSafe } from "./src/safety/merge-guard.js";
import { computeCheckoutPins, diffPins } from "./src/safety/pins.js";
import { collectLocalSecrets, findLocalSecretMatch } from "./src/safety/secrets.js";

function parsePorcelainV2Z(stdout: string): { changedFiles: string[]; submodules: string[] } {
  const tokens = stdout.split("\0");
  const changed = new Set<string>();
  const submodules = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok) continue;
    if (tok.startsWith("? ")) {
      const p = tok.slice(2);
      if (p) {
        changed.add(p);
        if (p.endsWith("/")) submodules.add(p);
      }
    } else if (tok.startsWith("1 ")) {
      const parts = tok.split(" ");
      const sub = parts[2] ?? "";
      const p = parts.slice(8).join(" ");
      if (p) {
        changed.add(p);
        if (sub.startsWith("S") || p.endsWith("/")) submodules.add(p);
      }
    } else if (tok.startsWith("u ")) {
      const parts = tok.split(" ");
      const sub = parts[2] ?? "";
      const p = parts.slice(10).join(" ");
      if (p) {
        changed.add(p);
        if (sub.startsWith("S") || p.endsWith("/")) submodules.add(p);
      }
    } else if (tok.startsWith("2 ")) {
      const parts = tok.split(" ");
      const sub = parts[2] ?? "";
      const p = parts.slice(9).join(" ");
      if (p) {
        changed.add(p);
        if (sub.startsWith("S") || p.endsWith("/")) submodules.add(p);
      }
      // Rename/copy emits the source path as the next NUL token.
      i += 1;
    }
  }

  return { changedFiles: [...changed], submodules: [...submodules] };
}

function parseRemotes(stdout: string): CheckoutInspection["remotes"] {
  const out: CheckoutInspection["remotes"] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(\S+)\t(.+) \((fetch|push)\)(?: \[[^\]]*\])?$/u.exec(line.trimEnd());
    if (m) {
      out.push({ name: m[1]!, url: m[2]!, kind: m[3]! as "fetch" | "push" });
    }
  }
  return out;
}

async function detectInProgressOp(gitDir: string): Promise<string | null> {
  const ops: readonly { marker: string; label: string }[] = [
    { marker: "MERGE_HEAD", label: "merge" },
    { marker: "REBASE_HEAD", label: "rebase" },
    { marker: "rebase-merge", label: "rebase" },
    { marker: "rebase-apply", label: "rebase" },
    { marker: "CHERRY_PICK_HEAD", label: "cherry-pick" },
    { marker: "REVERT_HEAD", label: "revert" },
    { marker: "sequencer", label: "sequencer" },
  ];
  for (const op of ops) {
    const exists = await lstat(join(gitDir, op.marker)).then(
      () => true,
      () => false,
    );
    if (exists) return op.label;
  }
  return null;
}

export async function inspectCheckoutAt(root: string): Promise<CheckoutInspection> {
  const topRes = await defaultGitExec(root, ["rev-parse", "--show-toplevel"]);
  if (topRes.code !== 0 || topRes.stdout.trim() === "") {
    throw new Error(`Not a git repository: ${topRes.stderr.trim() || root}`);
  }
  const topRoot = topRes.stdout.trim();

  const [gitDirRes, commonDirRes, headRes, symRefRes, statusRes, remoteRes] = await Promise.all([
    defaultGitExec(topRoot, ["rev-parse", "--path-format=absolute", "--git-dir"]),
    defaultGitExec(topRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    defaultGitExec(topRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]),
    defaultGitExec(topRoot, ["symbolic-ref", "--quiet", "HEAD"]),
    defaultGitExec(topRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames"]),
    defaultGitExec(topRoot, ["remote", "-v"]),
  ]);

  if (gitDirRes.code !== 0 || commonDirRes.code !== 0 || statusRes.code !== 0) {
    throw new Error("git inspection failed inside checkout");
  }

  const gitDir = gitDirRes.stdout.trim();
  const commonDir = commonDirRes.stdout.trim();
  const headSha = headRes.code === 0 && headRes.stdout.trim() !== "" ? headRes.stdout.trim() : null;
  const rawSym = symRefRes.code === 0 ? symRefRes.stdout.trim() : "";
  const branch = rawSym.startsWith("refs/heads/") ? rawSym.slice("refs/heads/".length) : null;
  const { changedFiles, submodules } = parsePorcelainV2Z(statusRes.stdout);

  const [inProgressOp, gitDirLinkIssue, hardLinkFlags] = await Promise.all([
    detectInProgressOp(gitDir),
    checkGitDirPlain(gitDir, commonDir),
    Promise.all(
      changedFiles.map((rel) =>
        lstat(join(topRoot, rel)).then(
          (st) => st.isFile() && st.nlink > 1,
          () => false,
        ),
      ),
    ),
  ]);

  const hardLinks = changedFiles.filter((_, idx) => hardLinkFlags[idx]);

  return {
    root: topRoot,
    gitDir,
    commonDir,
    headSha,
    branch,
    isDetached: branch === null,
    isClean: changedFiles.length === 0,
    inProgressOp,
    remotes: parseRemotes(remoteRes.stdout),
    changedFiles,
    hardLinks,
    submodules,
    gitDirLinkIssue,
  };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    inspectCheckout: async ({ root }) => inspectCheckoutAt(root),
    computePins: async ({ root }) => {
      const snap = await computeCheckoutPins(root);
      return snap.ok ? { ok: true, pins: snap.pins, error: null } : { ok: false, pins: {}, error: snap.error };
    },
    verifyPins: async ({ root, expectedPins }) => {
      const snap = await computeCheckoutPins(root);
      if (!snap.ok) {
        return { ok: false, driftedKey: "pins:unreadable", reason: snap.error };
      }
      const drift = diffPins(expectedPins, snap.pins);
      return drift
        ? { ok: false, driftedKey: drift.driftedKey, reason: drift.reason }
        : { ok: true, driftedKey: null, reason: null };
    },
    checkMergeSafe: async ({ root, targetRef, mode, expectedTipSha }) =>
      checkMergeSafe(root, targetRef, { mode, expectedTipSha }),
    scanOutboundForLocalSecrets: async ({ root, text }) => {
      const secrets = await collectLocalSecrets(root);
      const matchedSource = findLocalSecretMatch(text, secrets);
      return { ok: matchedSource === null, matchedSource };
    },
  },
});
