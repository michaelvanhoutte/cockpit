#!/usr/bin/env bash
#
# Assertions for branch-alias.sh. Plain bash on purpose: this runs in CI before
# (and independently of) any Node toolchain, and it guards a property that is
# about hostnames rather than about application logic.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
alias_for="$here/branch-alias.sh"

# The Worker that preview versions are uploaded to. The Cloudflare limit is on
# the combined alias + Worker name, so the budget is expressed against it.
WORKER='cockpit-preview'
LABEL_LIMIT=63

failures=0

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}

expect_eq() {
  local branch="$1" want="$2" got
  got=$(bash "$alias_for" "$branch")
  if [ "$got" != "$want" ]; then
    fail "alias for '$branch': want '$want', got '$got'"
  fi
}

expect_valid() {
  local branch="$1" got hostname
  got=$(bash "$alias_for" "$branch")
  hostname="$got-$WORKER"

  # Cloudflare: lowercase letters, numbers and dashes, beginning with a letter.
  if ! printf '%s' "$got" | grep -Eq '^[a-z][a-z0-9-]*$'; then
    fail "alias for '$branch' is not a valid Cloudflare alias: '$got'"
  fi
  if printf '%s' "$got" | grep -Eq -- '--|-$'; then
    fail "alias for '$branch' has a doubled or trailing dash: '$got'"
  fi
  if [ "${#hostname}" -gt "$LABEL_LIMIT" ]; then
    fail "hostname for '$branch' is ${#hostname} chars, over the $LABEL_LIMIT limit: '$hostname'"
  fi
}

# --- stability -------------------------------------------------------------
# These are pinned: a preview URL that silently moves is a URL someone has
# already bookmarked or pasted into a PR.
expect_eq 'claude/inbox-swipe-gestures-4393d9' 'inbox-swipe-gestures-4393d9-84090b'
expect_eq 'feat/x' 'x-d6e256'
expect_eq 'hotfix/URGENT_Fix--Thing' 'urgent-fix-thing-3853c6'
# Sanitises away to nothing, so it falls back to the hash with a letter prefix.
expect_eq '123' 'b-40bd00'

# --- the alias contract, over the shapes branches actually take ------------
while IFS= read -r branch; do
  [ -n "$branch" ] || continue
  expect_valid "$branch"
done <<'BRANCHES'
main
dev
feat/x
123
---
UPPERCASE
claude/cloudflare-deployment-strategy-9dcc0f
claude/inbox-swipe-gestures-4393d9
claude/a-very-long-branch-name-that-goes-well-past-the-thirty-eight-character-budget-and-then-quite-a-lot-more
release/2026.08.13
feat/ünïcödé-in-the-name
a/b/c/deeply/nested/branch/name
BRANCHES

# --- collision safety ------------------------------------------------------
# Different branches must never map to the same alias, even when the part the
# slug is taken from is identical or the difference is past the truncation
# point. This is what the always-appended full-name hash buys.
collide() {
  local a b
  a=$(bash "$alias_for" "$1")
  b=$(bash "$alias_for" "$2")
  if [ "$a" = "$b" ]; then
    fail "'$1' and '$2' both map to '$a'"
  fi
}
collide 'claude/same-slug' 'feat/same-slug'
collide 'a/x' 'b/x'
collide \
  'claude/identical-for-the-first-thirty-eight-chars-aaaa' \
  'claude/identical-for-the-first-thirty-eight-chars-bbbb'

if [ "$failures" -gt 0 ]; then
  printf '\n%d assertion(s) failed\n' "$failures" >&2
  exit 1
fi

printf 'branch-alias.sh: all assertions passed\n'
