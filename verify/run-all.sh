# verify/run-all.sh
set -uo pipefail
cd "$(dirname "$0")/.."
source verify/env.sh
rc=0
for f in \
  verify/01_gates.sh \
  verify/02_schema.sh \
  verify/03_corpus.sh \
  verify/04_packaging.sh \
  verify/05_nongoals.sh \
  verify/08_concept.sh \
  verify/10_forcedl.sh ; do
  echo "== $f =="; bash "$f" || rc=1
done
echo "== verify/mcp-protocol.mjs =="; node verify/mcp-protocol.mjs || rc=1
[ "$rc" = 0 ] && echo "ALL GREEN" || echo "ORACLE RED"
exit $rc
