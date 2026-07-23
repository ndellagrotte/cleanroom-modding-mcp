# verify/04_packaging.sh
source verify/env.sh
cd "$REPO"

# 4.1 Templates & guides are committed .ts content modules (so tsc copies them into dist).
[ -d "$REPO/src/templates" ] && pass "src/templates/ exists" || fail "src/templates/ missing"
[ -d "$REPO/src/guides" ]    && pass "src/guides/ exists"    || fail "src/guides/ missing"

# 4.2 After build, the modules land in dist (the C2 fix — plain tsc copies no non-TS assets).
[ -d "$REPO/dist/templates" ] && pass "dist/templates present" || fail "dist/templates missing (C2 regression)"
[ -d "$REPO/dist/guides" ]    && pass "dist/guides present"    || fail "dist/guides missing (C2 regression)"

# 4.3 The npm tarball ships dist/ but NOT the maintainer scripts or raw YAML/template pins.
pnpm pack --pack-destination /tmp >/tmp/p4_pack.log 2>&1
TGZ=$(ls -t /tmp/*.tgz | head -1)
tar tzf "$TGZ" > /tmp/p4_tar.txt
grep -q 'package/dist/templates/' /tmp/p4_tar.txt && pass "tarball ships dist/templates" || fail "tarball omits dist/templates"
grep -q 'package/dist/guides/'    /tmp/p4_tar.txt && pass "tarball ships dist/guides"    || fail "tarball omits dist/guides"
grep -qE 'package/(scripts/vendor-template|data/equivalence/.*\.yaml)' /tmp/p4_tar.txt \
  && fail "tarball leaks build-only assets (vendor script / raw YAML)" || pass "tarball excludes build-only assets"

# 4.4 yaml is a devDependency only (build-only; no dist/ code parses YAML — §2 non-goal).
node -e 'const p=require("'"$REPO"'/package.json"); process.exit(p.dependencies&&p.dependencies.yaml?1:0)' \
  && pass "yaml not in runtime dependencies" || fail "yaml leaked into runtime dependencies"
node -e 'const p=require("'"$REPO"'/package.json"); process.exit(p.devDependencies&&p.devDependencies.yaml?0:1)' \
  && pass "yaml present as devDependency" || fail "yaml missing from devDependencies"

# 4.5 templates-pins manifest exists with per-branch SHAs (§9), at least main + mixin.
node -e 'const m=require("'"$REPO"'/data/templates-pins.json"); const k=Object.keys(m.branches||m); if(k.includes("main")&&k.includes("mixin"))process.exit(0);process.exit(1)' \
  && pass "templates-pins.json records main+mixin SHAs" || fail "templates-pins.json missing main/mixin pins"

# 4.6 Template vendoring fidelity — raw {{ }} tokens intact + annotation naming the tokens.
tokencount=$(grep -rl '{{' "$REPO"/src/templates/*.ts 2>/dev/null | wc -l)
[ "$tokencount" -ge 1 ] && pass "template modules preserve {{ }} blossom tokens" || fail "no {{ }} tokens found — templates were wrongly expanded"
grep -rqiE 'mod_id|root_package|is_coremod|use_access_transformer' "$REPO"/src/templates/*.ts \
  && pass "template annotation names the blossom tokens" || fail "template annotation block absent"

exit $FAILED
