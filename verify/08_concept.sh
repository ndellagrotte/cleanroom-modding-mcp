# verify/08_concept.sh — static guardrails for the explain_concept banner (§4.3).
source verify/env.sh
grep -Eq 'CONCEPT_TO_TOPIC' "$REPO/src/services/concept-service.ts" \
  && pass "CONCEPT_TO_TOPIC map present" || fail "CONCEPT_TO_TOPIC map absent"
# Guard the R7 hazard: the equivalence lookup path must not route through expandConcept.
if awk '/equivalence/{e=NR} /expandConcept/{x=NR} END{exit !(e&&x&&(x>e-8&&x<e+8))}' "$REPO/src/services/concept-service.ts" 2>/dev/null; then
  fail "expandConcept appears adjacent to the equivalence lookup (R7 over-match risk)"
else
  pass "equivalence lookup not wired through expandConcept"
fi
grep -q 'Cross-loader differences' "$REPO/src/services/concept-service.ts" \
  && pass "formatForAI renders 'Cross-loader differences' section" || fail "banner section string missing"
grep -Eq 'equivalence\??\s*:' "$REPO/src/services/concept-service.ts" \
  && pass "ConceptExplanation.equivalence field present" || fail "ConceptExplanation.equivalence field missing"
exit $FAILED
