import { describe, expect, it, vi } from "vitest";
import { extension } from "../../src/index.js";
import { defaultConfigPaths, loadConfig } from "../../src/config/load.js";
import { ExtensionHarness } from "../integration/extension-harness.js";

class StatefulFakeFileSystem {
  readonly readFile = vi.fn(async (_path: string) => undefined);
  readonly writeFile = vi.fn(async (_path: string, _contents: string) => undefined);
}

describe("PR 1 extension boundary", () => {
  it("does not register an LLM tool or set Pi thinking level", async () => {
    const pi = new ExtensionHarness();
    await extension(pi.api());
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
});
