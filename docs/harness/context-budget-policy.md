# Harness Context Budget Policy

This file is an on-demand maintenance reference. Routine execution, review, publication, and resume contexts must not preload it.

## Purpose

Keep the coordinator and worker contexts small enough that current instructions, product evidence, and the active PR remain salient throughout the seven-PR goal.

## Auto-loaded budgets

| Surface | Maximum lines | Maximum words |
| --- | ---: | ---: |
| `AGENTS.md` | 140 | 1,800 |
| Orchestration `SKILL.md` | 180 | 2,000 |
| `docs/harness/v1-goal-state.md` | 180 | 2,200 |
| `docs/harness/v1-continuation.md` | 120 | 1,200 |
| One PR scope packet | 90 | 600 |

Run `.agents/skills/orchestrate-pi-reap-goal/scripts/check_context_budget.sh` after material harness changes, before a cross-machine handoff, and at every PR boundary.

## Compaction rules

1. Preserve the frozen plan as product authority; never shorten or rewrite it as context optimization.
2. Keep current declarations, active boundary, compact PR ledger, current leases, unresolved blockers, and evidence links in the goal-state record.
3. Move completed successor-PR detail to `docs/harness/profile-pr-evidence/pr-NN.md`; predecessor evidence remains historical.
4. Move chronological declarations and transitions to `docs/harness/v1-goal-history.md`.
5. Keep the continuation record as a resume index, not a second goal ledger.
6. Remove stale, superseded, or duplicated routing text from auto-loaded files after preserving any acceptance-relevant fact in an on-demand record.
7. Prefer exact paths, hashes, SHAs, and raw artifact links over repeated narrative.
8. Do not raise a budget until duplication and split opportunities have been exhausted.

Compaction is valid only when a new coordinator can recover every current authority, open risk, terminal requirement, and accepted evidence path without loading unrelated history.

## Loading rules

- Routine workers: active role skill, current successor scope packet from `profile-pr-scopes/`, bounded envelope, and targeted code/tests only.
- Root reconciliation: exact current sections plus live state; open archives only for a dispute or final acceptance.
- Final acceptance: load each compact PR evidence file and live PR/commit state, not the chronological archive unless a process dispute requires it.
