import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import type { AcpLaunchSpec } from "@get-bb/plugin-sdk/provider-bridge/acp";

// Not "acp-" prefixed: Qoder is aipc-only, so it stays out of the hosted Cloud picker.
export const QODER_PROVIDER_ID = "qoder";
// Absolute so the daemon finds it on a bare PATH; the wrapper forwards every flag to qodercli.
export const DEFAULT_QODER_COMMAND = "/home/danielcor/.qoder/entry/qoder";
const FALLBACK_MODEL = { id: "qwen4-max-preview", displayName: "Qwen 4 Max Preview" };
const REASONING_LEVELS = ["low", "medium", "high"] as const;

// Qoder runs in ACP mode under the SDK's generic bridge. Models come from ACP
// availableModels: no modelCli, because `qodercli` prints "DisplayName (key)"
// lines the SDK parser cannot read. Reasoning is the model-aware ACP
// "reasoning_effort" option, never a CLI flag that would override a resumed
// session. Cloudroom accept-edits runs Qoder's own "default" mode, which is
// expected to ask before each mutation so the bridge forwards the request to
// Cloudroom; that is verified live in plan Task 4. Only full bypasses approvals.
export function qoderLaunchSpec(command: string): AcpLaunchSpec {
  return {
    displayName: "Qoder",
    command: command.trim() || DEFAULT_QODER_COMMAND,
    args: ["--acp"],
    env: {},
    nativeReasoning: { configId: "reasoning_effort", supportedLevels: [...REASONING_LEVELS], defaultLevel: "high" },
    permissionCli: {
      workspaceWrite: ["--permission-mode", "default"],
      full: ["--permission-mode", "bypass_permissions"],
    },
  };
}

export function qoderProviderDeclaration(command: string): PluginProviderDeclaration {
  return {
    id: QODER_PROVIDER_ID,
    displayName: "Qoder",
    icon: "./icons/qoder.svg",
    strings: {
      signInHint: "Run `qodercli` on the machine once and sign in, then reload.",
      expiredHint: "Your Qoder login expired. Run `qodercli` on the machine to sign in again, then reload.",
      installUrl: "https://github.com/danielcor/cloudroom-plugins#qoder",
    },
    experimental_bridgeOptions: {
      acpDialect: "generic",
      acpLaunchSpec: { ...qoderLaunchSpec(command) },
    },
    models: {
      scope: "host",
      fallback: [
        {
          ...FALLBACK_MODEL,
          description: "Shown until Qoder reports its live model list over ACP.",
          supportedReasoningEfforts: REASONING_LEVELS.map((level) => ({ reasoningEffort: level, description: `${level} reasoning effort` })),
          defaultReasoningEffort: "high",
          isDefault: true,
        },
      ],
    },
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      fork: "tip",
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: [...REASONING_LEVELS],
    },
    composerActions: [],
  };
}
