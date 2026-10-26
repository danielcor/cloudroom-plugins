import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { AgyAcpAgent, parseArgs, parseModels, promptText, toolKind } from "../agy-acp.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixture = (name) => join(here, "fixtures", name);
const CID = "11111111-2222-3333-4444-555555555555";

function harness(transcript, { onSigint, argv = [], env: extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agy-acp-test-"));
  const argsLog = join(dir, "args.ndjson");
  const sent = [];
  const env = { ...process.env, FAKE_AGY_FIXTURE: fixture(transcript), FAKE_AGY_ARGS_LOG: argsLog, ...(onSigint ? { FAKE_AGY_ON_SIGINT: fixture(onSigint) } : {}), ...extraEnv };
  const agent = new AgyAcpAgent({
    send: (m) => sent.push(m),
    opts: { ...parseArgs(argv), agy: "fake-agy", stateDir: join(dir, "state") },
    spawnAgy: (args, cwd) => spawn(process.execPath, [join(here, "fake-agy.mjs"), ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] }),
    listModels: () => readFileSync(fixture("models.txt"), "utf8"),
  });
  let id = 0;
  const call = async (method, params) => {
    const rid = ++id;
    await agent.handle({ jsonrpc: "2.0", id: rid, method, params });
    const reply = sent.find((m) => m.id === rid);
    if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
    return reply.result;
  };
  const updates = () => sent.filter((m) => m.method === "session/update").map((m) => m.params.update);
  const spawns = () => (existsSync(argsLog) ? readFileSync(argsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { agent, call, sent, updates, spawns, dir };
}

const text = (t) => [{ type: "text", text: t }];

test("initialize advertises load, resume and text prompts", async () => {
  const h = harness("two-turn-read-file.ndjson");
  const r = await h.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(r.protocolVersion, 1);
  assert.equal(r.agentCapabilities.loadSession, true);
  assert.deepEqual(r.agentCapabilities.sessionCapabilities, { resume: {} });
  assert.equal(r.agentCapabilities.promptCapabilities.image, false);
  assert.equal(r.agentInfo.name, "agy-acp");
});

test("session/new starts no agy until the first prompt, lists Argon first, high by default", async () => {
  const h = harness("two-turn-read-file.ndjson");
  const r = await h.call("session/new", { cwd: "/tmp", mcpServers: [] });
  assert.match(r.sessionId, /^agyacp-[0-9a-f-]{36}$/);
  assert.deepEqual(h.spawns(), [], "a model probe (session/new only) leaves no agy conversation");
  assert.deepEqual(r.models.availableModels.slice(0, 3).map((m) => m.modelId), ["gemini-4-argon-high", "gemini-4-argon-medium", "gemini-4-argon-low"]);
  assert.equal(r.models.currentModelId, "gemini-4-argon-high");
  assert.equal(r.modes.currentModeId, "accept-edits");
  assert.deepEqual(r.configOptions.map((o) => [o.id, o.category]), [["model", "model"], ["effort", "thought_level"], ["mode", "mode"]]);
  await h.call("session/prompt", { sessionId: r.sessionId, prompt: text("read note.txt") });
  assert.deepEqual(h.spawns(), [["-p=", "--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-4-argon-high", "--mode", "accept-edits"]]);
  h.agent.shutdown();
});

test("two turns: tool call, streamed text, per-turn usage, context kept in one process", async () => {
  const h = harness("two-turn-read-file.ndjson");
  const { sessionId } = await h.call("session/new", { cwd: "/tmp", mcpServers: [] });
  const r1 = await h.call("session/prompt", { sessionId, prompt: text("read note.txt") });
  assert.equal(r1.stopReason, "end_turn");
  assert.deepEqual(r1.usage, { inputTokens: 8967, outputTokens: 61, thoughtTokens: 0, cachedReadTokens: 4747, totalTokens: 9028 });
  const u = h.updates();
  const call = u.find((x) => x.sessionUpdate === "tool_call");
  assert.deepEqual(call, { sessionUpdate: "tool_call", toolCallId: "agy-step-2", title: "read_file: /work/note.txt", kind: "read", status: "in_progress", rawInput: { Path: "/work/note.txt" }, locations: [{ path: "/work/note.txt" }] });
  const done = u.find((x) => x.sessionUpdate === "tool_call_update");
  assert.equal(done.status, "completed");
  assert.equal(done.rawOutput.output, "1 lines, 19 bytes");
  const said = u.filter((x) => x.sessionUpdate === "agent_message_chunk").map((x) => x.content.text).join("");
  assert.equal(said, "The exact contents of [note.txt](file:///work/note.txt) are: `hello from fixture`\n");
  assert.equal(u.some((x) => x.sessionUpdate === "user_message_chunk"), false, "prompts are not echoed live");

  const r2 = await h.call("session/prompt", { sessionId, prompt: text("what did you read?") });
  assert.equal(r2.stopReason, "end_turn");
  assert.equal(r2.usage.inputTokens, 2157);
  assert.equal(h.spawns().length, 1, "one agy process serves both turns");
  h.agent.shutdown();
});

test("commands agy auto-denies are reported in the reply", async () => {
  const h = harness("denied-command.ndjson");
  const { sessionId } = await h.call("session/new", { cwd: "/tmp", mcpServers: [] });
  const r = await h.call("session/prompt", { sessionId, prompt: text("run echo") });
  assert.equal(r.stopReason, "end_turn");
  const said = h.updates().filter((x) => x.sessionUpdate === "agent_message_chunk").map((x) => x.content.text).join("");
  assert.match(said, /agy auto-denied: command \(RunCommand\)/);
  assert.equal(h.updates().find((x) => x.sessionUpdate === "tool_call").kind, "execute");
  h.agent.shutdown();
});

test("session/cancel interrupts agy, ends the turn as cancelled, and the next prompt resumes the conversation", async () => {
  const h = harness("interrupted.ndjson", { onSigint: "interrupted-result.ndjson" });
  const { sessionId } = await h.call("session/new", { cwd: "/tmp", mcpServers: [] });
  const pending = h.call("session/prompt", { sessionId, prompt: text("write a story") });
  await new Promise((r) => setTimeout(r, 300));
  await h.agent.handle({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  assert.deepEqual(await pending, { stopReason: "cancelled" });
  h.agent.handle({ jsonrpc: "2.0", id: 99, method: "session/prompt", params: { sessionId, prompt: text("again") } });
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(h.spawns()[1].slice(-2), ["--conversation", CID]);
  h.agent.shutdown();
});

test("session/cancel while agy is still starting answers cancelled at once", async () => {
  const h = harness("two-turn-read-file.ndjson", { env: { FAKE_AGY_INIT_DELAY_MS: "20000" } });
  const { sessionId } = await h.call("session/new", { cwd: "/tmp", mcpServers: [] });
  const started = Date.now();
  const pending = h.call("session/prompt", { sessionId, prompt: text("read note.txt") });
  await new Promise((r) => setTimeout(r, 200));
  await h.agent.handle({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  assert.deepEqual(await pending, { stopReason: "cancelled" });
  assert.ok(Date.now() - started < 3000, "did not wait for agy to start");
  await h.agent.shutdown();
});

test("shutdown waits for agy to exit, escalating to SIGKILL", async () => {
  const h = harness("two-turn-read-file.ndjson", { env: { FAKE_AGY_IGNORE_SIGTERM: "1" } });
  const { sessionId } = await h.call("session/new", { cwd: "/tmp", mcpServers: [] });
  await h.call("session/prompt", { sessionId, prompt: text("read note.txt") });
  const proc = h.agent.sessions.get(sessionId).proc;
  await h.agent.shutdown();
  assert.equal(proc.signalCode, "SIGKILL");
});

// Runs the real CLI against a fake agy that ignores SIGTERM and stdin EOF; returns the agy pids.
async function runCli({ env = {}, script }) {
  const dir = mkdtempSync(join(tmpdir(), "agy-acp-cli-"));
  const pidLog = join(dir, "pids");
  const cli = spawn(process.execPath, [join(here, "..", "agy-acp.mjs"), "--agy", join(here, "fake-agy"), "--state-dir", join(dir, "state")], {
    env: { ...process.env, FAKE_AGY_FIXTURE: fixture("two-turn-read-file.ndjson"), FAKE_AGY_IGNORE_SIGTERM: "1", FAKE_AGY_PID_LOG: pidLog, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = [];
  createInterface({ input: cli.stdout }).on("line", (l) => lines.push(JSON.parse(l)));
  let id = 0;
  const send = (method, params) => cli.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...(method === "session/cancel" ? {} : { id: ++id }), method, params })}\n`);
  const reply = async (rid) => {
    while (!lines.some((m) => m.id === rid)) await new Promise((r) => setTimeout(r, 20));
    return lines.find((m) => m.id === rid).result;
  };
  const exited = new Promise((r) => cli.once("exit", r));
  await script({ cli, send, reply, waitForPid: async () => { while (!existsSync(pidLog)) await new Promise((r) => setTimeout(r, 20)); } });
  await exited;
  return readFileSync(pidLog, "utf8").trim().split("\n").map(Number);
}

const assertAllDead = (pids) => {
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/, `agy ${pid} was killed before agy-acp exited`);
};

test("the CLI waits for agy on stdin close plus SIGTERM, leaving no orphan", async () => {
  assertAllDead(await runCli({
    script: async ({ cli, send, reply }) => {
      send("session/new", { cwd: "/tmp", mcpServers: [] });
      const { sessionId } = await reply(1);
      send("session/prompt", { sessionId, prompt: text("read note.txt") });
      await reply(2);
      cli.stdin.end();
      cli.kill("SIGTERM");
    },
  }));
});

test("the CLI waits for an agy whose start was cancelled, leaving no orphan", async () => {
  assertAllDead(await runCli({
    env: { FAKE_AGY_INIT_DELAY_MS: "20000" },
    script: async ({ cli, send, reply, waitForPid }) => {
      send("session/new", { cwd: "/tmp", mcpServers: [] });
      const { sessionId } = await reply(1);
      send("session/prompt", { sessionId, prompt: text("read note.txt") });
      await waitForPid();
      send("session/cancel", { sessionId });
      cli.stdin.end(); // quit while the cancelled start is still being torn down
    },
  }));
});

test("a first prompt fails loudly when the session's conversation id cannot be saved", async () => {
  const h = harness("two-turn-read-file.ndjson");
  h.agent.stateDir = "/dev/null/agy-acp";
  const { sessionId } = await h.call("session/new", { cwd: "/tmp", mcpServers: [] });
  await assert.rejects(h.call("session/prompt", { sessionId, prompt: text("read note.txt") }), /could not save the session's agy conversation id/);
  await h.agent.shutdown();
});

test("settings changes restart agy with new flags on the same conversation", async () => {
  const h = harness("two-turn-read-file.ndjson");
  const { sessionId } = await h.call("session/new", { cwd: "/tmp", mcpServers: [] });
  await h.call("session/set_model", { sessionId, modelId: "gemini-4-argon-low" });
  const r = await h.call("session/set_config_option", { sessionId, configId: "effort", value: "high" });
  assert.equal(r.configOptions.find((o) => o.id === "effort").currentValue, "high");
  await h.call("session/set_mode", { sessionId, modeId: "bypass" });
  assert.deepEqual(h.updates().at(-1), { sessionUpdate: "current_mode_update", currentModeId: "bypass" });
  await assert.rejects(h.call("session/set_config_option", { sessionId, configId: "effort", value: "turbo" }), /Invalid effort/);
  await h.call("session/prompt", { sessionId, prompt: text("read note.txt") });
  assert.deepEqual(h.spawns()[0], ["-p=", "--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-4-argon-low", "--effort", "high", "--dangerously-skip-permissions"]);
  await h.call("session/set_mode", { sessionId, modeId: "plan" });
  await h.call("session/prompt", { sessionId, prompt: text("what did you read?") });
  assert.deepEqual(h.spawns()[1].slice(-4), ["--mode", "plan", "--conversation", CID]);
  h.agent.shutdown();
});

test("session/load replays the saved transcript; resume does not; unknown ids fail", async () => {
  const h = harness("two-turn-read-file.ndjson");
  const { sessionId } = await h.call("session/new", { cwd: "/tmp", mcpServers: [] });
  await h.call("session/prompt", { sessionId, prompt: text("read note.txt") });
  h.agent.shutdown();

  const h2 = harness("two-turn-read-file.ndjson");
  h2.agent.stateDir = h.agent.stateDir;
  const resumed = await h2.call("session/resume", { sessionId, cwd: "/tmp", mcpServers: [] });
  assert.equal(resumed.sessionId, undefined);
  assert.equal(h2.updates().length, 0);
  const loaded = await h2.call("session/load", { sessionId, cwd: "/tmp", mcpServers: [] });
  assert.equal(loaded.models.currentModelId, "gemini-4-argon-high");
  const replay = h2.updates();
  assert.deepEqual(replay[0], { sessionUpdate: "user_message_chunk", content: { type: "text", text: "read note.txt" } });
  assert.ok(replay.some((x) => x.sessionUpdate === "tool_call"));
  assert.deepEqual(h2.spawns().map((a) => a.slice(-2)), [["--conversation", CID], ["--conversation", CID]]);
  await assert.rejects(h2.call("session/load", { sessionId: "missing", cwd: "/tmp", mcpServers: [] }), (e) => e.code === -32002);
  const fresh = await h2.call("session/new", { cwd: "/tmp", mcpServers: [] });
  const before = h2.spawns().length;
  await h2.call("session/resume", { sessionId: fresh.sessionId, cwd: "/tmp", mcpServers: [] });
  assert.equal(h2.spawns().length, before, "resuming a never-prompted session starts nothing");
  await assert.rejects(h2.call("session/load", { sessionId: "../etc", cwd: "/tmp", mcpServers: [] }), /Invalid sessionId/);
  h2.agent.shutdown();
});

test("helpers", () => {
  assert.deepEqual(parseModels("").map((m) => m.modelId), ["gemini-4-argon-high", "gemini-4-argon-medium", "gemini-4-argon-low"]);
  assert.deepEqual(parseModels("x-1\tX One\ngemini-4-argon-low\tLow\n").map((m) => m.modelId), ["gemini-4-argon-low", "x-1"]);
  assert.equal(promptText([{ type: "text", text: "a" }, { type: "resource_link", uri: "file:///w/a%20b.ts", name: "b" }]), "a\n@/w/a b.ts");
  assert.throws(() => promptText([{ type: "image", data: "", mimeType: "image/png" }]), /text and resource blocks only/);
  assert.equal(toolKind("run_command"), "execute");
  assert.equal(parseArgs(["--dangerously-skip-permissions"]).mode, "bypass");
  assert.throws(() => parseArgs(["--mode", "yolo"]), /--mode must be one of/);
});
