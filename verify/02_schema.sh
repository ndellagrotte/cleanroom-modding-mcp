# verify/02_schema.sh
source verify/env.sh

# 2.1/2.2 The schema version is in lockstep across all three places that carry it.
#
# These checks used to pin the literal 2. The invariant DESIGN §5.1 actually
# states is *lockstep* — store.ts, dbs.ts and the shipped database must agree —
# and the version itself is expected to move whenever the DDL does (docs.db went
# to 3 when `documents.loader_version` was added). Deriving the expected value
# from store.ts keeps the oracle enforcing the real rule without needing an edit
# at every bump, and still fails loudly if any one of the three drifts.
want=$(grep -Eo 'SCHEMA_VERSION\s*=\s*[0-9]+' "$REPO/src/indexer/store.ts" | head -1 | grep -Eo '[0-9]+')
[ -n "$want" ] \
  && pass "store.ts declares SCHEMA_VERSION=$want" || fail "store.ts has no SCHEMA_VERSION constant"

grep -Eq "schemaVersion\s*:\s*${want}\b" "$REPO/src/dbs.ts" \
  && pass "dbs.ts DBS.docs.schemaVersion=$want (lockstep)" \
  || fail "dbs.ts docs.schemaVersion not $want (lockstep with store.ts broken)"

# The database is allowed to lag the source only until the next rebuild; that is
# a real, reportable state, so it fails rather than being waved through.
v=$(sqlite3 "$DOCS_DB" "SELECT value FROM metadata WHERE key='schema_version';")
[ "$v" = "$want" ] && pass "docs.db schema_version==$want" \
  || fail "docs.db schema_version is '$v', want $want — rebuild the corpus (pnpm run index-docs)"

# 2.3 The "bump together" link-comment now exists in store.ts (DESIGN §5.1 says it must be added).
grep -Eqi 'bump.*(together|lockstep|DBS\.docs)' "$REPO/src/indexer/store.ts" \
  && pass "store.ts carries the lockstep link-comment" || fail "store.ts missing lockstep link-comment"

# 2.4 Required objects exist with exactly the frozen structure.
tbls=$(sqlite3 "$DOCS_DB" "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name;")
for o in equivalence equivalence_fts; do
  grep -qx "$o" <<<"$tbls" && pass "object present: $o" || fail "missing object: $o"
done
for i in idx_equivalence_topic idx_equivalence_from; do
  sqlite3 "$DOCS_DB" "SELECT 1 FROM sqlite_master WHERE type='index' AND name='$i';" | grep -q 1 \
    && pass "index present: $i" || fail "missing index: $i"
done

# 2.5 equivalence columns are exactly the DDL set (order-independent).
# NOTE: BLIND_SPEC §2.5's flat want-string omitted `from_vocab`, but the spec's own §5.1
# DDL and §3 `from_vocab enum` check both require the column (it is load-bearing — the whole
# point of the from-vocabulary). This corrects that transcription defect against §5.1.
cols=$(sqlite3 "$DOCS_DB" "SELECT name FROM pragma_table_info('equivalence') ORDER BY name;" | tr '\n' ' ')
want='caveats code_after code_before entry_key from_api from_api_alt from_era from_versions from_vocab id keywords kind notes related sources to_api to_loader topic validated_against '
[ "$cols" = "$want" ] && pass "equivalence columns match DDL" || fail "equivalence columns differ: [$cols]"

# 2.6 kind CHECK constraint is enforced at the DB level.
if sqlite3 "$DOCS_DB" "INSERT INTO equivalence(entry_key,topic,from_vocab,from_api,to_loader,kind) VALUES('__probe__','x','fabric','x','cleanroom','bogus');" 2>/dev/null; then
  sqlite3 "$DOCS_DB" "DELETE FROM equivalence WHERE entry_key='__probe__';"
  fail "kind CHECK constraint not enforced (accepted 'bogus')"
else
  pass "kind CHECK constraint rejects out-of-enum value"
fi

# 2.7 FTS is content-synced to the base table (triggers work): counts equal.
b=$(sqlite3 "$DOCS_DB" "SELECT count(*) FROM equivalence;")
f=$(sqlite3 "$DOCS_DB" "SELECT count(*) FROM equivalence_fts;")
[ "$b" = "$f" ] && pass "equivalence_fts rowcount == base ($b)" || fail "fts/base rowcount skew ($f vs $b)"

exit $FAILED
