#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 IMAGE BUILD_SHA" >&2
  exit 2
fi

image=$1
build_sha=$2
portal_grant=ci-portal-grant-000000000000000000000000000000000000000000
access_token=ci-standalone-token-000000000000000000000000000000000000000000
source_fingerprint=1111111111111111111111111111111111111111111111111111111111111111
image_reference=ghcr.io/madpanda3d/firecrawl-mcp-server@sha256:2222222222222222222222222222222222222222222222222222222222222222
active_container=

cleanup() {
  if [[ -n "$active_container" ]]; then
    docker rm -f "$active_container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

start_runtime() {
  local mode=$1
  active_container="firecrawl-mcp-smoke-$mode"
  cleanup
  active_container="firecrawl-mcp-smoke-$mode"

  local -a mode_env
  if [[ "$mode" == portal ]]; then
    mode_env=(
      -e MCP_MODE=portal
      -e MCP_PORTAL_GRANT_TOKEN="$portal_grant"
      -e FIRECRAWL_PROVIDER_EXECUTION_ENABLED=false
    )
  else
    mode_env=(
      -e MCP_MODE=standalone
      -e MCP_ACCESS_TOKEN="$access_token"
      -e FIRECRAWL_PROVIDER_EXECUTION_ENABLED=true
    )
  fi

  docker run -d --rm --name "$active_container" \
    --init --network none --read-only --user 1000:1000 \
    --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
    --tmpfs /data:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=1000,gid=1000 \
    "${mode_env[@]}" \
    -e MCP_BUILD_SHA="$build_sha" \
    -e MCP_SOURCE_FINGERPRINT="$source_fingerprint" \
    -e MCP_IMAGE_REFERENCE="$image_reference" \
    "$image" >/dev/null
}

for mode in portal standalone; do
  start_runtime "$mode"
  passed=false
  for _ in {1..20}; do
    if docker exec "$active_container" node /app/scripts/runtime-smoke.mjs; then
      passed=true
      break
    fi
    sleep 1
  done
  if [[ "$passed" != true ]]; then
    docker logs "$active_container" >&2 || true
    exit 1
  fi
  cleanup
  active_container=
done
