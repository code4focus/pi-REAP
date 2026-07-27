import { Value } from "@sinclair/typebox/value";
import { safeDefaults } from "./defaults.js";
import { ConfigurationSchema, type EffortRouterConfig } from "./schema.js";

export interface ReadOnlyConfigFileSystem {
  readFile(path: string): Promise<string | undefined>;
}

export interface ConfigPaths {
  global: string;
  project: string;
}

export const defaultConfigPaths = (home: string, cwd: string): ConfigPaths => ({
  global: `${home}/.pi/agent/effort-router.json`,
  project: `${cwd}/.pi/effort-router.json`,
});

type ParseResult =
  | { valid: true; config: EffortRouterConfig | undefined }
  | { valid: false };

type ReadResult =
  | { readonly ok: true; readonly source: string | undefined }
  | { readonly ok: false };

function parseConfig(source: string | undefined): ParseResult {
  if (source === undefined) return { valid: true, config: undefined };
  try {
    const value: unknown = JSON.parse(source);
    return Value.Check(ConfigurationSchema, value)
      ? { valid: true, config: value as EffortRouterConfig }
      : { valid: false };
  } catch {
    return { valid: false };
  }
}

/** Reads only the two effort-router files; invalid input falls back to safe defaults. */
export async function loadConfig(fs: ReadOnlyConfigFileSystem, paths: ConfigPaths): Promise<EffortRouterConfig> {
  const readSafely = async (path: string): Promise<ReadResult> => {
    try { return { ok: true, source: await fs.readFile(path) }; } catch { return { ok: false }; }
  };
  const [global, project] = await Promise.all([readSafely(paths.global), readSafely(paths.project)]);
  if (!global.ok || !project.ok) return cloneDefaults();
  const globalResult = parseConfig(global.source);
  const projectResult = parseConfig(project.source);
  if (!globalResult.valid || !projectResult.valid) return cloneDefaults();
  return projectResult.config ?? globalResult.config ?? cloneDefaults();
}

function cloneDefaults(): EffortRouterConfig {
  return { ...safeDefaults, telemetry: { ...safeDefaults.telemetry }, ui: { ...safeDefaults.ui } };
}
