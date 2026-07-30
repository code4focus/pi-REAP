export interface VerifiedProfileRegistryEntry {
  readonly id: string;
  readonly state: "candidate" | "qualified" | "pinned";
  readonly capability: unknown;
  readonly admission: unknown;
  readonly binding: unknown;
  readonly capabilityDigest: string;
  readonly admissionDigest: string;
  readonly bindingDigest: string;
  readonly match: unknown;
}

export interface VerifiedProfileRegistry {
  readonly root: string;
  readonly entries: readonly VerifiedProfileRegistryEntry[];
}

export class ProfileRegistryContractError extends Error {}
export function readVerifiedProfileRegistry(configuredRoot: string): Promise<VerifiedProfileRegistry>;
