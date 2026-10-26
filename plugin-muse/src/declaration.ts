import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import type { AcpLaunchSpec } from "@get-bb/plugin-sdk/provider-bridge/acp";

// The hosted Cloud picker only offers a harness when a local provider id starts with "acp-".
export const MUSE_PROVIDER_ID = "acp-muse";
export const DEFAULT_MUSE_ACP_COMMAND = "muse-acp";
// Never a "-contributor" id: those let Meta train on the session (muse-acp also leaves them out of --list-models).
export const MUSE_MODELS = ["muse-wonder-full-1.0", "muse-wonder-1.0", "muse-spark-1.3", "muse-spark-1.2"];
const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

// muse-acp prints Muse's live catalog (the adapter only learns it after a session
// starts), exposes Muse's effort as the "reasoningEffort" config option, and
// takes --full to turn Muse's OS sandbox off. Other permission prompts reach
// Cloudroom as approvals; in Full mode the bridge approves them.
export function museLaunchSpec(command: string): AcpLaunchSpec {
  return {
    displayName: "Muse",
    command: command.trim() || DEFAULT_MUSE_ACP_COMMAND,
    args: [],
    env: {},
    modelCli: { listArgs: ["--list-models"], primaryModels: [...MUSE_MODELS] },
    nativeReasoning: { configId: "reasoningEffort", supportedLevels: [...REASONING_LEVELS], defaultLevel: "high" },
    permissionCli: { full: ["--full"] },
  };
}

export function museProviderDeclaration(command: string): PluginProviderDeclaration {
  return {
    id: MUSE_PROVIDER_ID,
    displayName: "Muse",
    icon: "./icons/muse.svg",
    strings: {
      signInHint: "Run `muse` on the machine once and sign in (or set META_API_KEY for the Cloudroom daemon), then reload.",
      expiredHint: "Your Muse login expired. Run `muse` on the machine to sign in again, then reload.",
      installUrl: "https://github.com/danielcor/cloudroom-plugins#muse",
    },
    experimental_bridgeOptions: {
      acpDialect: "generic",
      primaryModels: [...MUSE_MODELS],
      acpLaunchSpec: { ...museLaunchSpec(command) },
    },
    models: { scope: "host" },
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      fork: "none",
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: [...REASONING_LEVELS],
    },
    composerActions: [],
  };
}
