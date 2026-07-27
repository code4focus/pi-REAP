# Live-acceptance fingerprints

`sourceFingerprint` is SHA-256 over the canonical JSON source manifest emitted
by `scripts/reproduce-live-fingerprints.mjs`; its ordered fixed list is the
extension routing, policy, provider, and domain implementation files. The pin
module is deliberately excluded to avoid a self-hashing cycle.

`extensionBuildFingerprint` uses the same construction over the corresponding
`dist/` runtime JavaScript artifacts after `pnpm build`. It excludes `dist/eval`
and all evaluation acceptance constants, so attestation material cannot affect
the runtime build fingerprint. Reproduce both with:

`pnpm build && node scripts/reproduce-live-fingerprints.mjs .`

The in-process acceptance API consumes the pinned one-time challenge only after
all signature, binding, time, and ceiling checks pass. A second successful-use
attempt in that process is rejected as a replay. The coordinator must durably
record the receipt/artifact hashes; private-key destruction completes
cross-process consumption. An identical receipt/hash is idempotent evidence,
never a new acceptance.
