import { homedir } from "node:os";
import { posix } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { cliCommand, defineCli, PluginCliError } from "@get-bb/plugin-sdk";
import { contract, type ListResult, type ScopeInfo } from "./src/contract.js";
import type { Scope, SnippetView } from "./src/model.js";
import { stripInvisible } from "./src/secrets.js";
import { SnippetStore, type FilesPort, type Location } from "./src/store.js";

// A dot-folder: distribute-skills only picks up ~/skills/*/ folders with a SKILL.md, and skips this one.
export const DEFAULT_GLOBAL_DIR = "~/skills/.snippets";
export const PROJECT_SUBDIR = ".snippets";

export function expandHome(dir: string, home: string): string {
  const d = dir.trim();
  if (d === "~") return home;
  if (d.startsWith("~/")) return posix.join(home, d.slice(2));
  return d;
}

export default async function snippetsPlugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    globalDir: {
      type: "string",
      label: "Global snippets folder",
      description:
        "Absolute path, or ~/…, on the machine the Cloudroom server runs on. Point it at a Git checkout (for example ~/skills/.snippets) to version the global set. Project snippets always live in <repo>/.snippets/.",
      default: DEFAULT_GLOBAL_DIR,
    },
  });

  // `bb.sdk` is bound lazily: read it inside handlers, never at load.
  const store = new SnippetStore({
    read: (a) => bb.sdk.files.read(a),
    write: (a) => bb.sdk.files.write(a),
    list: (a) => bb.sdk.files.list(a),
    remove: (a) => bb.sdk.files.remove(a),
  } satisfies FilesPort);

  async function globalLocation(): Promise<Location> {
    const dir = expandHome((await settings.get()).globalDir || DEFAULT_GLOBAL_DIR, homedir());
    if (!posix.isAbsolute(dir)) throw new Error(`The global snippets folder must be an absolute path or start with ~/ (got "${dir}").`);
    return { scope: "global", dir: posix.normalize(dir) };
  }

  async function projectLocation(projectId: string): Promise<Location & { name: string }> {
    const project = await bb.sdk.projects.get({ projectId });
    const source = project.sources.find((s) => s.isDefault) ?? project.sources[0];
    if (!source) throw new Error(`Project ${project.name} has no local checkout.`);
    return {
      scope: "project",
      hostId: source.hostId,
      dir: posix.join(source.path, PROJECT_SUBDIR),
      name: project.name,
    };
  }

  async function locate(scope: Scope, projectId: string | null): Promise<Location> {
    if (scope === "global") return globalLocation();
    if (!projectId) throw new Error("Pick a project first: project snippets live in that project's repo.");
    return projectLocation(projectId);
  }

  async function listAll(projectId: string | null): Promise<ListResult> {
    const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
    const global: ScopeInfo = { dir: "", error: null };
    let globalSnippets: SnippetView[] = [];
    try {
      const loc = await globalLocation();
      global.dir = loc.dir;
      globalSnippets = await store.list(loc);
    } catch (e) {
      global.error = errorText(e);
    }
    let project: ListResult["project"] = null;
    let projectSnippets: SnippetView[] = [];
    if (projectId) {
      try {
        const loc = await projectLocation(projectId);
        project = { id: projectId, name: loc.name, dir: loc.dir, error: null };
        projectSnippets = await store.list(loc);
      } catch (e) {
        project = { id: projectId, name: project?.name ?? projectId, dir: project?.dir ?? "", error: errorText(e) };
      }
    }
    const projectIds = new Set(projectSnippets.map((s) => s.id));
    for (const s of globalSnippets) s.shadowed = projectIds.has(s.id);
    // Project snippets first: a project snippet with the same id wins.
    return { global, project, snippets: [...projectSnippets, ...globalSnippets] };
  }

  bb.rpc.register(contract, {
    async projects() {
      const all = await bb.sdk.projects.list();
      return all.filter((p) => p.sources.length > 0).map((p) => ({ id: p.id, name: p.name }));
    },
    async threadProject({ threadId }) {
      try {
        return { projectId: (await bb.sdk.threads.get({ threadId })).projectId };
      } catch {
        return { projectId: null };
      }
    },
    list: ({ projectId }) => listAll(projectId),
    async create({ scope, projectId, title, tags, body, id, order, created }) {
      return store.create(await locate(scope, projectId), { title, tags, body }, { id, order, created });
    },
    async save({ scope, projectId, id, expectedSha256, title, tags, body }) {
      return store.save(await locate(scope, projectId), id, { title, tags, body }, expectedSha256);
    },
    async duplicate({ scope, projectId, id }) {
      return store.duplicate(await locate(scope, projectId), id);
    },
    async remove({ scope, projectId, id, expectedSha256 }) {
      return store.remove(await locate(scope, projectId), id, expectedSha256);
    },
    async move({ scope, projectId, id, toIndex }) {
      return store.move(await locate(scope, projectId), id, toIndex);
    },
  });

  bb.cli.register(
    defineCli({
      name: "snip",
      summary: "List and show Prompt Snippets (project snippets first, then global).",
      description:
        "Fallback for agents: expand a snippet only when the user named it in their message. Project snippets come from the current thread's project.",
      commands: {
        list: cliCommand({
          summary: "List snippets: id, scope, title and tags.",
          options: { json: { type: "boolean", description: "Print JSON instead of a table." } },
          async run({ options }, ctx) {
            const result = await listAll(ctx.projectId ?? null);
            // A flagged snippet shows only its id: the secret may sit in its title, tags or a placeholder default.
            const visible = result.snippets
              .filter((s) => !s.shadowed)
              .map((s) => (s.secrets.length ? { ...s, title: "(hidden: looks like a secret)", tags: [], placeholders: [] } : s));
            if (options.json) {
              const rows = visible.map(({ id, scope, title, tags, placeholders, secrets }) => ({ id, scope, title, tags, placeholders, secretWarning: secrets.length > 0 }));
              return { exitCode: 0, stdout: `${JSON.stringify(rows, null, 2)}\n` };
            }
            const warn = [result.global.error && `global: ${result.global.error}`, result.project?.error && `project: ${result.project.error}`].filter(Boolean);
            const lines = visible.map((s) => `${s.id}\t${s.scope}\t${s.title}${s.tags.length ? `\t[${s.tags.join(", ")}]` : ""}`);
            return {
              exitCode: 0,
              stdout: lines.length ? `${lines.join("\n")}\n` : "No snippets.\n",
              ...(warn.length ? { stderr: `${warn.join("\n")}\n` } : {}),
            };
          },
        }),
        show: cliCommand({
          summary: "Print one snippet's body. Placeholders stay as {{name}} or {{name|default}}.",
          positionals: [{ name: "name", description: "Snippet id (the file name without .md).", required: true }],
          async run({ positionals }, ctx) {
            const name = String(positionals.name);
            const result = await listAll(ctx.projectId ?? null);
            const s = result.snippets.find((x) => x.id === name && !x.shadowed);
            if (!s) throw new PluginCliError(`No snippet named "${name}".`, { code: "not_found", hint: "Run `room-cli snip list` to see the ids." });
            if (s.secrets.length) {
              throw new PluginCliError(`Snippet "${name}" looks like it holds a secret (${s.secrets.join("; ")}); not printing it.`, { code: "secret_blocked", exitCode: 2 });
            }
            return { exitCode: 0, stdout: `${stripInvisible(s.body).replace(/\n?$/u, "\n")}` };
          },
        }),
      },
    }),
  );
}
