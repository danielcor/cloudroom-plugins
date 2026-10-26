// The bb.host artifact: the SDK's generic ACP bridge, which launches agy-acp
// (see src/declaration.ts) for every thread on this machine. The server builds the
// launch spec without knowing this machine's PATH, so the bridge is wrapped to
// resolve agy-acp and extend PATH here, on the host.
import { experimental_acpProviderBridge as acpBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import type { AcpLaunchSpec } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { resolveLaunchSpec } from "./resolve.js";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

// Rewrites every `acpLaunchSpec` under a request's params (thread options, model
// listing and maintenance calls each carry one at a different depth).
export function resolveLaunchSpecs(value: unknown, depth = 0): void {
  if (!isObject(value) || depth > 4) return;
  const spec = value["acpLaunchSpec"];
  if (isObject(spec) && typeof spec["command"] === "string" && isObject(spec["env"])) {
    value["acpLaunchSpec"] = resolveLaunchSpec(spec as unknown as AcpLaunchSpec);
  }
  for (const [key, child] of Object.entries(value)) if (key !== "acpLaunchSpec") resolveLaunchSpecs(child, depth + 1);
}

export function rewriteLine(line: string): string {
  try {
    const message: unknown = JSON.parse(line);
    if (!isObject(message) || !isObject(message["params"])) return line;
    resolveLaunchSpecs(message["params"]);
    return JSON.stringify(message);
  } catch {
    return line;
  }
}

export const experimental_providerBridge = { ...acpBridge, handleLine: (line: string) => acpBridge.handleLine(rewriteLine(line)) };
