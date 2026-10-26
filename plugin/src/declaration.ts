import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import type { AcpLaunchSpec } from "@get-bb/plugin-sdk/provider-bridge/acp";

export const AGY_PROVIDER_ID = "agy";
export const DEFAULT_AGY_ACP_COMMAND = "agy-acp";
export const ARGON_MODELS = ["gemini-4-argon-high", "gemini-4-argon-medium", "gemini-4-argon-low"];
const REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

// agy-acp exposes agy --effort as the "effort" config option and takes its
// default permission mode as a flag (headless agy cannot ask for approval).
export function agyLaunchSpec(command: string): AcpLaunchSpec {
  return {
    displayName: "Antigravity",
    command: command.trim() || DEFAULT_AGY_ACP_COMMAND,
    args: [],
    env: {},
    nativeReasoning: { configId: "effort", supportedLevels: [...REASONING_LEVELS] },
    permissionCli: {
      workspaceWrite: ["--mode", "accept-edits"],
      full: ["--dangerously-skip-permissions"],
    },
  };
}

export function agyProviderDeclaration(command: string): PluginProviderDeclaration {
  return {
    id: AGY_PROVIDER_ID,
    displayName: "Antigravity",
    icon: "./icons/antigravity.svg",
    strings: {
      signInHint: "Run `agy` on the machine once and sign in with Google, then reload.",
      expiredHint: "Your Antigravity session expired. Run `agy` on the machine to sign in again, then reload.",
      installUrl: "https://github.com/danielcor/cloudroom-argon#readme",
    },
    experimental_bridgeOptions: {
      acpDialect: "generic",
      primaryModels: [...ARGON_MODELS],
      acpLaunchSpec: { ...agyLaunchSpec(command) },
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
