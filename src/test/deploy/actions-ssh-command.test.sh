#!/usr/bin/env bash
set -Eeuo pipefail
source scripts/actions-ssh-command.sh
digest=$(printf 'a%.0s' {1..64})
image="ghcr.io/atmoos985/curdemotwo@sha256:$digest"
command="bash /opt/cutdemo/deploy-server.sh '$image'"
passed=0
[[ "$(parse_deploy_image "$command")" == "$image" ]]
passed=$((passed + 1))
for invalid in \
  '' 'id' 'bash' \
  "bash /opt/other/deploy-server.sh '$image'" \
  "bash /opt/cutdemo/deploy-server.sh 'ghcr.io/other/project@sha256:$digest'" \
  "bash /opt/cutdemo/deploy-server.sh 'ghcr.io/atmoos985/curdemotwo:latest'" \
  "bash /opt/cutdemo/deploy-server.sh 'ghcr.io/atmoos985/curdemotwo@sha256:abc'" \
  "$command; id" "$command extra" "$command"$'\nid' \
  "bash /opt/cutdemo/deploy-server.sh '$image; id'"; do
  if parse_deploy_image "$invalid" >/dev/null; then
    printf 'FAIL: unexpected command accepted\n' >&2
    exit 1
  fi
  passed=$((passed + 1))
done
printf 'SSH command checks: executed=%s passed=%s failed=0 skipped=0\n' "$passed" "$passed"
