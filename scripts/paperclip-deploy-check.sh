#!/usr/bin/env bash
# TON-814 - one-line deployability check for the deployed paperclip tree.
#
#   bash /home/tony/tonysplace_best/workspace/paperclip/scripts/paperclip-deploy-check.sh
#
# Exit 0 -> the deployed tree is safe to redeploy (fix + service present, the
#           branch is pinned to the durable fork branch).
# Exit 1 -> redeploying from the current tree state would lose the fix or the
#           productivity-review service. Do NOT redeploy; re-pin first.
#
# This script never mutates anything. It only reports.

set -uo pipefail

REPO="${PAPERCLIP_DEPLOYED_REPO:-/home/tony/tonysplace_best/workspace/paperclip}"
GUARD="$REPO/scripts/deployed-lineage-guard.sh"

if [ ! -x "$GUARD" ]; then
  bash "$GUARD"
  exit $?
fi

exec "$GUARD"
