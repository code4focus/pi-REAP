---
name: implement-pi-reap-pr
description: Implement one bounded Pi REAP PR slice from its hash-validated scope packet, including code, tests, validation evidence, commit preparation, or pull-request preparation. Use for requests to build, change, fix, continue, commit, or prepare one planned PR without loading unrelated plan slices or broad harness context.
---

# Implement a Planned Pi REAP PR

Implement exactly one plan slice and leave an evidence-backed handoff.

## Work as a dispatched executor

When `$orchestrate-pi-reap-goal` dispatched this task:

- stay within the assigned files, slice, and acceptance contract;
- do not spawn another agent;
- remember that other workers share the worktree and never revert their changes;
- report blockers with commands, errors, attempted approaches, and the smallest unresolved question;
- return changed paths and exact validation evidence to the root coordinator;
- do not perform the independent review of your own work;
- commit, push, or open/update a PR only when the dispatch envelope explicitly authorizes it.

## Load the minimal slice contract

1. Read the root `AGENTS.md`.
2. Obtain the PR number from the dispatch envelope, branch/PR metadata, or explicit user request. Do not scan every scope packet to infer it.
3. Run `bash .agents/skills/orchestrate-pi-reap-goal/scripts/resolve_pr_scope.sh <PR-number>`.
4. Read only the returned packet, the bounded task envelope, and targeted source/test files.
5. Inspect the worktree before deciding what is missing.
6. Extract deliverables, exclusions, acceptance criteria, relevant invariants, ownership, and prerequisite evidence from the packet.

Do not read the full plan, dispatch policy, blocker ledger, or another PR packet during routine work. If the resolver fails, return the stale/missing-packet evidence to the root instead of bypassing it. Open a packet's on-demand plan range only when exact semantics are absent or disputed, and report the exceptional range in the handoff.

## Implement within the boundary

- Preserve the always-on invariants in `AGENTS.md` and the current packet, including on failure paths.
- Implement only the packet's deliverables and assigned paths.
- Follow the ownership and module separation in the current packet.
- Add the test types and acceptance coverage required by the packet.
- Apply fixture provenance, sanitization, fidelity, property testing, corpus, or real-session requirements only when the packet names them.
- Stop at a test seam or interface when behavior belongs to an excluded or later packet.

## Validate and reconcile

1. Run focused tests while iterating.
2. Run all available `build`, `lint`, `typecheck`, and `test` checks before handoff.
3. Run the current packet's acceptance checks.
4. Re-read the diff against the working contract.
5. Report each acceptance criterion as passed, failed, or unverified, with the exact supporting command or artifact.

Do not substitute a unit test for a required real-session, corpus, cache-crossover, or human-review gate. Do not claim release savings from token counts alone.

## Prepare commits or a PR

Only create commits, push, or open/update a PR when the user asks.

Before a commit:

- inspect the full diff and status;
- stage only current-slice files;
- keep the commit semantically coherent;
- use an imperative subject describing the contract delivered;
- run relevant checks without bypassing hooks.

Before a PR:

- confirm its base contains the prerequisite slice;
- title it `PR N: <plan slice name>`;
- complete `.github/pull_request_template.md`;
- name explicit non-scope and deferred slices;
- include exact acceptance evidence and mark missing gates unverified;
- invoke `$review-pi-reap-pr` for a readiness pass when requested.
