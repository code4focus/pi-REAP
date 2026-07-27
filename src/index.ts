import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createProfileActivationSnapshot, type ProfileActivationSnapshot, type ProfileMatch } from "./domain/profile.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { defaultConfigPaths, loadConfig } from "./config/load.js";
import { safeDefaults } from "./config/defaults.js";
import { patchProviderPayload } from "./provider/patch.js";
import { EpochRouter, parseEffortCommand } from "./runtime/router.js";

export type PiExtension = ExtensionFactory;

export interface RuntimeAttestation {
  readonly capability: unknown;
  readonly admission: unknown;
  readonly modelCatalogRevision: string;
  readonly modelCatalogDigest: string;
  readonly piVersion: string;
  readonly providerAdapterRevision: string;
  readonly providerAdapterDigest: string;
}
interface PreparedRuntimeActivation {
  readonly snapshot: ProfileActivationSnapshot;
  readonly modelCatalogRevision: string;
  readonly modelCatalogDigest: string;
  readonly piVersion: string;
  readonly providerAdapterRevision: string;
  readonly providerAdapterDigest: string;
}
export interface ExtensionOptions { load?: () => ReturnType<typeof loadConfig>; activation?: RuntimeAttestation; }
const loadProductionConfig = () => loadConfig({ readFile: async (path) => {
  try { return await readFile(path, "utf8"); } catch { return undefined; }
} }, defaultConfigPaths(homedir(), process.cwd()));

/** Pi 0.82.1 extension factory. Routing remains local to this extension session. */
export const createExtension = (options: ExtensionOptions = {}): PiExtension => async (pi: ExtensionAPI) => {
  const activation = prepareRuntimeActivation(options.activation);
  const config = await (options.load ?? loadProductionConfig)().catch(() => ({
    ...safeDefaults,
    telemetry: { ...safeDefaults.telemetry },
    ui: { ...safeDefaults.ui },
  }));
  // telemetry remains an intentionally unused, read-only PR 4 seam.
  if (!config.enabled) return;
  let router: EpochRouter | undefined;
  let lastRunFailed = false;
  const current = () => router;
  const status = (ctx: ExtensionContext) => {
    if (config.ui.showStatus && current()) ctx.ui.setStatus("pi-reap", current()!.status());
  };
  const revoke = (ctx: ExtensionContext): false => {
    current()?.invalidate();
    lastRunFailed = false;
    status(ctx);
    return false;
  };
  const reconcile = (ctx: ExtensionContext, preserveQueuedInput = false): boolean => {
    const match = runtimeMatch(ctx, activation);
    if (!match || !activation || !current()) return revoke(ctx);
    const generation = current()!.generation;
    const resolved = current()!.activateSnapshot(match, activation.snapshot, { preserveQueuedInput });
    if (!resolved) return revoke(ctx);
    if (current()!.generation !== generation) lastRunFailed = false;
    return resolved;
  };

  pi.registerCommand("effort", {
    description: "Set Pi REAP effort for this session only.",
    handler: async (args, ctx) => { if (current() && parseEffortCommand(`/effort ${args}`, current()!)) status(ctx); },
  });
  pi.on("session_start", (event, ctx) => {
    // A start always replaces all state, including an explicit max override.
    router = new EpochRouter({ resumeReason: event.reason, config });
    reconcile(ctx);
    lastRunFailed = false;
    status(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    router = undefined;
    lastRunFailed = false;
    if (config.ui.showStatus) ctx.ui.setStatus("pi-reap", undefined);
  });
  pi.on("input", (event) => { current()?.queueInput({ prompt: event.text, source: event.source, ...(event.streamingBehavior ? { streamingBehavior: event.streamingBehavior } : {}) }); });
  pi.on("before_agent_start", (event, ctx) => {
    if (reconcile(ctx, true)) {
      if (current()?.replaceQueuedPrompt(event.prompt)) current()?.startQueued();
    }
    status(ctx);
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!reconcile(ctx)) return undefined;
    current()?.onProviderRequest();
    const input = current()?.providerInput();
    if (!input || current()?.runtime.mode !== "enforce") { status(ctx); return undefined; }
    const payload = patchProviderPayload(input, event.payload);
    status(ctx);
    return payload === event.payload ? undefined : payload;
  });
  pi.on("tool_call", (event, ctx) => { current()?.onToolCall(event.toolName); status(ctx); });
  pi.on("tool_execution_end", (event, ctx) => { if (event.isError) { const before = current()?.effectiveRung()?.ordinal; current()?.onToolError(); if (config.ui.notifyOnEscalation && before !== undefined && current()?.effectiveRung()?.ordinal !== before) ctx.ui.notify("Pi REAP raised effort after a tool failure", "warning"); } status(ctx); });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") {
      const failed = event.message.stopReason === "error" || event.message.stopReason === "length";
      lastRunFailed = failed;
      const before = current()?.effectiveRung()?.ordinal; current()?.onProviderEnd(event.message.stopReason);
      if (failed && config.ui.notifyOnEscalation && before !== undefined && current()?.effectiveRung()?.ordinal !== before) ctx.ui.notify("Pi REAP raised effort after an assistant failure", "warning");
    }
    status(ctx);
  });
  pi.on("session_compact", (event, ctx) => { current()?.onCompaction(event.reason, event.willRetry); status(ctx); });
  // Pi 0.82.1 agent_settled is fieldless; settle only the recorded terminal result.
  pi.on("agent_settled", (_event, ctx) => { current()?.settle(lastRunFailed); lastRunFailed = false; status(ctx); });
};

export const extension: PiExtension = createExtension();

export default extension;

function prepareRuntimeActivation(value: unknown): PreparedRuntimeActivation | undefined {
  const record = ownDataRecord(value, [
    "capability", "admission", "modelCatalogRevision", "modelCatalogDigest", "piVersion", "providerAdapterRevision", "providerAdapterDigest",
  ]);
  if (!record
    || typeof record.modelCatalogRevision !== "string" || typeof record.modelCatalogDigest !== "string"
    || typeof record.piVersion !== "string" || typeof record.providerAdapterRevision !== "string" || typeof record.providerAdapterDigest !== "string") return undefined;
  const snapshot = createProfileActivationSnapshot(record.capability, record.admission);
  return Object.freeze({
    snapshot,
    modelCatalogRevision: record.modelCatalogRevision,
    modelCatalogDigest: record.modelCatalogDigest,
    piVersion: record.piVersion,
    providerAdapterRevision: record.providerAdapterRevision,
    providerAdapterDigest: record.providerAdapterDigest,
  });
}

function runtimeMatch(ctx: ExtensionContext, activation: PreparedRuntimeActivation | undefined): ProfileMatch | undefined {
  if (!activation) return undefined;
  try {
    const model = ctx.model;
    const record = ownDataRecord(model, ["provider", "api", "id"], false);
    if (!record || typeof record.provider !== "string" || typeof record.api !== "string" || typeof record.id !== "string") return undefined;
    return Object.freeze({
      provider: record.provider,
      api: record.api,
      model: record.id,
      modelCatalogRevision: activation.modelCatalogRevision,
      modelCatalogDigest: activation.modelCatalogDigest,
      piVersion: activation.piVersion,
      providerAdapterRevision: activation.providerAdapterRevision,
      providerAdapterDigest: activation.providerAdapterDigest,
    });
  } catch { return undefined; }
}

/** Reads own data descriptors only: hostile getters and proxies fail closed without execution. */
function ownDataRecord(value: unknown, keys: readonly string[], exact = true): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string") || keys.some((key) => !ownKeys.includes(key)) || (exact && ownKeys.length !== keys.length)) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch { return undefined; }
}
