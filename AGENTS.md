# Pi REAP Repository Instructions

## Authority and scope

These instructions apply to the entire repository.

Treat `docs/plan/pi-REAP-v1.0.md` as the frozen product and delivery contract. For routine work, consume its relevant requirements through the hash-validated current PR scope packet; read the plan directly only under the context-routing exceptions below. Do not silently reinterpret a frozen requirement. If an explicit user instruction changes the plan, call out the deviation and its effect on the planned PR sequence.

## Product invariants

Preserve these rules in every change:

1. Decide the initial effort before the first provider request.
2. Keep routing policy out of prompts, messages, tool descriptions/results, and conversation history.
3. Apply effort request-locally through `before_provider_request`; never call `pi.setThinkingLevel(...)`.
4. Change only `reasoning.effort` in a supported provider payload. Preserve the complete request otherwise, including cache-related and reasoning-context fields.
5. Never lower effort within one task epoch. A settled independent task may start a new lower-effort epoch.
6. Leave unsupported, unknown, invalid, or conflicted requests unchanged.
7. Never select `max` automatically; only a local session command may enable it.
8. Register Pi-local commands only, never an LLM-callable routing tool.
9. Never write Pi settings or effort-router configuration. Do not persist prompt text in telemetry unless the user explicitly opts in.

## One planned PR at a time

Implement the seven slices in section 20 of the plan in order. Treat each slice as a scope boundary even when no GitHub PR exists yet:

1. Repository skeleton and contract tests.
2. Provider patch layer. Do not add classifier behavior.
3. Epoch runtime and deterministic policy.
4. Telemetry and shadow mode.
5. Evaluation harness.
6. Conservative enforcement.
7. Version 1.0 hardening.

Do not mix a later slice into the current one for convenience. Small interfaces or test seams needed by the current slice are acceptable; behavior, configuration, or rollout belonging to a later slice is not. Verify earlier slices still satisfy their acceptance criteria before building on them.

Use `$implement-pi-reap-pr` for implementation work and `$review-pi-reap-pr` for review or readiness audits.

## Context routing

Route routine work through the current PR scope packet instead of preloading broad harness material.

1. Resolve the packet with `bash .agents/skills/orchestrate-pi-reap-goal/scripts/resolve_pr_scope.sh <PR-number>`.
2. Give a worker only `AGENTS.md`, its role skill, the resolved packet, the bounded task envelope, and targeted source/test files.
3. Do not preload the full frozen plan, the full dispatch policy, the blocker ledger, or another PR packet into a routine execution, review, or publication worker.
4. Open only the on-demand plan ranges named by the current packet, and only when the packet lacks an exact semantic needed by the task.
5. If the resolver reports a missing or stale packet, stop routine dispatch. Prepare that packet once from the authoritative plan, validate it, then start the PR worker with a fresh context that loads only the packet.

Pass packet paths and hashes by reference. Do not paste large harness documents into dispatch envelopes.

Maintain `docs/harness/v1-goal-state.md` as the durable current execution record. Update it after a controlling user declaration, goal-state change, PR transition, worker-lease replacement, escalation, blocker decision, acceptance result, or material harness optimization. Routine execution workers must not preload it; PR-readiness and final-acceptance reviewers must read its latest current-declarations and relevant PR evidence.

Actively control context size throughout the goal. Compact auto-loaded harness and current-state files when they approach the repository budgets, move completed-PR evidence and historical events to on-demand files, and remove stale routing text. Compaction must preserve current authority, acceptance evidence, hashes, and links; it may not silently weaken policy or product semantics. Run `.agents/skills/orchestrate-pi-reap-goal/scripts/check_context_budget.sh` after material harness changes and at every PR boundary.

For a cross-machine handoff, treat `docs/harness/v1-continuation.md` as the compact resume index and run `.agents/skills/orchestrate-pi-reap-goal/scripts/resume_v1_goal.sh`. Reconcile its pinned facts with live Git/GitHub state before resuming. Do not use the handoff as product authority or preload unrelated packets.

## Goal-driven sub-agent execution

For goal-driven execution, invoke `$orchestrate-pi-reap-goal` and follow `docs/harness/subagent-dispatch-policy.md`.

- Keep the root coordinator on `gpt-5.6-sol` at `xhigh`. If runtime metadata cannot confirm that setting, report it as an unverified precondition instead of claiming it.
- Allow at most two live non-root agents across the entire agent tree. Spawn them directly from the root and forbid them from spawning children.
- Start implementation, test, and routine fix tasks with `gpt-5.6-terra` at `medium`. Start independent review, readiness, commit, PR, and publication tasks with `gpt-5.6-terra` at `high`.
- Treat each worker assignment as a PR-scoped lease. Within one PR, reuse the same execution agent through `followup_task` while its model/effort remains sufficient and the agent is usable; do not spawn a replacement merely because the next bounded task started.
- If a reused `fork_turns: "none"` publication agent cannot satisfy an external authorization check because it did not directly inherit the user's approval, treat that agent as unusable for publication. Replace only that PR's publication lease at the same model/effort with the smallest bounded turn fork that includes the explicit approval, record the replacement, and never load full history for this purpose.
- Treat a PR transition as a context boundary. After the current PR is accepted and its requested publication work finishes, release its worker leases and default to fresh workers for the next PR so stale context does not interfere.
- Keep the root focused on goal state, decomposition, dispatch, evidence reconciliation, and escalation decisions. Delegate product edits, test execution, review, commits, and PR operations to workers.
- Escalate an unresolved bounded problem one capability rung at a time: `Terra medium` to `Terra high` to `Sol high` to `Sol xhigh`, or start at the first rung appropriate to the role. Do not repeat the same model/effort attempt without materially new evidence.
- Treat an unresolved `xhigh` attempt as terminal for the current evidence. Record it in `docs/harness/goal-blockers.md`, stop retrying it, and either continue around it or block the goal when it prevents further progress.

This coordination policy is repository harness behavior, not a product feature or acceptance claim for any section 20 PR slice.

## Change workflow

Before editing:

1. Inspect the worktree and preserve user-owned changes.
2. Identify exactly one planned PR slice.
3. Extract that slice's deliverables, explicit exclusions, and acceptance criteria from the plan.
4. Identify the plan-wide invariants exercised by the change.

While editing:

- Keep policy, provider adaptation, runtime state, telemetry, and evaluation separated according to the plan's module layout.
- Add contract or regression coverage with behavior changes.
- Prefer typed, faithful lifecycle and payload fixtures over permissive `any`-based mocks.
- Label synthetic fixtures as synthetic. Do not present a fabricated payload as a captured real Pi request.
- Keep captured fixtures sanitized and free of prompt text, secrets, identifiers, and user content.
- Do not edit the frozen plan unless the user explicitly requests a plan revision.

Before handoff:

- Run the current slice's targeted tests and every available repository-wide `build`, `lint`, `typecheck`, and `test` check.
- Report exact commands and results. Mark a criterion unverified when its required environment or corpus is unavailable.
- Do not describe a slice as complete or PR-ready while a required acceptance criterion lacks evidence.
- Recheck that the diff contains no later-slice behavior or unrelated cleanup.

## Commits and pull requests

Do not commit, push, rewrite history, or open/update a PR unless the user asks.

When asked:

- Keep every commit coherent and within one planned PR slice. Separate unrelated refactors, generated artifacts, and follow-up work.
- Stage exact paths after reviewing the diff; never discard or absorb unrelated user changes.
- Use an imperative commit subject that describes the delivered contract, not a vague progress label.
- Do not bypass repository hooks or checks.
- Title the PR with its planned slice, for example `PR 2: Provider patch layer`.
- Use `.github/pull_request_template.md`. State scope, explicit non-scope, invariant impact, acceptance evidence, and residual risk.
- Base each PR on the accepted prerequisite slice. Do not hide prerequisite work in the current PR.
