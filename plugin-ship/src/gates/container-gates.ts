import type { PolledCheckRunOutput } from "../contract.js";

export type ContainerGateRepoKind = "pmzbot" | "AiTradingBot" | "rust-pmz-copytrading" | "generic";

export interface ContainerGateInspection {
  repoKind: ContainerGateRepoKind;
  hasBootstrapCloudroom: boolean;
  bootstrapScriptPath: string | null;
  hasMergeEligibilityScript: boolean;
  mergeEligibilityScriptPath: string | null;
  hasKiriRunner: boolean;
  kiriFiles: string[];
  inCloudSandbox: boolean;
  baseBranch: string | null;
  supportedForBase: boolean;
  unsupportedReason: string | null;
  recommendedGateCommand: string | null;
  containerConstraints: string[];
}

export interface ParsedGateReceipt {
  repo: string;
  base: string;
  commit: string;
  gate: string;
  result: "PASS" | "FAIL";
  passedCount: number | null;
  failedCount: number | null;
  skippedCount: number | null;
  wall: string | null;
  host: string | null;
  bootstrap: string | null;
  notRun: string | null;
  sourceAuthor: string | null;
  sourceKind: string | null;
}

export interface EffectiveGateStatus {
  ciGreen: boolean;
  gateSatisfied: boolean;
  gateSource: "github_checks" | "sandbox_receipt" | "none";
  failingChecks: number;
  pendingChecks: number;
  totalChecks: number;
  receipt: ParsedGateReceipt | null;
}

export interface TrustedReceiptSource {
  text: string;
  authorLogin?: string | null;
  kind?: string | null;
}

const PASSING_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

const CONTAINER_CONSTRAINTS: readonly string[] = [
  "/var/tmp is noexec (set PMZBOT_UNIT_TMP_ROOT=/tmp)",
  "/dev/shm is 256 MiB",
  "8 GiB RAM cgroup (run one full gate at a time)",
  "no Docker-in-Docker",
];

/**
 * Identify a repository's container merge-guard gate kind from its slug or directory basename.
 */
export function classifyContainerGateRepo(repoSlugOrName: string | null | undefined): ContainerGateRepoKind {
  if (!repoSlugOrName) return "generic";
  const short = repoSlugOrName.split("/").pop()?.trim().toLowerCase() ?? "";
  if (short === "pmzbot" || short.startsWith("pmzbot-")) return "pmzbot";
  if (short === "aitradingbot" || short.startsWith("aitradingbot-")) return "AiTradingBot";
  if (short === "rust-pmz-copytrading" || short.startsWith("rust-pmz-copytrading")) {
    return "rust-pmz-copytrading";
  }
  return "generic";
}

/**
 * Compute container merge-guard capabilities, base-branch restrictions, and exact gate commands.
 */
export function detectContainerGatePlan(input: {
  repoSlug?: string | null;
  repoDirName?: string | null;
  baseBranch?: string | null;
  hasBootstrapCloudroom: boolean;
  bootstrapScriptPath?: string | null;
  hasMergeEligibilityScript: boolean;
  mergeEligibilityScriptPath?: string | null;
  kiriFiles: readonly string[];
  inCloudSandbox: boolean;
}): ContainerGateInspection {
  const kindFromSlug = classifyContainerGateRepo(input.repoSlug);
  const repoKind =
    kindFromSlug !== "generic" ? kindFromSlug : classifyContainerGateRepo(input.repoDirName);

  const baseBranch = input.baseBranch?.trim() || null;
  let supportedForBase = true;
  let unsupportedReason: string | null = null;

  if (repoKind === "pmzbot" && baseBranch && baseBranch.toLowerCase() !== "dev") {
    supportedForBase = false;
    unsupportedReason = `pmzbot sandbox bootstrap is supported for base branch "dev" only (beta/master are unsupported; got "${baseBranch}").`;
  }

  let recommendedGateCommand: string | null = null;
  if (input.hasBootstrapCloudroom && supportedForBase) {
    switch (repoKind) {
      case "pmzbot":
        recommendedGateCommand =
          "PMZBOT_UNIT_TMP_ROOT=/tmp bash scripts/ci/bootstrap-cloudroom.sh && source /etc/profile.d/pmzbot-ci.sh && bash scripts/ci/self-hosted-runner/guest/container-smoke.sh smoke && ./run-unit-tests.sh -c Release && ./run-integration-tests.sh -c Release";
        break;
      case "AiTradingBot":
        recommendedGateCommand =
          "bash scripts/ci/bootstrap-cloudroom.sh && /opt/aitradingbot-ci/run-with-postgres.sh smoke";
        break;
      case "rust-pmz-copytrading":
        recommendedGateCommand = "bash scripts/ci/bootstrap-cloudroom.sh --gate full --smoke-release";
        break;
      default:
        recommendedGateCommand = "bash scripts/ci/bootstrap-cloudroom.sh";
        break;
    }
  }

  const kiriFiles = [...input.kiriFiles].sort();
  return {
    repoKind,
    hasBootstrapCloudroom: input.hasBootstrapCloudroom,
    bootstrapScriptPath: input.hasBootstrapCloudroom
      ? (input.bootstrapScriptPath ?? "scripts/ci/bootstrap-cloudroom.sh")
      : null,
    hasMergeEligibilityScript: input.hasMergeEligibilityScript,
    mergeEligibilityScriptPath: input.hasMergeEligibilityScript
      ? (input.mergeEligibilityScriptPath ?? "scripts/ci/merge-eligibility.sh")
      : null,
    hasKiriRunner: kiriFiles.length > 0,
    kiriFiles,
    inCloudSandbox: input.inCloudSandbox,
    baseBranch,
    supportedForBase,
    unsupportedReason,
    recommendedGateCommand,
    containerConstraints: [...CONTAINER_CONSTRAINTS],
  };
}

function parseResultLine(raw: string): {
  result: "PASS" | "FAIL" | null;
  passedCount: number | null;
  failedCount: number | null;
  skippedCount: number | null;
} {
  const verdictMatch = /\b(PASS|FAIL)\b/i.exec(raw);
  if (!verdictMatch) {
    return { result: null, passedCount: null, failedCount: null, skippedCount: null };
  }
  const result = verdictMatch[1]!.toUpperCase() === "PASS" ? "PASS" : "FAIL";
  const passedMatch = /\bpassed=(\d+)\b/i.exec(raw);
  const failedMatch = /\bfailed=(\d+)\b/i.exec(raw);
  const skippedMatch = /\bskipped=(\d+)\b/i.exec(raw);
  return {
    result,
    passedCount: passedMatch ? Number.parseInt(passedMatch[1]!, 10) : null,
    failedCount: failedMatch ? Number.parseInt(failedMatch[1]!, 10) : null,
    skippedCount: skippedMatch ? Number.parseInt(skippedMatch[1]!, 10) : null,
  };
}

/**
 * Parse `cloudroom-sandbox-gates` `Gate receipt` blocks from a PR body or trusted comment.
 */
export function parseGateReceipts(
  text: string,
  meta: { authorLogin?: string | null; kind?: string | null } = {},
): ParsedGateReceipt[] {
  const lines = text.split(/\r?\n/u);
  const receipts: ParsedGateReceipt[] = [];

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!.trim().replace(/^[#>*`\s]+/u, "").replace(/[*`:]+$/u, "");
    if (!/^Gate receipt$/i.test(header)) continue;

    const kv = new Map<string, string>();
    let hasUnexpectedFailSuiteLine = false;

    for (let j = i + 1; j < lines.length; j++) {
      const rawLine = lines[j]!;
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("```") || trimmed === "---") {
        if (kv.size > 0) break;
        continue;
      }
      if (/^[#>*`\s]*Gate receipt\b/i.test(trimmed)) break;

      const kvMatch = /^(?:[-*]\s*)?([a-z][a-z _-]{0,30}):\s*(.*)$/i.exec(trimmed);
      if (kvMatch) {
        const key = kvMatch[1]!.trim().toLowerCase();
        const val = kvMatch[2]!.trim();
        kv.set(key, val);
        if (key !== "not run" && key !== "result" && /\bFAIL\b/.test(val)) {
          hasUnexpectedFailSuiteLine = true;
        }
        continue;
      }

      if (kv.size === 0) break;
      if (/\bFAIL\b/.test(trimmed)) {
        hasUnexpectedFailSuiteLine = true;
      }
    }

    const commitRaw = kv.get("commit")?.toLowerCase() ?? "";
    const resultRaw = kv.get("result") ?? "";
    if (!/^[0-9a-f]{40}$/u.test(commitRaw) || !resultRaw) {
      continue;
    }

    const parsedRes = parseResultLine(resultRaw);
    if (!parsedRes.result) continue;

    const effectiveResult: "PASS" | "FAIL" =
      parsedRes.result === "PASS" &&
      (parsedRes.failedCount === null || parsedRes.failedCount === 0) &&
      !hasUnexpectedFailSuiteLine
        ? "PASS"
        : "FAIL";

    receipts.push({
      repo: kv.get("repo") ?? "",
      base: kv.get("base") ?? "",
      commit: commitRaw,
      gate: kv.get("gate") ?? "container-gate",
      result: effectiveResult,
      passedCount: parsedRes.passedCount,
      failedCount: parsedRes.failedCount,
      skippedCount: parsedRes.skippedCount,
      wall: kv.get("wall") ?? null,
      host: kv.get("host") ?? null,
      bootstrap: kv.get("bootstrap") ?? null,
      notRun: kv.get("not run") ?? null,
      sourceAuthor: meta.authorLogin ?? null,
      sourceKind: meta.kind ?? null,
    });
  }

  return receipts;
}

/**
 * Find the latest trusted passing `Gate receipt` matching `expectedHeadSha` verbatim.
 */
export function findPassingGateReceiptForSha(
  sources: readonly TrustedReceiptSource[],
  expectedHeadSha: string,
): ParsedGateReceipt | null {
  const normSha = expectedHeadSha.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(normSha)) return null;

  let latestMatch: ParsedGateReceipt | null = null;
  for (const src of sources) {
    const parsed = parseGateReceipts(src.text, {
      authorLogin: src.authorLogin ?? null,
      kind: src.kind ?? null,
    });
    for (const r of parsed) {
      if (
        r.commit === normSha &&
        r.result === "PASS" &&
        (r.failedCount === null || r.failedCount === 0)
      ) {
        latestMatch = r;
      }
    }
  }
  return latestMatch;
}

/**
 * Format a canonical `cloudroom-sandbox-gates` `Gate receipt` block.
 */
export function formatGateReceipt(input: {
  repo: string;
  base: string;
  commit: string;
  gate: string;
  result: "PASS" | "FAIL";
  passedCount?: number | null;
  failedCount?: number | null;
  skippedCount?: number | null;
  wall: string;
  host: string;
  bootstrap: string;
  notRun?: string | null;
}): string {
  const counts: string[] = [];
  if (typeof input.passedCount === "number") counts.push(`passed=${input.passedCount}`);
  if (typeof input.failedCount === "number") counts.push(`failed=${input.failedCount}`);
  if (typeof input.skippedCount === "number") counts.push(`skipped=${input.skippedCount}`);
  const resultLine = counts.length > 0 ? `${input.result} ${counts.join(" ")}` : input.result;

  return [
    "Gate receipt",
    `  repo:      ${input.repo}`,
    `  base:      ${input.base}`,
    `  commit:    ${input.commit}`,
    `  gate:      ${input.gate}`,
    `  result:    ${resultLine}`,
    `  wall:      ${input.wall}`,
    `  host:      ${input.host}`,
    `  bootstrap: ${input.bootstrap}`,
    `  not run:   ${input.notRun ?? "none"}`,
  ].join("\n");
}

/**
 * Combine GitHub check runs with an optional trusted exact-SHA sandbox `Gate receipt`.
 * Real failing or pending GitHub checks are NEVER overridden by a sandbox receipt.
 */
export function evaluateEffectiveGateStatus(
  checkRuns: readonly PolledCheckRunOutput[],
  passingReceipt: ParsedGateReceipt | null,
): EffectiveGateStatus {
  const pendingChecks = checkRuns.filter(
    (c) => c.conclusion === null || c.status.toLowerCase() !== "completed",
  ).length;
  const failingChecks = checkRuns.filter(
    (c) =>
      c.status.toLowerCase() === "completed" &&
      c.conclusion !== null &&
      !PASSING_CHECK_CONCLUSIONS.has(c.conclusion.toLowerCase()),
  ).length;
  const totalChecks = checkRuns.length;

  if (totalChecks > 0 && pendingChecks === 0 && failingChecks === 0) {
    return {
      ciGreen: true,
      gateSatisfied: true,
      gateSource: "github_checks",
      failingChecks,
      pendingChecks,
      totalChecks,
      receipt: passingReceipt,
    };
  }

  if (failingChecks === 0 && pendingChecks === 0 && passingReceipt !== null) {
    return {
      ciGreen: true,
      gateSatisfied: true,
      gateSource: "sandbox_receipt",
      failingChecks,
      pendingChecks,
      totalChecks,
      receipt: passingReceipt,
    };
  }

  return {
    ciGreen: false,
    gateSatisfied: false,
    gateSource: "none",
    failingChecks,
    pendingChecks,
    totalChecks,
    receipt: null,
  };
}
