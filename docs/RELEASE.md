# Release and rollback

## Release gate

Run `pnpm release:check` locally. It verifies the provenance-bound fixture procedure and exercises the release step in dry-run mode. The CI release-gate workflow runs build, lint, type checks, tests, evaluation checks, fixture verification, and the safe release/rollback exercises.

Signing and publication are external, approved release-environment steps and are deliberately not performed by this repository automation. Before them, review `docs/OPERATIONS.md` for restricted claims; do not convert unavailable cache observations into a pass or promote enforcement by default.

## Workflow action provenance

The release gate has least-privilege `contents: read` permission and uses only reviewed immutable action commits. These were verified from the official action repositories with `git ls-remote --tags` on 2026-07-27; the tag commit is used for annotated tags.

| Repository | Version/tag | Immutable commit |
| --- | --- | --- |
| `actions/checkout` | `v4.2.2` | `11bd71901bbe5b1630ceea73d27597364c9af683` |
| `pnpm/action-setup` | `v6.0.9` | `0ebf47130e4866e96fce0953f49152a61190b271` |
| `actions/setup-node` | `v4.2.0` | `1d0ff469b7ec7b3cb9d8673fde0c81c44821de2a` |

## Rollback

1. Select the prior verified artifact and its exact Pi compatibility pin.
2. Run `pnpm rollback:check` and the same mandatory and quality gates used for release.
3. Publish the prior artifact only through the approved external release process.
4. Record the release restriction and any unavailable external observation; do not weaken, skip, or redefine any gate to make rollback succeed.

`pnpm rollback:check` is a local dry-run exercise. It intentionally refuses a non-dry-run invocation so a rollback cannot silently publish or bypass gates.
