# verify/make-v1-db.sh — produces a schema-v1 docs.db from the v2 build, for P-DEGRADE.
source verify/env.sh
cp "$DOCS_DB" /tmp/docs_v1.db
sqlite3 /tmp/docs_v1.db "DROP TABLE IF EXISTS equivalence_fts; DROP TABLE IF EXISTS equivalence; UPDATE metadata SET value='1' WHERE key='schema_version';"
echo "/tmp/docs_v1.db"
