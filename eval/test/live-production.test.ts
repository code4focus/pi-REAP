import { appendFileSync, copyFileSync, chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exactTaskIds, planCalls, validateCatalog } from "../runner/live-driver.js";
import {
  CaptureAbortGuard, cleanupPrivateRoot, createPrivateRoot, loadInstalledPi, loadInstalledPiResponsesShared, loadPrivateRoot, readPrivateJsonFile, validatePrivateTaskFile,
  liveUsageFromPiAssistantUsage, productionExtensionOptions, unavailableCachePrefixMeasurement, validateProductionBuild, writeFailureReceipt, writePrivate,
} from "../runner/live-production.js";
import {
  expectedPiCatalogSha256,
  expectedPiExecutableSha256,
  expectedPiRuntimeGraphSha256,
} from "../../src/distribution/pi-graph-contract.js";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

const exactPiFiles = {
  coding: [
    "package.json", "dist/cli.js", "dist/index.js", "dist/core/sdk.js", "dist/core/agent-session.js", "dist/core/model-runtime.js",
    "dist/core/resource-loader.js", "dist/core/settings-manager.js", "dist/core/session-manager.js",
    "dist/core/extensions/loader.js", "dist/core/extensions/runner.js", "dist/core/auth-storage.js",
  ],
  ai: [
    "package.json", "dist/models.js", "dist/auth/resolve.js", "dist/api/openai-codex-responses.js",
    "dist/api/openai-responses-shared.js", "dist/providers/data/openai-codex.json",
  ],
  core: ["package.json", "dist/agent.js", "dist/agent-loop.js"],
} as const;
type PiDependencyKind = "ai" | "core";
const piDependencies = [
  { kind: "ai", name: "@earendil-works/pi-ai", tamperFile: "dist/models.js" },
  { kind: "core", name: "@earendil-works/pi-agent-core", tamperFile: "dist/agent.js" },
] as const;

interface ExactLivePiGraph {
  readonly directory: string;
  readonly graphRoot: string;
  readonly packages: Record<"coding" | PiDependencyKind, string>;
  readonly sources: Record<"coding" | PiDependencyKind, string>;
}

function copyExactPiPackage(source: string, target: string, kind: "coding" | PiDependencyKind): void {
  for (const relativePath of exactPiFiles[kind]) {
    const destination = join(target, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(source, relativePath), destination);
  }
  if (kind === "coding") chmodSync(join(target, "dist/cli.js"), 0o755);
}

function exactLivePiGraph(): ExactLivePiGraph {
  const directory = mkdtempSync(join(tmpdir(), "pi-reap-live-pi-graph-"));
  cleanup.push(directory);
  const graphRoot = join(directory, "node_modules");
  const scope = join(graphRoot, "@earendil-works");
  const installedCoding = realpathSync(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent"));
  const sources = {
    coding: installedCoding,
    ai: realpathSync(join(dirname(installedCoding), "pi-ai")),
    core: realpathSync(join(dirname(installedCoding), "pi-agent-core")),
  };
  const packages = {
    coding: join(scope, "pi-coding-agent"),
    ai: join(scope, "pi-ai"),
    core: join(scope, "pi-agent-core"),
  };
  mkdirSync(join(graphRoot, ".bin"), { recursive: true });
  for (const kind of ["coding", "ai", "core"] as const) copyExactPiPackage(sources[kind], packages[kind], kind);
  copyFileSync(join(packages.coding, "dist/cli.js"), join(graphRoot, ".bin", "pi"));
  chmodSync(join(graphRoot, ".bin", "pi"), 0o755);
  return { directory, graphRoot, packages, sources };
}

function nestedDependency(graph: ExactLivePiGraph, dependency: typeof piDependencies[number]): string {
  return join(graph.packages.coding, "node_modules", dependency.name);
}

function installExactNested(graph: ExactLivePiGraph, dependency: typeof piDependencies[number]): string {
  const nested = nestedDependency(graph, dependency);
  copyExactPiPackage(graph.packages[dependency.kind], nested, dependency.kind);
  return nested;
}

async function withLivePiGraph<T>(graph: ExactLivePiGraph, action: () => Promise<T> | T): Promise<T> {
  const originalPath = process.env.PATH;
  process.env.PATH = join(graph.graphRoot, ".bin");
  try {
    return await action();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
}

async function expectPreImportFailure(graph: ExactLivePiGraph, message: string | RegExp): Promise<void> {
  const importer = vi.fn(async () => ({ processResponsesStream() {} }));
  await withLivePiGraph(graph, async () => {
    await expect(loadInstalledPiResponsesShared(importer)).rejects.toThrow(message);
  });
  expect(importer).not.toHaveBeenCalled();
}

describe("production live-capture offline preflight and private-root safety", () => {
  it("refuses every predecessor live mode before provider setup without an exact production qualification", () => {
    const tasks = exactTaskIds.map((id) => ({ id, body: `synthetic ${id}`, grader: { kind: "exact" as const, expected: "synthetic" } }));
    const calls = planCalls(tasks); const enforce = calls.find((call) => call.kind === "route" && call.mode === "policy-enforce")!;
    const shadow = calls.find((call) => call.kind === "route" && call.mode === "policy-shadow")!; const cache = calls.find((call) => call.kind === "cache")!;
    for (const call of [enforce, shadow, cache]) expect(() => productionExtensionOptions(call, "/private/synthetic-telemetry")).toThrow("profile-bound live qualification is unavailable");
  });

  it("binds the installed Pi terminal parser to the exact production usage conversion boundary", async () => {
    const shared = await loadInstalledPiResponsesShared();
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
    expect(installed.catalog.piExecutableSha256).toBe(expectedPiExecutableSha256);
    expect(installed.catalog.piPackageSha256).toBe(expectedPiRuntimeGraphSha256);
    expect(installed.catalog.piCatalogSha256).toBe(expectedPiCatalogSha256);
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

  it("fingerprints the exact project-local pnpm Pi executable without a global install", () => {
    const originalPath = process.env.PATH;
    process.env.PATH = [join(process.cwd(), "node_modules", ".bin"), join(tmpdir(), "synthetic-missing-bin")].join(delimiter);
    try {
      const installed = loadInstalledPi();
      expect(installed.executablePath).toBe(realpathSync(join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")));
      expect(installed.packageRoot).toContain(`${join("node_modules", ".pnpm", "@earendil-works+pi-coding-agent@0.82.1")}`);
      expect(installed.catalog.piPackageVersion).toBe("0.82.1");
      expect(installed.catalog.piPackageSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    }
  });

  it.each(piDependencies)("rejects external and broken nested $name links without using a valid sibling or importing Pi", async (dependency) => {
    const external = exactLivePiGraph();
    const externalNested = nestedDependency(external, dependency);
    mkdirSync(dirname(externalNested), { recursive: true });
    symlinkSync(external.sources[dependency.kind], externalNested, "dir");
    await expectPreImportFailure(external, "escapes by symlink");

    const broken = exactLivePiGraph();
    const brokenNested = nestedDependency(broken, dependency);
    mkdirSync(dirname(brokenNested), { recursive: true });
    symlinkSync(join(broken.directory, "missing-dependency"), brokenNested, "dir");
    await expectPreImportFailure(broken, /ENOENT|no such file/i);
  });

  it.each(piDependencies)("rejects nonregular and escaping nested $name content before importing Pi", async (dependency) => {
    const nonregular = exactLivePiGraph();
    const nonregularNested = nestedDependency(nonregular, dependency);
    mkdirSync(dirname(nonregularNested), { recursive: true });
    writeFileSync(nonregularNested, "not a package\n");
    await expectPreImportFailure(nonregular, "dependency root is invalid");

    const escaping = exactLivePiGraph();
    const escapingNested = installExactNested(escaping, dependency);
    const runtimePath = join(escapingNested, dependency.tamperFile);
    const outsidePath = join(escaping.directory, `outside-${dependency.kind}.js`);
    writeFileSync(outsidePath, readFileSync(runtimePath));
    unlinkSync(runtimePath);
    symlinkSync(outsidePath, runtimePath);
    await expectPreImportFailure(escaping, "not an exact regular contained file");
  });

  it.each(piDependencies)("rejects wrong identity or version in nested $name instead of accepting the valid sibling", async (dependency) => {
    for (const mutation of ["identity", "version"] as const) {
      const graph = exactLivePiGraph();
      const nested = installExactNested(graph, dependency);
      const manifestPath = join(nested, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      if (mutation === "identity") manifest.name = `${dependency.name}-substituted`;
      else manifest.version = "0.82.2";
      writeFileSync(manifestPath, JSON.stringify(manifest));
      await expectPreImportFailure(graph, "incompatible dependency");
    }
  });

  it.each(piDependencies)("rejects same-version nested $name runtime tampering instead of accepting the valid sibling", async (dependency) => {
    const graph = exactLivePiGraph();
    const nested = installExactNested(graph, dependency);
    appendFileSync(join(nested, dependency.tamperFile), "\n// synthetic same-version tamper\n");
    await expectPreImportFailure(graph, "fabricated or differs");
  });

  it("uses exact sibling pi-ai and pi-agent-core only when both nested paths are genuinely absent", async () => {
    const graph = exactLivePiGraph();
    for (const dependency of piDependencies) {
      expect(() => lstatSync(nestedDependency(graph, dependency))).toThrow();
    }
    const importer = vi.fn(async () => ({ processResponsesStream() {} }));
    await withLivePiGraph(graph, async () => {
      const installed = loadInstalledPi();
      expect(installed.piAiRoot).toBe(realpathSync(graph.packages.ai));
      expect(installed.piAgentCoreRoot).toBe(realpathSync(graph.packages.core));
      await expect(loadInstalledPiResponsesShared(importer)).resolves.toMatchObject({
        processResponsesStream: expect.any(Function),
      });
    });
    expect(importer).toHaveBeenCalledTimes(1);
    expect(importer.mock.calls[0]?.[0]).toBe(pathToFileURL(realpathSync(join(graph.packages.ai, "dist/api/openai-responses-shared.js"))).href);
  });

  it("rejects CLI and catalog fingerprint mismatches before importing Pi", async () => {
    const cli = exactLivePiGraph();
    appendFileSync(join(cli.packages.coding, "dist/cli.js"), "\n// synthetic CLI tamper\n");
    await expectPreImportFailure(cli, "fabricated or differs");

    const catalog = exactLivePiGraph();
    appendFileSync(join(catalog.packages.ai, "dist/providers/data/openai-codex.json"), "\n");
    await expectPreImportFailure(catalog, "fabricated or differs");
  });

  it("rejects an external coding-agent link behind an unrelated local shim before importing Pi", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-reap-substituted-shim-")); cleanup.push(directory);
    const nodeModules = join(directory, "node_modules"); const bin = join(nodeModules, ".bin");
    const packageLink = join(nodeModules, "@earendil-works", "pi-coding-agent");
    mkdirSync(bin, { recursive: true }); mkdirSync(join(nodeModules, "@earendil-works"), { recursive: true });
    symlinkSync(realpathSync(join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent")), packageLink, "dir");
    const substituted = join(bin, "pi"); copyFileSync(process.execPath, substituted); chmodSync(substituted, 0o755);
    const substitutedSha256 = createHash("sha256").update(readFileSync(substituted)).digest("hex");
    const originalPath = process.env.PATH; process.env.PATH = bin;
    try {
      const importer = vi.fn(async () => ({ processResponsesStream() {} }));
      await expect(loadInstalledPiResponsesShared(importer)).rejects.toThrow("escapes by symlink");
      expect(importer).not.toHaveBeenCalled();
      expect(substitutedSha256).not.toBe(expectedPiExecutableSha256);
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    }
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
