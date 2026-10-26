// The host artifact resolves muse-acp on machines whose daemon has a bare PATH
// (src/resolve.ts is provider-agy's; its own tests live in plugin/test/resolve.test.ts)
// and pins every thread to a non-contributor model.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_providerBridge, rewriteLine } from "../src/host.js";
import { resolveLaunchSpec } from "../src/resolve.js";
import { MUSE_MODELS, museLaunchSpec, museProviderDeclaration } from "../src/declaration.js";

describe("muse-acp launch on a bare PATH", () => {
  it("Mac: finds muse-acp in Homebrew's bin and puts ~/.local/bin (muse) on PATH", () => {
    const spec = resolveLaunchSpec(museLaunchSpec("muse-acp"), {
      home: "/Users/u",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      exists: (p) => ["/Users/u/.local/bin", "/opt/homebrew/bin"].includes(p),
      executable: (p) => p === "/opt/homebrew/bin/muse-acp",
    });
    expect(spec.command).toBe("/opt/homebrew/bin/muse-acp");
    expect(spec.env.PATH).toBe("/opt/homebrew/bin:/Users/u/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(spec.modelCli).toEqual(museLaunchSpec("muse-acp").modelCli);
    expect(spec.permissionCli).toEqual({ full: ["--full"] });
  });

  it("rewrites the launch spec of a model-list request too", () => {
    const line = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "model/list", params: { providerOptions: { acpLaunchSpec: { ...museLaunchSpec("muse-acp"), command: "/abs/muse-acp" } } } });
    const out = JSON.parse(rewriteLine(line));
    expect(out.params.providerOptions.acpLaunchSpec.command).toBe("/abs/muse-acp");
    expect(out.params.providerOptions.acpLaunchSpec.modelCli.listArgs).toEqual(["--list-models", "--first", "muse-wonder-full-1.0"]);
  });
});

describe("thread model pinning", () => {
  const model = (m: unknown, method = "turn/start") => {
    const options = { ...(m === undefined ? {} : { model: m }), providerOptions: { acpLaunchSpec: museLaunchSpec("muse-acp") } };
    return JSON.parse(rewriteLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { threadId: "t", options } }))).params.options.model;
  };

  it("runs the plain twin of a contributor model", () => {
    expect(model("muse-wonder-full-1.0-contributor", "thread/start")).toBe("muse-wonder-full-1.0");
    expect(model("muse-spark-1.3-contributor")).toBe("muse-spark-1.3");
    const qualified = (id: string) => `muse-model:${encodeURIComponent(JSON.stringify(["meta", null, id]))}`;
    expect(model(qualified("muse-wonder-full-1.0-contributor"))).toBe("muse-wonder-full-1.0");
    expect(model(qualified("muse-spark-1.2"))).toBe(qualified("muse-spark-1.2"));
  });

  it("gives a thread without a model Wonder Full, and keeps a chosen one", () => {
    expect(model(undefined, "thread/start")).toBe("muse-wonder-full-1.0");
    expect(model("acp-default")).toBe("muse-wonder-full-1.0");
    expect(model("muse-spark-1.2")).toBe("muse-spark-1.2");
  });
});

describe("model/list through the SDK bridge", () => {
  it("lists Muse's catalog without contributor models, with Wonder Full the default", async () => {
    const h = createBridgeJsonRpcTestHarness(experimental_providerBridge.handleLine);
    const bridgeOptions = museProviderDeclaration("muse-acp").experimental_bridgeOptions as Record<string, unknown>;
    const acpLaunchSpec = { ...museLaunchSpec("muse-acp"), command: fileURLToPath(new URL("./fake-muse-acp.mjs", import.meta.url)) };
    h.sendRequest(1, "model/list", { providerOptions: { ...bridgeOptions, acpLaunchSpec } } as never);
    const r = await h.waitForResponse(1);
    expect(r.error).toBeUndefined();
    const { models, selectedOnlyModels } = r.result as { models: { id: string; isDefault: boolean; defaultReasoningEffort: string }[]; selectedOnlyModels: unknown[] };
    expect(models.map((m) => m.id)).toEqual(MUSE_MODELS);
    expect(models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(["muse-wonder-full-1.0"]);
    expect(models[0].defaultReasoningEffort).toBe("high");
    expect(JSON.stringify([models, selectedOnlyModels])).not.toContain("-contributor");
  });
});
