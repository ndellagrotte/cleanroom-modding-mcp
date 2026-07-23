# verify/02_schema.sh
source verify/env.sh

# 2.1 docs.db reports schema_version 2.
v=$(sqlite3 "$DOCS_DB" "SELECT value FROM metadata WHERE key='schema_version';")
[ "$v" = 2 ] && pass "docs.db schema_version==2" || fail "docs.db schema_version is '$v', want 2"

# 2.2 Source-of-truth constants agree (grep is exact; both must say 2).
grep -Eq 'SCHEMA_VERSION\s*=\s*2\b' "$REPO/src/indexer/store.ts" \
  && pass "store.ts SCHEMA_VERSION=2" || fail "store.ts SCHEMA_VERSION not 2"
grep -Eq 'schemaVersion\s*:\s*2\b' "$REPO/src/dbs.ts" \
  && pass "dbs.ts DBS.docs.schemaVersion=2 (lockstep)" || fail "dbs.ts docs.schemaVersion not 2"

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
