// src/host.ts ships the SDK's generic ACP bridge unchanged. These tests drive that bridge
// against fake-qoder-acp.mjs, a minimal ACP double, to pin what Qoder's launch spec asks of
// it: models from the ACP "model" config option, reasoning through each model's ACP
// "reasoning_effort" option,
// and the Cloudroom permission modes. Real Qoder's own approval behaviour is checked live
// (plan Task 4), not here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { BridgeJsonRpcOutputMessage, BridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_providerBridge } from "../src/host.js";
import { qoderLaunchSpec, qoderProviderDeclaration } from "../src/declaration.js";

const FAKE = fileURLToPath(new URL("./fake-qoder-acp.mjs", import.meta.url));

type LogEntry = { argv?: string[]; dir?: "in" | "out"; method?: string; params?: Record<string, unknown>; id?: unknown; result?: unknown; error?: unknown; reply?: string; end?: string; pid?: number };

let dir: string;
let workspace: string;
let logPath: string;
let h: BridgeJsonRpcTestHarness;
let nextId = 0;
let started: { threadId: string; providerThreadId: string }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qoder-host-"));
  workspace = join(dir, "workspace");
  mkdirSync(workspace);
  logPath = join(dir, "fake.log");
  started = [];
  h = createBridgeJsonRpcTestHarness(experimental_providerBridge.handleLine);
});

// Even when a test fails midway: release every thread it started, kill any Qoder process
// still alive, and wait for them to exit before removing the temporary directory.
afterEach(async () => {
  try {
    for (const { threadId, providerThreadId } of started) {
      await request("thread/stop", { threadId, providerThreadId, intent: "release", activeTurnId: null }).catch(() => undefined);
    }
    for (const { pid } of log()) if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
    await until(allExited, "every Qoder process to exit").catch(() => undefined);
  } finally {
    h.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The declared launch spec, pointed at the fake: same args and permission CLI.
function launchSpec() {
  return { ...qoderLaunchSpec(FAKE), env: { FAKE_QODER_LOG: logPath } };
}

function providerOptions() {
  const bridgeOptions = qoderProviderDeclaration(FAKE).experimental_bridgeOptions as Record<string, unknown>;
  return { ...bridgeOptions, acpLaunchSpec: launchSpec() };
}

const ACCEPT_EDITS = { permissionMode: "accept-edits", permissionScope: "workspace", approvalReviewer: "user", permissionEscalation: "ask" };
const FULL = { permissionMode: "full", permissionScope: "full", approvalReviewer: null, permissionEscalation: null };
const AUTO = { permissionMode: "auto", permissionScope: "workspace", approvalReviewer: "automatic", permissionEscalation: "ask" };

function options(policy: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { ...policy, ...extra, providerOptions: providerOptions() };
}

async function request(method: string, params: Record<string, unknown>): Promise<BridgeJsonRpcOutputMessage> {
  const id = `t${++nextId}`;
  h.sendRequest(id, method, params as never);
  return h.waitForResponse(id);
}

// The runtime's id shape: "creq_" and ten characters of its unambiguous alphabet.
const CREQ_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";
const clientRequestId = () => `creq_${[...(++nextId).toString(32).padStart(10, "0")].map((c) => CREQ_ALPHABET[parseInt(c, 32)]).join("")}`;

function log(): LogEntry[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogEntry);
}

const received = (method: string) => log().filter((e) => e.dir === "in" && e.method === method);

async function until<T>(probe: () => T | undefined, what: string, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const ends = () => log().filter((e) => e.end !== undefined).map((e) => e.end);

const deltaKinds = (threadId: string) =>
  h.messages
    .filter((m) => m.method === "thread/delta" && (m.params as { threadId: string }).threadId === threadId)
    .flatMap((m) => (m.params as { deltas: { kind: string }[] }).deltas.map((d) => d.kind));

async function startThread(threadId: string, policy: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const r = await request("thread/start", { threadId, cwd: workspace, options: options(policy, extra), instructionMode: "append" });
  expect(r.error).toBeUndefined();
  const providerThreadId = (r.result as { providerThreadId: string }).providerThreadId;
  started.push({ threadId, providerThreadId });
  return providerThreadId;
}

async function prompt(threadId: string, providerThreadId: string, text: string, policy: Record<string, unknown>) {
  return request("turn/start", {
    threadId,
    providerThreadId,
    input: [{ type: "text", text, mentions: [] }],
    clientRequestId: clientRequestId(),
    options: options(policy),
  });
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Every Qoder process this test launched has exited.
const allExited = () => (log().every((e) => e.pid === undefined || !alive(e.pid)) ? true : undefined);

// A release stop answers cleanly and leaves no Qoder process behind.
async function stop(threadId: string, providerThreadId: string) {
  const r = await request("thread/stop", { threadId, providerThreadId, intent: "release", activeTurnId: null });
  expect(r.error).toBeUndefined();
  await until(allExited, "every Qoder process to exit");
}

describe("host artifact", () => {
  it("re-exports the SDK's generic ACP bridge unchanged", () => {
    expect(experimental_providerBridge).toBe(experimental_acpProviderBridge);
  });
});

describe("model/list through ACP", () => {
  // Qoder reports models as the "model" config option and each model's levels as its own
  // reasoning_effort option, so Qwen 4 Max Preview gets Qoder's none/low/high/xhigh (default
  // xhigh) and a model without reasoning stays agent-managed: no declared levels are invented.
  it("lists Qwen 4 Max Preview from ACP config options with its live reasoning levels", async () => {
    const spec = launchSpec();
    expect(spec).not.toHaveProperty("modelCli");
    const r = await request("model/list", { providerOptions: providerOptions() });
    expect(r.error).toBeUndefined();
    type Model = { id: string; displayName: string; isDefault: boolean; supportedReasoningEfforts: { reasoningEffort: string; description: string }[]; defaultReasoningEffort: string };
    const { models } = r.result as { models: Model[] };
    expect(models.map((m) => m.id)).toEqual(["auto", "qmodel_latest"]);
    const [auto, qwen] = models;
    expect(qwen).toMatchObject({ displayName: "Qwen4-Max-Preview", isDefault: true, defaultReasoningEffort: "xhigh" });
    // The labels are the fake's option names, so the levels came over ACP, not a declared hint.
    expect(qwen.supportedReasoningEfforts).toEqual([
      { reasoningEffort: "none", description: "None" },
      { reasoningEffort: "low", description: "Low" },
      { reasoningEffort: "high", description: "High" },
      { reasoningEffort: "xhigh", description: "Extra High" },
    ]);
    expect(auto).toMatchObject({ isDefault: false, defaultReasoningEffort: "medium" });
    expect(auto.supportedReasoningEfforts.map((e) => e.reasoningEffort)).toEqual(["medium"]);
    // Discovery ran Qoder in ACP mode (no list-models invocation), opened one session and
    // probed each model's reasoning by switching the model option.
    const starts = log().filter((e) => e.argv);
    expect(starts.map((e) => e.argv)).toEqual([["--acp"]]);
    expect(received("session/new")).toHaveLength(1);
    expect(received("session/set_config_option").map((e) => e.params?.configId)).toEqual(["model", "model"]);
    await until(allExited, "the discovery process to exit");
  });
});

describe("reasoning_effort", () => {
  it("sets the chosen level through ACP reasoning_effort, never a CLI flag, on start and on resume", async () => {
    const threadId = "thr_reasoning";
    const providerThreadId = await startThread(threadId, ACCEPT_EDITS, { model: "qmodel_latest", reasoningLevel: "low" });
    expect(received("session/set_config_option").map((e) => e.params)).toEqual([{ sessionId: providerThreadId, configId: "reasoning_effort", value: "low" }]);
    expect(log().filter((e) => e.reply !== undefined && e.error !== undefined)).toEqual([]);
    await stop(threadId, providerThreadId);

    // session/load resets Qoder's reasoning to the model default, so the bridge sets it again.
    const resumed = await request("thread/resume", {
      threadId,
      providerThreadId,
      cwd: workspace,
      options: options(ACCEPT_EDITS, { model: "qmodel_latest", reasoningLevel: "high" }),
      instructionMode: "append",
    });
    expect(resumed.error).toBeUndefined();
    expect((resumed.result as { providerThreadId: string }).providerThreadId).toBe(providerThreadId);
    expect(received("session/load").map((e) => e.params?.sessionId)).toEqual([providerThreadId]);
    expect(received("session/set_config_option").map((e) => e.params?.value)).toEqual(["low", "high"]);
    // Every launch carries only the permission flags and --acp: no reasoning or model flag.
    for (const { argv } of log().filter((e) => e.argv)) expect(argv).toEqual(["--permission-mode", "default", "--acp"]);
    await stop(threadId, providerThreadId);
  });

  it("sends no reasoning_effort for a model that has none", async () => {
    const threadId = "thr_reasoning_auto";
    const providerThreadId = await startThread(threadId, ACCEPT_EDITS, { model: "auto", reasoningLevel: "high" });
    // Only the model switch: real Qoder rejects reasoning_effort on auto, so it is never sent.
    expect(received("session/set_config_option").map((e) => e.params)).toEqual([{ sessionId: providerThreadId, configId: "model", value: "auto" }]);
    await stop(threadId, providerThreadId);
  });
});

describe("permission modes", () => {
  it("rejects Cloudroom auto before launching Qoder", async () => {
    const r = await request("thread/start", { threadId: "thr_auto", cwd: workspace, options: options(AUTO), instructionMode: "append" });
    expect(r.error?.message).toContain('does not support permission mode "auto"');
    expect(log().filter((e) => e.argv)).toEqual([]);
  });

  it("accept-edits forwards mutation approval without auto-approval", async () => {
    const threadId = "thr_accept_edits";
    const providerThreadId = await startThread(threadId, ACCEPT_EDITS);
    expect(log().find((e) => e.argv)?.argv).toEqual(["--permission-mode", "default", "--acp"]);

    const target = join(workspace, "approved.txt");
    const turn = await prompt(threadId, providerThreadId, `edit ${target}`, ACCEPT_EDITS);
    expect(turn.error).toBeUndefined();
    const approval = await until(() => h.messages.find((m) => m.method === "interaction/request"), "the approval request");
    expect((approval.params as { payload: { kind: string; subject: { kind: string } } }).payload).toMatchObject({ kind: "approval", subject: { kind: "file_change" } });
    // The fake's outgoing log sees the request it sent (the R-1 test relies on this record).
    expect(log().filter((e) => e.dir === "out").map((e) => e.method)).toEqual(["session/request_permission"]);
    // The bridge holds Qoder's request open: no answer and no write until Cloudroom decides.
    await new Promise((r) => setTimeout(r, 200));
    expect(log().filter((e) => e.reply === "session/request_permission")).toEqual([]);
    expect(existsSync(target)).toBe(false);

    // Answer as Cloudroom's runtime would after the user approves.
    experimental_providerBridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: approval.id, result: { decision: "allow_once", grantedPermissions: null } }));
    const reply = await until(() => log().find((e) => e.reply === "session/request_permission"), "Qoder's permission reply");
    expect(reply.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    await until(() => (existsSync(target) ? true : undefined), "the approved write");
    expect(readFileSync(target, "utf8")).toBe("edited by fake qoder\n");
    await stop(threadId, providerThreadId);
  });

  it("accept-edits sends a denial back to Qoder and nothing is written", async () => {
    const threadId = "thr_accept_edits_deny";
    const providerThreadId = await startThread(threadId, ACCEPT_EDITS);
    const target = join(workspace, "denied.txt");
    await prompt(threadId, providerThreadId, `edit ${target}`, ACCEPT_EDITS);
    const approval = await until(() => h.messages.find((m) => m.method === "interaction/request"), "the approval request");
    experimental_providerBridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: approval.id, result: { decision: "deny" } }));
    const reply = await until(() => log().find((e) => e.reply === "session/request_permission"), "Qoder's permission reply");
    expect(reply.result).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    await until(() => (ends().length === 1 ? true : undefined), "the turn to end");
    expect(ends()).toEqual(["end_turn"]);
    expect(existsSync(target)).toBe(false);
    await stop(threadId, providerThreadId);
  });

  it("full uses bypass permissions", async () => {
    const threadId = "thr_full";
    const providerThreadId = await startThread(threadId, FULL);
    expect(log().find((e) => e.argv)?.argv).toEqual(["--permission-mode", "bypass_permissions", "--acp"]);
    const target = join(workspace, "bypassed.txt");
    await prompt(threadId, providerThreadId, `edit ${target}`, FULL);
    const reply = await until(() => log().find((e) => e.reply === "session/request_permission"), "Qoder's permission reply");
    expect(reply.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    await until(() => (existsSync(target) ? true : undefined), "the bypassed write");
    expect(h.messages.filter((m) => m.method === "interaction/request")).toEqual([]);
    await stop(threadId, providerThreadId);
  });

  // R-1 characterization. This documents the bridge's boundary, it does not show Qoder is
  // safe: in accept-edits the SDK bridge serves an ACP agent's fs/write_text_file inside the
  // workspace without any approval, so the only gate is the agent asking first through
  // session/request_permission. Whether Qoder's "default" mode asks before every mutation is
  // established only by the live mutation-denied check (plan Task 4).
  it("accept-edits lets a direct fs/write_text_file without a permission request write inside the workspace", async () => {
    const threadId = "thr_direct_write";
    const providerThreadId = await startThread(threadId, ACCEPT_EDITS);
    const inside = join(workspace, "direct.txt");
    await prompt(threadId, providerThreadId, `write-direct ${inside}`, ACCEPT_EDITS);
    const reply = await until(() => log().find((e) => e.reply === "fs/write_text_file"), "the direct write reply");
    expect(reply.error).toBeUndefined();
    expect(readFileSync(inside, "utf8")).toBe("written without asking\n");
    // The fake records every request it sends: it never asked.
    expect(log().filter((e) => e.dir === "out" && e.method === "session/request_permission")).toEqual([]);
    expect(log().filter((e) => e.dir === "out").map((e) => e.method)).toEqual(["fs/write_text_file"]);
    expect(h.messages.filter((m) => m.method === "interaction/request")).toEqual([]);
    await stop(threadId, providerThreadId);
  });

  it("accept-edits still refuses a direct fs/write_text_file outside the workspace", async () => {
    const threadId = "thr_direct_write_outside";
    const providerThreadId = await startThread(threadId, ACCEPT_EDITS);
    const outside = join(dir, "outside.txt");
    await prompt(threadId, providerThreadId, `write-direct ${outside}`, ACCEPT_EDITS);
    const reply = await until(() => log().find((e) => e.reply === "fs/write_text_file"), "the direct write reply");
    expect(JSON.stringify(reply.error)).toContain("outside the workspace");
    expect(existsSync(outside)).toBe(false);
    await stop(threadId, providerThreadId);
  });
});

describe("turns", () => {
  it("queues a steer: cancels the running prompt, then sends the steer in the same turn", async () => {
    const threadId = "thr_steer";
    const providerThreadId = await startThread(threadId, ACCEPT_EDITS);
    await prompt(threadId, providerThreadId, "hang", ACCEPT_EDITS);
    await until(() => (received("session/prompt").length === 1 ? true : undefined), "the first prompt");
    const steer = await request("turn/steer", {
      threadId,
      providerThreadId,
      // The ACP bridge mints no provider turn ids (turn.open carries none) and only checks
      // that a turn is active, so any id stands in for the runtime's.
      expectedTurnId: "turn_active",
      input: [{ type: "text", text: "steer: say hi", mentions: [] }],
      clientRequestId: clientRequestId(),
      options: options(ACCEPT_EDITS),
    });
    expect(steer.error).toBeUndefined();
    await until(() => (received("session/prompt").length === 2 ? true : undefined), "the steered prompt");
    const methods = log().filter((e) => e.dir === "in" && ["session/prompt", "session/cancel"].includes(e.method ?? "")).map((e) => e.method);
    expect(methods).toEqual(["session/prompt", "session/cancel", "session/prompt"]);
    expect(JSON.stringify(received("session/prompt")[1].params)).toContain("steer: say hi");
    await until(() => (ends().length === 2 ? true : undefined), "the steered prompt to end");
    expect(ends()).toEqual(["cancelled", "end_turn"]);
    // One turn for both inputs: opened once, both accepted, settled once.
    await until(() => (deltaKinds(threadId).includes("turn.boundary") ? true : undefined), "the turn to settle");
    const kinds = deltaKinds(threadId);
    expect(kinds.filter((k) => k === "turn.open")).toHaveLength(1);
    expect(kinds.filter((k) => k === "input.accepted")).toHaveLength(2);
    expect(kinds.filter((k) => k === "turn.boundary")).toHaveLength(1);
    await stop(threadId, providerThreadId);
  });
});
