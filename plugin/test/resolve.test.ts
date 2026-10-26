import { describe, expect, it } from "vitest";
import { resolveCommand, resolveLaunchSpec } from "../src/resolve.js";
import { rewriteLine } from "../src/host.js";
import { agyLaunchSpec } from "../src/declaration.js";

const home = "/home/u";
const files = (...paths: string[]) => ({ home, exists: (p: string) => paths.includes(p) });

describe("resolveCommand", () => {
  it("finds a bare name on PATH first", () => {
    expect(resolveCommand("agy-acp", "/usr/bin:/opt/x", files("/opt/x/agy-acp", "/home/u/.local/bin/agy-acp"))).toBe("/opt/x/agy-acp");
  });
  it("falls back to the extra dirs in order", () => {
    expect(resolveCommand("agy-acp", "/usr/bin", files("/opt/homebrew/bin/agy-acp", "/home/u/.npm-global/bin/agy-acp"))).toBe("/home/u/.npm-global/bin/agy-acp");
    expect(resolveCommand("agy-acp", "/usr/bin", files("/opt/homebrew/bin/agy-acp"))).toBe("/opt/homebrew/bin/agy-acp");
  });
  it("leaves a missing name and any path untouched", () => {
    expect(resolveCommand("agy-acp", "/usr/bin", files())).toBe("agy-acp");
    expect(resolveCommand("/opt/custom/agy-acp", "/usr/bin", files("/opt/custom/agy-acp"))).toBe("/opt/custom/agy-acp");
    expect(resolveCommand("./agy-acp", "/usr/bin", files())).toBe("./agy-acp");
  });
});

describe("resolveLaunchSpec", () => {
  const existing = ["/home/u/.local/bin", "/home/u/.npm-global/bin", "/opt/homebrew/bin", "/usr/local/bin"];

  it("bare PATH on a Mac: resolves agy-acp and puts node's dir on PATH", () => {
    const spec = resolveLaunchSpec(agyLaunchSpec("agy-acp"), {
      home,
      env: { PATH: "/usr/bin:/bin" },
      exists: (p) => [...existing, "/opt/homebrew/bin/agy-acp"].includes(p),
    });
    expect(spec.command).toBe("/opt/homebrew/bin/agy-acp");
    expect(spec.env.PATH).toBe("/opt/homebrew/bin:/home/u/.local/bin:/home/u/.npm-global/bin:/usr/local/bin:/usr/bin:/bin");
    expect(spec.args).toEqual([]);
    expect(spec.permissionCli).toEqual(agyLaunchSpec("agy-acp").permissionCli);
  });

  it("skips dirs that do not exist or are already on PATH", () => {
    const spec = resolveLaunchSpec(agyLaunchSpec("agy-acp"), {
      home,
      env: { PATH: "/home/u/.local/bin:/usr/bin" },
      exists: (p) => ["/home/u/.local/bin", "/usr/local/bin", "/home/u/.local/bin/agy-acp"].includes(p),
    });
    expect(spec.command).toBe("/home/u/.local/bin/agy-acp");
    expect(spec.env.PATH).toBe("/usr/local/bin:/home/u/.local/bin:/usr/bin");
  });

  it("keeps an absolute command, and adds its dir so node beside it resolves", () => {
    const spec = resolveLaunchSpec(agyLaunchSpec("/opt/custom/bin/agy-acp"), { home, env: { PATH: "/usr/bin" }, exists: (p) => p === "/opt/custom/bin" });
    expect(spec.command).toBe("/opt/custom/bin/agy-acp");
    expect(spec.env.PATH).toBe("/opt/custom/bin:/usr/bin");
  });

  it("leaves the spec alone when nothing needs adding", () => {
    const input = agyLaunchSpec("agy-acp");
    expect(resolveLaunchSpec(input, { home, env: { PATH: "/usr/bin" }, exists: () => false })).toEqual(input);
  });

  it("extends a PATH already set in the spec env", () => {
    const input = { ...agyLaunchSpec("agy-acp"), env: { PATH: "/custom", FOO: "1" } };
    const spec = resolveLaunchSpec(input, { home, env: { PATH: "/usr/bin" }, exists: (p) => p === "/opt/homebrew/bin" });
    expect(spec.env).toEqual({ PATH: "/opt/homebrew/bin:/custom", FOO: "1" });
  });
});

describe("rewriteLine", () => {
  const request = (params: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x", params });
  const spec = { ...agyLaunchSpec("agy-acp"), command: "/abs/agy-acp" };

  it("rewrites launch specs wherever the request carries them", () => {
    for (const params of [{ options: { providerOptions: { acpLaunchSpec: spec } } }, { providerOptions: { acpLaunchSpec: spec } }]) {
      const out = JSON.parse(rewriteLine(request(params)));
      const found = out.params.options?.providerOptions.acpLaunchSpec ?? out.params.providerOptions.acpLaunchSpec;
      expect(found.command).toBe("/abs/agy-acp");
      expect(found.nativeReasoning).toEqual(spec.nativeReasoning);
    }
  });

  it("passes other lines through untouched", () => {
    expect(rewriteLine("not json")).toBe("not json");
    const plain = request({ cwd: "/x" });
    expect(rewriteLine(plain)).toBe(plain);
  });
});
