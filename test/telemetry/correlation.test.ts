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
  telemetry.request(epoch, { id: "synthetic", provider: "openai", api: "openai-responses", reasoning: true }, { reasoning: { effort: "medium" } }, "enforce", { payload: {}, status: "applied", originalEffort: "medium", appliedEffort: "minimal" });
  epoch.requestCount = 2; expect(() => telemetry.request(epoch, { id: "synthetic", provider: "openai", api: "openai-responses", reasoning: true }, { reasoning: { effort: "high" } }, "enforce", { payload: {}, status: "applied", originalEffort: "high", appliedEffort: "minimal" })).not.toThrow();
  telemetry.response("stop", { inputTokens: 1 }); telemetry.response("stop", { outputTokens: 2 });
  const rows = readFileSync(join(directory, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const responses = rows.filter((row) => row.stopReason === "stop"); expect(responses).toHaveLength(2); expect(responses[0]).toMatchObject({ requestIndex: 1, patchStatus: "applied", originalEffort: "medium", appliedEffort: "minimal", inputTokens: 1 }); expect(responses[1]).toMatchObject({ requestIndex: 2, patchStatus: "applied", originalEffort: "high", appliedEffort: "minimal", outputTokens: 2, correlationError: "concurrent_pending_request" });
});
