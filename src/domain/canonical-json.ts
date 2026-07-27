import { createHash } from "node:crypto";

export type CanonicalData =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalData[]
  | { readonly [key: string]: CanonicalData };

export type CanonicalFailureReason =
  | "unsupported-type"
  | "unsupported-number"
  | "unsupported-prototype"
  | "unsupported-property"
  | "sparse-array"
  | "cycle"
  | "resource-limit"
  | "inspection-failed"
  | "hash-failed";

export type CanonicalResult =
  | { readonly ok: true; readonly canonical: string }
  | { readonly ok: false; readonly reason: CanonicalFailureReason };

export type DigestResult =
  | { readonly ok: true; readonly digest: string }
  | { readonly ok: false; readonly reason: CanonicalFailureReason };

const MAX_DEPTH = 100;
const MAX_NODES = 100_000;

/** Canonicalizes only closed JSON-like data and never throws. */
export function canonicalJson(value: unknown): CanonicalResult {
  try {
    return canonicalize(value, new Set<object>(), { nodes: 0 }, 0);
  } catch {
    return { ok: false, reason: "inspection-failed" };
  }
}

/** Hashes canonical data and returns a typed failure for every rejected input. */
export function canonicalProfileDigest(value: unknown): DigestResult {
  const canonical = canonicalJson(value);
  if (!canonical.ok) return canonical;
  try {
    return { ok: true, digest: createHash("sha256").update(canonical.canonical).digest("hex") };
  } catch {
    return { ok: false, reason: "hash-failed" };
  }
}

function canonicalize(
  value: unknown,
  active: Set<object>,
  budget: { nodes: number },
  depth: number,
): CanonicalResult {
  budget.nodes += 1;
  if (depth > MAX_DEPTH || budget.nodes > MAX_NODES) return { ok: false, reason: "resource-limit" };
  if (value === null) return { ok: true, canonical: "null" };
  if (typeof value === "boolean") return { ok: true, canonical: value ? "true" : "false" };
  if (typeof value === "string") return { ok: true, canonical: JSON.stringify(value) };
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) return { ok: false, reason: "unsupported-number" };
    return { ok: true, canonical: JSON.stringify(value) };
  }
  if (typeof value !== "object") return { ok: false, reason: "unsupported-type" };
  if (active.has(value)) return { ok: false, reason: "cycle" };
  active.add(value);
  const result = Array.isArray(value)
    ? canonicalizeArray(value, active, budget, depth)
    : canonicalizeRecord(value, active, budget, depth);
  active.delete(value);
  return result;
}

function canonicalizeArray(
  value: unknown[],
  active: Set<object>,
  budget: { nodes: number },
  depth: number,
): CanonicalResult {
  if (Object.getPrototypeOf(value) !== Array.prototype) return { ok: false, reason: "unsupported-prototype" };
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return { ok: false, reason: "unsupported-property" };
  const allowed = new Set<string>(["length"]);
  for (let index = 0; index < value.length; index += 1) allowed.add(String(index));
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    return { ok: false, reason: "unsupported-property" };
  }
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) return { ok: false, reason: "sparse-array" };
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      return { ok: false, reason: "unsupported-property" };
    }
    const item = canonicalize(descriptor.value, active, budget, depth + 1);
    if (!item.ok) return item;
    parts.push(item.canonical);
  }
  return { ok: true, canonical: `[${parts.join(",")}]` };
}

function canonicalizeRecord(
  value: object,
  active: Set<object>,
  budget: { nodes: number },
  depth: number,
): CanonicalResult {
  if (Object.getPrototypeOf(value) !== Object.prototype) return { ok: false, reason: "unsupported-prototype" };
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return { ok: false, reason: "unsupported-property" };
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const parts: string[] = [];
  for (const key of (keys as string[]).sort()) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      return { ok: false, reason: "unsupported-property" };
    }
    const item = canonicalize(descriptor.value, active, budget, depth + 1);
    if (!item.ok) return item;
    parts.push(`${JSON.stringify(key)}:${item.canonical}`);
  }
  return { ok: true, canonical: `{${parts.join(",")}}` };
}
