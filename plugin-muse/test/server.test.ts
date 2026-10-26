import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import museProviderPlugin from "../server.js";

async function load(settings?: { command: string }) {
  const host = createFakePluginHost({ pluginId: "provider-muse", ...(settings ? { settings } : {}) });
  await museProviderPlugin(host.bb);
  return host;
}

const launchSpec = (host: ReturnType<typeof createFakePluginHost>) => {
  const decl = host.harness.registrations.providerRegistrations.at(-1)!;
  return { decl, spec: (decl.experimental_bridgeOptions as { acpLaunchSpec: { command: string } }).acpLaunchSpec };
};

describe("provider-muse", () => {
  it("registers Muse as acp-muse on the ACP bridge, launching muse-acp with Wonder Full first", async () => {
    const { decl, spec } = launchSpec(await load());
    expect(decl.id).toBe("acp-muse");
    expect(decl.displayName).toBe("Muse");
    expect(decl.capabilities.permissionModes).toEqual(["accept-edits", "full"]);
    expect(decl.capabilities.reasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    const primary = ["muse-wonder-full-1.0", "muse-wonder-1.0", "muse-spark-1.3", "muse-spark-1.2"];
    expect(decl.experimental_bridgeOptions).toMatchObject({ acpDialect: "generic", primaryModels: primary });
    expect(spec).toEqual({
      displayName: "Muse",
      command: "muse-acp",
      args: [],
      env: {},
      modelCli: { listArgs: ["--list-models"], primaryModels: primary },
      nativeReasoning: { configId: "reasoningEffort", supportedLevels: ["low", "medium", "high", "xhigh", "max"], defaultLevel: "high" },
      permissionCli: { full: ["--full"] },
    });
  });

  it("never offers a contributor model", async () => {
    const { decl } = launchSpec(await load());
    expect(JSON.stringify(decl)).not.toContain("-contributor");
  });

  it("uses the command setting, and an empty one falls back to muse-acp", async () => {
    expect(launchSpec(await load({ command: "/opt/bin/muse-acp" })).spec.command).toBe("/opt/bin/muse-acp");
    expect(launchSpec(await load({ command: "  " })).spec.command).toBe("muse-acp");
  });
});
