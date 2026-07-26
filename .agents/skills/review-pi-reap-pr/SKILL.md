---
name: review-pi-reap-pr
description: Review a Pi REAP change, commit series, or pull request against one hash-validated PR scope packet, its invariants, tests, and acceptance evidence. Use for code review, scope review, PR-readiness checks, regression audits, or completion decisions without loading unrelated plan slices or broad harness context.
---

# Review a Pi REAP PR

Audit one planned slice without expanding or repairing it unless the user also asks for fixes.

## Work as a dispatched assurance agent

When `$orchestrate-pi-reap-goal` dispatched this task:

- do not spawn another agent;
- remain read-only unless the dispatch envelope explicitly assigns a commit, PR, or publication action;
- review the raw diff and acceptance evidence independently of the executor's conclusions;
- never repair findings during the independent review; return them to the root for redispatch;
- remember that other workers share the worktree and never revert their changes;
- report whether each finding blocks the slice or can be deferred.

## Establish minimal review authority

1. Read the root `AGENTS.md`.
2. Identify the review base, head, and PR number from the request, Git state, or PR metadata. Do not scan every scope packet to infer the number.
3. Run `bash .agents/skills/orchestrate-pi-reap-goal/scripts/resolve_pr_scope.sh <PR-number>`.
4. Read only the returned packet, raw diff, acceptance evidence, and targeted source/test files.
5. Extract deliverables, exclusions, acceptance criteria, relevant invariants, and prerequisites from the packet before assessing the code.

Do not read the full plan, dispatch policy, blocker ledger, executor narrative, or another PR packet during routine review. If the resolver fails, report the stale/missing packet as a readiness blocker. Open a packet's on-demand plan range only for a precise ambiguity or dispute and name that exceptional range in the review.

If the diff intentionally spans multiple slices, report that as a scope violation unless the user explicitly changed the frozen delivery sequence.

## Review in risk order

### 1. Packet invariants and failure safety

Check every always-on invariant and current-packet invariant affected by the diff.

Trace failure and unknown-shape paths, not only successful examples.

### 2. Slice boundary and architecture

- Reject behavior from later PR slices, even if presented as convenient plumbing.
- Allow a later-facing type or seam only when the current slice needs it and it introduces no later behavior.
- Check that policy, provider, runtime, telemetry, and evaluation responsibilities remain separated.
- Confirm prerequisite work belongs to the base rather than being hidden in this PR.

Apply the current packet's explicit exclusions and gates; do not import expectations from other PR packets.

### 3. Tests and fixture integrity

Map every packet acceptance criterion to exact test or operational evidence. Require the test type named by the packet rather than substituting a cheaper form of evidence.

Verify that:

- synthetic and captured evidence has truthful provenance;
- captured material is sanitized;
- required real-session, property, corpus, benchmark, or human-review evidence is not replaced by mocks;
- no test or fixture imports behavior from another PR packet.

### 4. Evidence and change hygiene

- Match every completion claim to an exact command, report, fixture, or review artifact.
- Treat absent required evidence as unverified, not passed.
- Check for unrelated changes, mixed-slice commits, generated noise, unsafe data, and plan edits.
- Confirm build, lint, typecheck, test, and slice-specific checks ran when available.

## Report the review

Lead with actionable findings ordered by severity. For each finding, include:

- affected file and line;
- violated plan section, invariant, or slice gate;
- concrete failure mode;
- smallest in-scope correction.

After findings, list:

- target slice and reviewed range;
- acceptance criteria status: passed, failed, or unverified;
- residual risks or missing evidence;
- later-slice work that must remain deferred.

If there are no findings, say so directly but still identify unverified gates and residual testing risk. Do not approve a slice as complete solely because the diff is clean.
