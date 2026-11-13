import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import agyProviderPlugin from "../server.js";

async function load(settings?: { command?: string; addDirs?: string }) {
  const host = createFakePluginHost({ pluginId: "provider-agy", ...(settings ? { settings } : {}) });
  await agyProviderPlugin(host.bb);
  return host;
}

const launchSpec = (host: ReturnType<typeof createFakePluginHost>) => {
  const regs = host.harness.registrations.providerRegistrations;
  return { count: regs.length, decl: regs.at(-1)!, spec: (regs.at(-1)!.experimental_bridgeOptions as { acpLaunchSpec: { command: string; env: Record<string, string> } }).acpLaunchSpec };
};

describe("provider-agy", () => {
  it("registers Antigravity on the ACP bridge, launching agy-acp with Argon first", async () => {
    const { decl, spec } = launchSpec(await load());
    expect(decl.id).toBe("agy");
    expect(decl.displayName).toBe("Antigravity");
    expect(decl.capabilities.permissionModes).toEqual(["accept-edits", "full"]);
    expect(decl.experimental_bridgeOptions).toMatchObject({ acpDialect: "generic", primaryModels: ["gemini-4-argon-high", "gemini-4-argon-medium", "gemini-4-argon-low"] });
    expect(spec).toEqual({
      displayName: "Antigravity",
      command: "agy-acp",
      args: [],
      env: {},
      nativeReasoning: { configId: "effort", supportedLevels: ["low", "medium", "high", "xhigh", "max"] },
      permissionCli: { workspaceWrite: ["--mode", "accept-edits"], full: ["--dangerously-skip-permissions"] },
    });
  });

  it("passes the addDirs setting to agy-acp as AGY_ACP_ADD_DIRS", async () => {
    expect(launchSpec(await load()).spec.env).toEqual({});
    expect(launchSpec(await load({ addDirs: " /home/me/skills:/opt/docs " })).spec.env).toEqual({ AGY_ACP_ADD_DIRS: "/home/me/skills:/opt/docs" });
  });

  it("uses the command setting, and an empty one falls back to agy-acp", async () => {
    expect(launchSpec(await load({ command: "/opt/bin/agy-acp" })).spec.command).toBe("/opt/bin/agy-acp");
    expect(launchSpec(await load({ command: "  " })).spec.command).toBe("agy-acp");
  });
});
