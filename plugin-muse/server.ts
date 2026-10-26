import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DEFAULT_MUSE_ACP_COMMAND, museProviderDeclaration } from "./src/declaration.js";

export default async function museProviderPlugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    command: {
      type: "string",
      label: "muse-acp command",
      description: "The muse-acp executable on each machine: a name on PATH or an absolute path.",
      default: DEFAULT_MUSE_ACP_COMMAND,
    },
  });

  let registration: { dispose(): void } | null = null;
  const register = (command: string): void => {
    registration?.dispose();
    registration = bb.providers.register(museProviderDeclaration(command));
  };

  register((await settings.get()).command);
  settings.onChange((next) => register(next.command));
  bb.onDispose(() => registration?.dispose());
}
