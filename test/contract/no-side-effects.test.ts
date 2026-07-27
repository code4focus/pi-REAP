import { describe, expect, it, vi } from "vitest";
import { createExtension } from "../../src/index.js";
import { defaultConfigPaths, loadConfig } from "../../src/config/load.js";
import { ConfigurationSchema } from "../../src/config/schema.js";
import { Value } from "@sinclair/typebox/value";
import { ExtensionHarness } from "../integration/extension-harness.js";

class StatefulFakeFileSystem {
  readonly readFile = vi.fn(async (_path: string) => undefined);
  readonly writeFile = vi.fn(async (_path: string, _contents: string) => undefined);
}

describe("PR 1 extension boundary", () => {
  it("does not register an LLM tool or set Pi thinking level", async () => {
    const pi = new ExtensionHarness();
    await createExtension({ load: async () => ({ enabled: true, mode: "shadow", ambiguousEffort: "high", failureEffort: "xhigh", telemetry: { enabled: false, includePromptText: false, directory: "synthetic" }, ui: { showStatus: false, notifyOnEscalation: false } }) })(pi.api());
    expect(pi.commands.has("effort")).toBe(true);
  });

  it("reads only effort-router configuration and never settings.json or writes", async () => {
    const fs = new StatefulFakeFileSystem();
    const paths = defaultConfigPaths("/home/synthetic", "/project/synthetic");
    const config = await loadConfig(fs, paths);
    expect(config.mode).toBe("shadow");
    expect(fs.readFile).toHaveBeenCalledTimes(2);
    expect(fs.readFile).toHaveBeenCalledWith("/home/synthetic/.pi/agent/effort-router.json");
    expect(fs.readFile).toHaveBeenCalledWith("/project/synthetic/.pi/effort-router.json");
    expect(fs.readFile.mock.calls.flat()).not.toContain(expect.stringContaining("settings.json"));
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it.each(["global", "project"] as const)("falls back safely when the %s asynchronous configuration read fails", async (failed) => {
    const paths = defaultConfigPaths("/home/synthetic", "/project/synthetic");
    const config = await loadConfig({ readFile: async (path) => {
      if (path === paths[failed]) throw new Error("synthetic read failure");
      return '{"enabled":true,"mode":"enforce","telemetry":{"enabled":true,"includePromptText":false,"directory":"synthetic"},"ui":{"showStatus":false,"notifyOnEscalation":false}}';
    } }, paths);
    expect(config.mode).toBe("shadow");
  });

  it.each([
    '{"enabled":true,"mode":"enforce","extra":true,"telemetry":{"enabled":true,"includePromptText":false,"directory":"synthetic"},"ui":{"showStatus":false,"notifyOnEscalation":false}}',
    '{"enabled":true,"mode":"enforce","telemetry":{"enabled":true,"includePromptText":false,"directory":"synthetic","extra":true},"ui":{"showStatus":false,"notifyOnEscalation":false}}',
    '{"enabled":true,"mode":"enforce","telemetry":{"enabled":true,"includePromptText":false,"directory":"synthetic"},"ui":{"showStatus":false,"notifyOnEscalation":false,"extra":true}}',
  ])("rejects configuration extras at every schema boundary", async (source) => {
    const paths = defaultConfigPaths("/home/synthetic", "/project/synthetic");
    const config = await loadConfig({ readFile: async () => source }, paths);
    expect(config.mode).toBe("shadow");
  });

  it.each(["global", "project"] as const)("does not accept an enforce peer when %s has an extra field", async (invalid) => {
    const paths = defaultConfigPaths("/home/synthetic", "/project/synthetic");
    const clean = '{"enabled":true,"mode":"enforce","telemetry":{"enabled":true,"includePromptText":false,"directory":"synthetic"},"ui":{"showStatus":false,"notifyOnEscalation":false}}';
    const invalidSource = JSON.stringify({ ...JSON.parse(clean) as object, extra: true });
    const config = await loadConfig({ readFile: async (path) => path === paths[invalid] ? invalidSource : clean }, paths);
    expect(config.mode).toBe("shadow");
  });

  it("Value.Check accepts the closed clean shape and rejects old profile/anchor fields", () => {
    const clean = { enabled: true, mode: "shadow", telemetry: { enabled: true, includePromptText: false, directory: "synthetic" }, ui: { showStatus: true, notifyOnEscalation: false } };
    expect(Value.Check(ConfigurationSchema, clean)).toBe(true);
    expect(Value.Check(ConfigurationSchema, { ...clean, profiles: {} })).toBe(false);
    expect(Value.Check(ConfigurationSchema, { ...clean, ambiguousAnchor: "deliberate" })).toBe(false);
    expect(Value.Check(ConfigurationSchema, { ...clean, failureAnchor: "exhaustive" })).toBe(false);
  });
});
