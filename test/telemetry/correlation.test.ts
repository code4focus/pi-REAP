import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { TaskEpoch } from "../../src/domain/task-epoch.js";
import type { ProfileObservation } from "../../src/telemetry/records.js";
import { TelemetryRuntime } from "../../src/telemetry/runtime.js";
import { TelemetryWriter } from "../../src/telemetry/writer.js";

let directory: string | undefined;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
const profile: ProfileObservation = { capability: { id: "cap", revision: "1", digest: "a".repeat(64), source: { kind: "repository-pinned", repositoryRevision: "synthetic" } }, admission: { id: "adm", revision: "1", digest: "b".repeat(64), source: { kind: "repository-pinned", repositoryRevision: "synthetic" } }, model: { provider: "openai", api: "openai-responses", model: "synthetic", catalogRevision: "catalog", catalogDigest: "c".repeat(64), piVersion: "0.82.1", adapterRevision: "adapter", adapterDigest: "d".repeat(64) }, requested: { rungId: "low", ordinal: 0 }, effective: { rungId: "low", ordinal: 0 }, resolved: { rungId: "low", ordinal: 0, providerValue: "minimal" }, generation: 1 };
const epoch = (id: string, requestCount: number): TaskEpoch => ({ id, createdAt: 1, lastActivityAt: 1, status: "active", taskClass: "simple_query", initialRung: { binding: {} as never, rungId: "low", ordinal: 0 }, initialSelector: { kind: "lowest-automatic" }, requestCount, toolCallCount: 0, toolErrorCount: 0, providerErrorCount: 0, lastPromptHash: "redacted", decisionIds: [] });

it("terminates every concurrent pending request without payload retention, then correlates a clean singleton", () => {
  directory = mkdtempSync(join(tmpdir(), "pi-reap-correlation-"));
  const telemetry = new TelemetryRuntime(new TelemetryWriter({ directory, sessionId: "synthetic" }));
  telemetry.request(epoch("one", 1), profile, "decision-1", { id: "synthetic", provider: "openai", api: "openai-responses" }, { status: "applied", payload: {}, originalEffort: "medium", appliedEffort: "minimal" });
  telemetry.request(epoch("one", 2), profile, "decision-2", { id: "synthetic", provider: "openai", api: "openai-responses" }, { status: "unsupported", payload: {} });
  telemetry.response("stop", { inputTokens: 0, outputTokens: 2, reasoningTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 5 });
  telemetry.request(epoch("two", 1), profile, "decision-3", { id: "synthetic", provider: "openai", api: "openai-responses" }, { status: "applied", payload: {}, originalEffort: "minimal", appliedEffort: "minimal" });
  telemetry.response("stop", { inputTokens: 0 });
  const rows = readFileSync(join(directory, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(rows[0]).toMatchObject({ requestIndex: 1, patchStatus: "applied", locallyAppliedProviderValue: "minimal", correlationError: "ambiguous_response" });
  expect(rows[1]).toMatchObject({ requestIndex: 2, patchStatus: "unsupported", correlationError: "ambiguous_response" });
  expect(rows[2]).toMatchObject({ requestIndex: 1, decisionId: "decision-3", inputTokens: 0 }); expect(rows[2]).not.toHaveProperty("correlationError");
  expect(JSON.stringify(rows)).not.toContain("payload");
  expect(rows[0]!.profile).toMatchObject({ capability: { id: "cap", digest: "a".repeat(64) }, resolved: { providerValue: "minimal" } });
});

it("flushes before a clean response for every profile-bound reconciliation change", () => {
  directory = mkdtempSync(join(tmpdir(), "pi-reap-boundary-"));
  const variations: readonly [string, (value: ProfileObservation) => void][] = [
    ["model", (v) => { v.model.model = "other"; }], ["provider", (v) => { v.model.provider = "other"; }], ["api", (v) => { v.model.api = "other"; }], ["catalog revision", (v) => { v.model.catalogRevision = "next"; }], ["catalog digest", (v) => { v.model.catalogDigest = "e".repeat(64); }], ["pi", (v) => { v.model.piVersion = "0.82.2"; }], ["adapter revision", (v) => { v.model.adapterRevision = "next"; }], ["adapter digest", (v) => { v.model.adapterDigest = "e".repeat(64); }], ["capability id", (v) => { v.capability.id = "other"; }], ["capability revision", (v) => { v.capability.revision = "2"; }], ["capability digest", (v) => { v.capability.digest = "e".repeat(64); }], ["capability source", (v) => { v.capability.source = { kind: "repository-pinned", repositoryRevision: "next" }; }], ["admission id", (v) => { v.admission.id = "other"; }], ["admission revision", (v) => { v.admission.revision = "2"; }], ["admission digest", (v) => { v.admission.digest = "e".repeat(64); }], ["admission source", (v) => { v.admission.source = { kind: "repository-pinned", repositoryRevision: "next" }; }], ["generation", (v) => { v.generation += 1; }],
  ];
  for (const [name, mutate] of variations) {
    const telemetry = new TelemetryRuntime(new TelemetryWriter({ directory, sessionId: `synthetic-${name}` }));
    const next = JSON.parse(JSON.stringify(profile)) as ProfileObservation; mutate(next);
    telemetry.request(epoch(`${name}-old`, 1), profile, "old", { id: "synthetic", provider: "openai", api: "openai-responses" }, { status: "applied", payload: {}, appliedEffort: "minimal" });
    telemetry.request(epoch(`${name}-new`, 1), next, "new", { id: "synthetic", provider: "openai", api: "openai-responses" }, { status: "applied", payload: {}, appliedEffort: "minimal" });
    telemetry.response("stop", { outputTokens: 0 });
  }
  const rows = readFileSync(join(directory, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(rows).toHaveLength(variations.length * 2); for (let index = 0; index < rows.length; index += 2) { expect(rows[index]).toMatchObject({ correlationError: "profile_boundary" }); expect(rows[index + 1]).toMatchObject({ outputTokens: 0 }); expect(rows[index + 1]).not.toHaveProperty("correlationError"); }
});

it("never fabricates an applied provider value for structured non-applied outcomes", () => {
  directory = mkdtempSync(join(tmpdir(), "pi-reap-outcome-"));
  const telemetry = new TelemetryRuntime(new TelemetryWriter({ directory, sessionId: "synthetic" }));
  const outcomes = [
    { status: "unsupported" as const, payload: {}, originalEffort: "medium" },
    { status: "invalid_payload" as const, payload: {}, originalEffort: "medium" },
    { status: "mapping_failed" as const, payload: {}, originalEffort: "medium" },
  ];
  for (const [index, outcome] of outcomes.entries()) { telemetry.request(epoch(`outcome-${index}`, 1), profile, `decision-${index}`, { id: "synthetic", provider: "openai", api: "openai-responses" }, outcome); telemetry.response("stop"); }
  const rows = readFileSync(join(directory, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const [index, row] of rows.entries()) { expect(row).toMatchObject({ patchStatus: outcomes[index]!.status, decisionId: `decision-${index}` }); expect(row).not.toHaveProperty("locallyAppliedProviderValue"); }
});
