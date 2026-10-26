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
    addDirs: {
      type: "string",
      label: "Extra directories for Accept edits",
      description:
        "Directories (separated by ':') that Accept edits threads may read and edit besides their workspace, on every machine. Headless agy auto-denies file reads outside the workspace; shell stays denied. Leave empty for none.",
      default: "",
    },
  });

  let registration: { dispose(): void } | null = null;
  const register = ({ command, addDirs }: { command: string; addDirs: string }): void => {
    registration?.dispose();
    registration = bb.providers.register(agyProviderDeclaration(command, addDirs));
  };

  register(await settings.get());
  settings.onChange(register);
  bb.onDispose(() => registration?.dispose());
}
