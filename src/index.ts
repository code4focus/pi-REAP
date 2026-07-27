import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { defaultConfigPaths, loadConfig } from "./config/load.js";
import { patchProviderPayload, type ProviderModel } from "./provider/patch.js";
import { EpochRouter, parseEffortCommand } from "./runtime/router.js";

export type PiExtension = ExtensionFactory;

export interface ExtensionOptions { load?: () => ReturnType<typeof loadConfig>; }
const loadProductionConfig = () => loadConfig({ readFile: async (path) => {
  try { return await readFile(path, "utf8"); } catch { return undefined; }
} }, defaultConfigPaths(homedir(), process.cwd()));

/** Pi 0.82.1 extension factory. Routing remains local to this extension session. */
export const createExtension = (options: ExtensionOptions = {}): PiExtension => async (pi: ExtensionAPI) => {
  const config = await (options.load ?? loadProductionConfig)();
  // telemetry remains an intentionally unused, read-only PR 4 seam.
  if (!config.enabled) return;
  let router: EpochRouter | undefined;
  let lastRunFailed = false;
  const current = () => router;
  const status = (ctx: ExtensionContext) => {
    if (config.ui.showStatus && current()) ctx.ui.setStatus("pi-reap", current()!.status());
  };

  pi.registerCommand("effort", {
    description: "Set Pi REAP effort for this session only.",
    handler: async (args, ctx) => { if (current() && parseEffortCommand(`/effort ${args}`, current()!)) status(ctx); },
  });
  pi.on("session_start", (event, ctx) => {
    // A start always replaces all state, including an explicit max override.
    router = new EpochRouter({ resumeReason: event.reason, config });
    lastRunFailed = false;
    status(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    router = undefined;
    lastRunFailed = false;
    if (config.ui.showStatus) ctx.ui.setStatus("pi-reap", undefined);
  });
  pi.on("input", (event) => { current()?.queueInput({ prompt: event.text, source: event.source, ...(event.streamingBehavior ? { streamingBehavior: event.streamingBehavior } : {}) }); });
  pi.on("before_agent_start", (_event, ctx) => { current()?.startQueued(); status(ctx); });
  pi.on("before_provider_request", (event, ctx) => {
    const effort = current()?.onProviderRequest();
    if (effort === undefined || current()?.runtime.mode !== "enforce") return undefined;
    const payload = patchProviderPayload(ctx.model as ProviderModel | undefined, event.payload, effort);
    return payload === event.payload ? undefined : payload;
  });
  pi.on("tool_call", (event, ctx) => { current()?.onToolCall(event.toolName); status(ctx); });
  pi.on("tool_execution_end", (event, ctx) => { if (event.isError) { const before = current()?.effectiveEffort(); current()?.onToolError(); if (config.ui.notifyOnEscalation && before !== undefined && current()?.effectiveEffort() !== before) ctx.ui.notify("Pi REAP raised effort after a tool failure", "warning"); } status(ctx); });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") {
      const failed = event.message.stopReason === "error" || event.message.stopReason === "length";
      lastRunFailed = failed;
      const before = current()?.effectiveEffort(); current()?.onProviderEnd(event.message.stopReason);
      if (failed && config.ui.notifyOnEscalation && before !== undefined && current()?.effectiveEffort() !== before) ctx.ui.notify("Pi REAP raised effort after an assistant failure", "warning");
    }
    status(ctx);
  });
  pi.on("session_compact", (event, ctx) => { current()?.onCompaction(event.reason, event.willRetry); status(ctx); });
  // Pi 0.82.1 agent_settled is fieldless; settle only the recorded terminal result.
  pi.on("agent_settled", (_event, ctx) => { current()?.settle(lastRunFailed); lastRunFailed = false; status(ctx); });
};

export const extension: PiExtension = createExtension();

export default extension;
