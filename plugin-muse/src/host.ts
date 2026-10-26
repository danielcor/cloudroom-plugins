// The bb.host artifact: the SDK's generic ACP bridge, which launches muse-acp
// (see src/declaration.ts) for every thread on this machine. The server builds the
// launch spec without knowing this machine's PATH, so the bridge is wrapped to
// resolve muse-acp and extend PATH here, on the host. It also pins the thread's
// model, so contributor mode stays off whatever a thread asks for.
import { experimental_acpProviderBridge as acpBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import type { AcpLaunchSpec } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { resolveLaunchSpec } from "./resolve.js";
import { MUSE_MODELS } from "./declaration.js";

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

const CONTRIBUTOR = "-contributor";

// The adapter also accepts provider-qualified choices: "muse-model:" + URI-encoded JSON [provider, profile, id]
// (it rejects one it cannot match to its catalog).
function modelId(model: string): string {
  if (!model.startsWith("muse-model:")) return model;
  try {
    const id: unknown = (JSON.parse(decodeURIComponent(model.slice("muse-model:".length))) as unknown[])[2];
    return typeof id === "string" ? id : model;
  } catch {
    return model;
  }
}

// A "-contributor" model is the same model with Meta allowed to train on the session:
// run its plain twin. No model (or the bridge's "acp-default") would leave the choice to
// the adapter, which takes the user's Muse settings: run Wonder Full instead.
export function pinModel(options: Json): void {
  const model = options["model"];
  if (typeof model !== "string" || model === "" || model === "acp-default") options["model"] = MUSE_MODELS[0];
  else if (modelId(model).endsWith(CONTRIBUTOR)) options["model"] = modelId(model).slice(0, -CONTRIBUTOR.length);
}

export function rewriteLine(line: string): string {
  try {
    const message: unknown = JSON.parse(line);
    if (!isObject(message) || !isObject(message["params"])) return line;
    const options = message["params"]["options"];
    if (isObject(options) && isObject(options["providerOptions"])) pinModel(options);
    resolveLaunchSpecs(message["params"]);
    return JSON.stringify(message);
  } catch {
    return line;
  }
}

export const experimental_providerBridge = { ...acpBridge, handleLine: (line: string) => acpBridge.handleLine(rewriteLine(line)) };
