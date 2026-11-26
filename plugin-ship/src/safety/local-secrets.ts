import { constants } from "node:fs";
import { lstat, open, opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isAlias, isNode, isPair, isScalar, parseAllDocuments, visit, type Alias, type Document, type Node } from "yaml";
import { foldConfusables, isSecretEnvBasename, normalizePathForCheck, stripInvisible } from "./never-edit.js";

export interface LocalSecret {
  name: string;
  value: string;
}

export interface LocalSecretCollection {
  secrets: LocalSecret[];
  incomplete: boolean;
  incompleteReasons: string[];
}

const SCALAR = /^(?:true|false|null|yes|no|on|off|~)$/iu;
const DOTENV_SECRET_ENDINGS = ["token", "secret", "password", "passwd", "passphrase", "credential", "credentials"];
const DOTENV_SECRET_WORDS = new Set([
  "key",
  "pwd",
  "auth",
  "pat",
  "apikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "clientkey",
  "signingkey",
  "passkey",
]);

function isDotenvSecretName(name: string): boolean {
  const words = name
    .replace(/([A-Z])([A-Z][a-z])/gu, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[\s_.-]+/u)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const last = words.at(-1);
  if (last === undefined) return false;
  return DOTENV_SECRET_WORDS.has(last) || DOTENV_SECRET_ENDINGS.some((e) => last.endsWith(e));
}

const TEMPLATE_REF_ATOM =
  String.raw`\.?[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\s*(?:["'][A-Za-z0-9_.-]+["']|\d+)\s*\])*`;
const PURE_REF_RE = new RegExp(
  String.raw`^(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$\{[A-Za-z_][A-Za-z0-9_]*:?[-=?+]\}|%[A-Za-z_][A-Za-z0-9_]*%|\$?\{\{\s*${TEMPLATE_REF_ATOM}(?:\s*(?:\|\||\?\?)\s*${TEMPLATE_REF_ATOM})*\s*\}\})$`,
  "su",
);

function anchorIndex(doc: Document.Parsed): (alias: Alias) => Node | undefined {
  const byName = new Map<string, { at: number; node: Node }[]>();
  visit(doc, {
    Node(_key, node) {
      if (isNode(node) && !isAlias(node) && node.anchor && node.range) {
        const list = byName.get(node.anchor) ?? [];
        list.push({ at: node.range[0], node });
        byName.set(node.anchor, list);
      }
    },
  });
  return (alias) => {
    const list = byName.get(alias.source);
    if (!list || !alias.range) return undefined;
    let lo = 0;
    let hi = list.length - 1;
    let found: Node | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.at < alias.range[0]) {
        found = list[mid]!.node;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
}

const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 4_000_000;
const MAX_ENV_FILES = 64;
const MAX_DIR_ENTRIES = 4_096;

type BoundedReadResult =
  | { status: "ok"; text: string; bytesRead: number }
  | { status: "missing"; bytesRead: 0 }
  | { status: "truncated"; text: string; bytesRead: number }
  | { status: "non_regular"; bytesRead: 0 }
  | { status: "error"; code?: string; bytesRead: number };

async function classifyEnoentPath(filePath: string): Promise<"dangling" | "absent" | "error"> {
  let cur = resolve(filePath);
  while (true) {
    try {
      const st = await lstat(cur);
      if (st.isSymbolicLink()) {
        try {
          await stat(cur);
        } catch {
          return "dangling";
        }
      }
      return "absent";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        return "error";
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return "absent";
    cur = parent;
  }
}

async function readTextBounded(filePath: string, maxBytes = MAX_FILE_BYTES): Promise<BoundedReadResult> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let totalBytes = 0;
  try {
    try {
      handle = await open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const kind = await classifyEnoentPath(filePath);
        if (kind === "absent") {
          return { status: "missing", bytesRead: 0 };
        }
        return { status: "error", code: "ENOENT", bytesRead: 0 };
      }
      return { status: "error", code, bytesRead: 0 };
    }
    const st = await handle.stat();
    if (!st.isFile()) return { status: "non_regular", bytesRead: 0 };

    const chunks: Buffer[] = [];
    let remaining = maxBytes + 1;
    while (remaining > 0) {
      const buf = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead <= 0) break;
      chunks.push(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
      totalBytes += bytesRead;
      remaining -= bytesRead;
    }
    const combined = Buffer.concat(chunks);
    if (totalBytes > maxBytes) {
      return { status: "truncated", text: combined.subarray(0, maxBytes).toString("utf8"), bytesRead: maxBytes };
    }
    return { status: "ok", text: combined.toString("utf8"), bytesRead: totalBytes };
  } catch (err) {
    return { status: "error", code: (err as NodeJS.ErrnoException).code, bytesRead: Math.min(totalBytes, maxBytes) };
  } finally {
    await handle?.close().catch(() => {});
  }
}

type DotenvQuote = "none" | "single" | "double" | "backtick";

interface DotenvEntry {
  key: string;
  value: string;
  quote: DotenvQuote;
  literal?: boolean;
}

function decodeShellUnquoted(raw: string): { value: string; hadEscapes: boolean } | null {
  let out = "";
  let hadEscapes = false;
  for (let k = 0; k < raw.length; k++) {
    const ch = raw[k]!;
    if (ch === "\\" && k + 1 < raw.length) {
      hadEscapes = true;
      out += raw[k + 1]!;
      k += 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      const rest = raw.slice(k).trimStart();
      if (rest === "" || rest.startsWith("#")) {
        return { value: out, hadEscapes };
      }
      return null;
    }
    out += ch;
  }
  return { value: out, hadEscapes };
}

function parseDotenv(text: string): { entries: DotenvEntry[]; incomplete: boolean } {
  const src = (text.startsWith("\uFEFF") ? text.slice(1) : text).replace(/\r\n/gu, "\n");
  const n = src.length;
  const entries: DotenvEntry[] = [];
  let incomplete = false;
  let i = 0;

  while (i < n) {
    while (i < n && (src[i] === " " || src[i] === "\t" || src[i] === "\n")) {
      i += 1;
    }
    if (i >= n) break;
    if (src[i] === "#") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }

    const lineEnd = src.indexOf("\n", i);
    const stopLine = lineEnd === -1 ? n : lineEnd;
    const headMatch = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=/u.exec(src.slice(i, stopLine));
    if (!headMatch) {
      incomplete = true;
      i = stopLine + 1;
      continue;
    }

    const key = headMatch[1]!;
    i += headMatch[0].length;
    const afterEq = i;
    while (i < n && (src[i] === " " || src[i] === "\t")) {
      i += 1;
    }
    const hadSpaceAfterEq = i > afterEq;

    if (i >= n || src[i] === "\n") {
      entries.push({ key, value: "", quote: "none" });
      if (src[i] === "\n") i += 1;
      continue;
    }

    const quote = src[i]!;
    if (quote === '"') {
      i += 1;
      const bodyStart = i;
      let bodyEnd = n;
      let decoded = "";
      let shellStyle = "";
      let closed = false;
      while (i < n) {
        const ch = src[i]!;
        if (ch === '"') {
          closed = true;
          bodyEnd = i;
          i += 1;
          break;
        }
        if (ch === "\\") {
          if (i + 1 >= n) {
            incomplete = true;
            decoded += "\\";
            shellStyle += "\\";
            i += 1;
            break;
          }
          const nxt = src[i + 1]!;
          if (nxt === "\n") {
            i += 2;
            continue;
          }
          if (nxt === "n") {
            decoded += "\n";
            shellStyle += "\\n";
          } else if (nxt === "r") {
            decoded += "\r";
            shellStyle += "\\r";
          } else if (nxt === "t") {
            decoded += "\t";
            shellStyle += "\\t";
          } else if (nxt === '"' || nxt === "\\" || nxt === "$") {
            decoded += nxt;
            shellStyle += nxt;
          } else if (nxt === "`") {
            decoded += "\\`";
            shellStyle += "`";
          } else {
            decoded += "\\" + nxt;
            shellStyle += "\\" + nxt;
          }
          i += 2;
          continue;
        }
        decoded += ch;
        shellStyle += ch;
        i += 1;
      }
      if (!closed) incomplete = true;
      const rawBody = src.slice(bodyStart, closed ? bodyEnd : i);
      const nodeStyle = rawBody.replace(/\r/gu, "").replace(/\\n/gu, "\n");
      const dotenvStyle = rawBody.replace(/\r\n?/gu, "\n").replace(/\\n/gu, "\n").replace(/\\r/gu, "\r");
      for (const v of new Set([decoded, shellStyle, nodeStyle, dotenvStyle])) {
        entries.push({ key, value: v, quote: "double" });
      }
      const restEnd = src.indexOf("\n", i);
      const stop = restEnd === -1 ? n : restEnd;
      if (!/^[ \t]*(?:#.*)?$/u.test(src.slice(i, stop))) {
        incomplete = true;
      }
      i = stop + 1;
      continue;
    }

    if (quote === "'" || quote === "`") {
      const qKind: DotenvQuote = quote === "'" ? "single" : "backtick";
      i += 1;
      const closeIdx = src.indexOf(quote, i);
      if (closeIdx === -1) {
        incomplete = true;
        const val = src.slice(i);
        entries.push({ key, value: val, quote: qKind });
        if (val.includes("\r")) {
          entries.push({ key, value: val.replace(/\r/gu, ""), quote: qKind });
        }
        i = n;
        continue;
      }
      const val = src.slice(i, closeIdx);
      entries.push({ key, value: val, quote: qKind });
      if (val.includes("\r")) {
        entries.push({ key, value: val.replace(/\r/gu, ""), quote: qKind });
      }
      i = closeIdx + 1;
      const restEnd = src.indexOf("\n", i);
      const stop = restEnd === -1 ? n : restEnd;
      if (!/^[ \t]*(?:#.*)?$/u.test(src.slice(i, stop))) {
        incomplete = true;
      }
      i = stop + 1;
      continue;
    }

    const valEnd = src.indexOf("\n", i);
    const stop = valEnd === -1 ? n : valEnd;
    const raw = src.slice(i, stop);
    i = stop + 1;
    if (/(?:^|[^\\])(?:\\\\)*\\$/u.test(raw)) {
      incomplete = true;
    }
    const collectUnquoted = (rawLine: string): string[] => {
      const vals: string[] = [];
      const hashIdx = rawLine.indexOf("#");
      if (hashIdx === -1) {
        vals.push(rawLine.trim());
      } else if (hashIdx === 0 || /[ \t]/u.test(rawLine[hashIdx - 1]!)) {
        vals.push(rawLine.slice(0, hashIdx).trim());
      } else {
        const stripped = rawLine.slice(0, hashIdx).trim();
        if (stripped !== "") vals.push(stripped);
        const full = rawLine.trim();
        if (full !== "" && full !== stripped) vals.push(full);
      }
      return vals;
    };
    const unquotedVals = collectUnquoted(raw);
    if (raw.includes("\r")) {
      for (const v of collectUnquoted(raw.replace(/\r/gu, ""))) {
        if (v !== "") unquotedVals.push(v);
      }
    }
    const emitted = new Map<string, boolean>();
    for (const v of unquotedVals) {
      if (emitted.has(v)) continue;
      entries.push({ key, value: v, quote: "none" });
      emitted.set(v, false);
    }
    if (!hadSpaceAfterEq) {
      const shellDecoded = decodeShellUnquoted(raw);
      if (shellDecoded && shellDecoded.value !== "") {
        const prevLit = emitted.get(shellDecoded.value);
        if (prevLit === undefined || (shellDecoded.hadEscapes && !prevLit)) {
          entries.push({
            key,
            value: shellDecoded.value,
            quote: "none",
            ...(shellDecoded.hadEscapes ? { literal: true } : {}),
          });
        }
      }
    }
  }

  return { entries, incomplete };
}

function parseGhHostsYml(text: string): { tokens: string[]; incomplete: boolean } {
  if (text.trim() === "") return { tokens: [], incomplete: false };
  const tokens: string[] = [];
  let incomplete = false;
  let docs: Document.Parsed[];
  try {
    const parsed = parseAllDocuments(text, { schema: "failsafe", strict: false, uniqueKeys: false, prettyErrors: false });
    docs = Array.isArray(parsed) ? parsed : [];
  } catch {
    return { tokens: [], incomplete: true };
  }
  for (const doc of docs) {
    if (doc.errors.length > 0) {
      incomplete = true;
    }
    const resolveAlias = anchorIndex(doc);
    visit(doc, {
      Pair(_key, pair) {
        if (!isPair(pair) || !isScalar(pair.key) || String(pair.key.value) !== "oauth_token") return;
        if (pair.value === null) return;
        const rawNode = pair.value as Node;
        const valNode = isAlias(rawNode) ? resolveAlias(rawNode) : rawNode;
        if (!valNode || !isScalar(valNode)) {
          incomplete = true;
          return;
        }
        if (typeof valNode.value === "string") {
          if (valNode.value !== "") tokens.push(valNode.value);
          return;
        }
        if (typeof valNode.source === "string" && valNode.source !== "") {
          tokens.push(valNode.source);
        }
        if (valNode.value !== null && valNode.value !== undefined) {
          const rendered = String(valNode.value);
          if (rendered !== "" && rendered !== valNode.source) tokens.push(rendered);
        }
      },
    });
  }
  return { tokens, incomplete };
}

function parseGitCredentials(text: string): { passwords: string[]; incomplete: boolean } {
  const passwords: string[] = [];
  let incomplete = false;
  const pushField = (raw: string) => {
    passwords.push(raw);
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded !== raw) passwords.push(decoded);
    } catch {
      incomplete = true;
    }
  };
  for (const line of text.replace(/\r\n?/gu, "\n").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      incomplete = true;
      continue;
    }
    if (url.password === "") continue;
    let decodedPassword = url.password;
    try {
      decodedPassword = decodeURIComponent(url.password);
    } catch {
      // Malformed percent encoding handled below via pushField.
    }
    if (decodedPassword === "x-oauth-basic" && url.username !== "") {
      pushField(url.username);
    } else {
      pushField(url.password);
    }
  }
  return { passwords, incomplete };
}

function isDotenvEntryName(name: string): boolean {
  const candidates = [
    normalizePathForCheck(name, false),
    normalizePathForCheck(foldConfusables(name, false), false),
    normalizePathForCheck(foldConfusables(name, true), false),
  ];
  return candidates.some((c) => isSecretEnvBasename(c));
}

function insertSorted(arr: string[], value: string): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, value);
}

type SecretCandidateSource = "explicit_cred" | "dotenv_secret_key" | "dotenv_ambiguous";

/**
 * Collect local credential values on the host machine (`.env*` in `root`,
 * `gh` `hosts.yml`, `GH_TOKEN`/`GITHUB_TOKEN`, and `~/.git-credentials`),
 * along with completeness status if any source was truncated, unreadable, or malformed.
 * Never return or log raw secret values outside the host process.
 */
export async function collectLocalSecrets(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<LocalSecretCollection> {
  const out: (LocalSecret & { source: SecretCandidateSource; quote?: DotenvQuote; literal?: boolean })[] = [];
  const incompleteReasons: string[] = [];
  let remainingBytes = MAX_TOTAL_BYTES;

  const readWithinBudget = async (label: string, filePath: string, optional: boolean): Promise<string> => {
    if (remainingBytes <= 0) {
      incompleteReasons.push(`budget_exceeded:${label}`);
      return "";
    }
    const cap = Math.min(MAX_FILE_BYTES, remainingBytes);
    const res = await readTextBounded(filePath, cap);
    remainingBytes = Math.max(0, remainingBytes - res.bytesRead);
    if (res.status === "ok") return res.text;
    if (res.status === "missing") {
      if (!optional) incompleteReasons.push(`unreadable:${label}`);
      return "";
    }
    if (res.status === "truncated") {
      incompleteReasons.push(`truncated:${label}`);
      if (cap < MAX_FILE_BYTES) {
        incompleteReasons.push(`budget_exceeded:${label}`);
      }
      return res.text;
    }
    if (res.status === "non_regular") {
      incompleteReasons.push(`non_regular:${label}`);
      return "";
    }
    incompleteReasons.push(`unreadable:${label}`);
    return "";
  };

  const xdgConfig = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  const ghConfigDir = env.GH_CONFIG_DIR ? resolve(root, env.GH_CONFIG_DIR) : join(xdgConfig, "gh");

  const hostsYml = await readWithinBudget("gh hosts.yml", join(ghConfigDir, "hosts.yml"), true);
  if (hostsYml !== "") {
    const parsedHosts = parseGhHostsYml(hostsYml);
    if (parsedHosts.incomplete) incompleteReasons.push("parse_error:gh hosts.yml");
    for (const token of parsedHosts.tokens) {
      out.push({ name: "gh oauth_token", value: token, source: "explicit_cred" });
    }
  }

  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const) {
    const v = env[key];
    if (v) out.push({ name: key, value: v, source: "explicit_cred" });
  }

  const credPaths = [
    { label: ".git-credentials", path: join(home, ".git-credentials") },
    { label: "git/credentials", path: join(xdgConfig, "git", "credentials") },
  ];
  for (const { label, path } of credPaths) {
    const text = await readWithinBudget(label, path, true);
    if (text === "") continue;
    const parsedCreds = parseGitCredentials(text);
    if (parsedCreds.incomplete) incompleteReasons.push(`parse_error:${label}`);
    for (const pass of parsedCreds.passwords) {
      out.push({ name: "git credential", value: pass, source: "explicit_cred" });
    }
  }

  const envFiles: string[] = [];
  let envFilesOverflow = false;
  let dirEntriesOverflow = false;
  let dirHandle: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    dirHandle = await opendir(root);
    let scannedEntries = 0;
    for await (const dirent of dirHandle) {
      scannedEntries += 1;
      if (scannedEntries > MAX_DIR_ENTRIES) {
        dirEntriesOverflow = true;
        break;
      }
      const name = dirent.name;
      if (!isDotenvEntryName(name)) continue;
      if (envFiles.length < MAX_ENV_FILES) {
        insertSorted(envFiles, name);
      } else {
        envFilesOverflow = true;
        if (name < envFiles[envFiles.length - 1]!) {
          envFiles.pop();
          insertSorted(envFiles, name);
        }
      }
    }
  } catch {
    incompleteReasons.push(`unreadable_dir:${root}`);
  } finally {
    await dirHandle?.close().catch(() => {});
  }
  if (dirEntriesOverflow) {
    incompleteReasons.push("budget_exceeded:dir_entries");
  }
  if (envFilesOverflow) {
    incompleteReasons.push("budget_exceeded:env_files");
  }
  for (const f of envFiles) {
    const text = await readWithinBudget(f, join(root, f), false);
    if (text === "") continue;
    const parsed = parseDotenv(text);
    if (parsed.incomplete) incompleteReasons.push(`parse_error:${f}`);
    for (const entry of parsed.entries) {
      out.push({
        name: `${entry.key} in ${f}`,
        value: entry.value,
        quote: entry.quote,
        literal: entry.literal,
        source: isDotenvSecretName(entry.key) ? "dotenv_secret_key" : "dotenv_ambiguous",
      });
    }
  }

  const secrets = out
    .filter(({ value, source, quote, literal }) => {
      if (source === "explicit_cred") {
        return value.length > 0;
      }
      if (source === "dotenv_secret_key") {
        if (value.length === 0) return false;
        if ((quote !== undefined && quote !== "none") || literal) return true;
        return !/^(?:0|1)$/u.test(value) && !SCALAR.test(value) && !PURE_REF_RE.test(value);
      }
      return value.length >= 8 && !/^[A-Za-z_-]+$/u.test(value);
    })
    .map(({ name, value }) => ({ name, value }));

  return {
    secrets,
    incomplete: incompleteReasons.length > 0,
    incompleteReasons,
  };
}

/**
 * Returns only the human-readable source name (e.g. `"API_KEY in .env"`) if any
 * collected local secret appears in `text`, or `null`. Never exposes the secret value.
 */
export function findLocalSecretMatch(text: string, localSecrets: readonly LocalSecret[]): string | null {
  const normalizedText = text.replace(/\r\n?/gu, "\n");
  const cleanText = stripInvisible(normalizedText);
  for (const s of localSecrets) {
    if (s.value === "") continue;
    if (text.includes(s.value)) return s.name;
    const normalizedSecret = s.value.replace(/\r\n?/gu, "\n");
    if (normalizedSecret !== "" && normalizedText.includes(normalizedSecret)) return s.name;
    const cleanSecret = stripInvisible(normalizedSecret);
    if (cleanSecret !== "" && cleanText.includes(cleanSecret)) return s.name;
  }
  return null;
}
