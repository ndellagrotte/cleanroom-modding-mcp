# verify/01_gates.sh
source verify/env.sh
cd "$REPO"

pnpm run build      >/tmp/p4_build.log 2>&1 && pass "build (tsc) green"        || fail "build"
pnpm run typecheck  >/tmp/p4_tc.log    2>&1 && pass "typecheck green"          || fail "typecheck"
pnpm run lint       >/tmp/p4_lint.log  2>&1 && pass "lint green"               || fail "lint"
pnpm run test       >/tmp/p4_test.log  2>&1 && pass "vitest green"             || fail "test"
pnpm run validate:equivalence >/tmp/p4_ve.log 2>&1 && pass "validate:equivalence green" || fail "validate:equivalence exists & passes"

# The C1 blocker: server must START without the "does not support prompts" crash.
timeout 10 bash -c "$SERVER_CMD </dev/null >/tmp/p4_boot.log 2>&1"; rc=$?
grep -qi 'does not support prompts' /tmp/p4_boot.log && fail "C1: prompts-capability startup crash present" || pass "C1: no prompts-capability crash on boot"
[ "$rc" = 124 -o "$rc" = 0 ] && pass "server boots (ran until timeout/clean exit)" || fail "server exited non-zero on boot ($rc)"

exit $FAILED
