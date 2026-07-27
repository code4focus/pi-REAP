import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const piCodingAgentPackageName = "@earendil-works/pi-coding-agent";
export const piAiPackageName = "@earendil-works/pi-ai";
export const piAgentCorePackageName = "@earendil-works/pi-agent-core";
export const expectedPiVersion = "0.82.1";
export const expectedPiExecutableSha256 = "af302f231437eaf6f37691bce4b34234fcb626bcb5eb3910d4fc3f6519bf78ca";
export const expectedPiRuntimeGraphSha256 = "fe2469ef9584883f9ea8b36d7f13d55f907ec4fd904663d38c2978d107bd2bc3";
export const expectedPiCatalogSha256 = "c3313710bc6910e6bbcb06d5867247e97ec3fa6c2af9bc780f8a3eefb03e32e1";

export const piRuntimeManifest = [
  "package.json", "dist/index.js", "dist/core/sdk.js", "dist/core/agent-session.js", "dist/core/model-runtime.js",
  "dist/core/resource-loader.js", "dist/core/settings-manager.js", "dist/core/session-manager.js",
  "dist/core/extensions/loader.js", "dist/core/extensions/runner.js", "dist/core/auth-storage.js",
  "node_modules/@earendil-works/pi-agent-core/dist/agent.js", "node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js",
  "node_modules/@earendil-works/pi-ai/dist/models.js", "node_modules/@earendil-works/pi-ai/dist/auth/resolve.js",
  "node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js", "node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js",
] as const;

export interface StrictPiGraph {
  readonly graphRoot: string;
  readonly codingAgentRoot: string;
  readonly piAiRoot: string;
  readonly piAgentCoreRoot: string;
  readonly codingAgentPackageJsonPath: string;
  readonly cliPath: string;
  readonly catalogPath: string;
  readonly responsesSharedPath: string;
  readonly piExecutableSha256: string;
  readonly piRuntimeGraphSha256: string;
  readonly piCatalogSha256: string;
}

export interface StrictPiGraphOptions {
  readonly graphRoot: string;
  readonly codingAgentRoot?: string;
}

interface ValidatedPackage {
  readonly root: string;
  readonly manifest: Record<string, unknown>;
  readonly manifestPath: string;
}

/**
 * Resolves and authenticates exactly the package graph that Node/Pi will use.
 * This function is read-only and has no auth, SDK, provider, or import effects.
 */
export function resolveStrictPiGraph(options: StrictPiGraphOptions): StrictPiGraph {
  const graphLexical = resolve(options.graphRoot);
  const graphInfo = lstatSync(graphLexical);
  if (graphInfo.isSymbolicLink() || !graphInfo.isDirectory()) {
    throw new Error("clean package graph root is symlinked or not a directory");
  }
  const graphRoot = realpathSync(graphLexical);
  const contained = (path: string): boolean => {
    const rel = relative(graphRoot, path);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };

  const regularFile = (packageRoot: string, relativePath: string, label: string, executable = false): string => {
    const path = resolve(packageRoot, relativePath);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`clean package graph ${label} is not an exact regular contained file`);
    }
    const actual = realpathSync(path);
    if (!contained(actual) || (executable && (info.mode & 0o111) === 0)) {
      throw new Error(`clean package graph ${label} is not an exact regular contained file`);
    }
    return actual;
  };

  const packageRoot = (lexical: string, name: string): ValidatedPackage => {
    lstatSync(lexical);
    const root = realpathSync(lexical);
    if (!contained(root)) {
      throw new Error(`clean package graph dependency escapes by symlink: ${name}`);
    }
    const info = lstatSync(root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`clean package graph dependency root is invalid: ${name}`);
    }
    const manifestPath = regularFile(root, "package.json", `manifest for ${name}`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    if (manifest.name !== name || manifest.version !== expectedPiVersion) {
      throw new Error(`clean package graph contains an incompatible dependency: ${name}`);
    }
    return Object.freeze({ root, manifest, manifestPath });
  };

  const packageRootIfPresent = (lexical: string, name: string): ValidatedPackage | undefined => {
    try {
      lstatSync(lexical);
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
    // The preferred Node/Pi path exists. Every subsequent error is terminal:
    // falling back would validate a different package than the runtime selects.
    return packageRoot(lexical, name);
  };

  const coding = packageRoot(
    options.codingAgentRoot ?? join(graphRoot, piCodingAgentPackageName),
    piCodingAgentPackageName,
  );
  const bin = coding.manifest.bin as Record<string, unknown> | undefined;
  if (bin?.pi !== "dist/cli.js") {
    throw new Error("clean package graph Pi bin binding is incompatible");
  }

  const dependency = (name: string): ValidatedPackage => {
    const leaf = name.split("/").at(-1);
    if (!leaf) throw new Error(`invalid dependency ${name}`);
    const nested = packageRootIfPresent(join(coding.root, "node_modules", name), name);
    if (nested) return nested;
    const sibling = packageRootIfPresent(join(dirname(coding.root), leaf), name);
    if (sibling) return sibling;
    throw new Error(`clean package graph dependency is absent or invalid: ${name}`);
  };

  const piAi = dependency(piAiPackageName);
  const piAgentCore = dependency(piAgentCorePackageName);
  const piAiPrefix = `node_modules/${piAiPackageName}/`;
  const piAgentCorePrefix = `node_modules/${piAgentCorePackageName}/`;
  const fingerprintRows = piRuntimeManifest.map((file) => {
    const selected = file.startsWith(piAiPrefix)
      ? [piAi.root, file.slice(piAiPrefix.length)] as const
      : file.startsWith(piAgentCorePrefix)
        ? [piAgentCore.root, file.slice(piAgentCorePrefix.length)] as const
        : [coding.root, file] as const;
    return Object.freeze({ file, sha256: digestFile(regularFile(selected[0], selected[1], file)) });
  });
  const cliPath = regularFile(coding.root, "dist/cli.js", "Pi CLI", true);
  const catalogPath = regularFile(piAi.root, "dist/providers/data/openai-codex.json", "Pi catalog");
  const responsesSharedPath = regularFile(piAi.root, "dist/api/openai-responses-shared.js", "Pi Responses parser");
  const piExecutableSha256 = digestFile(cliPath);
  const piRuntimeGraphSha256 = createHash("sha256").update(JSON.stringify(fingerprintRows)).digest("hex");
  const piCatalogSha256 = digestFile(catalogPath);
  if (
    piExecutableSha256 !== expectedPiExecutableSha256 ||
    piRuntimeGraphSha256 !== expectedPiRuntimeGraphSha256 ||
    piCatalogSha256 !== expectedPiCatalogSha256
  ) {
    throw new Error("clean package graph is fabricated or differs from the exact Pi 0.82.1 runtime");
  }
  return Object.freeze({
    graphRoot,
    codingAgentRoot: coding.root,
    piAiRoot: piAi.root,
    piAgentCoreRoot: piAgentCore.root,
    codingAgentPackageJsonPath: coding.manifestPath,
    cliPath,
    catalogPath,
    responsesSharedPath,
    piExecutableSha256,
    piRuntimeGraphSha256,
    piCatalogSha256,
  });
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function digestFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
