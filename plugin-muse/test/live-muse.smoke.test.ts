// Opt-in live smoke test: the plugin's bridge drives the installed muse-acp and the
// signed-in muse for two turns (muse-spark-1.3 unless MUSE_SMOKE_MODEL is set). Costs two small Muse turns.
//   MUSE_SMOKE=1 npx vitest run test/live-muse.smoke.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  experimental_assembleCapturedThreadEvents as assembleCapturedThreadEvents,
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { CapturedBridgeNotification } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_providerBridge } from "../src/host.js";
import { museLaunchSpec } from "../src/declaration.js";

describe.runIf(process.env.MUSE_SMOKE === "1")("live muse", () => {
  it("runs two Argon turns with a tool call through agy-acp", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "muse-smoke-"));
    writeFileSync(join(cwd, "note.txt"), "hello from the bridge smoke test\n");
    const h = createBridgeJsonRpcTestHarness(experimental_providerBridge.handleLine);
    const options = {
      model: process.env.MUSE_SMOKE_MODEL ?? "muse-spark-1.3",
      permissionMode: "accept-edits",
      permissionScope: "workspace",
      approvalReviewer: "user",
      permissionEscalation: "ask",
      providerOptions: { acpLaunchSpec: museLaunchSpec(process.env.MUSE_ACP_COMMAND ?? "muse-acp") },
    };
    const reply = async (id: number, method: string, params: Record<string, unknown>) => {
      h.sendRequest(id, method, params as never);
      const r = await h.waitForResponse(id);
      if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
      return r.result as Record<string, unknown>;
    };
    const events = () => assembleCapturedThreadEvents(h.messages.filter((m) => m.method !== undefined && m.id === undefined) as CapturedBridgeNotification[], "acp-muse");
    const completedTurns = () => events().filter((e) => e.type === "turn/completed").length;
    const waitTurns = async (n: number) => {
      const end = Date.now() + 240_000;
      while (completedTurns() < n && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
      expect(completedTurns()).toBe(n);
    };

    await reply(1, "initialize", { protocolVersion: 1, client: { name: "muse-smoke", version: "0.0.1" }, grammarVersions: [3, 3] });
    const started = await reply(2, "thread/start", { threadId: "smoke", cwd, options, instructionMode: "append" });
    const providerThreadId = started.providerThreadId as string;
    const turn = (id: number, text: string) =>
      reply(id, "turn/start", { threadId: "smoke", providerThreadId, input: [{ type: "text", text, mentions: [] }], clientRequestId: `creq_smkagyacp${"23456789"[id]}`, options });

    await turn(3, "Use a tool to read note.txt in the current directory and tell me its exact contents in one line.");
    await waitTurns(1);
    await turn(4, "What file did you just read? Answer in five words or fewer.");
    await waitTurns(2);
    await reply(5, "thread/stop", { threadId: "smoke", providerThreadId, intent: "release", activeTurnId: null });

    const all = events();
    const summary = all.map((e) => e.type).filter((t, i, a) => t !== a[i - 1]);
    const report = { providerThreadId, events: summary, completedItems: all.filter((e) => e.type === "item/completed") };
    if (process.env.MUSE_SMOKE_OUT) writeFileSync(process.env.MUSE_SMOKE_OUT, JSON.stringify(report, null, 1));
    expect(JSON.stringify(all)).toContain("hello from the bridge smoke test");
    expect(all.some((e) => e.type === "item/completed" && JSON.stringify(e).includes("note.txt") && !JSON.stringify(e).includes("agentMessage"))).toBe(true);
  }, 600_000);
});
