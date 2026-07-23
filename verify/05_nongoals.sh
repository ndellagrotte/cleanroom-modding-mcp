# verify/05_nongoals.sh
source verify/env.sh

# 5.1 modern-minecraft is NOT a Loader: never in LOADER_IDS, confined to equivalence surfaces.
grep -Eq "LOADER_IDS[^\n]*modern-minecraft" "$REPO/src/loaders.ts" 2>/dev/null \
  && fail "modern-minecraft leaked into LOADER_IDS" || pass "modern-minecraft absent from LOADER_IDS"
if grep -RIn "modern-minecraft" "$REPO/src" | grep -vqE 'equivalence|findEquivalent|find_equivalent|guide|backport|prompts|listTargets|\.test\.ts'; then
  grep -RIn "modern-minecraft" "$REPO/src" | grep -vE 'equivalence|findEquivalent|find_equivalent|guide|backport|prompts|listTargets|\.test\.ts'
  fail "modern-minecraft used outside the from-vocabulary surfaces"
else
  pass "modern-minecraft confined to from-vocabulary surfaces"
fi

# 5.2 No runtime YAML parsing: nothing under dist/ imports a yaml parser.
if grep -RIlE "from ['\"]yaml['\"]|require\(['\"]yaml['\"]\)" "$REPO/dist" 2>/dev/null; then
  fail "dist/ imports a YAML parser (runtime YAML forbidden)"
else
  pass "no runtime YAML parsing in dist/"
fi

# 5.3 Equivalence rows are NOT injected into the documents/chunks FTS corpus.
n=$(sqlite3 "$DOCS_DB" "SELECT count(*) FROM documents WHERE url LIKE 'cleanroom://equivalence/%';" 2>/dev/null || echo 0)
[ "${n:-0}" = 0 ] && pass "no equivalence rows polluted into documents table" || fail "equivalence leaked into documents ($n)"

# 5.4 No resources/subscribe capability, no listChanged flags.
grep -Eq "subscribe\s*:\s*true|listChanged\s*:\s*true" "$REPO/src/index.ts" \
  && fail "subscribe/listChanged flag set (forbidden)" || pass "no subscribe/listChanged flags"

exit $FAILED
