import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProfileBinding } from "../domain/profile.js";
import { readVerifiedProfileRegistry } from "./profile-registry-contract.mjs";

export type RegistryProfileState = "candidate" | "qualified" | "pinned";
export interface ProductionProfileActivation {
  readonly capability: unknown;
  readonly admission: unknown;
  readonly modelCatalogRevision: string;
  readonly modelCatalogDigest: string;
  readonly piVersion: string;
  readonly providerAdapterRevision: string;
  readonly providerAdapterDigest: string;
}

export interface ProfileActivationLoadOptions {
  readonly root?: string;
  readonly registryId?: string;
  readonly bindingDigest?: string;
}

const packageProfilesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../profiles");

/**
 * Read-only production activation selection.  A registry entry is usable only
 * when both independently configured identity pins exactly match it.  This is
 * intentionally a loader, never a writer or an upgrade mechanism.
 */
export async function loadProductionProfileActivation(options: ProfileActivationLoadOptions = {}): Promise<ProductionProfileActivation | undefined> {
  try {
    // Selection arrives from the validated, read-only extension config.  An
    const registryId = options.registryId;
    const bindingDigest = options.bindingDigest;
    if (typeof registryId !== "string" || !registryId || typeof bindingDigest !== "string" || !/^[a-f0-9]{64}$/u.test(bindingDigest)) return undefined;
    const configuredRoot = options.root ?? packageProfilesRoot;
    if (!isAbsolute(configuredRoot) || (await lstat(configuredRoot)).isSymbolicLink()) return undefined;
    const root = await realpath(configuredRoot);
    const { entries } = await readVerifiedProfileRegistry(root);
    const entry = entries.find((candidate) => candidate.id === registryId);
    if (!entry || entry.bindingDigest !== bindingDigest || entry.state === "candidate") return undefined;
    const binding = createProfileBinding(entry.capability, entry.admission);
    if (!binding?.ok) return undefined;
    const match = binding.binding.match;
    return Object.freeze({ capability: entry.capability, admission: entry.admission, modelCatalogRevision: match.modelCatalogRevision, modelCatalogDigest: match.modelCatalogDigest, piVersion: match.piVersion, providerAdapterRevision: match.providerAdapterRevision, providerAdapterDigest: match.providerAdapterDigest });
  } catch { return undefined; }
}
