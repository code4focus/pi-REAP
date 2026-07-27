import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exactTaskIds, planCalls, validateCatalog } from "../runner/live-driver.js";
import {
  CaptureAbortGuard, cleanupPrivateRoot, createPrivateRoot, loadInstalledPi, loadPrivateRoot, readPrivateJsonFile, validatePrivateTaskFile,
  liveUsageFromPiAssistantUsage, productionExtensionOptions, unavailableCachePrefixMeasurement, validateProductionBuild, writeFailureReceipt, writePrivate,
} from "../runner/live-production.js";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("production live-capture offline preflight and private-root safety", () => {
  it("constructs a complete read-only v1 config for each planned extension mode", async () => {
    const tasks = exactTaskIds.map((id) => ({ id, body: `synthetic ${id}`, grader: { kind: "exact" as const, expected: "synthetic" } }));
    const calls = planCalls(tasks); const enforce = calls.find((call) => call.kind === "route" && call.mode === "policy-enforce")!;
    const shadow = calls.find((call) => call.kind === "route" && call.mode === "policy-shadow")!; const cache = calls.find((call) => call.kind === "cache")!;
    for (const [call, mode] of [[enforce, "enforce"], [shadow, "shadow"], [cache, "shadow"]] as const) {
      const options = productionExtensionOptions(call, "/private/synthetic-telemetry"); const config = await options.load!();
      expect(config).toStrictEqual({ enabled: true, mode, ambiguousEffort: "high", failureEffort: "xhigh", telemetry: { enabled: true, includePromptText: false, directory: "/private/synthetic-telemetry" }, ui: { showStatus: false, notifyOnEscalation: false } });
      expect(options).toMatchObject({ telemetryDirectory: "/private/synthetic-telemetry", sessionId: `live-${call.ordinal}` });
    }
  });

  it("binds the installed Pi terminal parser to the exact production usage conversion boundary", async () => {
    const shared = await import(pathToFileURL("/Users/ove/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js").href) as { processResponsesStream: Function };
    const output = { content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    async function* fixture(): AsyncGenerator<unknown> { yield { type: "response.completed", response: { status: "completed", usage: { input_tokens: 200, input_tokens_details: { cached_tokens: 128, cache_write_tokens: 0 }, output_tokens: 2, total_tokens: 202 } } }; }
    await shared.processResponsesStream(fixture(), output, { push() {} }, { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, {});
    const record = liveUsageFromPiAssistantUsage(output.usage);
    expect(record.usage.cacheReadTokens).toBe(128);
    expect(record.cacheUsageProvenance).toMatchObject({ boundary: "pi_normalized_assistant_usage", cachedTokensPresence: "pi_normalized_presence_unknown", normalizedCacheReadTokens: 128 });
  });

  it("fingerprints the installed Pi 0.82.1 executable, package, and catalog offline", () => {
    const installed = loadInstalledPi();
    expect(installed.catalog.piPackageVersion).toBe("0.82.1");
    expect(installed.catalog.piExecutableSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(installed.catalog.piPackageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(installed.catalog.piCatalogSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(installed.cachePrefixMeasurement).toMatchObject({
      status: "measured", tokenizerName: "o200k_base", tokenCount: 1_112,
      commonPrefixSha256: "e578aed13602cfc7ef597920087483eed15671325d36849b5a5c22e23344c471",
      tokenizerFingerprint: "fc2139538d73fe447c400bebed90e1397c0ffe1a7487660497697b201b1b69e3",
    });
    expect(unavailableCachePrefixMeasurement()).toMatchObject({
      status: "unavailable", code: "provider_compatible_tokenizer_unavailable",
    });
    expect(() => validateCatalog(installed.catalog)).not.toThrow();
    expect(validateProductionBuild(process.cwd())).toMatchObject({ sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), extensionBuildFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("accepts only an owner-mode-0600 six-task input outside the repository", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-reap-private-input-")); cleanup.push(directory);
    const path = join(directory, "tasks.json");
    const tasks = exactTaskIds.map((id) => ({ id, body: `prompt-secret-canary-${id}`, grader: { kind: "exact", expected: `answer-${id}` } }));
    writeFileSync(path, JSON.stringify(tasks), { mode: 0o600 }); chmodSync(path, 0o600);
    expect(validatePrivateTaskFile(path, process.cwd())).toStrictEqual(tasks);
    chmodSync(path, 0o644); expect(() => validatePrivateTaskFile(path, process.cwd())).toThrow("unsafe");
    expect(() => validatePrivateTaskFile(join(process.cwd(), "package.json"), process.cwd())).toThrow("unsafe");
  });

  it("creates 0700/0600 sentinel-bound evidence and cleanup cannot follow a symlink", () => {
    const root = createPrivateRoot(); cleanup.push(root.path);
    expect(lstatSync(root.path).mode & 0o777).toBe(0o700);
    expect(lstatSync(root.sentinel).mode & 0o777).toBe(0o600);
    const evidence = writePrivate(root, "raw/01.output", "private-canary");
    expect(lstatSync(join(root.path, "raw")).mode & 0o777).toBe(0o700);
    expect(lstatSync(evidence).mode & 0o777).toBe(0o600);
    expect(loadPrivateRoot(root.path).nonce).toBe(root.nonce);
    const outside = mkdtempSync(join(tmpdir(), "pi-reap-outside-")); cleanup.push(outside);
    symlinkSync(outside, join(root.path, "escape"));
    expect(() => cleanupPrivateRoot(root.path)).toThrow("symlink");
    unlinkSync(join(root.path, "escape"));
    cleanupPrivateRoot(root.path);
    cleanup.splice(cleanup.indexOf(root.path), 1);
    expect(() => cleanupPrivateRoot(outside)).toThrow("unsafe");
  });

  it("rejects unsafe relative output names and private-tree mode drift", () => {
    const root = createPrivateRoot(); cleanup.push(root.path);
    expect(() => writePrivate(root, "../escape", "x")).toThrow("relative");
    const directory = join(root.path, "drift"); mkdirSync(directory, { mode: 0o700 }); chmodSync(directory, 0o755);
    expect(() => loadPrivateRoot(root.path)).toThrow("directory mode");
  });

  it("pins private capture/review reads to no-follow descriptors and rejects path replacement", () => {
    const root = createPrivateRoot(); cleanup.push(root.path);
    const outside = mkdtempSync(join(tmpdir(), "pi-reap-private-replacement-")); cleanup.push(outside);
    const outsideFile = join(outside, "replacement.json");
    writeFileSync(outsideFile, "[]\n", { mode: 0o600 }); chmodSync(outsideFile, 0o600);
    for (const name of ["capture.json", "review.json"]) {
      const path = writePrivate(root, name, "[]\n");
      expect(readPrivateJsonFile(path, root)).toStrictEqual([]);
      unlinkSync(path);
      symlinkSync(outsideFile, path);
      expect(() => readPrivateJsonFile(path, root)).toThrow();
      unlinkSync(path);
    }
  });

  it("records only sanitized typed failure state with the actual completed-call count", () => {
    const root = createPrivateRoot(); cleanup.push(root.path);
    const path = writeFailureReceipt(root, "adapter_call", 17);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      schemaVersion: 2, status: "failed", phase: "capture", failureCode: "adapter_call", completedCalls: 17,
    });
    expect(readFileSync(path, "utf8")).not.toContain("private");
    expect(() => writeFailureReceipt(root, "Private Detail", 0)).toThrow("sanitized");
    expect(() => writeFailureReceipt(root, "cap_rejected", 33)).toThrow("sanitized");
    expect(() => writeFailureReceipt(root, "cache_crossover_no_cache_read", 32, "post_capture")).toThrow("sanitized");
    expect(() => writeFailureReceipt(root, "adapter_call", 33, "post_capture")).toThrow("sanitized");

    const postCaptureRoot = createPrivateRoot(); cleanup.push(postCaptureRoot.path);
    const postCapturePath = writeFailureReceipt(postCaptureRoot, "cache_crossover_no_cache_read", 33, "post_capture");
    expect(JSON.parse(readFileSync(postCapturePath, "utf8"))).toMatchObject({
      schemaVersion: 2, status: "failed", phase: "post_capture", failureCode: "cache_crossover_no_cache_read", completedCalls: 33,
    });

    const legacyRoot = createPrivateRoot(); cleanup.push(legacyRoot.path);
    const legacyPath = writeFailureReceipt(legacyRoot, "legacy_or_missing_exact_prefix_measurement", 33, "post_capture");
    expect(JSON.parse(readFileSync(legacyPath, "utf8"))).toMatchObject({
      schemaVersion: 2, status: "failed", phase: "post_capture", failureCode: "legacy_or_missing_exact_prefix_measurement", completedCalls: 33,
    });
  });

  it("aborts outside the provider payload on stream-byte and wall-clock limits", async () => {
    let streamAborts = 0;
    const streamGuard = new CaptureAbortGuard(() => { streamAborts += 1; }, 60_000, 5);
    streamGuard.observeDelta("123");
    streamGuard.observeDelta("456");
    await Promise.resolve();
    expect(streamGuard.reason).toBe("stream_byte_limit");
    expect(streamAborts).toBe(1);
    streamGuard.observeDelta("more");
    expect(streamAborts).toBe(1);
    streamGuard.stop();

    vi.useFakeTimers();
    try {
      let wallAborts = 0;
      const wallGuard = new CaptureAbortGuard(() => { wallAborts += 1; }, 10, 1_000);
      await vi.advanceTimersByTimeAsync(10);
      expect(wallGuard.reason).toBe("wall_clock_limit");
      expect(wallAborts).toBe(1);
      wallGuard.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
