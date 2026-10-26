import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DEFAULT_AGY_ACP_COMMAND, agyProviderDeclaration } from "./src/declaration.js";

export default async function agyProviderPlugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    command: {
      type: "string",
      label: "agy-acp command",
      description: "The agy-acp executable on each machine: a name on PATH or an absolute path.",
      default: DEFAULT_AGY_ACP_COMMAND,
    },
  });

  let registration: { dispose(): void } | null = null;
  const register = (command: string): void => {
    registration?.dispose();
    registration = bb.providers.register(agyProviderDeclaration(command));
  };

  register((await settings.get()).command);
  settings.onChange((next) => register(next.command));
  bb.onDispose(() => registration?.dispose());
}
