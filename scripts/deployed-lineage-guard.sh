#!/usr/bin/env bash
# TON-814 - deployed-tree lineage guard.
#
# The deployed paperclip tree (/home/tony/tonysplace_best/workspace/paperclip)
# carries the long_active_duration false-positive fix (commit fa3c22dd) and the
# whole productivity-review service. Upstream (paperclipai/paperclip) DELETED
# that feature in 3bafac12f, so the fix can never live on upstream master.
#
# This guard is the executable form of the deploy pin:
#   - the fix files exist in the deployed branch tree and in the working tree,
#   - the fix commit is an ancestor of the deployed HEAD,
#   - the deployed branch tracks our fork's durable branch, not upstream,
#   - the protective git hooks are installed and byte-identical to the tracked
#     copies in scripts/git-hooks/ (a hook that drifted or vanished is a
#     missing guard, and a missing guard is a FAIL, never a SKIP),
#   - the guard's own assets are TRACKED by git and present on the durable
#     remote branch - an untracked guard dies with the next `git clean` or a
#     fresh clone, so an untracked guard is a broken guard.
#
# Fail closed: any missing precondition is a FAIL.
#
# Exit codes:
#   0  lineage intact
#   1  lineage BROKEN (fix or service missing, branch unpinned, hooks drifted)
#   2  guard could not evaluate (missing repo / git failure)

set -uo pipefail

# Which tree does this guard inspect? It MUST be the tree the guard itself
# lives in, otherwise running it from a fresh clone silently validates the
# deployed tree instead and reports OK on a broken clone. The env override is
# still honoured (the systemd unit and the redeploy script use it to point at
# the deployed tree explicitly), but the default is derived from this script's
# own location.
GUARD_SELF="${BASH_SOURCE[0]}"
GUARD_DIR="$(cd "$(dirname "$GUARD_SELF")" && pwd)"
DEFAULT_REPO="$(cd "$GUARD_DIR/.." 2>/dev/null && pwd)"
# The installed copy lives outside the repo (~/.local/share/paperclip-guard), so
# the derived parent is not a git tree; fall back to the known deployed tree in
# that case. The systemd unit also sets PAPERCLIP_DEPLOYED_REPO explicitly.
if [ -n "$DEFAULT_REPO" ] && [ -d "$DEFAULT_REPO/.git" ]; then
  REPO="${PAPERCLIP_DEPLOYED_REPO:-$DEFAULT_REPO}"
else
  REPO="${PAPERCLIP_DEPLOYED_REPO:-/home/tony/tonysplace_best/workspace/paperclip}"
fi
FIX_COMMIT="fa3c22dd14a2502ed055ef6e7c309478ff7d5346"
DURABLE_REMOTE="${PAPERCLIP_DURABLE_REMOTE:-fork}"
DURABLE_BRANCH="${PAPERCLIP_DURABLE_BRANCH:-ton/deployed-long-active-fix}"
# The invariant is not the remote's NAME (a fresh clone may call it anything)
# but WHICH REPOSITORY it points at: our fork carries the fix, upstream deleted
# the feature. So we assert the URL, and we assert upstream is not it.
DURABLE_URL_PATTERN="${PAPERCLIP_DURABLE_URL_PATTERN:-tonytouch/paperclip}"
FORBIDDEN_URL_PATTERN="${PAPERCLIP_FORBIDDEN_URL_PATTERN:-paperclipai/paperclip}"
SERVICE="server/src/services/productivity-review.ts"
TESTFILE="server/src/__tests__/productivity-review-service.test.ts"
MARKER="findLiveContinuationPath"
HOOK_NAMES="pre-commit pre-merge-commit post-merge post-checkout pre-push"
GUARD_ASSETS="scripts/deployed-lineage-guard.sh scripts/paperclip-deploy-check.sh scripts/install-deployed-lineage-guard.sh scripts/redeploy-paperclip.sh"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
fail() { echo "[$(ts)] deployed-lineage-guard: FAIL - $1"; exit "${2:-1}"; }

if [ ! -d "$REPO/.git" ]; then
  echo "[$(ts)] deployed-lineage-guard: FAIL - no git repo at $REPO"
  exit 2
fi

cd "$REPO" || { echo "[$(ts)] deployed-lineage-guard: FAIL - cannot cd $REPO"; exit 2; }

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo none)"
head_sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

echo "[$(ts)] deployed-lineage-guard: repo=$REPO branch=$branch upstream=$upstream head=${head_sha:0:10}"

# 1. The deployed branch must track the durable fork branch, and the remote it
#    tracks must be OUR FORK - not upstream. If it tracks upstream, an ordinary
#    pull can delete the service. We check the remote URL, not just its name,
#    so a clone that calls the fork 'origin' is judged on the same merits.
case "$upstream" in
  */*)
    up_remote="${upstream%%/*}"
    up_branch="${upstream#*/}"
    if [ "$up_branch" != "$DURABLE_BRANCH" ]; then
      fail "deployed branch '$branch' tracks '$upstream', expected branch '$DURABLE_BRANCH'"
    fi
    up_url="$(git remote get-url "$up_remote" 2>/dev/null || echo unknown)"
    case "$up_url" in
      *"$FORBIDDEN_URL_PATTERN"*)
        fail "deployed branch '$branch' tracks '$upstream' -> $up_url (upstream, which DELETED the productivity-review feature)" ;;
      *"$DURABLE_URL_PATTERN"*) ;;
      *) fail "deployed branch '$branch' tracks '$up_remote' -> $up_url, which is not our fork ($DURABLE_URL_PATTERN)" ;;
    esac
    DURABLE_REMOTE="$up_remote"
    ;;
  *)
    fail "deployed branch '$branch' tracks '$upstream', expected '$DURABLE_REMOTE/$DURABLE_BRANCH'"
    ;;
esac

# 2. The fix commit must be in the deployed history.
if ! git merge-base --is-ancestor "$FIX_COMMIT" HEAD 2>/dev/null; then
  fail "fix commit $FIX_COMMIT is not an ancestor of deployed HEAD ${head_sha:0:10}"
fi

# 3. The fix must be in the deployed branch tip's tree (not just history).
for path in "$SERVICE" "$TESTFILE"; do
  if ! git cat-file -e "HEAD:$path" 2>/dev/null; then
    fail "$path is absent from the deployed branch tree"
  fi
done

# 4. The fix must be in the working tree the service actually executes.
for path in "$SERVICE" "$TESTFILE"; do
  if [ ! -f "$path" ]; then
    fail "$path is absent from the working tree (deleted by a pull?)"
  fi
done

# 5. The behavioural marker must still be present - a file can survive while
#    the fix inside it is reverted.
if ! grep -q "$MARKER" "$SERVICE"; then
  fail "$SERVICE no longer contains $MARKER - the fix was reverted"
fi

# 6. The protective hooks must be installed and identical to the tracked
#    copies. A drifted or missing hook is a missing guard.
for hook in $HOOK_NAMES; do
  tracked="scripts/git-hooks/$hook"
  installed=".git/hooks/$hook"
  if [ ! -f "$tracked" ]; then
    fail "tracked hook $tracked is missing from the deployed tree"
  fi
  if [ ! -f "$installed" ]; then
    fail "hook $installed is not installed in the deployed tree"
  fi
  if ! cmp -s "$tracked" "$installed"; then
    fail "hook $installed has drifted from the tracked $tracked"
  fi
  if [ ! -x "$installed" ]; then
    fail "hook $installed is not executable"
  fi
done

# 7. The guard's own assets must be TRACKED by git. An untracked guard is
#    destroyed by `git clean -fd` and is absent from every fresh clone, so it
#    protects nothing. This is the check that makes the guard itself durable.
for asset in $GUARD_ASSETS; do
  if ! git ls-files --error-unmatch "$asset" >/dev/null 2>&1; then
    fail "guard asset $asset is NOT tracked by git - it will not survive a clone or git clean"
  fi
  if ! git cat-file -e "HEAD:$asset" 2>/dev/null; then
    fail "guard asset $asset is absent from the deployed branch tree"
  fi
done
for hook in $HOOK_NAMES; do
  if ! git ls-files --error-unmatch "scripts/git-hooks/$hook" >/dev/null 2>&1; then
    fail "hook source scripts/git-hooks/$hook is NOT tracked by git - it will not survive a clone"
  fi
done

# 8. The durable branch on the REMOTE must also carry the fix. A local-only
#    commit is not a durable home: a fresh clone of the fork must reproduce the
#    fix and the whole productivity-review service.
if git ls-remote --exit-code "$DURABLE_REMOTE" "refs/heads/$DURABLE_BRANCH" >/dev/null 2>&1; then
  remote_sha="$(git ls-remote "$DURABLE_REMOTE" "refs/heads/$DURABLE_BRANCH" 2>/dev/null | cut -f1)"
  if [ -n "$remote_sha" ]; then
    if ! git merge-base --is-ancestor "$FIX_COMMIT" "$remote_sha" 2>/dev/null; then
      fail "fix commit $FIX_COMMIT is NOT in $DURABLE_REMOTE/$DURABLE_BRANCH (${remote_sha:0:10}) - push it"
    fi
    for path in "$SERVICE" "$TESTFILE"; do
      if ! git cat-file -e "$remote_sha:$path" 2>/dev/null; then
        fail "$path is absent from $DURABLE_REMOTE/$DURABLE_BRANCH (${remote_sha:0:10}) - push it"
      fi
    done
  fi
else
  # The remote branch must be reachable; an unreachable durable branch means the
  # pin is unverifiable. Fail closed rather than skip.
  fail "cannot reach $DURABLE_REMOTE/$DURABLE_BRANCH - the durable pin is unverifiable"
fi

echo "[$(ts)] deployed-lineage-guard: OK - fix $MARKER present, durable branch $DURABLE_REMOTE/$DURABLE_BRANCH, hooks installed, guard assets tracked"
exit 0
