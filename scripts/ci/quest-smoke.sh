#!/bin/sh
set -eu

# Match Quest's main.sh positional arguments and pb configuration. Its "smoke"
# mode still includes a multi-minute k6 test, so explicitly exclude load phases.
# Full main/nightly runs continue to use the image's unmodified entrypoint.
if [ "$#" -lt 11 ] || [ "$1" != smoke ]; then
  echo 'Expected Quest smoke arguments (endpoint, credentials and MinIO settings)' >&2
  exit 2
fi
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/tmp/quest-pb-config}"
pb profile add quest "$2" "$3" "$4" -o json
pb profile default quest -o json
stream="ci$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"

exec ./quest.test -test.v -test.parallel=64 -test.timeout=12m \
  -test.skip '^(TestLoad.*WithK6.*|TestSmokeLoadWithK6Streams)$' \
  -edition="${QUEST_EDITION:-oss}" -mode=smoke \
  -query-url="$2" -query-user="$3" -query-pass="$4" -stream="$stream" \
  -minio-url="$8" -minio-user="$9" -minio-pass="${10}" -minio-bucket="${11}" \
  -ingestor-url="${12:-}" -ingestor-user="${13:-}" -ingestor-pass="${14:-}"
