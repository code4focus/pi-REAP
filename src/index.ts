/**
 * PR 1 intentionally exposes only the extension boundary. Routing behavior and
 * provider mutation begin in later planned slices.
 */
export interface PiExtensionHost {
  registerTool(definition: unknown): void;
  setThinkingLevel(level: string): void;
  on(event: string, handler: (...args: readonly unknown[]) => unknown): void;
}

export type PiExtension = (pi: PiExtensionHost) => void;

/** Registers no tool and performs no settings I/O. */
export const extension: PiExtension = (pi) => {
  void pi;
};

export default extension;
