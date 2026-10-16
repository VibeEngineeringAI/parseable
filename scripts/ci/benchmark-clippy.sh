#!/usr/bin/env bash
set -euo pipefail

# Each invocation owns its checkout: cargo-hack temporarily rewrites Cargo.toml
# and Cargo.lock to remove dev dependencies, so these commands cannot use --locked.
# Baseline Clippy seconds: all=147, base-hotpath=98+32, features=31+32+31+30.
args=(clippy --verbose --no-dev-deps)
case "${1:-}" in
  all)
    args+=(--all-features)
    ;;
  base-hotpath)
    args+=(--each-feature --exclude-features debug,hotpath-alloc,hotpath-cpu,kafka
      --exclude-all-features)
    ;;
  features)
    args+=(--each-feature --include-features debug,hotpath-alloc,hotpath-cpu,kafka
      --exclude-all-features --exclude-no-default-features)
    ;;
  *)
    echo 'Usage: benchmark-clippy.sh {all|base-hotpath|features} [--print-command-list]' >&2
    exit 2
    ;;
esac
if [[ "${2:-}" == --print-command-list && $# == 2 ]]; then
  args+=(--print-command-list)
elif (( $# != 1 )); then
  echo 'Unexpected arguments' >&2
  exit 2
fi
exec cargo hack "${args[@]}" -- -D warnings
