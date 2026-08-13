#!/usr/bin/env bash
#
# Derive a Cloudflare preview alias from a git branch name.
#
# Cloudflare constrains aliased preview URLs (docs/deployment.md §4):
#   - lowercase letters, numbers and dashes only, and must begin with a letter
#   - alias + Worker name must not exceed 63 characters
#
# The Worker is "cockpit-preview" (15 chars), which leaves 47 for the alias.
# The rules, in order:
#   1. Use only the last path segment, so "claude/inbox-swipe" -> "inbox-swipe".
#      Every branch here carries a "claude/" or "feat/" style prefix that costs
#      characters and carries no information the slug does not already have.
#   2. Sanitise to [a-z0-9-] and strip any leading non-letters.
#   3. Truncate the slug to 38 characters.
#   4. Always append a 6-character hash of the *full* branch name. Because the
#      hash covers the full name, truncation in step 3 and segment-stripping in
#      step 1 cannot collide two different branches onto one URL.
#
# 38 + 1 + 6 = 45, plus "-cockpit-preview" = 61. Two characters under the 63
# limit deliberately: the hostname label is what is actually capped, and being
# exactly at the limit would break on any future rename of the Worker.
#
# Usage: branch-alias.sh <branch-name>
set -euo pipefail

branch="${1:?usage: branch-alias.sh <branch-name>}"

# 1. last path segment
slug="${branch##*/}"

# 2. sanitise: lowercase, non-alphanumerics to dashes, collapse, trim, must
#    start with a letter
slug=$(printf '%s' "$slug" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/-+/-/g; s/^-+//; s/-+$//; s/^[^a-z]+//')

# 3. truncate, then re-trim in case we cut on a dash
slug="${slug:0:38}"
slug=$(printf '%s' "$slug" | sed -E 's/-+$//')

# 4. hash the full branch name for collision safety
hash=$(printf '%s' "$branch" | sha1sum | cut -c1-6)

# A branch whose name sanitises to nothing at all (e.g. "123") still needs a
# valid alias, and an alias must begin with a letter.
if [ -z "$slug" ]; then
  printf 'b-%s\n' "$hash"
else
  printf '%s-%s\n' "$slug" "$hash"
fi
