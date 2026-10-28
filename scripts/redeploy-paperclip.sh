#!/usr/bin/env bash
# TON-814 - the ONE command to redeploy the live paperclip tree without
# losing the long_active_duration fix (fa3c22dd) or the productivity-review
# service itself.
#
#   bash /home/tony/tonysplace_best/workspace/paperclip/scripts/redeploy-paperclip.sh
#   bash .../redeploy-paperclip.sh --check-only     # verify, do not mutate
#   bash .../redeploy-paperclip.sh --no-restart      # redeploy the tree, leave the server up
#
# WHY THIS EXISTS
#   Upstream paperclipai/paperclip DELETED the productivity-review feature in
#   3bafac12f, and denies pushes to this fork. The fix and the whole service
#   therefore exist ONLY on our fork branch `ton/deployed-long-active-fix`.
#   The unit paperclip.service runs the TypeScript source through tsx, so the
#   working tree IS the running program - a pull from upstream origin/main is
#   a silent, catastrophic regression that no test in this tree can catch.
#
# WHAT IT MUST NOT DO (and does not):
#   - `git pull origin main` / `git pull upstream main` / `git merge origin/main`
#   - `git reset --hard origin/main`
#   - `git checkout origin/master` / `git checkout upstream/master`
#   - `git push origin` / `git push upstream`   (denied upstream; makes the
#     source of truth ambiguous)
#
# The deploy source of truth is the FORK branch:
#   remote `fork` = https://github.com/tonytouch/paperclip.git
#   branch `ton/deployed-long-active-fix`
#
# Exit codes:
#   0  redeploy completed (or check passed), service healthy
#   1  refused - lineage broken / unhealthy, nothing was deployed
#   2  could not evaluate (missing repo, git failure)

set -uo pipefail

REPO="${PAPERCLIP_DEPLOYED_REPO:-/home/tony/tonysplace_best/workspace/paperclip}"
DURABLE_REMOTE="${PAPERCLIP_DURABLE_REMOTE:-fork}"
DURABLE_BRANCH="${PAPERCLIP_DURABLE_BRANCH:-ton/deployed-long-active-fix}"
SERVICE="server/src/services/productivity-review.ts"
TESTFILE="server/src/__tests__/productivity-review-service.test.ts"
MARKER="findLiveContinuationPath"
FIX_COMMIT="fa3c22dd14a2502ed055ef6e7c309478ff7d5346"
GUARD="$REPO/scripts/deployed-lineage-guard.sh"
INSTALLER="$REPO/scripts/install-deployed-lineage-guard.sh"

CHECK_ONLY=0
DO_RESTART=1
for arg in "$@"; do
  case "$arg" in
    --check-only)  CHECK_ONLY=1 ;;
    --no-restart)  DO_RESTART=0 ;;
    -h|--help)     sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "redeploy-paperclip: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { echo "[$(ts)] redeploy-paperclip: $*"; }
die() { echo "[$(ts)] redeploy-paperclip: REFUSED - $*" >&2; exit "${2:-1}"; }

[ -d "$REPO/.git" ] || die "no git repo at $REPO" 2
cd "$REPO" || die "cannot cd $REPO" 2

# ---------------------------------------------------------------------------
# Step 0. Pre-flight: the lineage guard must pass BEFORE we touch anything.
#         A guard that skips on a missing prerequisite is not a guard, so a
#         missing or failing guard is a hard refusal.
# ---------------------------------------------------------------------------
if [ ! -f "$GUARD" ]; then
  die "lineage guard missing at $GUARD - refusing to deploy blind"
fi
if ! bash "$GUARD"; then
  die "lineage guard FAILED - the fix/service is not intact, refusing to redeploy"
fi
say "pre-flight lineage guard: OK"

# ---------------------------------------------------------------------------
# Step 1. Refuse to operate if the tree is already in a destructive state.
# ---------------------------------------------------------------------------
current_upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo none)"
if [ "$current_upstream" != "$DURABLE_REMOTE/$DURABLE_BRANCH" ]; then
  die "branch tracks '$current_upstream', expected '$DURABLE_REMOTE/$DURABLE_BRANCH' - re-pin before deploying"
fi

if [ "$CHECK_ONLY" = "1" ]; then
  say "--check-only: lineage intact, branch pinned to $DURABLE_REMOTE/$DURABLE_BRANCH. Nothing to do."
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 2. Fetch the durable branch and move onto it. We never merge upstream.
# ---------------------------------------------------------------------------
say "fetching $DURABLE_REMOTE $DURABLE_BRANCH"
if ! git fetch --quiet "$DURABLE_REMOTE" "$DURABLE_BRANCH"; then
  die "could not fetch $DURABLE_REMOTE/$DURABLE_BRANCH"
fi

remote_sha="$(git rev-parse "FETCH_HEAD" 2>/dev/null || echo unknown)"
say "durable branch tip: ${remote_sha:0:10}"

if ! git merge-base --is-ancestor "$FIX_COMMIT" "$remote_sha" 2>/dev/null; then
  die "fix $FIX_COMMIT is not in $DURABLE_REMOTE/$DURABLE_BRANCH - refusing to deploy"
fi

if [ "$(git rev-parse HEAD)" != "$remote_sha" ]; then
  say "moving HEAD to ${remote_sha:0:10} (fast-forward only)"
  if ! git merge --ff-only "$remote_sha"; then
    die "could not fast-forward to the durable branch tip - resolve by hand, do NOT merge upstream"
  fi
else
  say "HEAD already at the durable branch tip"
fi

# ---------------------------------------------------------------------------
# Step 3. Post-deploy verification: the service and the fix must still be here.
# ---------------------------------------------------------------------------
for path in "$SERVICE" "$TESTFILE"; do
  [ -f "$path" ] || die "$path missing after the move - aborting"
done
grep -q "$MARKER" "$SERVICE" || die "$SERVICE lost the $MARKER fix after the move - aborting"
say "post-deploy tree check: service + fix present"

# ---------------------------------------------------------------------------
# Step 4. Reinstall the protective hooks and the guard (idempotent).
# ---------------------------------------------------------------------------
if [ -f "$INSTALLER" ]; then
  say "reinstalling lineage guard + protective hooks"
  if ! bash "$INSTALLER" >/dev/null 2>&1; then
    die "guard reinstall failed - the deployed tree would be unprotected"
  fi
fi

# ---------------------------------------------------------------------------
# Step 5. Restart the service (it runs the source via tsx, so this is the
#         deploy). Skip with --no-restart.
# ---------------------------------------------------------------------------
if [ "$DO_RESTART" = "0" ]; then
  say "--no-restart: tree redeployed, service left running"
  exit 0
fi

say "restarting paperclip.service"
if ! systemctl --user --machine="tony@.host" restart paperclip.service; then
  die "could not restart paperclip.service"
fi

# ---------------------------------------------------------------------------
# Step 6. Health check - a restart that leaves the server down is not a deploy.
# ---------------------------------------------------------------------------
healthy=0
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:3100/api/health" 2>/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done
if [ "$healthy" != "1" ]; then
  die "paperclip.service did not become healthy on 127.0.0.1:3100 within 60s"
fi
say "paperclip.service healthy on 127.0.0.1:3100"

say "redeploy complete. Fix $MARKER and the productivity-review service are intact."
exit 0
