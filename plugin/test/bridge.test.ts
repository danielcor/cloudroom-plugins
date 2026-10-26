// Drives the SDK's ACP bridge (what src/host.ts ships) against the real agy-acp
// adapter and a fake agy that replays recorded agy transcripts.
import { mkdtempSync, rmSync } from "node:fs";
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
import { agyLaunchSpec } from "../src/declaration.js";

const acpDir = fileURLToPath(new URL("../../acp/", import.meta.url));
let output: CapturedBridgeJsonRpcOutput;
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "agy-bridge-"));
  output = captureBridgeJsonRpcOutput();
});

afterEach(() => {
  output.restore();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("passes the SDK bridge conformance suite through agy-acp", async () => {
  const spec = agyLaunchSpec("agy-acp");
  const report = await runBridgeConformance({
    transport: { send: experimental_providerBridge.handleLine, takeMessages: output.takeMessages },
    providerId: "agy",
    session: {
      cwd: workspaceDir,
      promptInput: [{ type: "text", text: "read note.txt", mentions: [] }],
      interruptiblePromptInput: [{ type: "text", text: "hang", mentions: [] }],
      options: {
        permissionMode: "accept-edits",
        permissionScope: "workspace",
        approvalReviewer: "user",
        permissionEscalation: "ask",
        providerOptions: {
          acpLaunchSpec: {
            ...spec,
            permissionCli: { ...spec.permissionCli, insertAfterArgs: 1 }, // after the agy-acp script path
            command: process.execPath,
            args: [join(acpDir, "agy-acp.mjs"), "--agy", join(acpDir, "test", "fake-agy"), "--state-dir", join(workspaceDir, ".state")],
            env: { FAKE_AGY_FIXTURE: join(acpDir, "test", "fixtures", "two-turn-read-file.ndjson"), FAKE_AGY_ON_SIGINT: join(acpDir, "test", "fixtures", "interrupted-result.ndjson") },
          },
        },
      },
    },
    timeoutMs: 15_000,
  });
  output.restore();
  console.info(`agy bridge conformance:\n${formatConformanceReport(report)}`);
  // The SDK's ACP bridge always reports fork "tip" in its handshake; agy cannot fork, and the
  // provider declares fork "none", so Cloudroom never asks. Every other check must pass.
  const failed = report.results.filter((r) => r.status === "fail").map((r) => r.id);
  expect(failed).toEqual(["session/fork-identity"]);
  expect(report.results.find((r) => r.id === "turn/lifecycle")?.status).toBe("pass");
}, 60_000);
