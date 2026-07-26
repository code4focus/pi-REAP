# Pi REAP Sub-agent Dispatch Policy

**Status:** Normative repository coordination policy

**Scope:** Goal-driven implementation, testing, review, commit, PR, and publication work

**Product effect:** None; this policy does not alter the frozen Pi REAP runtime design

## 1. Objective

Use the root agent's Sol `xhigh` reasoning for orchestration and difficult synthesis while starting bounded worker tasks on Terra. Limit concurrency, require independent review, escalate model and effort only on evidence, and terminate fruitless attempts after one unresolved Sol `xhigh` pass.

## 2. Non-negotiable rules

1. The root coordinator remains `gpt-5.6-sol` at `xhigh`.
2. At most two non-root agents may be live across the complete agent tree.
3. All workers are direct children of the root. Workers must not spawn children.
4. Product edits, tests, reviews, commits, pushes, and PR actions are worker tasks.
5. The root owns decomposition, dispatch, goal state, evidence reconciliation, and escalation decisions.
6. Each product task belongs to exactly one plan section 20 PR slice.
7. A worker may act only inside the scope and mutation authority in its dispatch envelope.
8. An executor may not provide the independent acceptance review of its own work.
9. External mutations remain subject to explicit user authorization.
10. An unresolved `xhigh` attempt is recorded and stopped, not automatically retried.
11. Worker identities are PR-scoped: reuse them within a PR, and treat the next PR as an approved fresh-context boundary.

If the runtime cannot expose the root model or effort, record the `gpt-5.6-sol`/`xhigh` precondition as unverified. Never claim a model setting that was not confirmed.

## 3. Roles and default effort

| Role | Default | Responsibilities | Mutation authority |
| --- | --- | --- | --- |
| Root coordinator | `gpt-5.6-sol` / `xhigh` | Maintain goal ledger, split work, assign ownership, reconcile evidence, decide escalation or blocking | Harness coordination only; no product edits or GitHub publication |
| Execution worker | `gpt-5.6-terra` / `medium` | Implement, test, diagnose routine failures, and address review findings | Assigned paths only |
| Assurance/publication worker | `gpt-5.6-terra` / `high` | Independently review, verify readiness, inspect commits, and perform authorized commit/PR/publication operations | Read-only during review; explicit authorization for mutations |
| Escalation worker | Next unused rung through `gpt-5.6-sol` / `xhigh` | Resolve one evidence-backed problem that defeated the preceding rung | Narrow problem scope only |

The two slots are PR-scoped role leases, not goal-long permanent identities. Reuse each lease holder for related follow-ups throughout one PR while its capability remains sufficient. Replace it when escalation requires a different rung. Release the leases at the PR boundary so the next PR may start with clean context.

## 4. Capacity control

Before every spawn:

1. list the complete live agent tree;
2. count all non-root agents in active or waiting states;
3. confirm that the spawn will keep the count at or below two;
4. check whether the active PR already has a lease holder for the role;
5. confirm that no live worker has overlapping write ownership;
6. queue the task when no safe slot exists.

Do not spawn duplicate agents for the same problem at the same model/effort rung. Do not spawn an agent only to consume the available quota.

Escalation consumes a worker slot. Complete, interrupt, or otherwise retire the prior bounded attempt before starting its higher-effort replacement.

## 5. PR-scoped worker leases

Bind worker reuse to the plan PR slice, not to the entire seven-PR goal.

Maintain this lease state:

```text
plan PR slice:
execution agent:
execution model/effort rung:
assurance agent:
assurance model/effort rung:
lease status: active | released | replaced
replacement reason:
```

Within the same PR:

1. Send implementation, tests, routine fixes, and review corrections to the existing execution agent with `followup_task`.
2. Reuse the existing assurance agent for independent review rounds and authorized publication work.
3. Do not call `spawn_agent` for a new bounded task when a usable lease holder exists at the required rung.
4. If a leased agent is running, queue a related follow-up or send a clarification instead of opening a duplicate.
5. Replace a lease holder only for capability escalation, unrecoverable agent failure, an external-authorization visibility boundary, or explicit user direction.
6. An external-authorization visibility boundary exists only when a reused `fork_turns: "none"` publication agent is rejected because it did not directly inherit the user's explicit approval. Mark that agent unusable for publication, retain its accepted review evidence, and replace only the publication lease at the same model/effort with the smallest bounded turn fork that includes the approval. This is neither a capability escalation nor permission to load full history.
7. When escalation creates a higher-rung executor, transfer the execution lease to it and reuse it for the rest of that PR. Do not spawn a lower-rung replacement merely to downshift.

This reuse preserves the worker's task context and increases the chance that stable prompt prefixes remain cacheable.

At a PR boundary:

1. complete acceptance review and any authorized commit, push, or PR action;
2. record the lease holders and replacements in the PR evidence;
3. release both leases and allow their agents to finish;
4. default to fresh Terra workers with self-contained envelopes for the next PR.

A cross-PR reuse is allowed only when the root records a concrete continuity benefit and confirms that the prior PR context is still relevant and non-interfering. Never carry an agent across PRs merely to avoid a spawn.

## 6. Context routing

Use the hash-pinned packet at `docs/harness/pr-scopes/pr-NN.md` as the normal context boundary for one plan PR.

Resolve it before dispatch:

```text
bash .agents/skills/orchestrate-pi-reap-goal/scripts/resolve_pr_scope.sh <PR-number>
```

The resolver verifies the packet's PR identity and `source_plan_sha256` against the authoritative frozen plan. A missing or stale packet blocks routine dispatch.

| Role | Load normally | Load only on exception | Do not preload |
| --- | --- | --- | --- |
| Root coordinator | `AGENTS.md`, orchestration skill, current declarations/boundary/ledger/blockers from the goal-state record, current packet path/hash | Dispatch-policy section needed for a routing dispute; named plan range for packet repair or dispute; completed-PR evidence or history needed for acceptance | Other PR packets and unrelated history |
| Execution worker | `AGENTS.md`, implementation skill, current packet, task envelope, targeted code/tests | Current packet's named plan range | Full plan, dispatch policy, blocker ledger, other packets |
| Assurance worker | `AGENTS.md`, review skill, current packet, raw diff/evidence, targeted code/tests | Current packet's named plan range | Full plan, dispatch policy, blocker ledger, executor narrative, other packets |
| Publication task | Current packet, PR template, reviewed evidence, exact Git/GitHub state | Required release artifact | Full plan and unrelated harness docs |
| Escalation worker | Current packet, raw failure evidence, targeted code/tests | Exact disputed plan range | Other PR packets and unrelated history |
| PR readiness/final acceptance | Current goal-state record, relevant packet, raw evidence, exact repository/PR state | Exact disputed plan range or blocker record | Unrelated packets and obsolete conversation history |

Pass file paths and hashes in the dispatch envelope; do not paste broad documents into it. Search targeted source paths before opening whole files.

If packet resolution fails:

1. stop routine workers for that PR;
2. create one bounded preparation task that reads only the required authoritative plan ranges;
3. update the packet and current plan hash;
4. rerun the resolver;
5. discard the preparation context and start routine workers with fresh context.

The plan remains authoritative. Hash validation prevents a derived packet from silently surviving a plan change; it does not make the packet a new source of product truth.

Keep `docs/harness/v1-goal-state.md` current as the compact process authority. Record controlling declarations, current PR and leases, accepted conclusions and links, harness optimizations, and blockers. Move completed-PR detail to `docs/harness/pr-evidence/` and chronological events to `docs/harness/v1-goal-history.md`; those files are on-demand evidence, not normal context. Update the current record before dispatching work affected by a new declaration. Do not rely on conversation history as the sole source for an acceptance-relevant decision.

Run `.agents/skills/orchestrate-pi-reap-goal/scripts/check_context_budget.sh` after material harness changes and at every PR boundary. The root may compact or rewrite auto-loaded harness during the goal when doing so reduces context cost without changing authority, frozen semantics, acceptance conclusions, unresolved risks, hashes, or evidence traceability. Prefer removing duplication and splitting on-demand evidence over raising a budget. Never make routine workers load an archive to reconstruct current instructions.

## 7. Dispatch settings

Set model and effort explicitly for every worker:

```text
execution or routine fix:
  agent_type: worker
  model: gpt-5.6-terra
  reasoning_effort: medium

independent review, readiness, commit, or PR:
  agent_type: default
  model: gpt-5.6-terra
  reasoning_effort: high

first reasoning escalation:
  agent_type: worker
  model: gpt-5.6-terra
  reasoning_effort: high

first model escalation:
  agent_type: worker
  model: gpt-5.6-sol
  reasoning_effort: high

terminal escalation:
  agent_type: worker
  model: gpt-5.6-sol
  reasoning_effort: xhigh
```

Use `fork_turns: "none"` or a positive bounded turn count, both of which permit explicit model and effort selection. Never use a full-history fork with an explicit override. Prefer a self-contained task envelope over inheriting the root's full reasoning history.

For an external mutation, a relayed approval is not a substitute for direct user authorization. When authorization is required, use the minimum positive bounded turn fork that includes the latest explicit approval. If an existing `fork_turns: "none"` publication lease is rejected solely for missing directly inherited authorization, apply the same-rung lease-replacement rule in section 5.

## 8. Required dispatch envelope

Every task must state:

```text
goal:
plan PR slice:
scope packet path:
scope packet plan hash:
PR lease role:
role and model/effort:
bounded objective:
owned paths:
read-only or forbidden paths:
prerequisites and input artifacts:
explicit non-scope:
acceptance checks:
allowed mutations:
known failure evidence:
required output:
shared-worktree warning:
child spawning: forbidden
```

Execution tasks must invoke `$implement-pi-reap-pr`. Review tasks must invoke `$review-pi-reap-pr`.

For code-changing workers, state that other agents share the repository and that the worker must preserve and accommodate their edits. For independent review, pass the raw diff, plan slice, and evidence rather than the executor's intended conclusion.

## 9. Worker return contract

Require:

```text
outcome: completed | failed | blocked
summary:
changed paths:
reviewed range:
commands and results:
acceptance criteria: passed | failed | unverified
risks and deferred work:
blocker evidence:
recommended next action:
PR lease recommendation: retain | replace | release
exceptional context loaded:
```

The root must reconcile the report with current repository state before updating the goal ledger. A worker report is evidence, not automatic acceptance.

## 10. Execution and review sequence

For each bounded product task:

1. Dispatch implementation or routine diagnosis to the PR's leased medium execution worker, using `followup_task` after its first task.
2. Reconcile its paths, commands, and acceptance evidence.
3. Dispatch an independent review to the PR's leased high assurance worker.
4. Return ordinary findings to the same leased execution worker.
5. Repeat review only after the findings are materially addressed.
6. Dispatch authorized commit, push, PR, or publication work to the high assurance/publication worker.
7. Mark the task accepted only after its plan gate and independent review both pass.
8. Release the PR leases after requested publication work finishes.

The root may perform read-only inspection needed to reconcile dispatches. It must not silently take over a worker's implementation, review, or publication task.

## 11. Escalation ladder

Escalate only when a bounded, substantive attempt produced evidence and still could not meet its acceptance contract.

Examples of capability failure:

- the agent cannot derive a safe implementation after inspecting the relevant code;
- a relevant test still fails after a reasoned fix attempt;
- the agent finds contradictory technical constraints it cannot reconcile;
- an independent reviewer identifies a correctness problem the assigned level cannot resolve.

The following are not reasoning failures:

- missing user authority or a required decision;
- unavailable credentials, service, network, or hardware;
- a permission denial;
- a prerequisite PR or artifact that does not exist.

Route capability failures as follows:

| Starting lane | Attempt sequence |
| --- | --- |
| Terra medium execution | `Terra medium -> Terra high -> Sol high -> Sol xhigh -> terminal record` |
| Terra high assurance/publication | `Terra high -> Sol high -> Sol xhigh -> terminal record` |

Permit one bounded attempt per problem per model/effort rung. A second attempt at the same rung requires materially new evidence, changed external state, or explicit user direction. Do not disguise the same approach as a new attempt.

Each escalation handoff must include the previous commands, errors, changed paths, rejected hypotheses, remaining question, and acceptance criterion that is still failing. The higher-effort worker should receive evidence, not a mandated solution.

The successful escalation agent inherits the originating execution or assurance lease for the remainder of the PR. Do not revive the replaced lower-rung agent for routine follow-up work in that PR.

## 12. Terminal xhigh handling

If the `gpt-5.6-sol` `xhigh` worker cannot resolve the problem:

1. append a durable entry to `docs/harness/goal-blockers.md`;
2. classify it as `deferred` or `blocking`;
3. stop all further attempts on that problem;
4. free the worker slot;
5. continue only work independent of the record.

Classify a record as `blocking` when every remaining route to a stated goal terminal criterion depends on it. Otherwise classify it as `deferred` and continue, while keeping the affected acceptance criterion unverified or failed.

For a blocking record:

- stop dispatching dependent tasks;
- allow already-running independent tasks to finish when safe;
- leave the goal incomplete;
- set the goal to blocked when the active goal controller's rules permit it;
- state the exact unblock condition.

Do not rerun the technical attempt merely to satisfy a goal-controller recurrence rule. Resume only after new evidence, changed external state, or user direction, and begin a fresh escalation audit for that new state.

## 13. Goal and PR completion

A task is accepted only when:

- its diff stays inside one planned PR slice;
- its required checks have evidence;
- independent high-effort review passes;
- unresolved findings are explicitly deferred and non-blocking;
- authorized Git or GitHub actions have been verified.

The umbrella goal completes only when every stated terminal criterion has live evidence, no blocking record remains, requested PR/publication work is complete, and both worker slots are drained.

Record the worker roles, model/effort levels, task scopes, review result, and any escalation in the PR template. This is process evidence; it does not replace product acceptance evidence.
