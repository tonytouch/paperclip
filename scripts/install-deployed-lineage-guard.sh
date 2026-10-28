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

REPO="${PAPERCLIP_DEPLOYED_REPO:-/home/tony/tonysplace_best/workspace/paperclip}"
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
#    even if the tree is being rebuilt).
cp "$REPO/scripts/deployed-lineage-guard.sh" "$GUARD_DIR/deployed-lineage-guard.sh"
chmod 0755 "$GUARD_DIR/deployed-lineage-guard.sh"

cat > "$UNIT_DIR/paperclip-guard-deployed-lineage.service" <<'UNIT'
[Unit]
Description=TON-814 deployed paperclip tree lineage guard (long_active_duration fix must survive a redeploy)
After=network-online.target

[Service]
Type=oneshot
ExecStart=/home/tony/.local/share/paperclip-guard/deployed-lineage-guard.sh
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
