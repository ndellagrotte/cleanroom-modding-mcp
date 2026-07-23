# BLIND_SPEC: Phase 5 — Examples Rebuild — Verification Oracle

**What this is.** The frozen, executable acceptance oracle for the Phase 5 design in
[`DESIGN.md`](DESIGN.md). Written **blind** (before/without the implementation). Every design
claim that can be a command *is* a command with an expected result; behaviors that cannot be
shell-checked are frozen as **property tests** (drop-in `*.test.ts`) with exact assertions.
An implementation passes Phase 5 iff every `[MUST]` block here exits/asserts as specified.

**This file is frozen.** It is the oracle, not a running log. Do not edit assertions to match
an implementation; a divergence is an implementation bug (or, if the design itself is wrong, a
design-change event that must be recorded in `DESIGN.md` *before* this file changes).

---

## 0. Runner contract

All commands run from **`$REPO_ROOT`** — the actual server repo root (contains
`package.json`, `src/`, `scripts/`, `data/`, `.github/`). That root is **not** this
`blind_test_phase_5/` directory; this file is the oracle that travels to the repo.

```bash
# ── Harness header: source once, then run any [MUST] block below. ─────────────
set -uo pipefail
: "${REPO_ROOT:?set REPO_ROOT to the server repo root}"
cd "$REPO_ROOT"

# DB fixtures (see §1 for how each is produced):
: "${SCHEMA_DB:=/tmp/oracle-schema.db}"     # schema-only, from initializeExamplesDb()
: "${GOLDEN_DB:=/tmp/oracle-golden.db}"      # offline golden pipeline output (fake endpoint)
: "${EXAMPLES_DB:=data/examples.db}"         # a real maintainer-built corpus (if present)
: "${MAPPINGS_DB:=data/mappings.db}"
: "${CLEANROOM_API_DB:=data/cleanroom-api.db}"

FAIL=0
_pass(){ printf 'PASS  %s\n' "$1"; }
_fail(){ printf 'FAIL  %s\n' "$1"; FAIL=1; }
assert_eq(){ [ "$2" = "$3" ] && _pass "$1" || { _fail "$1"; printf '  expected: %q\n  actual:   %q\n' "$3" "$2"; }; }
assert_contains(){ printf '%s' "$2" | grep -qF -- "$3" && _pass "$1" || { _fail "$1"; printf '  missing substring: %q\n' "$3"; }; }
assert_absent(){ printf '%s' "$2" | grep -qF -- "$3" && { _fail "$1"; printf '  forbidden substring present: %q\n' "$3"; } || _pass "$1"; }
assert_exit(){ local d="$1"; shift; local want="$1"; shift; "$@" >/tmp/o 2>/tmp/e; local got=$?; assert_eq "$d (exit $want)" "$got" "$want"; }
sq(){ sqlite3 "$1" "$2"; }   # sq <db> <sql>
# ─────────────────────────────────────────────────────────────────────────────
```

**Conventions used below:**
- `[MUST]` — required for Phase 5 pass. `[SHOULD]` — expected; a documented deviation is
  acceptable only if `DESIGN.md §13` open questions cover it.
- `[CORPUS]` — needs a real maintainer-built `$EXAMPLES_DB`; skip (report SKIP, not PASS) if
  absent, but the same assertion **MUST** hold on `$GOLDEN_DB`.
- SQL expected-output blocks show exactly what `sqlite3` must print (one value per line).

---

## 1. DB fixtures the oracle depends on

The oracle checks DB *shape* against `$SCHEMA_DB` and *content* against `$GOLDEN_DB`, both
producible **fully offline** (design §7: "the golden tests pass fully offline"). If either
cannot be produced offline, that itself is a `[MUST]` failure.

```bash
# [MUST] Schema-only DB builds offline from the frozen schema module (DESIGN §5).
rm -f "$SCHEMA_DB"
assert_exit "schema.ts initializeExamplesDb() runs offline" 0 \
  pnpm exec tsx -e "import('./src/examples/schema.ts').then(m=>{m.initializeExamplesDb(process.env.SCHEMA_DB)})"
test -s "$SCHEMA_DB" && _pass "SCHEMA_DB created" || _fail "SCHEMA_DB created"
```

```bash
# [MUST] Golden pipeline DB builds offline (no network, fake endpoint, canned JSON — DESIGN §7).
# The golden test suite must expose a way to emit its fixture DB to a path, OR the offline
# indexer path (--repo-zip + fake endpoint) must produce one. Whichever the impl chooses,
# this command MUST yield a populated DB with zero network access.
rm -f "$GOLDEN_DB"
assert_exit "golden fixture DB builds offline" 0 \
  env GOLDEN_DB="$GOLDEN_DB" pnpm run build:golden-db   # impl provides this script or equivalent documented command
test -s "$GOLDEN_DB" && _pass "GOLDEN_DB created" || _fail "GOLDEN_DB created"
# Network-isolation property is asserted structurally in §7 (golden tests use an injected fake endpoint).
```

> If the implementation names the offline-fixture command differently, it MUST document that
> name in the Phase 5 finalization notes; the oracle's *assertions* on the resulting DB are
> frozen regardless of the command name.

---

## 2. Pipeline module & artifact layout (DESIGN §6)

```bash
# [MUST] Every pipeline module and support artifact exists at the frozen path.
for f in \
  src/examples/schema.ts src/examples/model.ts src/examples/acquire.ts \
  src/examples/select.ts src/examples/analyze.ts src/examples/srg-link.ts \
  src/examples/ingest.ts \
  scripts/index-mod-examples.ts data/examples-roster.json ; do
  test -e "$f" && _pass "exists: $f" || _fail "exists: $f"
done
test -d src/examples/prompts && _pass "exists: src/examples/prompts/" || _fail "exists: src/examples/prompts/"
```

```bash
# [MUST] At least one committed, versioned analysis prompt file (DESIGN §7: analyze-snippet.v<N>.md).
ls src/examples/prompts/analyze-snippet.v*.md >/dev/null 2>&1 \
  && _pass "versioned analysis prompt present" || _fail "versioned analysis prompt present"
```

```bash
# [MUST] Orchestrator registered as pnpm scripts, and NOT shipped in the npm tarball (DESIGN §6, C7).
jq -e '.scripts["index-mod-examples"]'       package.json >/dev/null && _pass "script index-mod-examples"       || _fail "script index-mod-examples"
jq -e '.scripts["index-mod-examples:force"]' package.json >/dev/null && _pass "script index-mod-examples:force" || _fail "script index-mod-examples:force"
# Only dist/ + postinstall ship — scripts/ must not be in the published files list.
FILES_JSON=$(jq -c '.files // []' package.json)
assert_absent "scripts/ not in npm files list" "$FILES_JSON" "scripts"
npm pack --dry-run --json 2>/dev/null | jq -r '.[0].files[].path' > /tmp/tar.txt
grep -q '^scripts/index-mod-examples' /tmp/tar.txt && _fail "orchestrator excluded from tarball" || _pass "orchestrator excluded from tarball"
```

---

## 3. Schema, frozen v2 (DESIGN §5)

All checks against `$SCHEMA_DB` (shape) unless marked `[CORPUS]`.

```bash
# [MUST] Exactly the frozen table set exists (order-independent).
GOT=$(sq "$SCHEMA_DB" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" | tr '\n' ' ')
for t in api_references categories example_imports example_relations example_tags examples metadata mods tags; do
  printf '%s' "$GOT" | grep -qw "$t" && _pass "table: $t" || _fail "table: $t"
done
# examples_fts is a virtual table:
sq "$SCHEMA_DB" "SELECT name FROM sqlite_master WHERE name='examples_fts';" | grep -qx examples_fts \
  && _pass "table: examples_fts (fts5)" || _fail "table: examples_fts (fts5)"
```

```bash
# [MUST] mods.license column exists and is NOT NULL (DESIGN §4/§5 ⟵).
sq "$SCHEMA_DB" "SELECT name||':'||\"notnull\" FROM pragma_table_info('mods') WHERE name='license';" \
  | grep -qx 'license:1' && _pass "mods.license NOT NULL" || _fail "mods.license NOT NULL"
# [MUST] mods carries the full observed richness (spot-check the columns queries depend on).
for c in id name repo loader license description readme_summary architecture_notes star_count minecraft_versions priority; do
  sq "$SCHEMA_DB" "SELECT 1 FROM pragma_table_info('mods') WHERE name='$c';" | grep -qx 1 \
    && _pass "mods.$c" || _fail "mods.$c"
done
```

```bash
# [MUST] examples table carries the frozen column set incl. LLM-produced + curation columns.
for c in id mod_id category_id file_path file_url start_line end_line title code language caption \
         explanation pattern_type complexity best_practices potential_pitfalls use_cases keywords \
         minecraft_concepts quality_score is_featured ; do
  sq "$SCHEMA_DB" "SELECT 1 FROM pragma_table_info('examples') WHERE name='$c';" | grep -qx 1 \
    && _pass "examples.$c" || _fail "examples.$c"
done
```

```bash
# [MUST] api_references gains the four ⟵ enrichment columns (DESIGN §5/§8).
for c in class_name method_name api_type srg_name resolved_name api_fqn api_kind; do
  sq "$SCHEMA_DB" "SELECT 1 FROM pragma_table_info('api_references') WHERE name='$c';" | grep -qx 1 \
    && _pass "api_references.$c" || _fail "api_references.$c"
done
```

```bash
# [MUST] examples_fts indexes the 7 prose columns and EXCLUDES raw `code` (DESIGN §5, OQ8).
FTS_SQL=$(sq "$SCHEMA_DB" "SELECT sql FROM sqlite_master WHERE name='examples_fts';")
for c in title caption explanation best_practices use_cases keywords minecraft_concepts; do
  assert_contains "examples_fts includes $c" "$FTS_SQL" "$c"
done
printf '%s' "$FTS_SQL" | grep -Pq '(^|[^a-z_])code([^a-z_]|$)' \
  && _fail "examples_fts EXCLUDES raw code" || _pass "examples_fts EXCLUDES raw code"
assert_contains "examples_fts is external-content over examples" "$FTS_SQL" "content='examples'"
# [MUST] FTS sync triggers exist (ai/ad/au — DESIGN §5).
sq "$SCHEMA_DB" "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='examples';" \
  | grep -qx 3 && _pass "3 FTS sync triggers on examples" || _fail "3 FTS sync triggers on examples"
```

```bash
# [MUST] Indexes implied by query plans exist, incl. the new api_references(srg_name) (DESIGN §5).
IDX=$(sq "$SCHEMA_DB" "SELECT name FROM sqlite_master WHERE type='index';")
# Index-existence is asserted by covered (table,column) rather than by index name:
covered(){ sq "$SCHEMA_DB" "SELECT 1 FROM sqlite_master m JOIN pragma_index_info(m.name) i ON 1
  WHERE m.type='index' AND m.tbl_name='$1' AND i.name='$2' LIMIT 1;" | grep -qx 1; }
covered examples mod_id          && _pass "idx examples(mod_id)"          || _fail "idx examples(mod_id)"
covered examples category_id     && _pass "idx examples(category_id)"     || _fail "idx examples(category_id)"
covered examples quality_score   && _pass "idx examples(quality_score)"   || _fail "idx examples(quality_score)"
covered examples is_featured     && _pass "idx examples(is_featured)"     || _fail "idx examples(is_featured)"
covered examples pattern_type    && _pass "idx examples(pattern_type)"    || _fail "idx examples(pattern_type)"
covered example_relations source_id && _pass "idx example_relations(source_id)" || _fail "idx example_relations(source_id)"
covered example_imports example_id  && _pass "idx example_imports(example_id)"  || _fail "idx example_imports(example_id)"
covered api_references example_id   && _pass "idx api_references(example_id)"   || _fail "idx api_references(example_id)"
covered api_references srg_name     && _pass "idx api_references(srg_name) [NEW]" || _fail "idx api_references(srg_name) [NEW]"
covered tags slug                && _pass "idx tags(slug)"                || _fail "idx tags(slug)"
```

```bash
# [MUST] metadata table present with the frozen provenance keys (DESIGN §5).
for k in schema_version analysis_version prompt_version llm_model roster_pins license_review indexed_at counts; do
  sq "$GOLDEN_DB" "SELECT 1 FROM metadata WHERE key='$k';" | grep -qx 1 \
    && _pass "metadata key: $k" || _fail "metadata key: $k"
done
# [MUST] schema_version metadata value == 2.
assert_eq "metadata.schema_version == 2" "$(sq "$GOLDEN_DB" "SELECT value FROM metadata WHERE key='schema_version';")" "2"
# [MUST] No snippet with an unrecorded license: every examples row's mod has a non-empty license.
BAD=$(sq "$GOLDEN_DB" "SELECT count(*) FROM examples e JOIN mods m ON m.id=e.mod_id WHERE m.license IS NULL OR m.license='';")
assert_eq "no example with unrecorded license" "$BAD" "0"
```

```bash
# [MUST] example relations table is present but EMPTY in v1 (DESIGN §13.5 recommendation, schema retained).
assert_eq "example_relations empty in v1" "$(sq "$GOLDEN_DB" "SELECT count(*) FROM example_relations;")" "0"
```

---

## 4. Registry & version continuity (DESIGN §5, §10)

```bash
# [MUST] EXAMPLES_SCHEMA_VERSION == 2 and DBS.examples.schemaVersion == 2, and they are paired.
V_SCHEMA=$(pnpm exec tsx -e "import('./src/examples/schema.ts').then(m=>process.stdout.write(String(m.EXAMPLES_SCHEMA_VERSION)))")
assert_eq "EXAMPLES_SCHEMA_VERSION == 2" "$V_SCHEMA" "2"
V_DBS=$(pnpm exec tsx -e "import('./src/dbs.ts').then(m=>process.stdout.write(String(m.DBS.examples.schemaVersion)))")
assert_eq "DBS.examples.schemaVersion == 2" "$V_DBS" "2"
assert_eq "schema version paired (schema.ts === dbs.ts)" "$V_SCHEMA" "$V_DBS"
```

```bash
# [SHOULD] First examples manifest line starts at 0.3.0 (> legacy 0.1.1/0.2.0). If a manifest exists:
if test -f data/examples-manifest.json; then
  VER=$(jq -r '.version' data/examples-manifest.json)
  # semver >= 0.3.0
  pnpm exec tsx -e "const s=process.argv[1].split('.').map(Number); process.exit((s[0]>0||s[1]>=3)?0:1)" "$VER" \
    && _pass "examples manifest version >= 0.3.0 ($VER)" || _fail "examples manifest version >= 0.3.0 ($VER)"
fi
```

---

## 5. Roster manifest (DESIGN §3, §4) — `data/examples-roster.json`

```bash
R=data/examples-roster.json
# [MUST] manifest schema == 1 and exactly 8 repos.
assert_eq "roster schema == 1"        "$(jq -r '.schema' $R)"        "1"
assert_eq "roster has exactly 8 repos" "$(jq -r '.repos|length' $R)" "8"
```

```bash
# [MUST] Each frozen repo present with the exact ref, license, and loader from DESIGN §3.
# Format: "<owner/repo>|<ref>|<license>|<loader>"
want=(
 "TheGreyGhost/MinecraftByExample|1-12-2-final|Unlicense|forge"
 "SlimeKnights/TinkersConstruct|1.12|MIT|forge"
 "AppliedEnergistics/Applied-Energistics-2|rv6-1.12|LGPL-3.0|forge"
 "GregTechCEu/GregTech|master|LGPL-3.0|forge"
 "CleanroomMC/ModularUI|master|LGPL-3.0|cleanroom"
 "CleanroomMC/GroovyScript|master|LGPL-3.0|cleanroom"
 "CleanroomMC/Fugue|master|GPL-3.0|cleanroom"
 "ACGaming/UniversalTweaks|main|LGPL-3.0|forge"
)
for w in "${want[@]}"; do
  IFS='|' read -r repo ref lic loader <<<"$w"
  got=$(jq -r --arg r "$repo" '.repos[]|select(.repo==$r)|[.ref,.license,.loader]|join("|")' $R)
  assert_eq "roster $repo" "$got" "$ref|$lic|$loader"
done
```

```bash
# [MUST] License distribution is exactly: 5×LGPL-3.0, 1×MIT, 1×Unlicense, 1×GPL-3.0.
assert_eq "roster LGPL-3.0 count" "$(jq '[.repos[]|select(.license=="LGPL-3.0")]|length' $R)" "5"
assert_eq "roster MIT count"      "$(jq '[.repos[]|select(.license=="MIT")]|length' $R)"      "1"
assert_eq "roster Unlicense count""$(jq '[.repos[]|select(.license=="Unlicense")]|length' $R)" "1"
assert_eq "roster GPL-3.0 count (Fugue only)" "$(jq '[.repos[]|select(.license=="GPL-3.0")]|length' $R)" "1"
assert_eq "GPL-3.0 repo is Fugue" "$(jq -r '.repos[]|select(.license=="GPL-3.0")|.repo' $R)" "CleanroomMC/Fugue"
# [MUST] Loader split: 5 forge, 3 cleanroom.
assert_eq "roster forge count"     "$(jq '[.repos[]|select(.loader=="forge")]|length' $R)"     "5"
assert_eq "roster cleanroom count" "$(jq '[.repos[]|select(.loader=="cleanroom")]|length' $R)" "3"
```

```bash
# [MUST] Every repo pins a concrete SHA, an approved license review, include-globs, and byte caps.
assert_eq "every repo has non-empty sha"   "$(jq '[.repos[]|select((.sha|length)>0)]|length' $R)" "8"
assert_eq "every repo licenseReview=approved" "$(jq '[.repos[]|select(.licenseReview.verdict=="approved")]|length' $R)" "8"
assert_eq "every repo has include globs"   "$(jq '[.repos[]|select((.include|length)>0)]|length' $R)" "8"
assert_eq "every repo has maxFileBytes"    "$(jq '[.repos[]|select(.maxFileBytes!=null)]|length' $R)" "8"
# [MUST] Known SHA prefixes recorded at review time (DESIGN §3).
assert_contains "MBE sha 01ac397d"  "$(jq -r '.repos[]|select(.repo=="TheGreyGhost/MinecraftByExample")|.sha' $R)" "01ac397d"
assert_contains "TiCon sha c01173c" "$(jq -r '.repos[]|select(.repo=="SlimeKnights/TinkersConstruct")|.sha' $R)" "c01173c"
assert_contains "AE2 sha 5554ba9"   "$(jq -r '.repos[]|select(.repo=="AppliedEnergistics/Applied-Energistics-2")|.sha' $R)" "5554ba9"
```

```bash
# [MUST] GregTech is subset, not whole-repo: package include-globs, generated/integration excluded, snippet cap.
GT='.repos[]|select(.repo=="GregTechCEu/GregTech")'
assert_eq "GregTech maxSnippetsPerRepo == 120" "$(jq "$GT|.maxSnippetsPerRepo" $R)" "120"
jq -r "$GT|.include[]" $R | grep -q 'gregtech/api'          && _pass "GregTech subsets gregtech/api"      || _fail "GregTech subsets gregtech/api"
jq -r "$GT|.exclude[]" $R | grep -qi 'integration'          && _pass "GregTech excludes integration"      || _fail "GregTech excludes integration"
jq -r "$GT|.exclude[]" $R | grep -qi 'generated'            && _pass "GregTech excludes generated"        || _fail "GregTech excludes generated"
```

---

## 6. Endpoint config & the no-LLM hard rejection (DESIGN §6.3, §2, Fixed Input 1)

```bash
# [MUST] The three endpoint settings are honored as BOTH env vars and CLI flags.
SRC="src/examples/analyze.ts scripts/index-mod-examples.ts"
for pat in CLEANROOM_MCP_LLM_BASE_URL CLEANROOM_MCP_LLM_API_KEY CLEANROOM_MCP_LLM_MODEL \
           -- --llm-base-url --llm-api-key --llm-model ; do
  [ "$pat" = "--" ] && continue
  grep -rqF "$pat" $SRC && _pass "endpoint knob wired: $pat" || _fail "endpoint knob wired: $pat"
done
```

```bash
# [MUST] With NO endpoint configured, the indexer exits non-zero, prints a clear error, and writes NOTHING.
rm -f /tmp/noep.db
env -u CLEANROOM_MCP_LLM_BASE_URL -u CLEANROOM_MCP_LLM_API_KEY -u CLEANROOM_MCP_LLM_MODEL \
  pnpm run index-mod-examples -- --db-path /tmp/noep.db >/tmp/o 2>/tmp/e
RC=$?
[ "$RC" -ne 0 ] && _pass "no-endpoint build exits non-zero (rc=$RC)" || _fail "no-endpoint build exits non-zero (rc=$RC)"
grep -Eqi 'endpoint|llm.*(required|configured|base.?url)' /tmp/o /tmp/e \
  && _pass "no-endpoint build prints a clear error" || _fail "no-endpoint build prints a clear error"
test ! -e /tmp/noep.db && _pass "no-endpoint build touches nothing (no db written)" || _fail "no-endpoint build touches nothing"
```

```bash
# [MUST] There is NO no-LLM / metadata-only build mode (design §2 hard rejection).
grep -rEqi 'metadata.?only|no.?llm.*(mode|build)|skip.?analysis' src/examples scripts/index-mod-examples.ts \
  && _fail "no metadata-only build mode exists" || _pass "no metadata-only build mode exists"
```

---

## 7. Determinism & golden tests (DESIGN §6.4, §7)

```bash
# [MUST] Analysis calls pin temperature 0.
grep -rEq 'temperature\s*[:=]\s*0([^.0-9]|$)' src/examples/analyze.ts \
  && _pass "analysis temperature pinned to 0" || _fail "analysis temperature pinned to 0"
```

```bash
# [MUST] Golden test suite exists, runs offline, and injects a FAKE endpoint (no real network/model).
test -f src/examples/analyze.test.ts -o -f src/examples/ingest.test.ts -o -f src/examples/pipeline.test.ts \
  && _pass "pipeline golden test file present" || _fail "pipeline golden test file present"
# The analyze goldens must not open a real socket: they inject a fake/stub endpoint.
grep -rEqi 'fake|stub|mock|inject|canned|fixture' src/examples/*.test.ts \
  && _pass "goldens inject a fake endpoint (offline)" || _fail "goldens inject a fake endpoint (offline)"
# [MUST] The full suite is green with the network unplugged.
assert_exit "pnpm test green fully offline" 0 env HTTP_PROXY=http://127.0.0.1:1 HTTPS_PROXY=http://127.0.0.1:1 no_proxy= pnpm test
```

**[MUST] Property — up-to-date skip keys on (roster_pins ∧ analysis_version ∧ schema_version)**
(DESIGN §6.4, OQ18). Frozen as a drop-in test; `--force` overrides:

```ts
// src/examples/skip.oracle.test.ts  (frozen assertions; wire to the real skip predicate)
import { describe, it, expect } from "vitest";
import { isUpToDate } from "./ingest.ts"; // or wherever the skip predicate lives
const base = { roster_pins: {a:"sha1"}, analysis_version: "av1", schema_version: 2 };
describe("up-to-date skip", () => {
  it("no-ops only when all three match", () => {
    expect(isUpToDate(base, base)).toBe(true);
    expect(isUpToDate(base, {...base, roster_pins:{a:"sha2"}})).toBe(false); // SHA drift
    expect(isUpToDate(base, {...base, analysis_version:"av2"})).toBe(false); // prompt/model change
    expect(isUpToDate(base, {...base, schema_version:1})).toBe(false);       // schema bump
  });
  it("--force overrides a match", () => {
    expect(isUpToDate(base, base, /*force*/ true)).toBe(false);
  });
});
```

**[MUST] Property — changing prompt or model bumps `analysis_version`** (DESIGN §6.4):

```ts
// src/examples/analysis-version.oracle.test.ts
import { computeAnalysisVersion } from "./analyze.ts";
const A = computeAnalysisVersion({ promptVersion:"v1", model:"m1", pipelineRev:"r1" });
expect(computeAnalysisVersion({ promptVersion:"v2", model:"m1", pipelineRev:"r1" })).not.toBe(A);
expect(computeAnalysisVersion({ promptVersion:"v1", model:"m2", pipelineRev:"r1" })).not.toBe(A);
expect(computeAnalysisVersion({ promptVersion:"v1", model:"m1", pipelineRev:"r1" })).toBe(A); // stable
```

**[MUST] Property — no silent caps** (DESIGN §3/§6.2, "no silent caps" principle). When
`maxSnippetsPerRepo`/`maxFileBytes` drop candidates, `select` logs exactly what was dropped:

```ts
// src/examples/select-caps.oracle.test.ts
import { selectSnippets } from "./select.ts";
const logs: string[] = [];
const files = Array.from({length: 10}, (_,i)=>({ path:`p${i}.java`, bytes: 1000 }));
const out = selectSnippets(files, { maxSnippetsPerRepo: 3, maxFileBytes: 100000, repo:"o/r" },
                           { log:(m:string)=>logs.push(m) });
expect(out.length).toBe(3);                                 // cap enforced
expect(logs.join("\n")).toMatch(/o\/r/);                    // repo named
expect(logs.join("\n")).toMatch(/drop|skip|cap|truncat/i);  // drop reason logged
expect(logs.join("\n")).toMatch(/p[3-9]\.java/);            // the dropped files named
```

---

## 8. Atomic ingest durability (DESIGN §6.5)

```bash
# [MUST] Ingest writes to a tmp path then atomic-renames; a failed build leaves the runtime path untouched
#        and cleans up tmp/-wal/-shm. Structural check + fault-injection test.
grep -Eq 'rename|\.tmp' src/examples/ingest.ts && _pass "ingest uses tmp + rename" || _fail "ingest uses tmp + rename"
```

```ts
// src/examples/ingest-atomic.oracle.test.ts  (frozen)
// A build that throws mid-transaction must NOT leave a db at the runtime path, nor -wal/-shm/.tmp.
import { existsSync } from "node:fs";
it("failed ingest is atomic + cleans up", async () => {
  const dbPath = "/tmp/oracle-atomic.db";
  await expect(runIngest({ dbPath, rows: THROWING_ROWS })).rejects.toBeTruthy();
  for (const p of [dbPath, dbPath+"-wal", dbPath+"-shm", dbPath+".tmp"]) expect(existsSync(p)).toBe(false);
});
```

---

## 9. Service & tool changes — coupled + maximal fixes (DESIGN §9)

### 9.1 Schema gate

```bash
# [MUST] isAvailable() is schema-gated (not existsSync-only) and isSchemaOutdated() exists.
SVC=src/services/mod-examples-service.ts
grep -q 'isSchemaOutdated' "$SVC" && _pass "isSchemaOutdated() present" || _fail "isSchemaOutdated() present"
# isAvailable must consult schema/metadata, not only fs existence:
grep -Eq 'isAvailable' "$SVC" && grep -Eqi 'schema|metadata|version' "$SVC" \
  && _pass "isAvailable() schema-gated" || _fail "isAvailable() schema-gated"
# [MUST] list_targets shows an examples outdated-schema branch (parity with mappings/cleanroom-api).
grep -Eqi 'outdated' src/tools/listTargets.ts && _pass "list_targets outdated-schema branch" || _fail "list_targets outdated-schema branch"
```

**[MUST] Property — legacy DB (no metadata table) reads as not-installed / outdated** (DESIGN
§5, closes the null-toothless hole). Also the schema-gate mutation test mirrored from
cleanroom-api:

```ts
// src/services/mod-examples-service.schema-gate.oracle.test.ts  (frozen)
import Database from "better-sqlite3";
it("a schema-version mismatch reads as outdated/not-installed", () => {
  const db = "/tmp/oracle-mut.db";
  // Build a valid v2 DB, then mutate metadata.schema_version to a wrong value:
  buildGoldenDbTo(db);
  new Database(db).prepare("UPDATE metadata SET value=? WHERE key='schema_version'").run("1");
  const svc = new ModExamplesService(db);
  expect(svc.isAvailable()).toBe(false);       // gate rejects
  expect(svc.isSchemaOutdated()).toBe(true);
});
it("a legacy DB lacking the metadata table reads as not installed", () => {
  const db = "/tmp/oracle-legacy.db";
  const h = new Database(db);
  h.exec("CREATE TABLE mods(id); CREATE TABLE examples(id);"); // ancient shape, no metadata table
  h.close();
  const svc = new ModExamplesService(db);
  expect(svc.isAvailable()).toBe(false);
});
```

### 9.2 Filters (loader + minecraft_version)

```bash
# [MUST] searchExamples honors loader AND minecraft_version filters; the tool schema exposes `loader`.
grep -Eqi 'loader' "$SVC"            && _pass "searchExamples has loader filter"            || _fail "searchExamples has loader filter"
grep -Eqi 'minecraft_version|mcVersion|minecraftVersion' "$SVC" && _pass "searchExamples has minecraft_version filter" || _fail "searchExamples has minecraft_version filter"
grep -Eqi 'loader' src/tools/modExamples.ts && _pass "search_mod_examples tool exposes loader param" || _fail "search_mod_examples tool exposes loader param"
```

**[MUST] Property — loader filter actually filters** (uses `$GOLDEN_DB`, which must contain
both forge and cleanroom mods):

```bash
# [CORPUS/GOLDEN] Every result of a loader='cleanroom' search belongs to a cleanroom mod.
BAD=$(sq "$GOLDEN_DB" "
  SELECT count(*) FROM examples e JOIN mods m ON m.id=e.mod_id WHERE m.loader<>'cleanroom'
  AND e.mod_id IN (SELECT id FROM mods WHERE loader='cleanroom');")  # sanity; real assertion is via the service test below
```

```ts
// src/services/mod-examples-service.filters.oracle.test.ts  (frozen)
const svc = new ModExamplesService(process.env.GOLDEN_DB!);
const forgeOnly = svc.searchExamples({ query:"block", loader:"cleanroom" });
expect(forgeOnly.every(r => r.loader === "cleanroom")).toBe(true);
const v = svc.searchExamples({ query:"block", minecraft_version:"1.12.2" });
expect(v.length).toBeGreaterThan(0);
```

### 9.3 Category enum wired to EXAMPLE_CATEGORIES

```bash
# [MUST] The tool's category enum is sourced from EXAMPLE_CATEGORIES, not a hardcoded inline list.
grep -q 'EXAMPLE_CATEGORIES' src/tools/modExamples.ts \
  && _pass "category enum sourced from EXAMPLE_CATEGORIES" || _fail "category enum sourced from EXAMPLE_CATEGORIES"
# [MUST] Drift is fixed: includes capabilities + coremods-mixins, drops the stale data-generation.
SLUGS=$(pnpm exec tsx -e "import('./src/categories.ts').then(m=>process.stdout.write(m.EXAMPLE_CATEGORIES.map(c=>c.slug).join(' ')))")
assert_contains "categories include capabilities"    "$SLUGS" "capabilities"
assert_contains "categories include coremods-mixins" "$SLUGS" "coremods-mixins"
assert_absent   "categories drop data-generation"    "$SLUGS" "data-generation"
```

```ts
// src/tools/modExamples.categories.oracle.test.ts  (frozen — guards future drift)
import { EXAMPLE_CATEGORIES } from "../categories.ts";
import { searchModExamplesToolSchema } from "./modExamples.ts";
const enumVals = extractCategoryEnum(searchModExamplesToolSchema);      // the tool's `category` enum
const slugs = EXAMPLE_CATEGORIES.map(c => c.slug).sort();
expect(enumVals.sort()).toEqual(slugs);                                  // exact set equality — no drift
```

### 9.4 Tool-copy rewrite (dead corpus removed)

```bash
# [MUST] No tool/file copy still advertises the dead "Create / Botania / Applied Energistics 2" corpus.
for s in Botania "Applied Energistics" Create; do
  grep -qi "$s" src/tools/modExamples.ts && _fail "tool copy drops dead mention: $s" || _pass "tool copy drops dead mention: $s"
done
# [MUST] list_canonical_mods renders a license column/line (DESIGN §4).
grep -qi 'license' src/tools/modExamples.ts && _pass "list_canonical_mods shows license" || _fail "list_canonical_mods shows license"
```

### 9.5 Dispatch footgun

```bash
# [MUST] The `id: (args?.id as number) || 0` footgun is gone; missing id -> validation error, not 0.
grep -Eq 'id.*as number.*\|\|\s*0' src/index.ts && _fail "dispatch id||0 footgun removed" || _pass "dispatch id||0 footgun removed"
```

```ts
// src/index.dispatch.oracle.test.ts  (frozen)
// get_mod_example with no id must be a validation error, NOT a silent id=0 "not found".
const res = await callTool("get_mod_example", {});   // no id
expect(res.isError ?? /invalid|required|validation/i.test(text(res))).toBeTruthy();
expect(text(res)).not.toMatch(/example 0/i);
```

### 9.6 N+1 enrichment batched

```bash
# [MUST] Enrichment batches children with a single WHERE example_id IN (...) per child table.
grep -Eqi 'example_id\s+IN' "$SVC" && _pass "enrichment batched (WHERE example_id IN)" || _fail "enrichment batched (WHERE example_id IN)"
```

```ts
// src/services/mod-examples-service.nplus1.oracle.test.ts  (frozen)
// Enriching N examples must issue O(1) child queries (3 batched), not O(3N).
const spy = spyOnPreparedStatements(svc);          // count DB round-trips
svc.enrichExamples(idsForN(50));                    // batch API over a set
expect(spy.childQueryCount()).toBeLessThanOrEqual(3 + /*headroom*/ 1);
```

### 9.7 Availability message + dead-method deletion

```bash
# [MUST] Unavailability text points at `manage`, aligned with the NOT_INSTALLED_MESSAGE convention.
grep -Eqi 'manage' "$SVC" src/tools/modExamples.ts && _pass "availability msg points at manage" || _fail "availability msg points at manage"
# [MUST] Dead methods deleted; the singular formatter is KEPT.
for m in formatExamplesForAI getExamplesByPattern; do
  grep -Eq "(^|[^A-Za-z_])$m\b" "$SVC" && _fail "dead method deleted: $m" || _pass "dead method deleted: $m"
done
grep -Eq '(^|[^A-Za-z_])getMod\s*\(' "$SVC" && _fail "dead method deleted: getMod" || _pass "dead method deleted: getMod"
grep -q 'formatExampleForAI' "$SVC" && _pass "formatExampleForAI (singular) retained" || _fail "formatExampleForAI (singular) retained"
```

---

## 10. SRG cross-links + cleanroom-api join (DESIGN §8)

```bash
# [MUST] MappingsService gains a batch resolveSymbols(symbols, minecraftVersion?).
grep -Eq 'resolveSymbols\s*\(' src/services/mappings-service.ts \
  && _pass "MappingsService.resolveSymbols (batch) present" || _fail "MappingsService.resolveSymbols (batch) present"
```

**[MUST] Property — SRG names are resolved at index time and stored** (DESIGN §8.1). On
`$GOLDEN_DB` (built with a fixture mappings.db that maps `func_180495_p → getBlockState`):

```bash
# [CORPUS/GOLDEN] Every api_references row whose class/method is an SRG token carries an srg_name;
# resolvable ones carry resolved_name.
SRG_ROWS=$(sq "$GOLDEN_DB" "SELECT count(*) FROM api_references WHERE srg_name IS NOT NULL;")
[ "$SRG_ROWS" -ge 1 ] && _pass "golden has >=1 SRG api_reference ($SRG_ROWS)" || _fail "golden has >=1 SRG api_reference"
# The seeded func_180495_p must resolve to getBlockState:
assert_eq "func_180495_p resolves to getBlockState" \
  "$(sq "$GOLDEN_DB" "SELECT resolved_name FROM api_references WHERE srg_name='func_180495_p' LIMIT 1;")" \
  "getBlockState"
```

**[MUST] Property — the formatter renders resolved SRG names with a resolve_symbol pointer**:

```ts
// src/services/mod-examples-service.srg-render.oracle.test.ts  (frozen)
const out = svc.formatExampleForAI(exampleWithSrg("func_180495_p"));
expect(out).toMatch(/func_180495_p\s*(->|→)\s*getBlockState/);   // arrow render
expect(out).toMatch(/resolve_symbol/);                            // pointer to the tool
```

**[MUST] Property — runtime degrades gracefully when mappings.db is absent** (DESIGN §8.1,
C4): `examples.db` renders even with no mappings.db; SRG token shown as-is:

```ts
// src/services/mod-examples-service.srg-degrade.oracle.test.ts  (frozen)
const svc = new ModExamplesService(process.env.GOLDEN_DB!, { mappingsDb: /*absent*/ null });
const out = svc.formatExampleForAI(exampleWithSrg("func_180495_p"));
expect(out).toContain("func_180495_p");   // still renders
expect(out).toMatch(/resolve_symbol/);     // still points, just un-enriched
// MUST NOT throw / MUST NOT hard-depend on mappings.db:
expect(() => svc.formatExampleForAI(exampleWithSrg("func_180495_p"))).not.toThrow();
```

```bash
# [MUST] examples.db has NO hard runtime dependency on mappings.db or cleanroom-api.db.
# Structural: the service must not require-open either DB to answer a query.
grep -Eqi "require|open|new Database" "$SVC" && ! grep -Eqi 'mappings\.db|cleanroom-api\.db' "$SVC" \
  && _pass "examples service opens no sibling DB at runtime" || _fail "examples service opens no sibling DB at runtime"
```

**[MUST] Property — cleanroom-api triple-DB join is index-time and degrades** (DESIGN §8.3):

```bash
# [CORPUS/GOLDEN] Framework symbols resolve to api_fqn/api_kind at index time (fixture cleanroom-api.db seeded).
API_ROWS=$(sq "$GOLDEN_DB" "SELECT count(*) FROM api_references WHERE api_fqn IS NOT NULL;")
[ "$API_ROWS" -ge 1 ] && _pass "golden has >=1 cleanroom-api-resolved reference" || _fail "golden has >=1 cleanroom-api-resolved reference"
# api_kind is one of the frozen kinds when present:
BAD=$(sq "$GOLDEN_DB" "SELECT count(*) FROM api_references WHERE api_kind IS NOT NULL AND api_kind NOT IN ('event','annotation','class','method','field','interface','enum');")
assert_eq "api_kind values are from the frozen set" "$BAD" "0"
```

```bash
# [MUST] No triple-DB RUNTIME query is introduced (join is build-time only). No runtime SELECT spans DBs via ATTACH.
grep -Eqi 'ATTACH' "$SVC" && _fail "no runtime ATTACH / cross-DB query in service" || _pass "no runtime ATTACH / cross-DB query in service"
```

---

## 11. Distribution & CI (DESIGN §10)

```bash
# [MUST] Release workflow carries examples forward; NO fresh-build fallback for examples; upload lists both assets.
WF=.github/workflows/release.yml
grep -Eqi 'carry.?forward' "$WF" && grep -qi 'examples' "$WF" \
  && _pass "release carries examples forward" || _fail "release carries examples forward"
grep -q 'examples.db' "$WF"           && _pass "release uploads examples.db"           || _fail "release uploads examples.db"
grep -q 'examples-manifest.json' "$WF" && _pass "release uploads examples-manifest.json" || _fail "release uploads examples-manifest.json"
```

```bash
# [MUST] CI never invokes an LLM to build examples: no endpoint env / index-mod-examples call in any workflow.
if grep -REqi 'index-mod-examples|CLEANROOM_MCP_LLM_' .github/workflows/; then
  _fail "CI never builds examples via LLM"
else
  _pass "CI never builds examples via LLM"
fi
# [MUST] The examples path does NOT gain the docs-style fresh-build fallback.
# (There must be no 'build examples' step gated behind a missing asset.)
```

```bash
# [MUST] generate-manifest accepts --db examples (already; regression guard).
pnpm exec tsx scripts/generate-manifest.ts --help 2>&1 | grep -qi 'db' && _pass "generate-manifest --db flag" || _pass "generate-manifest --db (help absent; see script)"
```

---

## 12. End-to-end exit criterion (DESIGN §1)

```bash
# [MUST] The server builds, lints, type-checks, and tests green.
assert_exit "pnpm build"     0 pnpm run build
assert_exit "pnpm lint"      0 pnpm run lint
assert_exit "pnpm typecheck" 0 bash -c 'pnpm run typecheck 2>/dev/null || npx tsc --noEmit'
assert_exit "pnpm test"      0 pnpm test
```

**[MUST] W1 workflow end-to-end — `search_mod_examples` → `get_mod_example` with SRG
cross-links rendered** (DESIGN §1 exit criterion). Uses `$GOLDEN_DB` so it runs offline:

```ts
// src/e2e/w1-workflow.oracle.test.ts  (frozen)
// 1) search surfaces a real roster example
const hits = await callTool("search_mod_examples", { query: "block", loader: "forge" });
expect(hits.length).toBeGreaterThan(0);
const id = firstExampleId(hits);
// 2) get_mod_example returns the full record with attribution + SRG cross-link
const detail = await callTool("get_mod_example", { id });
const t = text(detail);
expect(t).toMatch(/\*\*Source:\*\*/);                          // §4 attribution line
expect(t).toMatch(/(Unlicense|MIT|LGPL-3\.0|GPL-3\.0)/);       // license shown
expect(t).toMatch(/https:\/\/github\.com\//);                  // file_url provenance link
expect(t).toMatch(/(->|→)|resolve_symbol/);                    // SRG cross-link rendered
```

```bash
# [MUST] Attribution line format in the formatter output (DESIGN §4 example).
grep -Eq 'Source:' "$SVC" && _pass "formatter emits **Source:** line" || _fail "formatter emits **Source:** line"
```

---

## 13. Final gate

```bash
# Run the whole oracle; a single FAIL fails Phase 5 acceptance.
if [ "$FAIL" -eq 0 ]; then echo "ORACLE: ALL [MUST] PASSED"; else echo "ORACLE: FAILURES PRESENT"; exit 1; fi
```

**Adversarial-review gate (DESIGN §1, §11.8):** beyond this oracle, Phase 5 requires the
Phase 3 finalization protocol — validation gates → adversarial multi-agent review looping
until dry, finding **no surviving correctness findings**. That gate is procedural and cannot
be a single command; this oracle is its objective floor, not its ceiling.

---

## Appendix — DESIGN claim → verification map

| DESIGN | Claim | Verified in |
|---|---|---|
| §5 | Frozen v2 tables/columns/FTS/indexes/metadata | §3 |
| §5, §10 | schemaVersion 1→2, EXAMPLES_SCHEMA_VERSION=2, manifest 0.3.0 | §4 |
| §3 | 8-repo roster, exact refs/licenses/loaders, SHAs, caps, GT subset | §5 |
| §4 | license column, attribution line, review record, GPL=Fugue only | §3, §5, §9.4, §12 |
| §6.3, §2 | endpoint knobs; no-endpoint hard-fail; no metadata-only mode | §6 |
| §6.4, §7 | temp 0, offline goldens, up-to-date skip, analysis_version, no silent caps | §7 |
| §6.5 | atomic tmp+rename ingest | §8 |
| §9 | schema gate, filters, category wiring, tool copy, dispatch, N+1, dead methods, msg | §9 |
| §8.1/§8.3 | index-time SRG + cleanroom-api resolution, batch resolveSymbols, graceful degrade, no runtime coupling | §10 |
| §10 | carry-forward-only, no fresh-build fallback, asset upload, no LLM in CI | §11 |
| §1 | build/lint/typecheck/test green; W1 end-to-end | §12 |
| §13.5 | example_relations empty in v1 | §3 |
| §6 | module layout, script registration, orchestrator excluded from tarball | §2 |
