---
name: orchestrate-pi-reap-goal
description: Run Pi REAP goal-driven execution through no more than two direct Terra-first gpt-5.6 sub-agents while the root remains a Sol xhigh coordinator. Resolve hash-pinned PR scope packets to isolate context, reuse PR-scoped workers for follow-up tasks, refresh them at PR boundaries, and escalate only when necessary. Use when launching, continuing, monitoring, or completing the repository goal; routing implementation, review, commit, PR, or publication context; escalating through Terra medium, Terra high, Sol high, and Sol xhigh; or recording a terminal blocker.
---

# Orchestrate the Pi REAP Goal

Coordinate the goal; delegate every execution and assurance task.

## Load the policy

Read these files completely before the first dispatch:

1. `AGENTS.md`
2. `docs/harness/subagent-dispatch-policy.md`

Do not preload the full product plan. Read `docs/harness/goal-blockers.md` only when the goal ledger names an unresolved record or a terminal escalation must be recorded.

## Establish the goal ledger

Confirm that the root is configured as `gpt-5.6-sol` at `xhigh`. If this cannot be inspected, state that the precondition is unverified.

Create or update a task ledger containing:

- active plan PR slice;
- bounded queued, active, review, accepted, deferred, and blocked tasks;
- task dependencies and file ownership;
- acceptance evidence;
- PR-scoped execution and assurance lease holders;
- active agent names, roles, and model/effort rungs;
- unresolved blocker identifiers.

Persist the current ledger in `docs/harness/v1-goal-state.md`. Update that project document whenever the user changes the controlling execution policy, a PR or lease changes state, evidence is accepted, a blocker changes, or the root changes harness behavior. Keep superseded declarations in its history while making the current declaration unambiguous.

Create a platform goal only when the user explicitly asks to launch or create it. Keep an existing goal active until all of its terminal criteria have evidence.

## Route minimal context

At the start of each PR, run:

```text
bash .agents/skills/orchestrate-pi-reap-goal/scripts/resolve_pr_scope.sh <PR-number>
```

Record the returned packet path and its `source_plan_sha256` in the goal ledger. Give routine workers the packet path, not the full plan or dispatch policy. Never load or forward another PR packet.

If resolution fails because the packet is missing or stale:

1. stop routine dispatch for that PR;
2. assign one bounded packet-preparation task that reads only the authoritative plan ranges needed for that PR;
3. update the packet hash and contents;
4. rerun the resolver;
5. end the preparation context and start the execution worker fresh with only the resolved packet.

Permit direct plan reads only for packet repair, an ambiguity the packet explicitly cannot resolve, or an acceptance dispute. Record the exceptional range loaded and why.

Do not send the full goal-state document to routine workers. Require PR-readiness and final-acceptance reviewers to read its current declarations and the relevant PR row so they evaluate against the latest recorded process contract.

## Dispatch within two slots

Before every spawn, list the agent tree and count live non-root agents. Never exceed two and never permit workers to spawn children. Do not fill an idle slot without independent useful work.

Resolve the PR-scoped lease before spawning:

1. Identify the active PR slice and required role.
2. If that PR already has a usable agent at the required model/effort rung, send the next bounded task with `followup_task`; do not spawn.
3. If the leased agent is still running, queue a related follow-up or send a scope clarification; do not create a duplicate.
4. Spawn only when the PR has no lease holder, escalation requires another model/effort rung, the leased agent is unusable, or a new PR begins.
5. When escalation replaces the executor, transfer the PR execution lease to the higher-rung agent and reuse that agent for the remainder of the PR.

Use explicit settings:

- execution: `gpt-5.6-terra`, `medium`, worker role;
- independent review or publication: `gpt-5.6-terra`, `high`;
- escalation: replace the failed attempt at the next unused rung: `gpt-5.6-terra/high`, `gpt-5.6-sol/high`, then `gpt-5.6-sol/xhigh`.

Use `fork_turns: "none"` or a positive bounded turn count and a complete dispatch envelope rather than relying on inherited conversation. Never use a full-history fork when setting an explicit model or effort. Include the goal, plan slice, resolved packet path/hash, task, owned paths, read-only areas, prerequisites, explicit non-scope, acceptance checks, permitted mutations, relevant evidence, and required return format. Tell every worker that the worktree is shared and child spawning is forbidden.

Use `$implement-pi-reap-pr` in execution envelopes and `$review-pi-reap-pr` in assurance envelopes.

At PR acceptance, finish any authorized publication action, release both PR leases, and drain their workers. Default to fresh Terra workers and a self-contained dispatch envelope for the next PR. Reuse across a PR boundary only when the root explicitly records why the old context remains relevant and non-interfering.

## Reconcile results

Require workers to return:

- outcome: completed, failed, or blocked;
- changed or reviewed paths;
- commands and results;
- acceptance criteria status;
- remaining risks;
- blocker evidence when applicable.

Send routine review findings back to the same PR-scoped execution lease holder. Reuse the PR's assurance agent for later review rounds and authorized publication work while preserving its independence from execution. Accept a task only after independent high-effort review and required validation evidence. Delegate authorized commit, push, and PR actions to the assurance/publication lane; the root does not perform them.

## Escalate without churn

Treat a capability failure as a bounded attempt that produced evidence but could not satisfy the task. Do not treat missing permission, unavailable service, or a user decision as a reasoning failure.

Escalate once per capability rung:

```text
Terra medium -> Terra high -> Sol high -> Sol xhigh -> record and stop
Terra high -> Sol high -> Sol xhigh -> record and stop
```

End the previous attempt or free its slot before spawning a replacement. Pass the new agent the raw failure evidence, not a predetermined solution. Do not retry the same problem at the same model/effort rung unless new evidence, external state, or user direction materially changes it.

If `gpt-5.6-sol/xhigh` cannot resolve the problem:

1. append a record to `docs/harness/goal-blockers.md`;
2. stop dispatching work on that problem;
3. continue independent work when the blocker is non-critical;
4. stop dependent work and mark the goal blocked when the blocker prevents terminal completion and the active goal controller permits that status.

Do not manufacture repeated technical attempts to satisfy a goal-controller blocking threshold.

## Finish the goal

Finish only when all requested PR slices and publication actions are complete, independent review has passed, acceptance evidence is recorded, no blocking issue remains, and both worker slots are drained. Report deferred non-blocking records explicitly.
