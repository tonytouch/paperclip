#!/usr/bin/env bash
# TON-814 - install the deployed-tree lineage guard.
#
#   bash /home/tony/tonysplace_best/workspace/paperclip/scripts/install-deployed-lineage-guard.sh
#
# Installs, idempotently:
#   1. the four protective git hooks into the deployed clone's .git/hooks,
#      byte-identical to the tracked copies in scripts/git-hooks/;
#   2. a systemd user timer that runs the guard hourly and fails loudly.
#
# Idempotent: safe to re-run. Never touches the running server.

set -uo pipefail

# Which tree do we install into? The tree THIS SCRIPT lives in, so that running
# it from a fresh clone arms that clone rather than silently re-arming the
# deployed tree. The env override still wins when explicitly set.
INSTALLER_SELF="${BASH_SOURCE[0]}"
INSTALLER_DIR="$(cd "$(dirname "$INSTALLER_SELF")" && pwd)"
DEFAULT_REPO="$(cd "$INSTALLER_DIR/.." 2>/dev/null && pwd)"
if [ -n "$DEFAULT_REPO" ] && [ -d "$DEFAULT_REPO/.git" ]; then
  REPO="${PAPERCLIP_DEPLOYED_REPO:-$DEFAULT_REPO}"
else
  REPO="${PAPERCLIP_DEPLOYED_REPO:-/home/tony/tonysplace_best/workspace/paperclip}"
fi
UNIT_DIR="${HOME}/.config/systemd/user"
GUARD_DIR="${HOME}/.local/share/paperclip-guard"
HOOK_NAMES="pre-commit pre-merge-commit post-merge post-checkout pre-push"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

if [ ! -d "$REPO/.git" ]; then
  echo "[$(ts)] install-deployed-lineage-guard: FAIL - no git repo at $REPO"
  exit 2
fi

mkdir -p "$UNIT_DIR" "$GUARD_DIR" "$REPO/.git/hooks"

# 1. Hooks.
for hook in $HOOK_NAMES; do
  src="$REPO/scripts/git-hooks/$hook"
  dst="$REPO/.git/hooks/$hook"
  if [ ! -f "$src" ]; then
    echo "[$(ts)] install-deployed-lineage-guard: FAIL - tracked hook missing: $src"
    exit 1
  fi
  cp "$src" "$dst"
  chmod 0755 "$dst"
  echo "[$(ts)] install-deployed-lineage-guard: installed hook $hook"
done

# 2. Guard runner (a stable path outside the repo, so the timer keeps working
#    even if the tree is being rebuilt) + the systemd user timer.
#
#    The timer watches ONE tree - the deployed one. Running this installer
#    from a different clone must arm that clone's hooks (done in step 1) but
#    must NOT repoint the deployed timer at the clone. So the timer and the
#    installed runner are only written for the deployed tree.
DEPLOYED_REPO="/home/tony/tonysplace_best/workspace/paperclip"
if [ "$REPO" != "$DEPLOYED_REPO" ]; then
  echo "[$(ts)] install-deployed-lineage-guard: $REPO is not the deployed tree ($DEPLOYED_REPO)"
  echo "[$(ts)] install-deployed-lineage-guard: armed THIS clone's hooks only; the deployed timer is untouched"
  exit 0
fi

cp "$REPO/scripts/deployed-lineage-guard.sh" "$GUARD_DIR/deployed-lineage-guard.sh"
chmod 0755 "$GUARD_DIR/deployed-lineage-guard.sh"

cat > "$UNIT_DIR/paperclip-guard-deployed-lineage.service" <<UNIT
[Unit]
Description=TON-814 deployed paperclip tree lineage guard (long_active_duration fix must survive a redeploy)
After=network-online.target

[Service]
Type=oneshot
ExecStart=/home/tony/.local/share/paperclip-guard/deployed-lineage-guard.sh
# The installed guard lives OUTSIDE the repo, so it cannot derive the tree it
# guards from its own location. Point it at the deployed tree explicitly.
Environment=PAPERCLIP_DEPLOYED_REPO=$REPO
Nice=10
UNIT

cat > "$UNIT_DIR/paperclip-guard-deployed-lineage.timer" <<'UNIT'
[Unit]
Description=TON-814 deployed paperclip tree lineage guard, hourly at :41

[Timer]
OnCalendar=*-*-* *:41:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# NOTE: on this host a plain `systemctl --user` call hangs (it never returns).
# `--machine=tony@.host` reaches the same user manager reliably, so use it
# everywhere in this script.
systemctl --user --machine="tony@.host" daemon-reload
systemctl --user --machine="tony@.host" enable --now paperclip-guard-deployed-lineage.timer

echo "[$(ts)] install-deployed-lineage-guard: done"
systemctl --user --machine="tony@.host" list-timers paperclip-guard-deployed-lineage.timer --no-pager || true
"$GUARD_DIR/deployed-lineage-guard.sh"
