# The deployed paperclip tree: lineage and redeploy procedure

**Owner:** CTO · **Ticket:** TON-814 · **Related:** TON-751 (fix `fa3c22dd`), TON-755 (live verification)

## Why this document exists

The `long_active_duration` false-positive fix (commit `fa3c22dd14a2502ed055ef6e7c309478ff7d5346`)
and the entire `productivity-review` service are **not on upstream main**. Upstream
`paperclipai/paperclip` deleted the whole feature in `3bafac12f` and denies pushes to this fork.

They live in exactly two places:

1. the fork branch `ton/deployed-long-active-fix` on `fork` (`https://github.com/tonytouch/paperclip.git`), and
2. the deployed working tree `/home/tony/tonysplace_best/workspace/paperclip`.

The unit `paperclip.service` runs the TypeScript **source** through `tsx`
(`cli/src/index.ts run`), so the working tree *is* the running program. A restart is a deploy,
and a bad pull is a silent, catastrophic regression that no test in this tree can catch.

## Deploy source of truth

| | |
|---|---|
| Deployed tree | `/home/tony/tonysplace_best/workspace/paperclip` |
| Deployed branch | `ton/ton-809-manager-boundary` |
| Tracked upstream | `fork/ton/deployed-long-active-fix` ✅ |
| Durable remote | `fork` = `https://github.com/tonytouch/paperclip.git` |
| `origin` | `https://github.com/paperclipai/paperclip.git` — **upstream, never deploy from it** |

`git pull` in the deployed tree pulls **from the fork's durable branch**, which carries the fix.
That is safe. The danger is only an explicit pull/merge/reset *from upstream*.

Verify the pin at any time:

```bash
cd /home/tony/tonysplace_best/workspace/paperclip
git rev-parse --abbrev-ref --symbolic-full-name '@{u}'   # must print fork/ton/deployed-long-active-fix
```

## The one command to redeploy

```bash
bash /home/tony/tonysplace_best/workspace/paperclip/scripts/redeploy-paperclip.sh
```

It refuses to deploy unless the lineage guard passes, fast-forwards onto the durable branch,
re-verifies the service and the `findLiveContinuationPath` marker, reinstalls the protective
hooks, restarts `paperclip.service`, and waits for health on `127.0.0.1:3100`.

Variants: `--check-only` (verify, mutate nothing) · `--no-restart` (redeploy the tree, leave the server up).

## What you must NOT run

- `git pull origin main` · `git pull upstream main` · `git merge origin/main` — deletes the service
- `git reset --hard origin/main` — same, plus it discards the working tree
- `git checkout origin/master` · `git checkout upstream/master` — same
- `git push origin` · `git push upstream` — denied upstream, and it makes the source of truth ambiguous

## The guard

`scripts/deployed-lineage-guard.sh` (installed at `~/.local/share/paperclip-guard/`, run hourly by
the `paperclip-guard-deployed-lineage.timer` systemd user timer) fails closed on any of:

1. the deployed branch not tracking `fork/ton/deployed-long-active-fix`;
2. `fa3c22dd` not an ancestor of deployed HEAD;
3. the service or its test absent from the deployed branch tree;
4. either file absent from the working tree;
5. `findLiveContinuationPath` missing from the service (file present but fix reverted);
6. a protective hook missing, non-executable, or drifted from its tracked copy;
7. **the guard's own assets not tracked by git** — an untracked guard dies with the next
   `git clean` and is absent from every fresh clone, so it protects nothing;
8. the durable branch on the **remote** not carrying the fix and the service — a local-only
   commit is not a durable home.

## Protective git hooks (installed in `.git/hooks/`)

| Hook | Blocks |
|---|---|
| `pre-merge-commit` | a merge whose result would delete the service or drop the `findLiveContinuationPath` fix |
| `post-merge` | self-heals after a fast-forward pull that dropped the files (a FF pull creates no merge commit, so `pre-merge-commit` never runs) |
| `post-checkout` | a branch checkout that would leave the tree without the service |
| `pre-push` | any push to `origin` / `upstream` |

Reinstall them (idempotent) with:

```bash
bash /home/tony/tonysplace_best/workspace/paperclip/scripts/install-deployed-lineage-guard.sh
```

## Upstream state (do not push there)

- Upstream `origin/master` is at `25f1070fb`; `server/src/services/productivity-review.ts` is
  **absent** from its tree.
- `git rev-list --count HEAD..origin/master` = 2812 — upstream is far ahead, so a merge would
  bring in the feature's deletion.
- Upstream denies pushes to this fork. Do not attempt them.
