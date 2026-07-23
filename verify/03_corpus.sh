# verify/03_corpus.sh
source verify/env.sh

# Property invariants over the corpus (every emitted line must end in PASS).
sql_out=$(sqlite3 "$DOCS_DB" < verify/corpus.sql)
echo "$sql_out"
if grep -q 'FAIL' <<<"$sql_out"; then fail "corpus.sql invariants"; else pass "corpus.sql invariants all PASS"; fi

# 3.1 Topic coverage floor: each of the 7 core seed topics MUST have >=1 entry.
for t in registration events networking mixins-access-transformers capabilities-attachments item-block-settings resources-datagen; do
  n=$(sqlite3 "$DOCS_DB" "SELECT count(*) FROM equivalence WHERE topic='$t';")
  [ "$n" -ge 1 ] && pass "topic seeded: $t ($n)" || fail "core seed topic empty: $t"
done
# resources-datagen must include the honest kind:missing row.
n=$(sqlite3 "$DOCS_DB" "SELECT count(*) FROM equivalence WHERE topic='resources-datagen' AND kind='missing';")
[ "$n" -ge 1 ] && pass "resources-datagen has a kind:missing entry" || fail "resources-datagen missing its kind:missing row"

exit $FAILED
