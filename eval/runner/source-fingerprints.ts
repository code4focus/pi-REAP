import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Fixed relevant source list. Acceptance evaluator constants are not runtime artifacts. */
export const sourceManifestFiles = [
  "src/config/defaults.ts", "src/config/load.ts", "src/config/schema.ts", "src/domain/effort.ts", "src/domain/routing-decision.ts", "src/domain/runtime-state.ts", "src/domain/task-epoch.ts", "src/index.ts", "src/policy/classifier.ts", "src/policy/features.ts", "src/provider/patch.ts", "src/runtime/router.ts", "src/telemetry/records.ts", "src/telemetry/runtime.ts", "src/telemetry/writer.ts",
] as const;
/** Built extension artifacts only; nothing below `dist/eval` is included. */
export const extensionBuildFiles = [
  "dist/config/defaults.js", "dist/config/load.js", "dist/config/schema.js", "dist/domain/effort.js", "dist/domain/routing-decision.js", "dist/domain/runtime-state.js", "dist/domain/task-epoch.js", "dist/index.js", "dist/policy/classifier.js", "dist/policy/features.js", "dist/provider/patch.js", "dist/runtime/router.js", "dist/telemetry/records.js", "dist/telemetry/runtime.js", "dist/telemetry/writer.js",
] as const;

export function canonicalFileManifest(root: string, files: readonly string[]): string {
  return JSON.stringify(files.map((file) => ({ file, sha256: createHash("sha256").update(readFileSync(join(root, file))).digest("hex") })));
}
export function sourceManifestFingerprint(root: string): string { return createHash("sha256").update(canonicalFileManifest(root, sourceManifestFiles)).digest("hex"); }
export function extensionBuildFingerprint(root: string): string { return createHash("sha256").update(canonicalFileManifest(root, extensionBuildFiles)).digest("hex"); }
