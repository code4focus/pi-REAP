import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TelemetryWriter } from "../../src/telemetry/writer.js";

let directory: string | undefined;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); delete process.env.PI_REAP_TELEMETRY_DIR; directory = undefined; });

it("uses an explicit environment directory without changing configuration", () => {
  directory = mkdtempSync(join(tmpdir(), "pi-reap-writer-")); process.env.PI_REAP_TELEMETRY_DIR = directory;
  const writer = new TelemetryWriter({ sessionId: "synthetic" });
  writer.writeEpoch({ schemaVersion: 1, sessionHash: writer.sessionHash, epochId: "synthetic", status: "settled", taskClass: "simple_query", requestCount: 0, toolCallCount: 0, toolErrorCount: 0, providerErrorCount: 0, startedAt: 1, endedAt: 2 });
  expect(readFileSync(join(directory, "epochs.jsonl"), "utf8")).toContain('"schemaVersion":1');
});
