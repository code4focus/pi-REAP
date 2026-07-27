#!/usr/bin/env bash
set -euo pipefail

budget_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
budget_repo_root="$(cd "${budget_script_dir}/../../../.." && pwd)"
budget_failed=false

budget_check_file() {
  local budget_path="$1"
  local budget_max_lines="$2"
  local budget_max_words="$3"
  local budget_label="$4"
  local budget_lines
  local budget_words

  if [[ ! -f "$budget_path" ]]; then
    printf 'missing context surface: %s\n' "$budget_path" >&2
    budget_failed=true
    return
  fi

  budget_lines="$(wc -l < "$budget_path" | tr -d ' ')"
  budget_words="$(wc -w < "$budget_path" | tr -d ' ')"
  printf '%-24s %4s/%-4s lines %5s/%-5s words\n' \
    "$budget_label" "$budget_lines" "$budget_max_lines" "$budget_words" "$budget_max_words"

  if (( budget_lines > budget_max_lines || budget_words > budget_max_words )); then
    printf 'context budget exceeded: %s\n' "$budget_path" >&2
    budget_failed=true
  fi
}

budget_check_file "${budget_repo_root}/AGENTS.md" 140 1800 "AGENTS.md"
budget_check_file \
  "${budget_repo_root}/.agents/skills/orchestrate-pi-reap-goal/SKILL.md" \
  180 2000 "orchestration skill"
budget_check_file \
  "${budget_repo_root}/docs/harness/v1-goal-state.md" \
  180 2200 "goal state"
budget_check_file \
  "${budget_repo_root}/docs/harness/v1-continuation.md" \
  120 1200 "continuation"

shopt -s nullglob
for budget_packet in "${budget_repo_root}"/docs/harness/profile-pr-scopes/pr-*.md; do
  budget_check_file "$budget_packet" 90 600 "$(basename "$budget_packet")"
done

for budget_evidence in "${budget_repo_root}"/docs/harness/profile-pr-evidence/pr-*.md; do
  budget_check_file "$budget_evidence" 240 3000 "$(basename "$budget_evidence") evidence"
done

if [[ "$budget_failed" == true ]]; then
  exit 65
fi
