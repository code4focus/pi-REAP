# Pi compatibility and fixture upgrades

Pi REAP 1.0 is pinned to `@earendil-works/pi-coding-agent@0.82.1`, corresponding to upstream commit `cee5ff7520d8828bed9955ef00419e995d1f91e0`. Do not broaden the range.

Before changing that pin, capture each required final request payload from a real Pi session only when an approved privacy-safe capture environment is available. Remove prompts, user content, credentials, cookies, identifiers, and provider secrets. Record the capture's Pi revision and a provenance statement. Never relabel a synthetic fixture as captured.

Place the sanitized files under `test/fixtures/` and list each one in `final-payload-manifest.json` with `captured-sanitized` provenance. The verifier rejects unknown manifest entries, unknown final-payload shapes, unsupported APIs, and unsanitized sensitive fields. This is intentionally fail-closed: do not upgrade Pi or enable a changed shape until the adapter and fixtures have been reviewed.

Run the following after every candidate upgrade:

```sh
pnpm fixtures:verify
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm eval:build
pnpm eval:typecheck
pnpm release:check
```

The committed fixtures are explicitly synthetic, sanitized final-payload shape fixtures; they are not captured real Pi requests. Their purpose is regression coverage only, not a claim of live wire behavior.
