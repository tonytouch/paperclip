#!/usr/bin/env bash
# TON-1129 - REPAIR the deployed tree's lineage pin.
#
#   bash scripts/repin-deployed-lineage.sh
#   bash scripts/repin-deployed-lineage.sh --check-only
#
# WHY
#   The deployed tree's branch must track the fork's durable branch
#   (fork/ton/deployed-long-active-fix). That upstream link lives in LOCAL
#   git config, so it is lost the moment a branch is cut from a local
#   branch - and the guard then fails closed and refuses every redeploy,
#   with nothing in the repository showing what the pin is supposed to be.
#
#   This script is the repair, and the pin itself is committed in
#   scripts/deployed-lineage-guard.conf on the durable branch.
#
#   It is idempotent and it only ever touches the upstream pointer of the
#   CURRENT branch - it never checks out, resets, merges, pulls, or moves
#   HEAD, so it cannot disturb a working tree that carries other work.
#
# Exit codes:
#   0  the pin is (or was made) correct and the guard passes
#   1  the pin could not be repaired, or the guard still fails
#   2  could not evaluate (missing repo / git failure)

set -uo pipefail

# Which tree does this repair? The tree THIS SCRIPT lives in, unless the
# env override says otherwise (the systemd unit and the redeploy script
# point it at the deployed tree explicitly).
SELF="${BASH_SOURCE[0]}"
SELF_DIR="$(cd "$(dirname "$SELF")" && pwd)"
DEFAULT_REPO="$(cd "$SELF_DIR/.." 2>/dev/null && pwd)"
if [ -n "$DEFAULT_REPO" ] && [ -e "$DEFAULT_REPO/.git" ]; then
  REPO="${PAPERCLIP_DEPLOYED_REPO:-$DEFAULT_REPO}"
else
  REPO="${PAPERCLIP_DEPLOYED_REPO:-/home/tony/tonysplace_best/workspace/paperclip}"
fi

CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "repin-deployed-lineage: unknown argument '$arg'" >&2; exit 2 ;;
  esac
done

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say() { echo "[$(ts)] repin-deployed-lineage: $*"; }
die() { echo "[$(ts)] repin-deployed-lineage: FAIL - $*" >&2; exit "${2:-1}"; }

[ -e "$REPO/.git" ] || die "no git repo at $REPO" 2
cd "$REPO" || die "cannot cd $REPO" 2

# ---------------------------------------------------------------------------
# Read the committed pin. The conf lives in the repo; the installed copy
# (next to the installed guard runner) is the fallback for a tree where the
# conf has not been checked out yet.
# ---------------------------------------------------------------------------
CONF=""
for candidate in "$REPO/scripts/deployed-lineage-guard.conf" "$SELF_DIR/deployed-lineage-guard.conf"; do
  if [ -f "$candidate" ]; then CONF="$candidate"; break; fi
done
[ -n "$CONF" ] || die "no pin file found (scripts/deployed-lineage-guard.conf) - cannot know the intended pin" 2

conf_get() {
  # conf_get KEY - value of KEY, empty if absent.
  sed -n "s/^$1=//p" "$CONF" | head -n 1
}

DURABLE_REMOTE="${PAPERCLIP_DURABLE_REMOTE:-$(conf_get DEPLOYED_DURABLE_REMOTE)}"
DURABLE_BRANCH="${PAPERCLIP_DURABLE_BRANCH:-$(conf_get DEPLOYED_DURABLE_BRANCH)}"
[ -n "$DURABLE_REMOTE" ] || die "the pin file does not name a durable remote" 2
[ -n "$DURABLE_BRANCH" ] || die "the pin file does not name a durable branch" 2

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
current_upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo none)"
expected_upstream="$DURABLE_REMOTE/$DURABLE_BRANCH"

say "repo=$REPO branch=$branch upstream=$current_upstream expected=$expected_upstream"

if [ "$current_upstream" = "$expected_upstream" ]; then
  say "pin already correct"
elif [ "$CHECK_ONLY" = "1" ]; then
  say "--check-only: pin is BROKEN (upstream=$current_upstream) - not repairing"
  die "the deployed branch does not track $expected_upstream" 1
else
  # The durable remote must exist and must NOT be upstream. Pushing to or
  # pulling from upstream is what destroys the service.
  if ! git remote get-url "$DURABLE_REMOTE" >/dev/null 2>&1; then
    die "remote '$DURABLE_REMOTE' does not exist in this clone - cannot set the pin" 1
  fi
  remote_url="$(git remote get-url "$DURABLE_REMOTE" 2>/dev/null || echo unknown)"
  case "$remote_url" in
    *paperclipai/paperclip*) die "remote '$DURABLE_REMOTE' points at upstream ($remote_url) - refusing to pin to it" 1 ;;
  esac

  # Make sure the durable branch is known locally, so the pin can be set.
  if ! git rev-parse --verify "refs/remotes/$DURABLE_REMOTE/$DURABLE_BRANCH" >/dev/null 2>&1; then
    say "fetching $DURABLE_REMOTE $DURABLE_BRANCH"
    git fetch --quiet "$DURABLE_REMOTE" "$DURABLE_BRANCH" \
      || die "could not fetch $DURABLE_REMOTE/$DURABLE_BRANCH" 1
  fi

  say "setting upstream of '$branch' to $expected_upstream"
  git branch --set-upstream-to="$expected_upstream" "$branch" >/dev/null 2>&1 \
    || die "could not set the upstream of '$branch' to $expected_upstream" 1
  say "upstream now: $(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo none)"
fi

# ---------------------------------------------------------------------------
# The guard is the authority: the pin is only correct if the guard says so.
# ---------------------------------------------------------------------------
GUARD="$REPO/scripts/deployed-lineage-guard.sh"
if [ ! -f "$GUARD" ]; then
  die "lineage guard missing at $GUARD" 2
fi
if bash "$GUARD"; then
  say "lineage guard: OK"
  exit 0
fi

die "lineage guard still fails - the pin alone does not make the tree deployable" 1
