// A copy of provider-agy's plugin/src/resolve.ts (each plugin bundles its own host artifact; keep them in sync).
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { AcpLaunchSpec } from "@get-bb/plugin-sdk/provider-bridge/acp";

// SSH machines run their host daemon with a bare PATH (no ~/.local/bin, no npm
// global bin, no Homebrew), so agy-acp, node and agy are not found there.
export function extraBinDirs(home = homedir()): string[] {
  return [join(home, ".local", "bin"), join(home, ".npm-global", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

interface Deps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean; // a directory to put on PATH
  executable?: (path: string) => boolean; // a command to launch
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Finds a bare command on PATH, then in the extra dirs. Paths with a separator are left alone.
export function resolveCommand(command: string, pathValue: string, deps: Deps = {}): string {
  if (command.includes("/") || isAbsolute(command)) return command;
  const executable = deps.executable ?? isExecutableFile;
  for (const dir of [...pathValue.split(delimiter), ...extraBinDirs(deps.home)]) {
    if (dir && executable(join(dir, command))) return join(dir, command);
  }
  return command;
}

// Resolves the agy-acp command and prepends the existing extra dirs (and the
// command's own dir) to PATH, so its `#!/usr/bin/env node` and agy resolve too.
export function resolveLaunchSpec(spec: AcpLaunchSpec, deps: Deps = {}): AcpLaunchSpec {
  const exists = deps.exists ?? existsSync;
  const basePath = spec.env.PATH ?? (deps.env ?? process.env).PATH ?? "";
  const command = resolveCommand(spec.command, basePath, deps);
  const present = new Set(basePath.split(delimiter));
  const prepend: string[] = [];
  for (const dir of [...(isAbsolute(command) ? [dirname(command)] : []), ...extraBinDirs(deps.home)]) {
    if (!present.has(dir) && !prepend.includes(dir) && exists(dir)) prepend.push(dir);
  }
  const env = prepend.length > 0 ? { ...spec.env, PATH: [...prepend, ...(basePath ? [basePath] : [])].join(delimiter) } : spec.env;
  return { ...spec, command, env };
}
