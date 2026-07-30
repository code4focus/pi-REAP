# Pi compatibility and fixture upgrades

Pi REAP 1.0 pins both its peer and development dependency to `@earendil-works/pi-coding-agent@0.82.1`, corresponding to upstream commit `cee5ff7520d8828bed9955ef00419e995d1f91e0`. The package metadata also pins the exact CLI, complete runtime graph, and catalog fingerprints exercised by the offline package gate. Do not broaden either range or accept a same-version graph with different bytes.

Before changing that pin, capture each required final request payload from a real Pi session only when an approved privacy-safe capture environment is available. Remove prompts, user content, credentials, cookies, identifiers, and provider secrets. Record the capture's Pi revision and a provenance statement. Never relabel a synthetic fixture as captured.

## Profile candidate and pin workflow

The packaged `profiles/` registry is deliberately candidate-only. Inspect it with `pnpm profile:list`, validate exact source, identity, catalog digest, adapter digest, and Pi `0.82.1` compatibility with `pnpm profile:verify`, and inspect one candidate with `pnpm profile:check -- --id <profile-id>`. A candidate is never an activation or enforcement authority: unknown, stale, digest-mismatched, or source-conflicted profiles preserve the provider baseline.

For a Pi or catalog upgrade, use this exact sequence: upgrade the dependency; resolve the exact catalog/model identity; create a candidate; complete static validation, sanitized replay, representative evaluation, and qualification; obtain human approval; then add a reviewed repository pin for the exact profile ID, revision, profile digest, catalog digest, and adapter digest. Run the release gate last. Do not use model-name ranges or copy provider values across models. This repository does not write Pi settings or routing configuration as part of that process.

Place the sanitized files under `test/fixtures/` and list each one in `final-payload-manifest.json` with `captured-sanitized` provenance. The verifier rejects unknown manifest entries, unknown final-payload shapes, unsupported APIs, and unsanitized sensitive fields. This is intentionally fail-closed: do not upgrade Pi or enable a changed shape until the adapter and fixtures have been reviewed.

Run the following after every candidate upgrade:

```sh
pnpm fixtures:verify
pnpm profile:verify
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm eval:build
pnpm eval:typecheck
pnpm release:check
```

The committed fixtures are explicitly synthetic, sanitized final-payload shape fixtures; they are not captured real Pi requests. Their purpose is regression coverage only, not a claim of live wire behavior.
