#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s <PR number 1-7>\n' "$0" >&2
  exit 64
fi

scope_raw_pr="${1#PR}"
scope_raw_pr="${scope_raw_pr#pr}"
if [[ ! "$scope_raw_pr" =~ ^0?[1-7]$ ]]; then
  printf 'invalid PR number: %s\n' "$1" >&2
  exit 64
fi

scope_pr_number="$((10#$scope_raw_pr))"
printf -v scope_pr_padded '%02d' "$scope_pr_number"

scope_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scope_repo_root="$(cd "${scope_script_dir}/../../../.." && pwd)"
scope_default_plan="${scope_repo_root}/docs/plan/pi-REAP-v1.0-profile-revision.md"
scope_default_packet_dir="${scope_repo_root}/docs/harness/profile-pr-scopes"
scope_packet_path="${scope_default_packet_dir}/pr-${scope_pr_padded}.md"

if [[ ! -f "$scope_default_plan" ]]; then
  printf 'plan not found: %s\n' "$scope_default_plan" >&2
  exit 66
fi

if [[ ! -f "$scope_packet_path" ]]; then
  printf 'scope packet not found: %s\n' "$scope_packet_path" >&2
  exit 66
fi

if command -v shasum >/dev/null 2>&1; then
  scope_plan_hash="$(shasum -a 256 "$scope_default_plan" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  scope_plan_hash="$(sha256sum "$scope_default_plan" | awk '{print $1}')"
else
  printf 'no SHA-256 tool available\n' >&2
  exit 69
fi

scope_packet_hash="$(sed -n 's/^source_plan_sha256: //p' "$scope_packet_path" | head -n 1)"
if [[ "$scope_packet_hash" != "$scope_plan_hash" ]]; then
  printf 'stale scope packet for PR %s: expected %s, found %s\n' \
    "$scope_pr_number" "$scope_plan_hash" "${scope_packet_hash:-missing}" >&2
  exit 65
fi

if ! grep -Fqx "plan_pr: ${scope_pr_number}" "$scope_packet_path"; then
  printf 'scope packet PR identity mismatch: %s\n' "$scope_packet_path" >&2
  exit 65
fi

if ! grep -Fqx 'scope_packet_version: 1' "$scope_packet_path"; then
  printf 'unsupported scope packet version: %s\n' "$scope_packet_path" >&2
  exit 65
fi

if ! grep -Fqx 'source_plan: docs/plan/pi-REAP-v1.0-profile-revision.md' "$scope_packet_path"; then
  printf 'scope packet source identity mismatch: %s\n' "$scope_packet_path" >&2
  exit 65
fi

printf '%s\n' "$scope_packet_path"
