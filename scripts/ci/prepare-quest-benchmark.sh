#!/usr/bin/env bash
set -euo pipefail

# Prepare an experimental Quest checkout whose fixed persistence sleeps are
# replaced by bounded readiness waits (see quest-readiness.patch). Fails closed:
# the checkout must be exactly the pinned upstream commit with no local changes,
# and the patch must apply cleanly in full.
#
#   prepare-quest-benchmark.sh [--clone] [--verify] QUEST_DIR
#
#   --clone   fetch the pinned commit into QUEST_DIR (must not exist yet)
#   --verify  also run gofmt, go vet, the readiness unit tests and the hermetic
#             harness in quest-benchmark-tests/ (needs Go >= 1.21 on PATH)
#
# Afterwards build the experimental image with Quest's own Dockerfile, e.g.
#   docker build -t quest:readiness QUEST_DIR

readonly QUEST_REPO=https://github.com/parseablehq/quest.git
readonly QUEST_SHA=f4a026eecde1badde8776ff366a743f9bbca2e67

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly patch="$script_dir/quest-readiness.patch"
readonly harness="$script_dir/quest-benchmark-tests/readiness_harness_test.go"

die() {
  echo "prepare-quest-benchmark: $*" >&2
  exit 1
}

clone=false
verify=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --clone) clone=true ;;
    --verify) verify=true ;;
    --) shift; break ;;
    -*) die "unknown option: $1" ;;
    *) break ;;
  esac
  shift
done
[ "$#" -eq 1 ] || die "usage: $0 [--clone] [--verify] QUEST_DIR"
quest_dir=$1
[ -f "$patch" ] || die "missing $patch"

if "$clone"; then
  [ ! -e "$quest_dir" ] || die "$quest_dir already exists; refusing to --clone over it"
  git init --quiet "$quest_dir"
  git -C "$quest_dir" remote add origin "$QUEST_REPO"
  git -C "$quest_dir" fetch --quiet --depth 1 origin "$QUEST_SHA"
  git -C "$quest_dir" -c advice.detachedHead=false checkout --quiet FETCH_HEAD
fi

[ -d "$quest_dir" ] || die "$quest_dir does not exist"
quest_dir=$(cd "$quest_dir" && pwd)
q() { git -C "$quest_dir" "$@"; }

[ "$(q rev-parse --show-toplevel 2>/dev/null)" = "$quest_dir" ] ||
  die "$quest_dir is not the root of a git checkout"
head=$(q rev-parse --verify 'HEAD^{commit}')
[ "$head" = "$QUEST_SHA" ] || die "Quest checkout is at $head, expected pinned $QUEST_SHA"
[ -z "$(q status --porcelain --untracked-files=all)" ] ||
  die "Quest checkout has local changes; refusing to patch (already applied?)"

# Apply atomically: --check first so a partial application is impossible.
q apply --check --whitespace=error-all "$patch" || die "patch does not apply to $QUEST_SHA"
q apply --whitespace=error-all "$patch"

# Confirm the result rather than trusting the apply exit status alone.
grep -q 'time.Sleep(120 \* time.Second)' "$quest_dir/tests/integration/query_test.go" &&
  die "TestSmokeIngestAndQuery still sleeps"
grep -q 'time.Sleep(120 \* time.Second)' "$quest_dir/tests/integration/alert_test.go" &&
  die "TestSmokeAlertLifecycle still sleeps"
grep -q 'time.Sleep(parseableSyncWait)' "$quest_dir/tests/integration/integrity_test.go" &&
  die "TestIntegrity still sleeps"
[ -f "$quest_dir/tests/integration/readiness/readiness.go" ] || die "readiness package missing"
grep -q 'tests/integration/readiness/' "$quest_dir/Dockerfile" ||
  die "Dockerfile does not run the readiness tests"

if "$verify"; then
  command -v go >/dev/null || die "--verify needs go on PATH"
  [ -f "$harness" ] || die "missing $harness"
  harness_copy="$quest_dir/tests/integration/zz_readiness_harness_test.go"
  trap 'rm -f "$harness_copy"' EXIT
  (
    cd "$quest_dir"
    unformatted=$(gofmt -l tests)
    [ -z "$unformatted" ] || die "gofmt needed: $unformatted"
    go vet ./tests/...
    go test -count=1 ./tests/integration/clients/... ./tests/integration/readiness/...
    cp "$harness" "$harness_copy"
    # The harness replaces NewGlob.QueryClient; never run it with real tests.
    go test -count=1 -run '^TestHarness' ./tests/integration
    rm -f "$harness_copy"
    go test -c -o /dev/null ./tests/integration
  )
  [ -z "$(q status --porcelain --untracked-files=all -- tests/integration/zz_readiness_harness_test.go)" ] ||
    die "harness copy was not removed"
fi

echo "Quest $QUEST_SHA patched with $(sha256sum "$patch" | cut -d' ' -f1) (quest-readiness.patch)"
q status --short
