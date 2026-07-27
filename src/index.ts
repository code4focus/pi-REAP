import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * PR 1 intentionally exposes only the extension boundary. Routing behavior and
 * provider mutation begin in later planned slices.
 */
export type PiExtension = ExtensionFactory;
export type NoOpExtensionAPI = Pick<ExtensionAPI, "registerTool" | "setThinkingLevel">;

/** Registers no tool and performs no settings I/O. */
export const registerExtension = (pi: NoOpExtensionAPI): void => {
  void pi;
};

export const extension: PiExtension = registerExtension;

export default extension;
