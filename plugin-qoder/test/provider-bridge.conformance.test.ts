// Runs the SDK's bridge conformance suite against what src/host.ts ships, with Qoder's
// declared launch spec pointed at fake-qoder-acp.mjs: start, resume, tip fork, prompt
// deltas, interrupt and release stops. Queued steer is not in the suite; host.test.ts covers it.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { CapturedBridgeJsonRpcOutput } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_providerBridge } from "../src/host.js";
import { qoderLaunchSpec, qoderProviderDeclaration } from "../src/declaration.js";

const FAKE = fileURLToPath(new URL("./fake-qoder-acp.mjs", import.meta.url));
let output: CapturedBridgeJsonRpcOutput;
let dir: string;

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Pids of every Qoder process the suite launched, from the fake's log.
const pids = () => {
  const path = join(dir, "fake.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    const { pid } = JSON.parse(line) as { pid?: number };
    return pid === undefined ? [] : [pid];
  });
};
const allExited = () => (pids().every((pid) => !alive(pid)) ? true : undefined);

async function until<T>(probe: () => T | undefined, what: string, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qoder-conformance-"));
  output = captureBridgeJsonRpcOutput();
});

afterEach(async () => {
  output.restore();
  for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGKILL");
  await until(allExited, "every Qoder process to exit").catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

it("passes the SDK bridge conformance suite with Qoder's launch spec", async () => {
  const bridgeOptions = qoderProviderDeclaration(FAKE).experimental_bridgeOptions as Record<string, unknown>;
  const report = await runBridgeConformance({
    transport: { send: experimental_providerBridge.handleLine, takeMessages: output.takeMessages },
    providerId: "qoder",
    session: {
      cwd: dir,
      promptInput: [{ type: "text", text: "say hello", mentions: [] }],
      zeroWorkPromptInput: [{ type: "text", text: "zero-work", mentions: [] }],
      interruptiblePromptInput: [{ type: "text", text: "hang", mentions: [] }],
      options: {
        permissionMode: "accept-edits",
        permissionScope: "workspace",
        approvalReviewer: "user",
        permissionEscalation: "ask",
        model: "qmodel_latest",
        reasoningLevel: "high",
        providerOptions: { ...bridgeOptions, acpLaunchSpec: { ...qoderLaunchSpec(FAKE), env: { FAKE_QODER_LOG: join(dir, "fake.log") } } },
      },
    },
    timeoutMs: 15_000,
  });
  output.restore();
  console.info(`qoder bridge conformance:\n${formatConformanceReport(report)}`);
  expect(report.results.filter((r) => r.status === "fail")).toEqual([]);
  const passed = new Set(report.results.filter((r) => r.status === "pass").map((r) => r.id));
  // The suite's final release stop leaves no Qoder process behind.
  await until(allExited, "every Qoder process to exit");
  for (const id of [
    "session/start-identity",
    "turn/lifecycle",
    "item/opens-before-delta",
    "stop/release-not-interrupted",
    "session/resume-identity",
    "session/resume-id-uniqueness",
    "session/fork-identity",
    "turn/settles-without-activity",
    "session/threads-independent",
    "stop/interrupt-settles-before-result",
  ]) {
    expect(passed, id).toContain(id);
  }
}, 90_000);
