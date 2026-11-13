import { homedir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import snippetsPlugin, { expandHome } from "../server.js";
import { FakeFiles } from "./fake-files.js";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.harness.dispose();
});

const project = {
  id: "proj_1",
  name: "cloudroom-plugins",
  kind: "standard",
  gitRemoteUrl: null,
  createdAt: 0,
  updatedAt: 0,
  sources: [{ id: "src_1", projectId: "proj_1", hostId: "host_aipc", path: "/repo", isDefault: true, type: "local_path", createdAt: 0, updatedAt: 0 }],
};

async function load(seed: Record<string, string> = {}, settings: Record<string, string> = { globalDir: "/g" }) {
  const files = new FakeFiles(seed);
  const host = createFakePluginHost({
    pluginId: "snippets",
    settings,
    sdk: {
      files: { read: (a) => files.read(a), write: (a) => files.write(a) as never, list: (a) => files.list(a), remove: (a) => files.remove(a) as never },
      projects: { get: async () => project as never, list: async () => [project] as never },
      threads: { get: async ({ threadId }) => ({ projectId: threadId === "thr_1" ? "proj_1" : "other" }) as never },
    },
  });
  hosts.push(host);
  await snippetsPlugin(host.bb);
  return { host, files };
}

const md = (title: string, order: number, body: string) => `---\ntitle: ${title}\norder: ${order}\n---\n${body}`;

describe("snippets server", () => {
  it("registers the rpc methods and the snip CLI", async () => {
    const { host } = await load();
    expect([...host.harness.inspection.registrations.rpcMethods].sort()).toEqual(["create", "duplicate", "list", "move", "projects", "remove", "save", "threadProject"]);
    const help = await host.harness.runCli(["--help"]);
    expect(help.stdout).toContain("list");
    expect(help.stdout).toContain("show");
  });

  it("lists project snippets first and marks a shadowed global one", async () => {
    const { host } = await load({
      "/g/review.md": md("Global review", 10, "g"),
      "/g/commit.md": md("Commit", 20, "c"),
      "/repo/.snippets/review.md": md("Project review", 10, "p"),
    });
    const r = (await host.harness.callRpc("list", { projectId: "proj_1" })) as { snippets: { id: string; scope: string; shadowed: boolean }[]; project: { dir: string } };
    expect(r.project.dir).toBe("/repo/.snippets");
    expect(r.snippets.map((s) => [s.scope, s.id, s.shadowed])).toEqual([
      ["project", "review", false],
      ["global", "review", true],
      ["global", "commit", false],
    ]);
  });

  it("validates rpc input before a handler runs", async () => {
    const { host, files } = await load();
    await expect(host.harness.callRpc("remove", { scope: "global", projectId: null, id: "../../x", expectedSha256: "s" })).rejects.toThrow();
    await expect(host.harness.callRpc("create", { scope: "global", projectId: null, title: "t", tags: [], body: "", extra: 1 })).rejects.toThrow();
    expect(files.writes).toEqual([]);
  });

  it("refuses a project write without a project", async () => {
    const { host } = await load();
    await expect(host.harness.callRpc("create", { scope: "project", projectId: null, title: "t", tags: [], body: "" })).rejects.toThrow("Pick a project first");
  });

  it("resolves a thread's project", async () => {
    const { host } = await load();
    expect(await host.harness.callRpc("threadProject", { threadId: "thr_1" })).toEqual({ projectId: "proj_1" });
  });

  it("room-cli snip list and show, with the project from the CLI context", async () => {
    const { host } = await load({
      "/g/commit.md": md("Commit message", 10, "Write a commit message.\n"),
      "/repo/.snippets/brief.md": "---\ntitle: Worker brief\ntags: delegate\n---\nWORKER BRIEF for {{role}}​",
    });
    const list = await host.harness.runCli(["list"], { projectId: "proj_1" });
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toBe("brief\tproject\tWorker brief\t[delegate]\ncommit\tglobal\tCommit message\n");
    const show = await host.harness.runCli(["show", "brief"], { projectId: "proj_1" });
    expect(show).toMatchObject({ exitCode: 0, stdout: "WORKER BRIEF for {{role}}\n" });
    const missing = await host.harness.runCli(["show", "nope"], {});
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain('No snippet named "nope"');
  });

  it("room-cli snip show refuses a snippet that looks like a secret", async () => {
    const token = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    const { host } = await load({ "/g/leak.md": md("Leak", 10, `key ${token}`) });
    const r = await host.harness.runCli(["show", "leak"], {});
    expect(r.exitCode).toBe(2);
    expect(r.stdout + r.stderr).not.toContain(token);
  });

  it("room-cli snip list hides a flagged snippet's title, tags and placeholder defaults", async () => {
    const token = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    const { host } = await load({ "/g/leak.md": `---\ntitle: key ${token}\ntags: ${token.toLowerCase()}\n---\nuse {{key|${token}}}` });
    const table = await host.harness.runCli(["list"], {});
    expect(table.stdout).toBe("leak\tglobal\t(hidden: looks like a secret)\n");
    const json = await host.harness.runCli(["list", "--json"], {});
    expect(json.stdout).not.toContain(token);
    expect(JSON.parse(json.stdout)).toEqual([{ id: "leak", scope: "global", title: "(hidden: looks like a secret)", tags: [], placeholders: [], secretWarning: true }]);
  });

  it("defaults the global folder to ~/skills/.snippets and project snippets to <repo>/.snippets", async () => {
    const { host } = await load({}, {});
    const r = (await host.harness.callRpc("list", { projectId: "proj_1" })) as { global: { dir: string }; project: { dir: string } };
    expect(r.global.dir).toBe(`${homedir()}/skills/.snippets`);
    expect(r.project.dir).toBe("/repo/.snippets");
  });

  it("expands ~ in the global folder", () => {
    expect(expandHome("~/skills/.snippets", "/home/d")).toBe("/home/d/skills/.snippets");
    expect(expandHome("~", "/home/d")).toBe("/home/d");
    expect(expandHome("/abs", "/home/d")).toBe("/abs");
  });
});
