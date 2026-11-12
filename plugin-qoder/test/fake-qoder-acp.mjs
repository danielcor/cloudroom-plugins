#!/usr/bin/env node
// Minimal deterministic ACP double for `qoder --acp`, enough for the SDK's generic bridge:
// initialize, session/new|load|fork, set_config_option, prompt and cancel. Like real Qoder
// 1.1.88 it reports models both as models.availableModels and as a "model" config option,
// plus a per-model "reasoning_effort" (thought_level) option that models without reasoning
// lack, and session/load resets reasoning to the model default. Prompts drive it by keyword:
//   "hang"               waits for session/cancel
//   "zero-work"          ends the turn with no updates
//   "edit PATH"          asks session/request_permission, then writes PATH only if allowed
//   "write-direct PATH"  calls fs/write_text_file with no permission request first
//   anything else        replies with one text chunk
// When FAKE_QODER_LOG is set it appends JSON lines: {argv, pid}, every message received
// ({dir:"in", ...}), every request it sends ({dir:"out", ...}), the bridge's reply to each
// request it makes ({reply: method, ...}), and how each prompt ended ({end: stopReason}).
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Ids, names and reasoning values as real Qoder reports them; the first value is the default.
const MODELS = [
  { modelId: "auto", name: "Auto (default)", reasoning: [] },
  {
    modelId: "qmodel_latest",
    name: "Qwen4-Max-Preview",
    reasoning: [
      { value: "xhigh", name: "Extra High" },
      { value: "high", name: "High" },
      { value: "low", name: "Low" },
      { value: "none", name: "None" },
    ],
  },
];
const DEFAULT_MODEL = "qmodel_latest";
const modelInfo = (modelId) => MODELS.find((m) => m.modelId === modelId);

const record = (entry) => process.env.FAKE_QODER_LOG && appendFileSync(process.env.FAKE_QODER_LOG, `${JSON.stringify(entry)}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const fail = (code, message) => Object.assign(new Error(message), { code });

record({ argv: process.argv.slice(2), pid: process.pid });

let counter = 0;
const sessions = new Map(); // sessionId -> { model, effort?, cancel?: () => void }
const pending = new Map(); // our request id -> { method, resolve }

function open(sessionId) {
  const id = sessionId ?? `qoder-${process.pid}-${++counter}`;
  sessions.set(id, { model: DEFAULT_MODEL, effort: modelInfo(DEFAULT_MODEL).reasoning[0]?.value });
  return id;
}
function session(id) {
  const s = sessions.get(id);
  if (!s) throw fail(-32602, `Unknown session ${id}`);
  return s;
}
function configOptions(id) {
  const { model, effort } = session(id);
  const reasoning = modelInfo(model).reasoning;
  return [
    { type: "select", id: "model", name: "Model", category: "model", currentValue: model, options: MODELS.map((m) => ({ value: m.modelId, name: m.name })) },
    ...(reasoning.length ? [{ type: "select", id: "reasoning_effort", name: "Reasoning", category: "thought_level", currentValue: effort, options: reasoning }] : []),
  ];
}
const state = (id) => ({
  models: { availableModels: MODELS.map(({ modelId, name }) => ({ modelId, name })), currentModelId: session(id).model },
  configOptions: configOptions(id),
});

function setConfigOption({ sessionId, configId, value }) {
  const s = session(sessionId);
  const reasoning = modelInfo(s.model).reasoning;
  if (configId === "model") {
    const info = modelInfo(value);
    if (!info) throw fail(-32602, `Unknown model ${value}`);
    Object.assign(s, { model: info.modelId, effort: info.reasoning[0]?.value });
  } else if (configId === "reasoning_effort" && reasoning.length) {
    if (!reasoning.some((r) => r.value === value)) throw fail(-32602, `Invalid value ${value}`);
    s.effort = value;
  } else {
    // Real Qoder's answer, for example to reasoning_effort on a model without reasoning.
    throw fail(-32602, `Invalid params: Unknown config option: ${configId}`);
  }
  return { configOptions: configOptions(sessionId) };
}

function ask(method, params) {
  const id = ++counter;
  record({ dir: "out", method, params, id });
  send({ id, method, params });
  return new Promise((resolve) => pending.set(id, { method, resolve }));
}
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const say = (sessionId, text) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

async function prompt({ sessionId, prompt: blocks }) {
  const s = session(sessionId);
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const [word, path] = text.trim().split(/\s+/);
  if (word === "hang") {
    say(sessionId, "working");
    await new Promise((resolve) => (s.cancel = resolve));
    return "cancelled";
  }
  if (word === "zero-work") return "end_turn";
  if (word === "edit") {
    const toolCallId = `edit-${++counter}`;
    const call = { toolCallId, title: `Edit ${path}`, kind: "edit", locations: [{ path }], rawInput: { file_path: path, content: "edited by fake qoder\n" } };
    update(sessionId, { sessionUpdate: "tool_call", status: "pending", ...call });
    const answer = await ask("session/request_permission", {
      sessionId,
      toolCall: call,
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    const allowed = answer.result?.outcome?.outcome === "selected" && answer.result.outcome.optionId === "allow";
    if (allowed) await ask("fs/write_text_file", { sessionId, path, content: "edited by fake qoder\n" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: allowed ? "completed" : "failed" });
    return "end_turn";
  }
  if (word === "write-direct") {
    const answer = await ask("fs/write_text_file", { sessionId, path, content: "written without asking\n" });
    say(sessionId, answer.error ? "write refused" : "wrote file");
    return "end_turn";
  }
  say(sessionId, `Qoder fake reply (${s.model}, ${s.effort ?? "no reasoning"})`);
  return "end_turn";
}

async function dispatch(method, p) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false }, sessionCapabilities: { fork: {} } },
        authMethods: [],
        agentInfo: { name: "fake-qoder-acp", version: "0.0.0" },
      };
    case "session/new": {
      const sessionId = open();
      return { sessionId, ...state(sessionId) };
    }
    case "session/load":
      open(p.sessionId);
      return state(p.sessionId);
    case "session/fork": {
      // Like session/load, the source may come from an earlier process: any id is accepted.
      const sessionId = open();
      return { sessionId, ...state(sessionId) };
    }
    case "session/set_config_option":
      return setConfigOption(p);
    case "session/prompt": {
      const stopReason = await prompt(p);
      record({ end: stopReason });
      return { stopReason };
    }
    case "session/cancel":
      sessions.get(p.sessionId)?.cancel?.();
      return null;
    default:
      throw fail(-32601, `Method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    const mine = pending.get(msg.id);
    if (!mine) return;
    pending.delete(msg.id);
    record({ reply: mine.method, ...(msg.error ? { error: msg.error } : { result: msg.result }) });
    mine.resolve(msg);
    return;
  }
  record({ dir: "in", method: msg.method, params: msg.params, ...(msg.id !== undefined ? { id: msg.id } : {}) });
  dispatch(msg.method, msg.params ?? {}).then(
    (result) => msg.id !== undefined && send({ id: msg.id, result }),
    (e) => msg.id !== undefined && send({ id: msg.id, error: { code: e.code ?? -32603, message: e.message } }),
  );
});
rl.on("close", () => process.exit(0));
