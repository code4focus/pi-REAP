import { describe, expect, it } from "vitest";
import { ExtensionHarness } from "./extension-harness.js";

describe("typed extension lifecycle harness", () => {
  it("uses Pi-derived lifecycle payloads", () => {
    const harness = new ExtensionHarness();
    expect(() => harness.start()).not.toThrow();
  });
});
