#!/usr/bin/env bash
set -Eeuo pipefail

# This is the forced command for the Actions-only SSH key. Never evaluate client shell text.
parse_deploy_image() {
  local command=${1-}
  local prefix="bash /opt/cutdemo/deploy-server.sh 'ghcr.io/atmoos985/curdemotwo@sha256:"
  [[ "$command" == "$prefix"* && "$command" == *"'" ]] || return 2
  local digest=${command#"$prefix"}
  digest=${digest%"'"}
  [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || return 2
  printf 'ghcr.io/atmoos985/curdemotwo@sha256:%s\n' "$digest"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if ! image=$(parse_deploy_image "${SSH_ORIGINAL_COMMAND-}"); then
    printf 'Only this repository\x27s immutable-image deployment command is permitted.\n' >&2
    exit 2
  fi
  export CUTDEMO_DEPLOY_DIR=/opt/cutdemo
  exec /bin/bash /opt/cutdemo/deploy-server.sh "$image"
fi
