# Release and rollback

## Release gate

Run `pnpm release:check` locally. It is the authoritative, non-recursive local gate: fixture verification; root and evaluation builds; lint; both type checks; sample/evaluation gate; full tests; rollback dry-run; and package dry-run all run in that order. The release-gate workflow runs this same command on pull requests, manual dispatches, and version tags.

Signing and publication are external, approved release-environment steps and are deliberately not performed by this repository automation. Before them, review `docs/OPERATIONS.md` for restricted claims; do not convert unavailable cache observations into a pass or promote enforcement by default.

## Pi package installation

The 1.0.0 package declares `pi.extensions: ["./src/index.ts"]`; Pi resource paths are package-root-relative. Pi can load the source entry from local and git packages, while the built `main`, `exports`, and `types` entries are checked before packing.

```sh
pnpm build
pi install -l /absolute/path/to/pi-reap
pi install -l git:github.com/code4focus/pi-REAP@<reviewed-commit>
pi -e /absolute/path/to/pi-reap
```

Use `pi config -l` to enable or disable the installed extension. The local `-e` form is temporary for that Pi invocation; project-local installation uses `.pi/settings.json`, which Pi manages. The extension itself never writes settings or routing configuration.

No tag or published release is created by this work. Replace `<reviewed-commit>` only after reviewing and pinning an actual commit; the local path and `-e` forms above are the immediately exercised installation paths.

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
