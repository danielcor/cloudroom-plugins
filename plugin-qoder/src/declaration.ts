import type { PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import type { AcpLaunchSpec } from "@get-bb/plugin-sdk/provider-bridge/acp";

// Not "acp-" prefixed: Qoder is aipc-only, so it stays out of the hosted Cloud picker.
export const QODER_PROVIDER_ID = "qoder";
// Absolute so the daemon finds it on a bare PATH; the wrapper forwards every flag to qodercli.
export const DEFAULT_QODER_COMMAND = "/home/danielcor/.qoder/entry/qoder";
// Qoder's live ACP id and name for Qwen 4 Max Preview, and the reasoning values it reports for it.
const FALLBACK_MODEL = { id: "qmodel_latest", displayName: "Qwen4-Max-Preview" };
const FALLBACK_REASONING = [
  { reasoningEffort: "none", description: "None" },
  { reasoningEffort: "low", description: "Low" },
  { reasoningEffort: "high", description: "High" },
  { reasoningEffort: "xhigh", description: "Extra High" },
] as const;

// Qoder runs in ACP mode under the SDK's generic bridge. Its session/new reports
// both models.availableModels and configOptions; the bridge uses the "model"
// config option. No modelCli, because `qodercli` prints "DisplayName (key)"
// lines the SDK parser cannot read. Reasoning is the per-model ACP
// "reasoning_effort" option (category thought_level), which the bridge finds
// on its own; there is no nativeReasoning hint, because Qoder's auto, fast and
// efficient models have no reasoning option and reject "reasoning_effort".
// The bridge sets reasoning over ACP on start and, only when the thread has a
// level, again after session/load, which resets it to the model default.
// Cloudroom accept-edits runs Qoder's own "default" mode, which asks before
// each mutation, so the bridge forwards the request to Cloudroom. Only full
// bypasses approvals.
export function qoderLaunchSpec(command: string): AcpLaunchSpec {
  return {
    displayName: "Qoder",
    command: command.trim() || DEFAULT_QODER_COMMAND,
    args: ["--acp"],
    env: {},
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
          supportedReasoningEfforts: FALLBACK_REASONING.map((effort) => ({ ...effort })),
          defaultReasoningEffort: "xhigh",
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
      reasoningLevels: FALLBACK_REASONING.map((effort) => effort.reasoningEffort),
    },
    composerActions: [],
  };
}
