## Planned slice

- Plan PR: `PR N: <name from the resolved scope packet>`
- Depends on:
- Review range:

## Scope

- Deliverables:
- Plan sections implemented:

## Explicit non-scope

- Deferred plan slices:
- Intentionally excluded behavior:

## Goal dispatch evidence

Complete this section when the PR was produced by goal-driven execution.

| Role | Agent/task | Model and effort | Scope | Result |
| --- | --- | --- | --- | --- |
| Execution |  | `gpt-5.6-terra` / `medium` |  |  |
| Independent review |  | `gpt-5.6-terra` / `high` |  |  |
| Escalation, if any |  |  |  |  |

- Terminal blocker records:
- Unverified root `gpt-5.6-sol` / `xhigh` precondition, if applicable:
- Execution lease reused for this PR:
- Assurance lease reused for this PR:
- Lease replacements and reasons:
- Cross-PR reuse, justification, and context-interference assessment:
- Scope packet path and plan hash:
- Exceptional plan ranges or broad harness context loaded:
- Goal-state record revision/date reviewed:

## Frozen invariant check

- [ ] Initial effort is decided before the first provider request.
- [ ] Routing remains invisible to prompts, messages, tools, and history.
- [ ] Effort is request-local; `setThinkingLevel()` is not called.
- [ ] Supported payloads differ only at `reasoning.effort`.
- [ ] Effort never decreases within an epoch; independent settled work can reset.
- [ ] Unknown, invalid, unsupported, or conflicted input preserves the baseline.
- [ ] `max` is enabled only by an explicit session command.
- [ ] No LLM-callable routing tool or settings/config write was introduced.
- [ ] Telemetry excludes prompt text by default.
- [ ] Not applicable items are explained below.

Invariant notes:

## Acceptance evidence

| Check or plan criterion | Command or artifact | Result |
| --- | --- | --- |
| Targeted tests |  |  |
| Build |  |  |
| Lint |  |  |
| Typecheck |  |  |
| Full test suite |  |  |
| Slice-specific gate |  |  |

Unverified criteria and reason:

## Fixtures, telemetry, and data safety

- [ ] Fixtures are synthetic and labelled, or captured from Pi and sanitized.
- [ ] No prompt text, secret, identifier, or user content was added.
- [ ] Required real-session, corpus, benchmark, or human-review gates are backed by real evidence or marked unverified.

## Commit and review hygiene

- [ ] Commits are coherent and limited to this planned slice.
- [ ] The diff contains no unrelated cleanup or later-slice behavior.
- [ ] Prerequisite work is present in the base, not hidden in this PR.
- [ ] No checks or hooks were bypassed.
- [ ] `$review-pi-reap-pr` findings are resolved or recorded below.

## Residual risk and follow-up

- Known risks:
- Deferred follow-up:
- Review findings intentionally not addressed:
