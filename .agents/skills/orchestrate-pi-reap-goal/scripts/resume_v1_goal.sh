#!/usr/bin/env bash
set -euo pipefail

resume_launch=true
resume_fetch=true

resume_usage() {
  printf 'usage: %s [--check] [--no-fetch]\n' "$0" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      resume_launch=false
      ;;
    --no-fetch)
      resume_fetch=false
      ;;
    -h|--help)
      resume_usage
      exit 0
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      resume_usage
      exit 64
      ;;
  esac
  shift
done

resume_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
resume_repo_root="$(cd "${resume_script_dir}/../../../.." && pwd)"
resume_plan_path="${resume_repo_root}/docs/plan/pi-REAP-v1.0-profile-revision.md"
resume_handoff_path="${resume_repo_root}/docs/harness/v1-continuation.md"
resume_expected_hash="5425f588ecc8f2a8a36b81b08a4709eb7249e60b98a0d4c91bc9faac86506de2"

resume_field() {
  local resume_key="$1"
  local resume_count
  resume_count="$(grep -Ec "^${resume_key}: " "$resume_handoff_path" || true)"
  if [[ "$resume_count" != 1 ]]; then
    printf 'continuation field must occur exactly once: %s\n' "$resume_key" >&2
    exit 65
  fi
  sed -n "s/^${resume_key}: //p" "$resume_handoff_path"
}

resume_require_none_metadata() {
  local resume_key
  for resume_key in active_plan_pr active_branch expected_base_ref expected_base_sha expected_head_sha; do
    if [[ "$(resume_field "$resume_key")" != none ]]; then
      printf 'continuation metadata must be none for %s\n' "$resume_execution_mode" >&2
      exit 65
    fi
  done
}

resume_validate_active_ref() {
  local resume_actual_base
  local resume_actual_head
  resume_actual_base="$(git -C "$resume_repo_root" rev-parse --verify "${resume_expected_base_ref}^{commit}" 2>/dev/null || true)"
  resume_actual_head="$(git -C "$resume_repo_root" rev-parse --verify "${resume_active_branch}^{commit}" 2>/dev/null || true)"
  if [[ "$resume_actual_base" != "$resume_expected_base_sha" ]] || \
    [[ "$resume_actual_head" != "$resume_expected_head_sha" ]]; then
    printf 'successor active ref does not match recorded SHA\n' >&2
    exit 65
  fi
  if ! git -C "$resume_repo_root" merge-base --is-ancestor \
    "$resume_expected_base_sha" "$resume_expected_head_sha"; then
    printf 'successor active head is not descended from recorded base\n' >&2
    exit 65
  fi
}

if ! git -C "$resume_repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'not a Git worktree: %s\n' "$resume_repo_root" >&2
  exit 69
fi

resume_remote_url="$(git -C "$resume_repo_root" remote get-url origin 2>/dev/null || true)"
case "$resume_remote_url" in
  git@github.com:code4focus/pi-REAP.git|https://github.com/code4focus/pi-REAP.git|ssh://git@github.com/code4focus/pi-REAP.git)
    ;;
  *)
    printf 'unexpected origin: %s\n' "${resume_remote_url:-missing}" >&2
    exit 65
    ;;
esac

if [[ ! -f "$resume_plan_path" || ! -f "$resume_handoff_path" ]]; then
  printf 'missing successor plan or continuation record\n' >&2
  exit 66
fi

if command -v shasum >/dev/null 2>&1; then
  resume_actual_hash="$(shasum -a 256 "$resume_plan_path" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  resume_actual_hash="$(sha256sum "$resume_plan_path" | awk '{print $1}')"
else
  printf 'no SHA-256 tool available\n' >&2
  exit 69
fi

if [[ "$resume_actual_hash" != "$resume_expected_hash" ]]; then
  printf 'successor plan hash mismatch: expected %s, found %s\n' \
    "$resume_expected_hash" "$resume_actual_hash" >&2
  exit 65
fi

resume_handoff_version="$(resume_field handoff_version)"
resume_handoff_status="$(resume_field handoff_status)"
resume_repository="$(resume_field repository)"
resume_source_plan="$(resume_field source_plan)"
resume_source_hash="$(resume_field source_plan_sha256)"

if [[ "$resume_handoff_version" != 1 ]]; then
  printf 'unsupported continuation handoff version: %s\n' "$resume_handoff_version" >&2
  exit 65
fi

if [[ "$resume_handoff_status" != ready ]]; then
  printf 'continuation record is not ready: %s\n' "$resume_handoff_path" >&2
  exit 65
fi

if [[ "$resume_repository" != code4focus/pi-REAP ]]; then
  printf 'continuation repository identity mismatch: %s\n' "$resume_repository" >&2
  exit 65
fi

if [[ "$resume_source_plan" != docs/plan/pi-REAP-v1.0-profile-revision.md ]] || \
  [[ "$resume_source_hash" != "$resume_expected_hash" ]]; then
  printf 'continuation source identity mismatch: %s\n' "$resume_handoff_path" >&2
  exit 65
fi

resume_goal_status="$(resume_field platform_goal_status)"
resume_execution_mode="$(resume_field execution_mode)"
resume_active_plan_pr="$(resume_field active_plan_pr)"
resume_active_branch="$(resume_field active_branch)"
resume_expected_base_ref="$(resume_field expected_base_ref)"
resume_expected_base_sha="$(resume_field expected_base_sha)"
resume_expected_head_sha="$(resume_field expected_head_sha)"

case "$resume_execution_mode" in
  preparing_profile_revision_packets|final_profile_audit)
    if [[ "$resume_goal_status" != active ]]; then
      printf 'continuation goal status must be active for %s\n' "$resume_execution_mode" >&2
      exit 65
    fi
    resume_require_none_metadata
    resume_active_mode=false
    ;;
  completed_profile_handoff)
    if [[ "$resume_goal_status" != complete ]]; then
      printf 'continuation goal status must be complete for completed handoff\n' >&2
      exit 65
    fi
    resume_require_none_metadata
    resume_active_mode=false
    ;;
  executing_profile_pr_0[1-7]|reviewing_profile_pr_0[1-7]|publishing_profile_pr_0[1-7])
    resume_mode_pr="${resume_execution_mode##*_pr_}"
    if [[ "$resume_goal_status" != active || "$resume_active_plan_pr" != "$resume_mode_pr" ]]; then
      printf 'continuation active PR metadata does not match mode: %s\n' "$resume_execution_mode" >&2
      exit 65
    fi
    if [[ ! "$resume_active_branch" =~ ^origin/.+ ]] || \
      [[ ! "$resume_expected_base_ref" =~ ^origin/.+ ]] || \
      [[ ! "$resume_expected_base_sha" =~ ^[0-9a-f]{40}$ ]] || \
      [[ ! "$resume_expected_head_sha" =~ ^[0-9a-f]{40}$ ]]; then
      printf 'continuation active PR metadata is incomplete or invalid\n' >&2
      exit 65
    fi
    if [[ "$resume_active_branch" == "$resume_expected_base_ref" ]] || \
      [[ "$resume_expected_head_sha" == "$resume_expected_base_sha" ]]; then
      printf 'continuation active PR branch or head must differ from its base\n' >&2
      exit 65
    fi
    resume_active_mode=true
    ;;
  *)
    printf 'unknown successor execution mode: %s\n' "$resume_execution_mode" >&2
    exit 65
    ;;
esac

for resume_pr in 1 2 3 4 5 6 7; do
  bash "${resume_script_dir}/resolve_pr_scope.sh" "$resume_pr" >/dev/null
done

printf 'successor boundary: %s (PR 1-7 packets validated)\n' "$resume_execution_mode"

if [[ -n "$(git -C "$resume_repo_root" status --porcelain)" ]]; then
  printf 'working tree must be clean before cross-machine resume\n' >&2
  git -C "$resume_repo_root" status --short >&2
  exit 65
fi

bash "${resume_script_dir}/check_context_budget.sh"

if [[ "$resume_fetch" == true ]]; then
  git -C "$resume_repo_root" fetch --prune origin
fi

resume_main_sha="$(git -C "$resume_repo_root" rev-parse --verify origin/main 2>/dev/null || true)"
if [[ -z "$resume_main_sha" ]]; then
  printf 'origin/main is unavailable; reconcile remote state manually\n' >&2
  exit 65
fi

if [[ "$resume_active_mode" == true ]]; then
  resume_validate_active_ref
fi

printf 'Pi REAP v1 continuation is ready.\n'
printf 'repository: code4focus/pi-REAP\n'
printf 'origin/main: %s\n' "$resume_main_sha"
printf 'active successor boundary: %s\n' "$resume_execution_mode"
printf 'handoff: %s\n' "$resume_handoff_path"

if [[ "$resume_launch" == false ]]; then
  exit 0
fi

if ! command -v codex >/dev/null 2>&1; then
  printf 'codex CLI is not installed or not on PATH\n' >&2
  exit 69
fi

resume_prompt='Continue the active Pi REAP v1 goal using $orchestrate-pi-reap-goal. Begin with docs/harness/v1-continuation.md and its authoritative loading order. Reconcile live Git/GitHub state before changing the execution record. Keep the platform goal active or recreate/rebind it if this machine has no active goal. Do not load the full plan or any PR packet during initial reconciliation. Resume at the recorded PR boundary, use at most two direct Terra-first sub-agents, preserve all frozen invariants and publication rules, and actively compact or split auto-loaded harness before it exceeds the repository context budgets.'

exec codex \
  -C "$resume_repo_root" \
  -m gpt-5.6-sol \
  -c 'model_reasoning_effort="xhigh"' \
  -s workspace-write \
  -a on-request \
  "$resume_prompt"
