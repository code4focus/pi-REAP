#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const sourceFiles = ["src/config/defaults.ts", "src/config/load.ts", "src/config/schema.ts", "src/domain/effort.ts", "src/domain/routing-decision.ts", "src/domain/runtime-state.ts", "src/domain/task-epoch.ts", "src/index.ts", "src/policy/classifier.ts", "src/policy/features.ts", "src/provider/patch.ts", "src/runtime/router.ts", "src/telemetry/records.ts", "src/telemetry/runtime.ts", "src/telemetry/writer.ts"];
const buildFiles = ["dist/config/defaults.js", "dist/config/load.js", "dist/config/schema.js", "dist/domain/effort.js", "dist/domain/routing-decision.js", "dist/domain/runtime-state.js", "dist/domain/task-epoch.js", "dist/index.js", "dist/policy/classifier.js", "dist/policy/features.js", "dist/provider/patch.js", "dist/runtime/router.js", "dist/telemetry/records.js", "dist/telemetry/runtime.js", "dist/telemetry/writer.js"];
const fingerprint = (files) => createHash("sha256").update(JSON.stringify(files.map((file) => ({ file, sha256: createHash("sha256").update(readFileSync(join(root, file))).digest("hex") })))).digest("hex");
console.log(JSON.stringify({ sourceFingerprint: fingerprint(sourceFiles), extensionBuildFingerprint: fingerprint(buildFiles) }, null, 2));
