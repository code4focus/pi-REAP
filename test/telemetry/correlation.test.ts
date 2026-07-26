import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { TaskEpoch } from "../../src/domain/task-epoch.js";
import { TelemetryRuntime } from "../../src/telemetry/runtime.js";
import { TelemetryWriter } from "../../src/telemetry/writer.js";

let directory: string | undefined;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
it("records concurrent pending requests without interrupting correlation", () => {
  directory = mkdtempSync(join(tmpdir(), "pi-reap-correlation-")); const telemetry = new TelemetryRuntime(new TelemetryWriter({ directory, sessionId: "synthetic" }));
  const epoch: TaskEpoch = { id: "synthetic-epoch", createdAt: 1, lastActivityAt: 1, status: "active", taskClass: "simple_query", initialEffort: "low", requestCount: 1, toolCallCount: 0, toolErrorCount: 0, providerErrorCount: 0, lastPromptHash: "hash", decisionIds: [] };
  telemetry.request(epoch, { id: "synthetic", provider: "openai", api: "openai-responses", reasoning: true }, { reasoning: {} }, "enforce", "low", "low", true);
  epoch.requestCount = 2; expect(() => telemetry.request(epoch, { id: "synthetic", provider: "openai", api: "openai-responses", reasoning: true }, { reasoning: {} }, "enforce", "low", "low", true)).not.toThrow();
  telemetry.response("stop"); telemetry.response("stop");
  const rows = readFileSync(join(directory, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(rows.some((row) => row.correlationError === "concurrent_pending_request")).toBe(true); expect(rows.filter((row) => row.stopReason === "stop")).toHaveLength(2);
});
