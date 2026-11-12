import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DEFAULT_QODER_COMMAND, qoderProviderDeclaration } from "./src/declaration.js";

export default async function qoderProviderPlugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    command: {
      type: "string",
      label: "Qoder command",
      description: "Absolute path to the Qoder CLI (or its ~/.qoder/entry/qoder wrapper) on this machine. It is launched with --acp.",
      default: DEFAULT_QODER_COMMAND,
    },
  });

  let registration: { dispose(): void } | null = null;
  const register = (command: string): void => {
    registration?.dispose();
    registration = bb.providers.register(qoderProviderDeclaration(command));
  };

  register((await settings.get()).command);
  settings.onChange((next) => register(next.command));
  bb.onDispose(() => registration?.dispose());
}
