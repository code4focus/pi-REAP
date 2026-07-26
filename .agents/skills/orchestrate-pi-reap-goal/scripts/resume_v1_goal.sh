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
resume_plan_path="${resume_repo_root}/docs/plan/pi-REAP-v1.0.md"
resume_handoff_path="${resume_repo_root}/docs/harness/v1-continuation.md"
resume_expected_hash="184c964814cd1752b89409fec352cafb11f8b1cffe91b55abb660b34dfb290f6"

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
  printf 'missing frozen plan or continuation record\n' >&2
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
  printf 'frozen plan hash mismatch: expected %s, found %s\n' \
    "$resume_expected_hash" "$resume_actual_hash" >&2
  exit 65
fi

if ! grep -Fqx 'handoff_status: ready' "$resume_handoff_path"; then
  printf 'continuation record is not ready: %s\n' "$resume_handoff_path" >&2
  exit 65
fi

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
resume_pr1_sha="$(git -C "$resume_repo_root" rev-parse --verify origin/pr-01-repository-skeleton 2>/dev/null || true)"

if [[ -z "$resume_main_sha" ]]; then
  printf 'origin/main is unavailable; reconcile remote state manually\n' >&2
  exit 65
fi

printf 'Pi REAP v1 continuation is ready.\n'
printf 'repository: code4focus/pi-REAP\n'
printf 'origin/main: %s\n' "$resume_main_sha"
printf 'PR 1 head: %s\n' "${resume_pr1_sha:-not present; inspect PR #1}"
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
