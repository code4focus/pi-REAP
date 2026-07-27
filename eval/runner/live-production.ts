import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJson, captureStreamByteLimit, captureWallClockMs, catalogPricing, ceilingRatesMicroUsd, configuredApi, configuredModel, configuredProvider,
  evaluationSystemPromptForCall, exactCachePrefixMeasurement, expectedControlHashes, modelFingerprintForCatalog, sessionIdForCall, sha256,
  type CachePrefixMeasurementCapability, type CacheUsageProvenance, type CaptureAdapter, type CaptureFailurePhase, type CatalogModel, type CapturedObservation, type PlannedCall, type PrivateTask,
} from "./live-driver.js";
import { recordPiAssistantUsage } from "./live-observability.js";
import type { AutomaticEffort } from "../../src/domain/effort.js";
import { effectiveCostMicros } from "./cost.js";
import type { UsageMetrics } from "./types.js";
import { expectedExtensionBuildFingerprint, expectedSourceFingerprint } from "./live-acceptance-pins.js";
import { extensionBuildFingerprint, sourceManifestFingerprint } from "./source-fingerprints.js";

const sentinelName = ".pi-reap-pr6-live-sentinel";
const piPackageName = "@earendil-works/pi-coding-agent";
const piVersion = "0.82.1";
const piRuntimeManifest = [
  "package.json", "dist/index.js", "dist/core/sdk.js", "dist/core/agent-session.js", "dist/core/model-runtime.js",
  "dist/core/resource-loader.js", "dist/core/settings-manager.js", "dist/core/session-manager.js",
  "dist/core/extensions/loader.js", "dist/core/extensions/runner.js", "dist/core/auth-storage.js",
  "node_modules/@earendil-works/pi-agent-core/dist/agent.js", "node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js",
  "node_modules/@earendil-works/pi-ai/dist/models.js", "node_modules/@earendil-works/pi-ai/dist/auth/resolve.js",
  "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js", "node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js",
] as const;

export interface InstalledPi {
  readonly executablePath: string;
  readonly packageRoot: string;
  readonly packageJsonPath: string;
  readonly catalogPath: string;
  readonly catalog: CatalogModel;
  readonly cachePrefixMeasurement: CachePrefixMeasurementCapability;
}
export interface PrivateRoot {
  readonly path: string;
  readonly sentinel: string;
  readonly ownerUid: number;
  readonly nonce: string;
}

export interface PiTerminalAssistantUsage { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly reasoning?: number }
/** The exact production terminal-usage boundary; raw field presence is unavailable after Pi normalization. */
export function liveUsageFromPiAssistantUsage(assistantUsage: PiTerminalAssistantUsage): { readonly usage: UsageMetrics; readonly cacheUsageProvenance: CacheUsageProvenance } {
  const cache = recordPiAssistantUsage(assistantUsage);
  if (cache.rawCachedTokens.status !== "unavailable_at_pi_normalized_boundary") throw new Error("Pi terminal usage must not claim raw cache-field presence");
  const usage: UsageMetrics = {
    uncachedInputTokens: assistantUsage.input, cacheReadTokens: cache.liveEvalCacheReadTokens, cacheWriteTokens: assistantUsage.cacheWrite,
    inputTokens: assistantUsage.input + cache.liveEvalCacheReadTokens,
    outputTokens: assistantUsage.output, reasoningTokens: assistantUsage.reasoning ?? 0,
  };
  const cacheUsageProvenance: CacheUsageProvenance = {
    schemaVersion: 1, boundary: "pi_normalized_assistant_usage",
    cachedTokensPresence: "pi_normalized_presence_unknown",
    cacheWriteTokensPresence: "pi_normalized_presence_unknown",
    normalizedCacheReadTokens: cache.piNormalizedCacheReadTokens, normalizedCacheWriteTokens: usage.cacheWriteTokens,
  };
  return Object.freeze({ usage: Object.freeze(usage), cacheUsageProvenance: Object.freeze(cacheUsageProvenance) });
}

export function validateProductionBuild(repositoryRoot: string): { readonly sourceFingerprint: string; readonly extensionBuildFingerprint: string } {
  const root = realpathSync(repositoryRoot);
  const sourceFingerprint = sourceManifestFingerprint(root); const extensionBuild = extensionBuildFingerprint(root);
  if (sourceFingerprint !== expectedSourceFingerprint || extensionBuild !== expectedExtensionBuildFingerprint) throw new Error("production extension source or build fingerprint is stale");
  return Object.freeze({ sourceFingerprint, extensionBuildFingerprint: extensionBuild });
}

/** Offline only: resolves the installed executable, package, and built-in catalog without creating auth/runtime state. */
export function loadInstalledPi(): InstalledPi {
  const executablePath = resolveInstalledExecutable();
  const resolvedExecutable = realpathSync(executablePath);
  const packageRoot = dirname(dirname(resolvedExecutable));
  const packageJsonPath = join(packageRoot, "package.json");
  const catalogPath = join(packageRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data", "openai-codex.json");
  const packageBytes = readFileSync(packageJsonPath); const pkg = JSON.parse(packageBytes.toString("utf8")) as Record<string, unknown>;
  if (pkg.name !== piPackageName || pkg.version !== piVersion || realpathSync(join(packageRoot, "dist", "cli.js")) !== resolvedExecutable) throw new Error("unsupported installed Pi runtime");
  const catalogBytes = readFileSync(catalogPath); const data = JSON.parse(catalogBytes.toString("utf8")) as Record<string, Record<string, unknown>>;
  const model = data["openai-codex-responses"]?.["gpt-5.4-mini"] as { api?: unknown; reasoning?: unknown; cost?: Record<string, unknown> } | undefined;
  if (!model) throw new Error("configured Pi model absent from installed catalog");
  const catalog: CatalogModel = {
    id: "openai-codex/gpt-5.4-mini", api: String(model.api), reasoning: model.reasoning === true,
    ratesPerMillion: { input: Number(model.cost?.input), output: Number(model.cost?.output), cacheRead: Number(model.cost?.cacheRead), cacheWrite: Number(model.cost?.cacheWrite) },
    piExecutableSha256: digestFile(resolvedExecutable), piPackageSha256: installedPackageFingerprint(packageRoot), piCatalogSha256: sha256(catalogBytes), piPackageVersion: piVersion,
  };
  return Object.freeze({ executablePath, packageRoot, packageJsonPath, catalogPath, catalog, cachePrefixMeasurement: exactCachePrefixMeasurement() });
}

/** Explicit unavailable seam retained for fail-closed capability tests. */
export function unavailableCachePrefixMeasurement(): CachePrefixMeasurementCapability {
  return Object.freeze({
    schemaVersion: 1, status: "unavailable", code: "provider_compatible_tokenizer_unavailable",
    provider: configuredProvider, model: configuredModel, api: configuredApi,
  });
}

export function validatePrivateTaskFile(path: string, repositoryRoot: string): readonly PrivateTask[] {
  if (!isAbsolute(path)) throw new Error("private task path must be absolute");
  const opened = readOwnedNoFollow(path, process.getuid?.() ?? -1, 65_536); const real = opened.realPath; const root = realpathSync(repositoryRoot);
  if (!relative(root, real).startsWith("..")) throw new Error("private task file must remain outside the repository");
  return JSON.parse(opened.bytes.toString("utf8")) as readonly PrivateTask[];
}

export function createPrivateRoot(): PrivateRoot {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pi-reap-pr6-live-"));
  chmodSync(root, 0o700);
  const nonce = randomBytes(32).toString("hex"); const ownerUid = process.getuid?.() ?? -1; const sentinel = join(root, sentinelName);
  writeExclusivePrivate(sentinel, `${JSON.stringify({ schemaVersion: 1, root: realpathSync(root), ownerUid, nonce })}\n`);
  return Object.freeze({ path: realpathSync(root), sentinel, ownerUid, nonce });
}

export function loadPrivateRoot(path: string): PrivateRoot {
  if (!isAbsolute(path)) throw new Error("private root path must be absolute");
  if (lstatSync(path).isSymbolicLink()) throw new Error("private root is unsafe");
  const root = realpathSync(path); const info = lstatSync(root);
  if (!root.startsWith(`${realpathSync(tmpdir())}/`) || !basename(root).startsWith("pi-reap-pr6-live-") || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw new Error("private root is unsafe");
  const sentinel = join(root, sentinelName);
  const value = JSON.parse(readOwnedNoFollow(sentinel, info.uid, 4096).bytes.toString("utf8")) as Record<string, unknown>;
  if (value.schemaVersion !== 1 || value.root !== root || value.ownerUid !== info.uid || typeof value.nonce !== "string" || !/^[a-f0-9]{64}$/.test(value.nonce)) throw new Error("private root sentinel binding is invalid");
  validateTree(root, info.uid);
  return Object.freeze({ path: root, sentinel, ownerUid: info.uid, nonce: value.nonce });
}

/** Opens a private JSON input with O_NOFOLLOW, validates the descriptor, and reads only from that descriptor. */
export function readPrivateJsonFile(path: string, root: PrivateRoot, maxBytes = 16_777_216): unknown {
  if (!isAbsolute(path)) throw new Error("private input path must be absolute");
  const lexical = relative(root.path, resolve(path)); if (lexical.startsWith("..") || isAbsolute(lexical)) throw new Error("private input escapes capture root");
  const opened = readOwnedNoFollow(path, root.ownerUid, maxBytes);
  const actual = relative(root.path, opened.realPath); if (actual.startsWith("..") || isAbsolute(actual)) throw new Error("private input resolves outside capture root");
  return JSON.parse(opened.bytes.toString("utf8"));
}

export function writePrivate(root: PrivateRoot, relativePath: string, contents: string | Buffer): string {
  validateRelativeName(relativePath);
  const path = join(root.path, relativePath); const parent = dirname(path);
  ensurePrivateDirectory(root, parent);
  writeExclusivePrivate(path, contents);
  return path;
}

export function writeFailureReceipt(root: PrivateRoot, failureCode: string, completedCalls: number, phase: CaptureFailurePhase = "capture"): string {
  const postCaptureCode = failureCode === "cache_crossover_no_cache_read" ||
    failureCode === "legacy_or_missing_exact_prefix_measurement" ||
    failureCode === "post_capture_finalization_failed";
  const validCaptureCount = phase === "capture" && !postCaptureCode && Number.isInteger(completedCalls) && completedCalls >= 0 && completedCalls < 33;
  const validPostCaptureCount = phase === "post_capture" && postCaptureCode && completedCalls === 33;
  if (!/^[a-z_]+$/.test(failureCode) || (!validCaptureCount && !validPostCaptureCount)) throw new Error("invalid sanitized failure receipt");
  return writePrivate(root, "failure-receipt.json", `${JSON.stringify({ schemaVersion: 2, status: "failed", phase, failureCode, completedCalls, rootHash: sha256(root.path) })}\n`);
}

/** Cleanup refuses unknown roots, ownership/mode drift, symlinks, and sentinel mismatch before recursive removal. */
export function cleanupPrivateRoot(path: string): void {
  const root = loadPrivateRoot(path);
  rmSync(root.path, { recursive: true, force: false });
}

/** Creates the real SDK adapter only after the caller has completed the authorization preflight. */
export function productionAdapterFactory(installed: InstalledPi, privateRoot: PrivateRoot, repositoryRoot: string): () => Promise<CaptureAdapter> {
  return async () => new PiSdkCaptureAdapter(installed, privateRoot, repositoryRoot);
}

/** Client-side abort guard; it never changes a provider payload. */
export class CaptureAbortGuard {
  private streamedBytes = 0;
  private readonly timer: ReturnType<typeof setTimeout>;
  private stopped = false;
  reason?: "wall_clock_limit" | "stream_byte_limit";
  constructor(
    private readonly abort: () => Promise<void> | void,
    wallClockMs = captureWallClockMs,
    private readonly streamByteLimit = captureStreamByteLimit,
  ) {
    this.timer = setTimeout(() => this.trigger("wall_clock_limit"), wallClockMs);
  }
  observeDelta(delta: string): void {
    if (this.stopped) return;
    this.streamedBytes += Buffer.byteLength(delta);
    if (this.streamedBytes > this.streamByteLimit) this.trigger("stream_byte_limit");
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }
  private trigger(reason: "wall_clock_limit" | "stream_byte_limit"): void {
    if (this.stopped || this.reason !== undefined) return;
    this.reason = reason;
    void Promise.resolve(this.abort()).catch(() => undefined);
  }
}

class PiSdkCaptureAdapter implements CaptureAdapter {
  private readonly installed: InstalledPi;
  private readonly privateRoot: PrivateRoot;
  private readonly repositoryRoot: string;
  constructor(installed: InstalledPi, privateRoot: PrivateRoot, repositoryRoot: string) {
    this.installed = installed; this.privateRoot = privateRoot; this.repositoryRoot = realpathSync(repositoryRoot);
  }
  estimate(call: PlannedCall, task: PrivateTask): UsageMetrics {
    const conservativeInput = Buffer.byteLength(task.body) + Buffer.byteLength(evaluationSystemPromptForCall(call));
    return { inputTokens: conservativeInput, uncachedInputTokens: conservativeInput, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }
  async execute(call: PlannedCall, task: PrivateTask): Promise<CapturedObservation> {
    const started = performance.now();
    const previousUmask = process.umask(0o077);
    try {
      const sdk = await import(pathToFileURL(join(this.installed.packageRoot, "dist", "index.js")).href) as PiSdkModule;
      const authModule = await import(pathToFileURL(join(this.installed.packageRoot, "dist", "core", "auth-storage.js")).href) as AuthModule;
      const production = await import(pathToFileURL(join(this.repositoryRoot, "dist", "index.js")).href) as ProductionExtensionModule;
      const credential = authModule.readStoredCredential("openai-codex", join(sdk.getAgentDir(), "auth.json"));
      if (!credential) throw new Error("authorized credential is unavailable");
      if (credential.type === "oauth" && (!Number.isFinite(credential.expires) || credential.expires <= Date.now() + 3_600_000)) throw new Error("authorized OAuth credential would require refresh");
      const credentials = authModule.AuthStorage.inMemory({ "openai-codex": credential });
      const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
      const model = modelRuntime.getModel("openai-codex", "gpt-5.4-mini"); if (!model) throw new Error("authorized model is unavailable");
      const telemetryDirectory = join(this.privateRoot.path, "telemetry", String(call.ordinal)); ensurePrivateDirectory(this.privateRoot, telemetryDirectory);
      const state: ObserverState = { providerRequests: 0, responseAttempts: 0, retryEvents: 0, toolRounds: 0 };
      const baseline = observerFactory((pi) => pi.on("before_provider_request", (event) => {
        state.baselinePayload = cloneJson(event.payload);
        state.baselinePayloadHash = sha256(canonicalJson(state.baselinePayload));
      }));
      const productFactory = production.createExtension({ telemetryDirectory, sessionId: `live-${call.ordinal}`, mode: call.extensionMode });
      const applied = observerFactory((pi) => {
        pi.on("before_provider_request", (event) => {
          state.providerRequests += 1;
          let payload = event.payload;
          if (call.kind === "cache" || call.baselineEffort) payload = patchEffortOnly(payload, call.kind === "cache" ? call.effort : call.baselineEffort!);
          state.appliedPayload = cloneJson(payload);
          state.appliedPayloadHash = sha256(canonicalJson(state.appliedPayload)); const appliedEffort = effortIn(payload);
          if (appliedEffort !== undefined) state.appliedEffort = appliedEffort; else delete state.appliedEffort;
          return payload;
        });
        pi.on("after_provider_response", () => { state.responseAttempts += 1; });
      });
      const settings = sdk.SettingsManager.inMemory({ transport: "sse", compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, maxRetryDelayMs: 0 } } }, { projectTrusted: false });
      const loader = new sdk.DefaultResourceLoader({
        cwd: this.privateRoot.path, agentDir: join(this.privateRoot.path, "agent"), settingsManager: settings,
        extensionFactories: [baseline, productFactory, applied], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPrompt: evaluationSystemPromptForCall(call),
      });
      await loader.reload({ resolveProjectTrust: async () => false });
      const sessionId = sessionIdForCall(call);
      const sessionManager = sdk.SessionManager.inMemory(this.privateRoot.path, { id: sessionId });
      const created = await sdk.createAgentSession({ cwd: this.privateRoot.path, agentDir: join(this.privateRoot.path, "agent"), modelRuntime, model, thinkingLevel: "high", noTools: "all", tools: [], customTools: [], resourceLoader: loader, sessionManager, settingsManager: settings });
      const session = created.session;
      if (session.sessionFile !== undefined || session.getActiveToolNames().length !== 0) throw new Error("isolated no-session/no-tools contract failed");
      const abortGuard = new CaptureAbortGuard(() => session.abort());
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "auto_retry_start") state.retryEvents += 1;
        if (event.type === "tool_execution_start") state.toolRounds += 1;
        if (event.type === "message_update") {
          const streamEvent = event.assistantMessageEvent;
          const delta = typeof streamEvent === "object" && streamEvent !== null && "delta" in streamEvent ? streamEvent.delta : undefined;
          if (typeof delta === "string") abortGuard.observeDelta(delta);
        }
      });
      let assistant: AssistantMessage | undefined;
      try {
        await session.prompt(task.body, { expandPromptTemplates: false, source: "extension" });
        await session.waitForIdle();
        if (abortGuard.reason !== undefined) throw new Error(`client capture aborted: ${abortGuard.reason}`);
        assistant = [...session.messages].reverse().find((message) => message.role === "assistant") as AssistantMessage | undefined;
      } finally {
        abortGuard.stop();
        unsubscribe();
        session.dispose();
      }
      if (!assistant || assistant.stopReason !== "stop") throw new Error("provider run did not stop successfully");
      const output = assistant.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("");
      const { usage, cacheUsageProvenance } = liveUsageFromPiAssistantUsage(assistant.usage);
      const productionRecommendation = readSelectedEffort(telemetryDirectory);
      const selectedEffort = call.kind === "cache" ? call.effort : call.baselineEffort ?? productionRecommendation;
      secureTree(telemetryDirectory);
      const controls = expectedControlHashes(call, task, this.installed.catalog);
      const accepted = output === task.grader.expected;
      const criticalFailure = task.id === "task-high-risk-failure" && !accepted;
      const catalogCost = effectiveCostMicros(usage, catalogPricing);
      const ceilingCost = usage.uncachedInputTokens * ceilingRatesMicroUsd.uncachedInput
        + usage.cacheReadTokens * ceilingRatesMicroUsd.cacheRead
        + usage.cacheWriteTokens * ceilingRatesMicroUsd.cacheWrite
        + usage.outputTokens * ceilingRatesMicroUsd.output
        + usage.reasoningTokens * ceilingRatesMicroUsd.reasoning;
      const observation: CapturedObservation = {
        call, selectedEffort, ...(call.kind === "route" && call.mode === "policy-shadow" ? {} : { appliedEffort: state.appliedEffort }),
        baselinePayload: state.baselinePayload ?? fail("baseline request observation missing"),
        appliedPayload: state.appliedPayload ?? fail("applied request observation missing"),
        baselinePayloadHash: state.baselinePayloadHash ?? fail("baseline request observation missing"), appliedPayloadHash: state.appliedPayloadHash ?? fail("applied request observation missing"),
        providerRequests: state.providerRequests, responseAttempts: state.responseAttempts, retries: state.retryEvents, toolRounds: state.toolRounds,
        cacheUsageProvenance,
        usage, latencyMs: Math.round(performance.now() - started), providerFingerprint: sha256("openai-codex"), modelFingerprint: modelFingerprintForCatalog(this.installed.catalog),
        controlHashes: controls, output, outputHash: sha256(output), accepted, criticalFailure,
        catalogCostMicros: catalogCost, ceilingCostMicros: ceilingCost,
      };
      writePrivate(this.privateRoot, `raw/${String(call.ordinal).padStart(2, "0")}.output`, output);
      writePrivate(this.privateRoot, `raw/${String(call.ordinal).padStart(2, "0")}.metrics.json`, `${JSON.stringify({ ...observation, output: undefined })}\n`);
      return observation;
    } catch (error) {
      try {
        writePrivate(this.privateRoot, `errors/${String(call.ordinal).padStart(2, "0")}.json`, `${JSON.stringify({
          schemaVersion: 1, callOrdinal: call.ordinal, errorName: error instanceof Error ? error.name : "Error",
          errorMessage: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined,
        })}\n`);
      } catch { /* preserve the original failure */ }
      throw new Error(`live Pi capture failed at call ${call.ordinal}`);
    } finally { process.umask(previousUmask); }
  }
}

interface ObserverState {
  providerRequests: number; responseAttempts: number; retryEvents: number; toolRounds: number;
  baselinePayload?: unknown; appliedPayload?: unknown; baselinePayloadHash?: string; appliedPayloadHash?: string;
  appliedEffort?: AutomaticEffort;
}
interface ExtensionApi { on(name: string, handler: (event: Record<string, unknown>) => unknown): void }
type ExtensionFactory = (api: ExtensionApi) => void;
interface PiSdkModule {
  getAgentDir(): string;
  ModelRuntime: { create(options: Record<string, unknown>): Promise<{ getModel(provider: string, id: string): Record<string, unknown> | undefined }> };
  SettingsManager: { inMemory(settings: Record<string, unknown>, options: Record<string, unknown>): unknown };
  DefaultResourceLoader: new (options: Record<string, unknown>) => { reload(options: Record<string, unknown>): Promise<void> };
  SessionManager: { inMemory(cwd: string, options: { id: string }): unknown };
  createAgentSession(options: Record<string, unknown>): Promise<{ session: AgentSession }>;
}
interface AuthModule { AuthStorage: { inMemory(data: Record<string, Credential>): unknown }; readStoredCredential(provider: string, path: string): Credential | undefined }
type Credential = { type: "api_key"; key?: string } | { type: "oauth"; refresh: string; access: string; expires: number };
interface ProductionExtensionModule { createExtension(options: Record<string, unknown>): ExtensionFactory }
interface AgentSession {
  sessionFile?: string; messages: readonly AssistantMessage[]; getActiveToolNames(): string[];
  subscribe(handler: (event: { type: string; readonly [key: string]: unknown }) => void): () => void;
  prompt(text: string, options: Record<string, unknown>): Promise<void>; waitForIdle(): Promise<void>; abort(): Promise<void>; dispose(): void;
}
interface AssistantMessage { role: string; stopReason?: string; content: Array<{ type: string; text?: string }>; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number } }

function resolveInstalledExecutable(): string {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    // pnpm's local shim is not the installed runtime: its parent is this
    // repository's node_modules and cannot be fingerprinted as a Pi package.
    // The production boundary intentionally uses the externally installed Pi.
    if (basename(directory) === ".bin" && basename(dirname(directory)) === "node_modules") continue;
    const candidate = join(directory, "pi");
    try { const info = statSync(candidate); if (info.isFile() && (info.mode & 0o111) !== 0) return candidate; } catch { /* continue */ }
  }
  throw new Error("installed Pi executable was not found");
}
function readSelectedEffort(directory: string): AutomaticEffort {
  const lines = readFileSync(join(directory, "decisions.jsonl"), "utf8").trim().split("\n");
  const row = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
  if (!["low", "medium", "high", "xhigh"].includes(String(row.recommendedEffort))) throw new Error("production extension did not emit a selected effort");
  return row.recommendedEffort as AutomaticEffort;
}
function observerFactory(register: (pi: ExtensionApi) => void): ExtensionFactory { return (pi) => register(pi); }
function patchEffortOnly(payload: unknown, effort: AutomaticEffort): unknown {
  const base = record(payload); const reasoning = record(base.reasoning);
  return { ...base, reasoning: { ...reasoning, effort } };
}
function effortIn(payload: unknown): AutomaticEffort | undefined {
  const effort = record(record(payload).reasoning).effort; return ["low", "medium", "high", "xhigh"].includes(String(effort)) ? effort as AutomaticEffort : undefined;
}
function cloneJson(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("provider payload is not JSON serializable");
  return JSON.parse(serialized) as unknown;
}
function record(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("provider payload is not an object"); return value as Record<string, unknown>; }
function digestFile(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function installedPackageFingerprint(root: string): string {
  return sha256(JSON.stringify(piRuntimeManifest.map((file) => ({ file, sha256: digestFile(join(root, file)) }))));
}
function readOwnedNoFollow(path: string, ownerUid: number, maxBytes: number): { readonly bytes: Buffer; readonly realPath: string } {
  if (typeof constants.O_NOFOLLOW !== "number") throw new Error("private no-follow reads are unavailable");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== ownerUid || (info.mode & 0o777) !== 0o600 || info.size > maxBytes) throw new Error("unsafe private input descriptor");
    const realPath = realpathSync(path); const before = lstatSync(realPath);
    if (!before.isFile() || before.isSymbolicLink() || before.dev !== info.dev || before.ino !== info.ino) throw new Error("private input path changed during open");
    const bytes = readFileSync(fd);
    const after = lstatSync(realPath);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size) throw new Error("private input path changed during read");
    return { bytes, realPath };
  } finally { closeSync(fd); }
}
function ensurePrivateDirectory(root: PrivateRoot, path: string): void {
  const rel = relative(root.path, resolve(path)); if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("private path escapes capture root");
  let cursor = root.path;
  for (const part of rel.split("/").filter(Boolean)) {
    cursor = join(cursor, part);
    try { mkdirSync(cursor, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = lstatSync(cursor); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe private directory");
    chmodSync(cursor, 0o700);
  }
}
function writeExclusivePrivate(path: string, contents: string | Buffer): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, contents); } finally { closeSync(fd); }
  chmodSync(path, 0o600);
}
function validateRelativeName(path: string): void { if (!path || isAbsolute(path) || path.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error("invalid private relative path"); }
function validateTree(path: string, ownerUid: number): void {
  for (const name of readdirSync(path)) {
    const child = join(path, name); const info = lstatSync(child);
    if (info.isSymbolicLink() || info.uid !== ownerUid) throw new Error("cleanup tree contains unsafe ownership or symlink");
    if (info.isDirectory()) { if ((info.mode & 0o777) !== 0o700) throw new Error("cleanup tree has unsafe directory mode"); validateTree(child, ownerUid); }
    else if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw new Error("cleanup tree has unsafe file mode");
  }
}
function secureTree(path: string): void {
  const info = lstatSync(path); if (info.isDirectory()) { chmodSync(path, 0o700); for (const child of readdirSync(path)) secureTree(join(path, child)); } else if (info.isFile() && !info.isSymbolicLink()) chmodSync(path, 0o600); else throw new Error("private evidence tree is unsafe");
}
function fail(message: string): never { throw new Error(message); }
