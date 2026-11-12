import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import qoderProviderPlugin from "../server.js";

const QODER_WRAPPER = "/home/danielcor/.qoder/entry/qoder";

async function load(settings?: { command: string }) {
  const host = createFakePluginHost({ pluginId: "provider-qoder", ...(settings ? { settings } : {}) });
  await qoderProviderPlugin(host.bb);
  return host;
}

const current = (host: ReturnType<typeof createFakePluginHost>) => {
  const decl = host.harness.registrations.providerRegistrations.at(-1)!;
  const options = decl.experimental_bridgeOptions as Record<string, unknown> & { acpLaunchSpec: { command: string } };
  return { decl, options, spec: options.acpLaunchSpec };
};

describe("provider-qoder", () => {
  it("registers Qoder through generic ACP with the exact launch contract", async () => {
    const host = await load();
    const { decl, options, spec } = current(host);

    expect(host.harness.registrations.providerRegistrations).toHaveLength(1);
    expect(decl.id).toBe("qoder");
    expect(decl.displayName).toBe("Qoder");
    expect(decl.capabilities.permissionModes).toEqual(["accept-edits", "full"]);
    expect(decl.capabilities.reasoningLevels).toEqual(["none", "low", "high", "xhigh"]);
    expect(decl.capabilities).toMatchObject({
      fork: "tip",
      supportsManualCompaction: false,
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
    });
    expect(decl.maintenance?.usage).toBe(false);
    expect(decl.maintenance?.installation).toBe(false);
    expect(decl.models?.scope).toBe("host");
    // The fallback is Qwen 4 Max Preview as live Qoder 1.1.88 reports it over ACP.
    expect(decl.models?.fallback).toEqual([
      expect.objectContaining({
        id: "qmodel_latest",
        displayName: "Qwen4-Max-Preview",
        isDefault: true,
        defaultReasoningEffort: "xhigh",
      }),
    ]);
    expect(decl.models?.fallback?.[0].supportedReasoningEfforts.map((e) => e.reasoningEffort)).toEqual(["none", "low", "high", "xhigh"]);
    expect(options.acpDialect).toBe("generic");
    // Models come from ACP config options: no CLI list parser and no primary-model filter.
    expect(options).not.toHaveProperty("primaryModels");
    // No nativeReasoning hint: the bridge reads each model's live reasoning_effort option.
    expect(spec).toEqual({
      displayName: "Qoder",
      command: QODER_WRAPPER,
      args: ["--acp"],
      env: {},
      permissionCli: {
        workspaceWrite: ["--permission-mode", "default"],
        full: ["--permission-mode", "bypass_permissions"],
      },
    });
    expect(spec).not.toHaveProperty("modelCli");
    expect(spec).not.toHaveProperty("reasoningCli");
    expect(spec).not.toHaveProperty("nativeReasoning");
  });

  it("declares only a non-secret command setting and no frontend or installer", async () => {
    const host = await load();
    const descriptors = host.harness.registrations.settingsDescriptors as Record<string, { type: string; default?: unknown; secret?: boolean }>;
    expect(Object.keys(descriptors)).toEqual(["command"]);
    expect(descriptors.command.type).toBe("string");
    expect(descriptors.command.secret).not.toBe(true);
    expect(descriptors.command.default).toBe(QODER_WRAPPER);

    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.name).toBe("bb-plugin-provider-qoder");
    expect(manifest.bb).toMatchObject({ server: "./server.ts", host: "./src/host.ts" });
    expect(manifest.bb).not.toHaveProperty("app");
  });

  it("uses the command setting and an empty one falls back to the absolute Qoder wrapper", async () => {
    expect(current(await load({ command: "/opt/qoder/bin/qodercli" })).spec.command).toBe("/opt/qoder/bin/qodercli");
    expect(current(await load({ command: "  " })).spec.command).toBe(QODER_WRAPPER);
  });

  it("replaces and disposes the registration without leaking resources", async () => {
    const host = await load();
    await host.harness.setSettings({ command: "/opt/qoder/bin/qodercli" });

    const registrations = host.harness.registrations.providerRegistrations;
    expect(registrations).toHaveLength(1);
    expect(current(host).spec.command).toBe("/opt/qoder/bin/qodercli");

    await host.harness.dispose();
    expect(host.harness.registrations.providerRegistrations).toHaveLength(0);
  });
});
