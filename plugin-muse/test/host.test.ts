// The host artifact resolves muse-acp on machines whose daemon has a bare PATH
// (src/resolve.ts is provider-agy's; its own tests live in plugin/test/resolve.test.ts).
import { describe, expect, it } from "vitest";
import { rewriteLine } from "../src/host.js";
import { resolveLaunchSpec } from "../src/resolve.js";
import { museLaunchSpec } from "../src/declaration.js";

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
    const line = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "models/list", params: { providerOptions: { acpLaunchSpec: { ...museLaunchSpec("muse-acp"), command: "/abs/muse-acp" } } } });
    const out = JSON.parse(rewriteLine(line));
    expect(out.params.providerOptions.acpLaunchSpec.command).toBe("/abs/muse-acp");
    expect(out.params.providerOptions.acpLaunchSpec.modelCli.listArgs).toEqual(["--list-models"]);
  });
});
