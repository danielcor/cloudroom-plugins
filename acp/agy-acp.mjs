#!/usr/bin/env node
// agy-acp: an Agent Client Protocol (ACP) agent on stdio that drives the
// Google Antigravity CLI (`agy`) through its headless stream-json mode.
// One long-lived `agy -p= --input-format stream-json --output-format stream-json`
// process per ACP session, started on the session's first prompt (so model probes
// that only call session/new leave no empty agy conversations behind). The agy
// conversation id is saved per session, and session/load and session/resume map
// to `agy --conversation <id>`.
// agy keeps its own login; this adapter never reads or writes credentials.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.0";
export const PROTOCOL_VERSION = 1;
export const ARGON_MODELS = [
  { modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
  { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
  { modelId: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
];
export const MODES = [
  { id: "accept-edits", name: "Accept edits", description: "agy --mode accept-edits: reads and edits in the workspace (and any --add-dir / AGY_ACP_ADD_DIRS directories) run; shell commands and reads outside those directories are denied (headless agy cannot ask)." },
  { id: "auto", name: "Auto", description: "agy --mode auto." },
  { id: "plan", name: "Plan", description: "agy --mode plan: plan only, no changes." },
  { id: "bypass", name: "Bypass permissions", description: "agy --dangerously-skip-permissions: every tool runs without asking." },
];
export const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];
// agy models can carry their effort in the id (gemini-4-argon-high). agy refuses --effort with such a model
// unless the two agree, so the id's suffix wins and --effort is left off.
export const effortSuffixed = (modelId) => /-(low|medium|high|xhigh|max)$/.test(modelId);
const SESSION_PREFIX = "agyacp-";

const ERR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603, notFound: -32002 };
const INIT_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 5_000;

const READ_TOOLS = new Set(["read_file", "view_file", "view_file_outline", "view_code_item"]);
const EDIT_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "edit_file"]);
const SEARCH_TOOLS = new Set(["grep_search", "find_by_name", "list_dir", "codebase_search"]);
const FETCH_TOOLS = new Set(["read_url_content", "search_web", "view_content_chunk"]);
const PATH_KEYS = ["AbsolutePath", "Path", "TargetFile", "File", "DirectoryPath", "SearchPath"];

export function parseArgs(argv) {
  const opts = { agy: process.env.AGY_PATH || "", mode: "accept-edits", model: "", effort: "default", stateDir: "", addDirs: (process.env.AGY_ACP_ADD_DIRS || "").split(delimiter).filter(Boolean) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => inline ?? argv[++i];
    if (flag === "--agy") opts.agy = value();
    else if (flag === "--mode") opts.mode = value();
    else if (flag === "--dangerously-skip-permissions") opts.mode = "bypass";
    else if (flag === "--model") opts.model = value();
    else if (flag === "--effort") opts.effort = value();
    else if (flag === "--state-dir") opts.stateDir = value();
    else if (flag === "--add-dir") opts.addDirs.push(value());
    else if (flag === "--version") opts.version = true;
    else if (flag === "--help" || flag === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!MODES.some((m) => m.id === opts.mode)) throw new Error(`--mode must be one of ${MODES.map((m) => m.id).join(", ")}`);
  if (!EFFORTS.includes(opts.effort)) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);
  return opts;
}

export function findAgy(explicit, env = process.env) {
  if (explicit) return explicit;
  for (const dir of (env.PATH || "").split(delimiter)) {
    if (dir && existsSync(join(dir, "agy"))) return join(dir, "agy");
  }
  const local = join(homedir(), ".local", "bin", "agy");
  return existsSync(local) ? local : "agy";
}

// `agy models` prints "<id>\t<name>" lines. Argon first (high, medium, low), then the rest in agy's order.
export function parseModels(stdout) {
  const listed = [];
  for (const line of stdout.split("\n")) {
    const m = /^(\S+)\t(.+)$/.exec(line.trim());
    if (m) listed.push({ modelId: m[1], name: m[2].trim() });
  }
  if (listed.length === 0) return [...ARGON_MODELS];
  const ids = new Set(listed.map((m) => m.modelId));
  const argon = ARGON_MODELS.filter((m) => ids.has(m.modelId)).map((m) => listed.find((l) => l.modelId === m.modelId));
  return [...argon, ...listed.filter((m) => !ARGON_MODELS.some((a) => a.modelId === m.modelId))];
}

export function toolKind(name) {
  if (READ_TOOLS.has(name)) return "read";
  if (EDIT_TOOLS.has(name)) return "edit";
  if (SEARCH_TOOLS.has(name)) return "search";
  if (FETCH_TOOLS.has(name)) return "fetch";
  if (name === "run_command") return "execute";
  if (name === "delete_file") return "delete";
  return "other";
}

export function toolTitle(name, params = {}) {
  const detail = params.CommandLine ?? PATH_KEYS.map((k) => params[k]).find((v) => typeof v === "string") ?? params.Query ?? params.Url;
  return typeof detail === "string" ? `${name}: ${detail}` : name;
}

function toolLocations(params = {}) {
  const path = PATH_KEYS.map((k) => params[k]).find((v) => typeof v === "string" && v.startsWith("/"));
  return path ? [{ path }] : [];
}

export function promptText(blocks) {
  const parts = [];
  for (const b of blocks ?? []) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "resource_link") parts.push(`@${b.uri.startsWith("file:") ? fileURLToPath(b.uri) : b.uri}`);
    else if (b.type === "resource" && typeof b.resource?.text === "string") parts.push(`<resource uri="${b.resource.uri}">\n${b.resource.text}\n</resource>`);
    else throw Object.assign(new Error(`agy-acp accepts text and resource blocks only, not ${b.type}`), { code: ERR.invalidParams });
  }
  return parts.join("\n");
}

// agy's result.usage is cumulative for the conversation (it survives --conversation restarts),
// so a turn's usage is the sum of its steps' usage.
function addUsage(total, u = {}) {
  return {
    inputTokens: total.inputTokens + (u.input_tokens ?? 0),
    outputTokens: total.outputTokens + (u.output_tokens ?? 0),
    thoughtTokens: total.thoughtTokens + (u.thinking_tokens ?? 0),
    cachedReadTokens: total.cachedReadTokens + (u.cache_read_tokens ?? 0),
    totalTokens: total.totalTokens + (u.total_tokens ?? 0),
  };
}
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedReadTokens: 0, totalTokens: 0 };

// Resolves once the process has exited: SIGTERM, then SIGKILL after a grace period.
function killProc(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  proc.stdin.end();
  proc.kill("SIGTERM");
  const timer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
  timer.unref();
  return exited.then(() => clearTimeout(timer));
}

export class AgyAcpAgent {
  constructor({ send, opts, spawnAgy, listModels }) {
    this.send = send;
    this.opts = opts;
    this.agy = findAgy(opts.agy);
    this.spawnAgy = spawnAgy ?? ((args, cwd) => spawn(this.agy, args, { cwd, stdio: ["pipe", "pipe", "pipe"] }));
    this.listModels = listModels ?? (() => {
      const r = spawnSync(this.agy, ["models"], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" });
      return r.status === 0 ? r.stdout : "";
    });
    this.models = null;
    this.sessions = new Map();
    this.children = new Set(); // every live agy process, so shutdown can wait for all of them
    this.stateDir = opts.stateDir || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agy-acp", "sessions");
  }

  // ---- JSON-RPC plumbing ----
  async handle(msg) {
    if (msg.method === undefined) return; // a response to nothing we sent
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      const result = await this.dispatch(msg.method, msg.params ?? {});
      if (isRequest) this.send({ jsonrpc: "2.0", id: msg.id, result: result ?? null });
    } catch (e) {
      if (isRequest) this.send({ jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? ERR.internal, message: e.message } });
      else process.stderr.write(`agy-acp: ${msg.method}: ${e.message}\n`);
    }
  }

  dispatch(method, p) {
    switch (method) {
      case "initialize": return this.initialize(p);
      case "authenticate": return {};
      case "session/new": return this.openSession({ cwd: p.cwd, additionalDirectories: p.additionalDirectories });
      case "session/load": return this.openSession({ cwd: p.cwd, sessionId: p.sessionId, replay: true, additionalDirectories: p.additionalDirectories });
      case "session/resume": return this.openSession({ cwd: p.cwd, sessionId: p.sessionId, additionalDirectories: p.additionalDirectories });
      case "session/prompt": return this.prompt(p);
      case "session/cancel": return this.cancel(p);
      case "session/set_model": return this.setOption(p.sessionId, "model", p.modelId).then(() => ({}));
      case "session/set_mode": return this.setOption(p.sessionId, "mode", p.modeId).then(() => ({}));
      case "session/set_config_option": return this.setOption(p.sessionId, p.configId, p.value).then((s) => ({ configOptions: this.configOptions(s) }));
      default: throw Object.assign(new Error(`Method not found: ${method}`), { code: ERR.methodNotFound });
    }
  }

  initialize(p) {
    return {
      protocolVersion: Math.min(Number(p.protocolVersion) || PROTOCOL_VERSION, PROTOCOL_VERSION),
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { resume: {} },
      },
      authMethods: [],
      agentInfo: { name: "agy-acp", title: "Antigravity (agy)", version: VERSION },
    };
  }

  // persist: "no" (live only), "yes" (live + transcript for session/load replay), "only" (transcript only).
  update(session, update, persist = "yes") {
    if (persist !== "only") this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session.id, update } });
    if (persist !== "no" && session.id) {
      try {
        mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
        appendFileSync(this.transcriptPath(session.id), `${JSON.stringify(update)}\n`, { mode: 0o600 });
      } catch (e) {
        process.stderr.write(`agy-acp: could not save the session transcript: ${e.message}\n`);
      }
    }
  }

  transcriptPath(id) {
    return join(this.stateDir, `${id}.ndjson`);
  }

  // ---- sessions ----
  getModels() {
    if (this.models === null) this.models = parseModels(this.listModels());
    return this.models;
  }

  session(id) {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error(`Unknown session ${id}`), { code: ERR.notFound });
    return s;
  }

  async openSession({ cwd, sessionId, replay = false, additionalDirectories = [] }) {
    if (typeof cwd !== "string" || !cwd.startsWith("/")) throw Object.assign(new Error("cwd must be an absolute path"), { code: ERR.invalidParams });
    if (sessionId !== undefined && !/^[\w-]{1,128}$/.test(sessionId)) throw Object.assign(new Error("Invalid sessionId"), { code: ERR.invalidParams });
    const models = this.getModels();
    const model = this.opts.model || (models.some((m) => m.modelId === "gemini-4-argon-high") ? "gemini-4-argon-high" : models[0].modelId);
    const id = sessionId ?? `${SESSION_PREFIX}${randomUUID()}`;
    // Our sessions map to the agy conversation saved at their first prompt (none yet: start fresh);
    // any other id is taken as an agy conversation id.
    const conversation = !sessionId ? null : sessionId.startsWith(SESSION_PREFIX) ? this.savedConversation(sessionId) : sessionId;
    const s = { id, conversation, cwd, model, effort: this.opts.effort, mode: this.opts.mode, addDirs: [...new Set([...this.opts.addDirs, ...(Array.isArray(additionalDirectories) ? additionalDirectories : []).filter((d) => typeof d === "string" && d.startsWith("/"))])], proc: null, procKey: "", turn: null, tools: new Map() };
    const old = this.sessions.get(id);
    if (old) this.stopProc(old);
    if (conversation) await this.ensureProc(s); // fails fast when agy has no such conversation
    this.sessions.set(id, s);
    if (replay && existsSync(this.transcriptPath(id))) {
      for (const line of readFileSync(this.transcriptPath(id), "utf8").split("\n")) {
        if (line.trim()) this.update(s, JSON.parse(line), "no");
      }
    }
    return {
      ...(sessionId === undefined ? { sessionId: id } : {}),
      models: { availableModels: models, currentModelId: s.model },
      modes: { availableModes: MODES, currentModeId: s.mode },
      configOptions: this.configOptions(s),
    };
  }

  savedConversation(id) {
    try {
      return readFileSync(join(this.stateDir, `${id}.conversation`), "utf8").trim() || null;
    } catch (e) {
      if (e.code === "ENOENT") return null; // never prompted
      throw e;
    }
  }

  saveConversation(s) {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.stateDir, `${s.id}.conversation`), `${s.conversation}\n`, { mode: 0o600 });
  }

  configOptions(s) {
    return [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: this.getModels().map((m) => ({ value: m.modelId, name: m.name })) },
      { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: s.effort, options: EFFORTS.map((e) => ({ value: e, name: e === "default" ? "Default" : e })) },
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: s.mode, options: MODES.map((m) => ({ value: m.id, name: m.name, description: m.description })) },
    ];
  }

  async setOption(sessionId, key, value) {
    const s = this.session(sessionId);
    const valid = { model: this.getModels().map((m) => m.modelId), effort: EFFORTS, mode: MODES.map((m) => m.id) }[key];
    if (!valid) throw Object.assign(new Error(`Unknown config option ${key}`), { code: ERR.invalidParams });
    if (!valid.includes(value)) throw Object.assign(new Error(`Invalid ${key} "${value}"; expected one of ${valid.join(", ")}`), { code: ERR.invalidParams });
    s[key] = value; // agy takes these as launch flags: the next prompt restarts agy with --conversation
    if (key === "mode") this.update(s, { sessionUpdate: "current_mode_update", currentModeId: value }, "no");
    return s;
  }

  agyArgs(s) {
    const args = ["-p=", "--input-format", "stream-json", "--output-format", "stream-json", "--model", s.model];
    if (s.effort !== "default" && !effortSuffixed(s.model)) args.push("--effort", s.effort);
    if (s.mode === "bypass") args.push("--dangerously-skip-permissions");
    else {
      args.push("--mode", s.mode);
      for (const dir of s.addDirs) args.push("--add-dir", dir);
    }
    if (s.conversation) args.push("--conversation", s.conversation);
    return args;
  }

  // Start (or restart after a settings change, cancel, or crash) the agy process; resolves after agy's init event.
  ensureProc(s) {
    const key = JSON.stringify([s.model, s.effort, s.mode]);
    if (s.proc && s.procKey === key) return Promise.resolve();
    if (s.proc) this.stopProc(s);
    const wanted = s.conversation;
    const proc = this.spawnAgy(this.agyArgs(s), s.cwd);
    this.children.add(proc);
    proc.once("exit", () => this.children.delete(proc));
    s.proc = proc;
    s.procKey = key;
    s.stderr = "";
    proc.stdin.on("error", () => {}); // a dead agy surfaces through its exit event
    return new Promise((resolve, reject) => {
      let ready = false;
      const fail = (message, code = ERR.internal) => {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        if (s.proc === proc) this.stopProc(s);
        else proc.kill("SIGKILL");
        reject(Object.assign(new Error(message), { code }));
      };
      const timer = setTimeout(() => fail(`agy did not start within ${INIT_TIMEOUT_MS / 1000}s. ${s.stderr.trim()}`), INIT_TIMEOUT_MS);
      proc.on("error", (e) => fail(`Could not run ${this.agy}: ${e.message}. Install agy: curl -fsSL https://antigravity.google/cli/install.sh | bash`));
      proc.stderr.on("data", (chunk) => {
        s.stderr = (s.stderr + chunk).slice(-4000);
        process.stderr.write(chunk);
      });
      createInterface({ input: proc.stdout }).on("line", (line) => {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.event === "init" && !ready) {
          if (wanted && ev.conversation_id !== wanted) {
            return fail(`agy has no conversation ${wanted} on this machine`, ERR.notFound);
          }
          if (!wanted) {
            try {
              s.conversation = ev.conversation_id;
              this.saveConversation(s); // without it the session could not be resumed
            } catch (e) {
              s.conversation = null;
              return fail(`agy-acp could not save the session's agy conversation id in ${this.stateDir}: ${e.message}`);
            }
          }
          ready = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        if (s.proc === proc) this.onEvent(s, ev);
      });
      proc.on("exit", (code, signal) => {
        if (!ready) fail(`agy exited before starting (${signal ?? code}). ${s.stderr.trim()}`);
        if (s.proc !== proc) return;
        s.proc = null;
        if (s.turn) this.finishTurn(s, s.turn.cancelled ? { stopReason: "cancelled" } : { error: `agy exited (${signal ?? code}) during the turn. ${s.stderr.trim()}` });
      });
    });
  }

  stopProc(s) {
    const proc = s.proc;
    s.proc = null;
    return proc ? killProc(proc) : Promise.resolve();
  }

  // ---- turns ----
  async prompt(p) {
    const s = this.session(p.sessionId);
    if (s.turn) throw Object.assign(new Error("A prompt is already running in this session"), { code: ERR.invalidRequest });
    const text = promptText(p.prompt);
    const turn = { cancelled: false, usage: ZERO_USAGE };
    s.turn = turn;
    try {
      await this.ensureProc(s);
    } catch (e) {
      s.turn = null;
      if (turn.cancelled) return { stopReason: "cancelled" };
      throw e;
    }
    if (turn.cancelled) {
      s.turn = null;
      return { stopReason: "cancelled" };
    }
    return new Promise((resolve, reject) => {
      Object.assign(turn, { resolve, reject });
      this.update(s, { sessionUpdate: "user_message_chunk", content: { type: "text", text } }, "only");
      s.proc.stdin.write(`${JSON.stringify({ event: "user", message: { content: [{ type: "text", text }] } })}\n`);
    });
  }

  cancel(p) {
    const s = this.sessions.get(p.sessionId);
    if (!s?.turn) return;
    s.turn.cancelled = true;
    const proc = s.proc;
    if (!s.turn.resolve) {
      if (proc) this.stopProc(s); // abort a pending start: prompt() then answers "cancelled"
      return;
    }
    if (!proc) return;
    s.procKey = ""; // the interrupted agy exits; the next prompt starts a new one on the same conversation
    proc.kill("SIGINT"); // agy ends the turn with result{status:ERROR,error:"interrupted"} and exits
    setTimeout(() => proc.exitCode === null && proc.kill("SIGKILL"), KILL_GRACE_MS).unref();
  }

  onEvent(s, ev) {
    if (ev.event === "step_update") return this.onStep(s, ev.step_update ?? {});
    if (ev.event !== "result" || !s.turn) return;
    const r = ev.result ?? {};
    if (s.turn.cancelled) return this.finishTurn(s, { stopReason: "cancelled" });
    if (r.status !== "SUCCESS") return this.finishTurn(s, { error: `agy: ${r.error || r.status || "turn failed"}` });
    if (Array.isArray(r.denied_actions) && r.denied_actions.length > 0) {
      const denied = r.denied_actions.map((d) => `${d.action} (${d.display_name})`).join(", ");
      this.update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n> agy auto-denied: ${denied}. Headless agy cannot ask for permission. Switch this session to the "bypass" mode, start agy-acp with --add-dir DIR (or AGY_ACP_ADD_DIRS) for a directory it must read outside the workspace, or add a read_file(DIR/**) rule under permissions.allow in ~/.gemini/antigravity-cli/settings.json, and ask again.\n` } });
    }
    this.finishTurn(s, { stopReason: "end_turn", usage: s.turn.usage });
  }

  onStep(s, st) {
    if (!s.turn) return;
    if (st.usage) s.turn.usage = addUsage(s.turn.usage, st.usage);
    if (st.step_type === "agent_response") {
      if (st.thinking_delta) this.update(s, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: st.thinking_delta } });
      if (st.text_delta) this.update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: st.text_delta } });
      if (st.state === "ERROR" && st.error) this.update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n> agy error: ${st.error}\n` } });
      return;
    }
    if (st.step_type !== "tool") return;
    const id = `agy-step-${st.step_index}`;
    const info = st.tool_info ?? {};
    const name = info.name ?? st.tool_name ?? "tool";
    if (!s.tools.has(id)) {
      s.tools.set(id, name);
      this.update(s, { sessionUpdate: "tool_call", toolCallId: id, title: toolTitle(name, info.parameters), kind: toolKind(name), status: "in_progress", rawInput: info.parameters ?? {}, locations: toolLocations(info.parameters) });
    }
    if (st.state === "DONE" || st.state === "ERROR") {
      s.tools.delete(id);
      const out = info.output ?? st.error;
      this.update(s, {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: st.state === "DONE" ? "completed" : "failed",
        ...(out === undefined ? {} : { rawOutput: { output: out }, content: [{ type: "content", content: { type: "text", text: String(out) } }] }),
      });
    }
  }

  finishTurn(s, outcome) {
    const turn = s.turn;
    s.turn = null;
    if (!turn?.resolve) return;
    for (const id of s.tools.keys()) this.update(s, { sessionUpdate: "tool_call_update", toolCallId: id, status: "failed" });
    s.tools.clear();
    if (outcome.error) turn.reject(Object.assign(new Error(outcome.error), { code: ERR.internal }));
    else turn.resolve({ stopReason: outcome.stopReason, ...(outcome.usage ? { usage: outcome.usage } : {}) });
  }

  shutdown() {
    for (const s of this.sessions.values()) s.proc = null;
    return Promise.all([...this.children].map(killProc));
  }
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`agy-acp: ${e.message}\n`);
    process.exit(2);
  }
  if (opts.version) return process.stdout.write(`agy-acp ${VERSION}\n`);
  if (opts.help) {
    return process.stdout.write(`Usage: agy-acp [--agy PATH] [--model ID] [--effort ${EFFORTS.join("|")}] [--mode ${MODES.map((m) => m.id).join("|")}] [--dangerously-skip-permissions] [--add-dir DIR]... [--state-dir DIR]\nAn ACP agent on stdio for the Antigravity CLI (agy). agy must be installed and signed in.\n`);
  }
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const agent = new AgyAcpAgent({ send, opts });
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: "2.0", id: null, error: { code: ERR.parse, message: "Parse error" } });
    }
    void agent.handle(msg);
  });
  let quitting = null;
  const quit = () => (quitting ??= agent.shutdown().then(() => process.exit(0)));
  rl.on("close", quit);
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main();
