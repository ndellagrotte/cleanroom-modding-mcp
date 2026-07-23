# verify/10_forcedl.sh — the generic DbVersioning forcing path treats docs.db's bump as an update.
source verify/env.sh
grep -Eq 'force' "$REPO/src/db-versioning.ts" && pass "db-versioning force path present" || fail "db-versioning force path missing"
grep -Eq "docs[^}]*skipUpdate\s*:\s*true|docs[^}]*pinned\s*:\s*true" "$REPO/src/dbs.ts" \
  && fail "docs.db pinned/skipUpdate — v1 clients would not force-redownload" \
  || pass "docs.db not pinned; bump triggers force-redownload"
exit $FAILED
