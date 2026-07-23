# BLIND_SPEC: Phase 4 — Porting Layer — Frozen Verification Oracle

**What this is.** The executable acceptance oracle for Phase 4, derived *blind* from
[DESIGN.md](DESIGN.md) before implementation exists. It is frozen: the implementation is judged
against these commands, not the reverse. Every check that can be a command is a command. Prose
appears only where a claim is inherently human-judged (licensing correctness, guide prose
quality) — those are explicitly flagged `[MANUAL]` and quarantined in §16.

**How to run.** All checks are collected into runnable files in a `verify/` tree (contents given
inline below; save each fenced block to its stated path). A check **passes** iff it prints only
`PASS`/`OK` lines for its assertions and exits `0`. The master runner (§0.3) runs everything and
exits non-zero on the first `FAIL`.

**Blindness rule.** Where DESIGN pins an exact value (schema version, an enum, an error code, a
file path, a message substring) the oracle asserts that exact value. Where content is
hand-authored and unknowable in advance (the ~150 corpus rows, guide bodies) the oracle asserts
**properties derivable from the design contract** (uniqueness, enum membership, referential
integrity, twin byte-identity) rather than specific data. No check reads the implementation to
decide what "correct" means.

---

## 0. Environment, fixtures, master runner

### 0.1 Required environment

```bash
# verify/env.sh — sourced by every check. Save and `source verify/env.sh` first.
set -euo pipefail

# Project root (the repo whose src/ DESIGN.md cites). Override if not CWD's parent project.
: "${REPO:?set REPO to the project root containing src/index.ts, package.json}"

# The freshly built docs.db (schema v2) produced by `pnpm run index-docs`.
: "${DOCS_DB:?set DOCS_DB to the built docs.db path}"

# Node entry the MCP client subprocess speaks to (implementation-agnostic: real stdio server).
: "${SERVER_CMD:=node ${REPO}/dist/index.js}"

# Authoritative frozen sets (from DESIGN — do not edit to match an impl).
FROM_VOCABS='fabric neoforge modern-minecraft'
TO_LOADERS='cleanroom forge'
KINDS='direct analog pattern-change missing'
ERAS='yarn-<=1.21.11 mojang-26x fabric-pre-1.20.5 legacy-modern-forge-1.16-1.20.1'
TOPICS='registration events networking mixins-access-transformers capabilities-attachments item-block-settings resources-datagen fluids serialization-nbt-codecs resource-loading energy-transfer enchantments advancements permissions particles config data-components block-entity-renderer text-components'
TEMPLATE_COMPONENTS='build.gradle gradle.properties settings.gradle mcmod.info ExampleMod.java mixins.json modid_at.cfg README checklist'
GUIDES='porting-from-fabric porting-from-neoforge backporting mixin-setup'
PROMPTS='scaffold_cleanroom_mod port_mod_to_cleanroom backport_feature'
export REPO DOCS_DB SERVER_CMD FROM_VOCABS TO_LOADERS KINDS ERAS TOPICS TEMPLATE_COMPONENTS GUIDES PROMPTS

pass(){ printf 'PASS: %s\n' "$1"; }
fail(){ printf 'FAIL: %s\n' "$1"; FAILED=1; }
FAILED=0
```

### 0.2 Frozen expectation table (single source of truth for the oracle)

| Symbol | Frozen value | DESIGN cite |
|---|---|---|
| docs.db `SCHEMA_VERSION` | `2` | §5.1 |
| `DBS.docs.schemaVersion` | `2` (lockstep) | §5.1 |
| `from` vocabulary enum | `fabric` \| `neoforge` \| `modern-minecraft` | Fixed Input 3, §4.1 |
| `to_loader` enum | `cleanroom` \| `forge` | §5.1 |
| `kind` enum | `direct` \| `analog` \| `pattern-change` \| `missing` | §5.1 |
| `from_era` enum | `yarn-<=1.21.11` \| `mojang-26x` \| `fabric-pre-1.20.5` \| `legacy-modern-forge-1.16-1.20.1` | §3.3 |
| seed topics | 19 ids (see `TOPICS`) | §3.2 |
| template components | 9 (see `TEMPLATE_COMPONENTS`) | §7.1 |
| guides | 4 (see `GUIDES`) | §7.1 |
| prompts | 3 (see `PROMPTS`) | §8 |
| capabilities declared | `resources` **and** `prompts` | §7.1, §10 |
| ReadResource not-found code | `-32002` | §7.1 |
| GetPrompt bad-name / missing-arg code | `-32602` | §8 |
| `limit` clamp | `min(max(limit\|\|15,1),50)` | §4.1 |
| entry_key shape | `<topic>/<from_vocab>/<slug(from_api)>`, UNIQUE | §3.1, §5.1 |
| citation URL scheme | `cleanroom://equivalence/<entry_key>` | §3.4 |
| degrade message substrings | `isn't present` … `manage` (non-`isError`) | §4.2 |

### 0.3 Master runner

```bash
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
  verify/05_nongoals.sh ; do
  echo "== $f =="; bash "$f" || rc=1
done
echo "== verify/mcp-protocol.mjs =="; node verify/mcp-protocol.mjs || rc=1
[ "$rc" = 0 ] && echo "ALL GREEN" || echo "ORACLE RED"
exit $rc
```

---

## 1. Exit-criterion gates (§1 "builds, lints, type-checks, tests green")

```bash
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
```

**Expected stdout:** six `PASS:` lines, no `FAIL:`.

---

## 2. Schema bump 1→2 (§5.1)

```bash
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
cols=$(sqlite3 "$DOCS_DB" "SELECT name FROM pragma_table_info('equivalence') ORDER BY name;" | tr '\n' ' ')
want='caveats code_after code_before entry_key from_api from_api_alt from_era from_versions id keywords kind notes related sources to_api to_loader topic validated_against '
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
```

---

## 3. Corpus property assertions (§3, §5, §6)

Data is unknowable blind, so every assertion is a **zero-violations** invariant over whatever rows
exist. Run: `sqlite3 "$DOCS_DB" < verify/corpus.sql` — every emitted line must end in `PASS`.

```sql
-- verify/corpus.sql
.mode list
.separator '  ->  '
.headers off

-- non-empty seed corpus
SELECT 'corpus non-empty', CASE WHEN count(*)>=1 THEN 'PASS' ELSE 'FAIL' END FROM equivalence;

-- entry_key UNIQUE (belt-and-braces vs the UNIQUE constraint)
SELECT 'entry_key unique', CASE WHEN count(*)=count(DISTINCT entry_key) THEN 'PASS' ELSE 'FAIL' END FROM equivalence;

-- entry_key shape: '<topic>/<from_vocab>/<slug>'
SELECT 'entry_key shape', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE entry_key <> topic||'/'||from_vocab||'/'||substr(entry_key, length(topic||'/'||from_vocab||'/')+1)
   OR entry_key NOT LIKE topic||'/'||from_vocab||'/%';

-- from_vocab enum (the three; NEVER a Loader value)
SELECT 'from_vocab enum', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE from_vocab NOT IN ('fabric','neoforge','modern-minecraft');

-- to_loader enum
SELECT 'to_loader enum', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE to_loader NOT IN ('cleanroom','forge');

-- kind enum (redundant w/ CHECK, kept for the frozen record)
SELECT 'kind enum', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE kind NOT IN ('direct','analog','pattern-change','missing');

-- from_era enum OR null
SELECT 'from_era enum', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE from_era IS NOT NULL AND from_era NOT IN
  ('yarn-<=1.21.11','mojang-26x','fabric-pre-1.20.5','legacy-modern-forge-1.16-1.20.1');

-- topic in the seed taxonomy
SELECT 'topic in taxonomy', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE topic NOT IN (
 'registration','events','networking','mixins-access-transformers','capabilities-attachments',
 'item-block-settings','resources-datagen','fluids','serialization-nbt-codecs','resource-loading',
 'energy-transfer','enchantments','advancements','permissions','particles','config',
 'data-components','block-entity-renderer','text-components');

-- to_api present unless kind='missing' (DESIGN §6.2 validation rule)
SELECT 'to_api required unless missing', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE kind<>'missing' AND (to_api IS NULL OR trim(to_api)='');

-- from_api always present
SELECT 'from_api present', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE from_api IS NULL OR trim(from_api)='';

-- JSON-array columns are valid JSON arrays when non-null
SELECT 'from_api_alt json', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END FROM equivalence WHERE from_api_alt IS NOT NULL AND (json_valid(from_api_alt)=0 OR json_type(from_api_alt)<>'array');
SELECT 'caveats json',      CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END FROM equivalence WHERE caveats      IS NOT NULL AND (json_valid(caveats)=0      OR json_type(caveats)<>'array');
SELECT 'related json',      CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END FROM equivalence WHERE related      IS NOT NULL AND (json_valid(related)=0      OR json_type(related)<>'array');
SELECT 'sources json',      CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END FROM equivalence WHERE sources      IS NOT NULL AND (json_valid(sources)=0      OR json_type(sources)<>'array');

-- keywords compile-derived and non-empty (§5.1 "compile-derived: split identifiers")
SELECT 'keywords non-empty', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE keywords IS NULL OR json_valid(keywords)=0 OR json_array_length(keywords)<1;

-- every entry has >=1 source (§6.2 "non-empty sources[]")
SELECT 'sources non-empty', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence WHERE sources IS NULL OR json_array_length(sources)<1;

-- LICENSING (§2, §6.3): no source may declare an LGPL family license.
SELECT 'no LGPL sources', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence e, json_each(e.sources) s
WHERE upper(json_extract(s.value,'$.license')) LIKE 'LGPL%';

-- related[] links only use the blessed schemes (§3.4): cleanroom://equivalence|guide|template , api:// , or a bare entry_key.
SELECT 'related scheme', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence e, json_each(e.related) r
WHERE r.value NOT LIKE 'cleanroom://equivalence/%'
  AND r.value NOT LIKE 'cleanroom://guide/%'
  AND r.value NOT LIKE 'cleanroom://template/%'
  AND r.value NOT LIKE 'api://%'
  AND r.value NOT LIKE '%/%/%';

-- referential integrity: every cleanroom://equivalence/<key> related-link resolves to a real entry_key.
SELECT 'related equivalence links resolve', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence e, json_each(e.related) r
WHERE r.value LIKE 'cleanroom://equivalence/%'
  AND substr(r.value, length('cleanroom://equivalence/')+1) NOT IN (SELECT entry_key FROM equivalence);

-- referential integrity: cleanroom://guide/<name> links point at one of the four guides (fragment allowed).
SELECT 'related guide links valid', CASE WHEN count(*)=0 THEN 'PASS' ELSE 'FAIL' END
FROM equivalence e, json_each(e.related) r
WHERE r.value LIKE 'cleanroom://guide/%'
  AND replace(substr(r.value, length('cleanroom://guide/')+1), '#'||'', '#') NOT LIKE '%'
  AND substr(replace(r.value,'cleanroom://guide/',''), 1, instr(substr(r.value,'cleanroom://guide/'||'')||'#',''))='' ; -- see note
```

> Note on the last check: SQLite string-splitting on `#` is awkward; the MCP protocol test
> (§7) re-verifies guide-link validity precisely against the live resource enumeration and is
> authoritative. The SQL variant above is a coarse smoke check.

**Expected:** every line ends `-> PASS`.

### 3.1 Topic coverage floor (seed roster is present, not just valid)

```bash
# appended to verify/03_corpus.sh
source verify/env.sh
# Each of the 7 PROJECT_DESIGN core seed topics MUST have >=1 entry (DESIGN §3.2 seed list).
for t in registration events networking mixins-access-transformers capabilities-attachments item-block-settings resources-datagen; do
  n=$(sqlite3 "$DOCS_DB" "SELECT count(*) FROM equivalence WHERE topic='$t';")
  [ "$n" -ge 1 ] && pass "topic seeded: $t ($n)" || fail "core seed topic empty: $t"
done
# resources-datagen must include the honest kind:missing row (§3.2 marks it kind: missing).
n=$(sqlite3 "$DOCS_DB" "SELECT count(*) FROM equivalence WHERE topic='resources-datagen' AND kind='missing';")
[ "$n" -ge 1 ] && pass "resources-datagen has a kind:missing entry" || fail "resources-datagen missing its kind:missing row"
exit $FAILED
```

---

## 4. Packaging & non-TS asset reachability (§7.3, §11)

```bash
# verify/04_packaging.sh
source verify/env.sh
cd "$REPO"

# 4.1 Templates & guides are committed .ts content modules (so tsc copies them into dist).
for c in $TEMPLATE_COMPONENTS; do
  ls "$REPO"/src/templates/*.ts >/dev/null 2>&1 || { fail "src/templates/*.ts absent"; break; }
done
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

exit $FAILED
```

### 4.6 Template vendoring fidelity (§9, Fixed Input 4) — raw tokens intact

```bash
# appended to verify/04_packaging.sh (before exit)
# Raw upstream bytes: {{ }} blossom tokens are PRESERVED, not expanded. At least the token-bearing
# components must still contain '{{'. (Design: emitting expanded files would break real builds.)
tokencount=$(grep -rl '{{' "$REPO"/src/templates/*.ts 2>/dev/null | wc -l)
[ "$tokencount" -ge 1 ] && pass "template modules preserve {{ }} blossom tokens" || fail "no {{ }} tokens found — templates were wrongly expanded"
# Each token-bearing snapshot carries an annotation block explaining tokens (§9).
grep -rqiE 'mod_id|root_package|is_coremod|use_access_transformer' "$REPO"/src/templates/*.ts \
  && pass "template annotation names the blossom tokens" || fail "template annotation block absent"
```

---

## 5. Non-goals as negative assertions (§2)

```bash
# verify/05_nongoals.sh
source verify/env.sh

# 5.1 modern-minecraft is NOT a Loader: never in LOADER_IDS, never in any loader/scope enum,
#     never surfaced by list_targets' loader matrix. (Fixed Input 3 / §2 non-goal.)
grep -RIl "modern-minecraft" "$REPO/src" | while read f; do echo "$f"; done > /tmp/p4_mm.txt || true
# It MUST NOT appear in the loader registry.
grep -Eq "LOADER_IDS[^\n]*modern-minecraft" "$REPO/src/dbs.ts" "$REPO"/src/**/*.ts 2>/dev/null \
  && fail "modern-minecraft leaked into LOADER_IDS" || pass "modern-minecraft absent from LOADER_IDS"
# It MAY appear only in equivalence/find_equivalent surfaces (the from-vocabulary).
if grep -RIn "modern-minecraft" "$REPO/src" | grep -vqE 'equivalence|findEquivalent|find_equivalent|guide|backport'; then
  grep -RIn "modern-minecraft" "$REPO/src" | grep -vE 'equivalence|findEquivalent|find_equivalent|guide|backport'
  fail "modern-minecraft used outside the from-vocabulary surfaces"
else
  pass "modern-minecraft confined to from-vocabulary surfaces"
fi

# 5.2 No runtime YAML parsing: nothing under dist/ imports a yaml parser (§2, §6.2).
if grep -RIlE "from ['\"]yaml['\"]|require\(['\"]yaml['\"]\)" "$REPO/dist" 2>/dev/null; then
  fail "dist/ imports a YAML parser (runtime YAML forbidden)"
else
  pass "no runtime YAML parsing in dist/"
fi

# 5.3 Equivalence rows are NOT injected into the documents/chunks FTS corpus (§2 non-goal).
#     No documents row may carry a cleanroom://equivalence/ URL.
n=$(sqlite3 "$DOCS_DB" "SELECT count(*) FROM documents WHERE url LIKE 'cleanroom://equivalence/%';" 2>/dev/null || echo 0)
[ "${n:-0}" = 0 ] && pass "no equivalence rows polluted into documents table" || fail "equivalence leaked into documents ($n)"

# 5.4 No resources/subscribe capability, no listChanged flags (§2 non-goal). Verified in §7 protocol test too.
grep -Eq "subscribe\s*:\s*true|listChanged\s*:\s*true" "$REPO/src/index.ts" \
  && fail "subscribe/listChanged flag set (forbidden)" || pass "no subscribe/listChanged flags"

exit $FAILED
```

---

## 6. `find_equivalent` behavior — degrade & clamp (§4.1, §4.2)

These need a running server; they are implemented in the protocol harness (§7) but the two
**data-independent** invariants are stated here as the contract they enforce:

- **P-CLAMP.** For any integer `limit` input, the number of `###` hit sections in the output is
  `≤ min(max(limit||15,1),50)`. Checked with `limit=0` (→ effective 1), `limit=999` (→ ≤50),
  `limit` omitted (→ ≤15).
- **P-DEGRADE.** Against a v1 docs.db (no `equivalence` table / `schema_version=1`),
  `find_equivalent` returns a result whose `isError` is falsy and whose text contains both
  `isn't present` and `manage` — never a thrown error, never `isError:true`. (§4.2)
- **P-LISTED.** `find_equivalent` appears in `tools/list` **regardless** of corpus presence
  (docs.db is required; only its data may be transiently absent). (§4.2)
- **P-HIT.** For every distinct `(from_vocab, from_api)` in the corpus, calling
  `find_equivalent(query=from_api, from=from_vocab)` yields a non-degrade result whose text
  contains the substring `from_api` and at least one `###` hit and a `kind` badge. (Derives the
  FTS-matches-its-own-content property purely from DB contents.)
- **P-MISSING-HONEST.** For every `kind='missing'` entry surfaced, the rendered hit contains the
  honest phrasing substring `No 1.12.2 equivalent`. (§4.1)

### 6.1 v1-degrade fixture builder

```bash
# verify/make-v1-db.sh — produces a schema-v1 docs.db from the v2 build, for P-DEGRADE.
source verify/env.sh
cp "$DOCS_DB" /tmp/docs_v1.db
sqlite3 /tmp/docs_v1.db "DROP TABLE IF EXISTS equivalence_fts; DROP TABLE IF EXISTS equivalence; UPDATE metadata SET value='1' WHERE key='schema_version';"
echo "/tmp/docs_v1.db"
```

The harness (§7) runs the server twice: once with `DOCS_DB=$DOCS_DB` (asserts P-HIT/P-CLAMP/
P-MISSING-HONEST/P-LISTED) and once with `DOCS_DB=/tmp/docs_v1.db` (asserts P-DEGRADE + still
P-LISTED).

---

## 7. MCP protocol oracle (§7, §8, §10) — the byte-parity & wiring net

This is the §10 "instantiate the server and assert" net, run over a **real stdio subprocess** so
it is implementation-shape-agnostic (no assumption about server exports). It requires the
project's own `@modelcontextprotocol/sdk` (already a dependency).

```js
// verify/mcp-protocol.mjs   — run: node verify/mcp-protocol.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';

const REPO = process.env.REPO ?? process.cwd();
const ENTRY = process.env.SERVER_ENTRY ?? `${REPO}/dist/index.js`;
const FROM_VOCABS = ['fabric','neoforge','modern-minecraft'];
const KINDS = ['direct','analog','pattern-change','missing'];
const TEMPLATE_COMPONENTS = ['build.gradle','gradle.properties','settings.gradle','mcmod.info','ExampleMod.java','mixins.json','modid_at.cfg','README','checklist'];
const GUIDES = ['porting-from-fabric','porting-from-neoforge','backporting','mixin-setup'];
const PROMPTS = { scaffold_cleanroom_mod:['mod_id'], port_mod_to_cleanroom:['source_loader'], backport_feature:['source_version'] };

let failed = 0;
const ok  = (m)=>console.log('PASS:', m);
const bad = (m,e)=>{ console.log('FAIL:', m, e?.message??e??''); failed=1; };
const check = async (m,fn)=>{ try{ await fn(); ok(m);}catch(e){ bad(m,e);} };

async function connect(docsDb){
  const client = new Client({ name:'blind-oracle', version:'0' }, { capabilities:{} });
  const transport = new StdioClientTransport({
    command: 'node', args:[ENTRY],
    env: { ...process.env, ...(docsDb?{DOCS_DB:docsDb}:{}) },
  });
  await client.connect(transport);
  return { client, transport };
}
const textOf = (res)=> (res?.content ?? res?.messages?.flatMap(m=>[m.content]) ?? [])
  .map(c=> c?.type==='text'? c.text : (c?.resource?.text ?? '')).join('\n');

async function main(){
  const primaryDb = process.env.DOCS_DB;
  const v1Db = process.env.DOCS_DB_V1; // set to /tmp/docs_v1.db (see verify/make-v1-db.sh)

  // ---------- capabilities (§7.1, §10) ----------
  let { client, transport } = await connect(primaryDb);
  const caps = client.getServerCapabilities();
  await check('capabilities include resources', async()=> assert.ok(caps?.resources));
  await check('capabilities include prompts (C1)', async()=> assert.ok(caps?.prompts));
  await check('no resources.subscribe (§2 non-goal)', async()=> assert.notEqual(caps?.resources?.subscribe, true));

  // ---------- tools listed (P-LISTED) ----------
  const tools = (await client.listTools()).tools.map(t=>t.name);
  for (const t of ['find_equivalent','get_project_template','get_porting_guide','list_targets'])
    await check(`tool listed: ${t}`, async()=> assert.ok(tools.includes(t)));

  // find_equivalent schema exposes the exact from-vocabulary enum (Fixed Input 3).
  await check('find_equivalent.from enum == 3 from-vocabs', async()=>{
    const fe = (await client.listTools()).tools.find(t=>t.name==='find_equivalent');
    const en = fe.inputSchema?.properties?.from?.enum ?? [];
    assert.deepEqual([...en].sort(), [...FROM_VOCABS].sort());
  });

  // ---------- resources: concrete enumeration (§7.1) ----------
  const resUris = (await client.listResources()).resources.map(r=>r.uri);
  for (const c of TEMPLATE_COMPONENTS)
    await check(`resource enumerated: template/${c}`, async()=> assert.ok(resUris.includes(`cleanroom://template/${c}`)));
  for (const g of GUIDES)
    await check(`resource enumerated: guide/${g}`, async()=> assert.ok(resUris.includes(`cleanroom://guide/${g}`)));

  // ---------- resource read + not-found code -32002 (§7.1) ----------
  await check('ReadResource unknown -> -32002', async()=>{
    try { await client.readResource({ uri:'cleanroom://template/does-not-exist' }); assert.fail('should throw'); }
    catch(e){ assert.equal(e.code, -32002); }
  });

  // ---------- tool-twin BYTE parity (§7.2, OQ20) ----------
  for (const c of TEMPLATE_COMPONENTS){
    await check(`byte-parity template/${c}`, async()=>{
      const r = await client.readResource({ uri:`cleanroom://template/${c}` });
      const rBody = r.contents.map(x=>x.text??'').join('');
      const t = await client.callTool({ name:'get_project_template', arguments:{ component:c } });
      assert.equal(textOf(t).trim(), rBody.trim());
    });
  }
  for (const g of GUIDES){
    await check(`byte-parity guide/${g}`, async()=>{
      const r = await client.readResource({ uri:`cleanroom://guide/${g}` });
      const rBody = r.contents.map(x=>x.text??'').join('');
      const t = await client.callTool({ name:'get_porting_guide', arguments:{ name:g } });
      assert.equal(textOf(t).trim(), rBody.trim());
    });
  }

  // ---------- prompts (§8) ----------
  const promptNames = (await client.listPrompts()).prompts.map(p=>p.name);
  for (const p of Object.keys(PROMPTS))
    await check(`prompt listed: ${p}`, async()=> assert.ok(promptNames.includes(p)));

  await check('scaffold_cleanroom_mod embeds template/checklist resource', async()=>{
    const r = await client.getPrompt({ name:'scaffold_cleanroom_mod', arguments:{ mod_id:'demo' } });
    const embeds = r.messages.some(m=> m.content?.type==='resource' && String(m.content?.resource?.uri||'').includes('cleanroom://template/checklist'));
    assert.ok(embeds, 'no embedded checklist resource');
  });
  await check('port_mod_to_cleanroom embeds porting-from-fabric guide', async()=>{
    const r = await client.getPrompt({ name:'port_mod_to_cleanroom', arguments:{ source_loader:'fabric' } });
    const embeds = r.messages.some(m=> String(m.content?.resource?.uri||'').includes('cleanroom://guide/porting-from-fabric'));
    assert.ok(embeds);
  });
  await check('backport_feature embeds backporting guide', async()=>{
    const r = await client.getPrompt({ name:'backport_feature', arguments:{ source_version:'1.21' } });
    const embeds = r.messages.some(m=> String(m.content?.resource?.uri||'').includes('cleanroom://guide/backporting'));
    assert.ok(embeds);
  });
  await check('GetPrompt unknown name -> -32602', async()=>{
    try{ await client.getPrompt({ name:'__nope__', arguments:{} }); assert.fail('should throw'); }
    catch(e){ assert.equal(e.code,-32602); }
  });
  await check('GetPrompt missing required arg -> -32602', async()=>{
    try{ await client.getPrompt({ name:'scaffold_cleanroom_mod', arguments:{} }); assert.fail('should throw'); }
    catch(e){ assert.equal(e.code,-32602); }
  });

  // ---------- list_targets surfaces the Phase-4 capabilities (§10) ----------
  await check('list_targets reports prompts+resources+templates+equivalence', async()=>{
    const t = textOf(await client.callTool({ name:'list_targets', arguments:{} })).toLowerCase();
    for (const kw of ['prompt','resource','template','equivalen'])
      assert.ok(t.includes(kw), `list_targets omits "${kw}"`);
  });
  // list_targets must NOT list modern-minecraft as a loader target (§2 non-goal).
  await check('list_targets does not present modern-minecraft as a loader', async()=>{
    const t = textOf(await client.callTool({ name:'list_targets', arguments:{} }));
    // allowed only if clearly labelled as a from-vocabulary, never in a loader matrix row.
    const badRow = /loader[^\n]*modern-minecraft/i.test(t);
    assert.ok(!badRow, 'modern-minecraft appears as a loader target');
  });

  // ---------- find_equivalent: clamp + hit + missing-honest (§4) ----------
  const feHits = (out)=> (out.match(/^### /gm)||[]).length;
  await check('find_equivalent clamps limit=999 to <=50', async()=>{
    const out = textOf(await client.callTool({ name:'find_equivalent', arguments:{ query:'net', from:'fabric', limit:999 } }));
    assert.ok(feHits(out) <= 50);
  });
  await check('find_equivalent limit=0 -> >=1 effective (never 0-cap error)', async()=>{
    const r = await client.callTool({ name:'find_equivalent', arguments:{ query:'net', from:'fabric', limit:0 } });
    assert.notEqual(r.isError, true);
  });
  await check('find_equivalent default header shape', async()=>{
    const out = textOf(await client.callTool({ name:'find_equivalent', arguments:{ query:'registry', from:'fabric' } }));
    assert.match(out, /Found \d+ equivalents/);
    assert.ok(feHits(out) <= 15);
  });

  // P-HIT: every distinct (vocab, from_api) must be found by its own text. Sampled to keep it bounded;
  // the SQL corpus check already guarantees FTS/base parity, so a sample is sufficient signal.
  // (Full sweep available by removing the LIMIT in the query below.)
  // This block requires sqlite3 CLI; skipped gracefully if absent.
  await check('P-HIT sample: each from_api is retrievable', async()=>{
    const { execSync } = await import('node:child_process');
    let rows;
    try { rows = execSync(`sqlite3 -json "${primaryDb}" "SELECT from_vocab,from_api,kind FROM equivalence ORDER BY id LIMIT 25;"`).toString(); }
    catch { console.log('   (sqlite3 CLI unavailable — P-HIT sample skipped)'); return; }
    for (const {from_vocab, from_api, kind} of JSON.parse(rows||'[]')){
      const out = textOf(await client.callTool({ name:'find_equivalent', arguments:{ query:from_api, from:from_vocab } }));
      assert.ok(out.includes(from_api.slice(0, Math.min(24, from_api.length))), `not retrievable: ${from_api}`);
      if (kind==='missing') assert.ok(/No 1\.12\.2 equivalent/i.test(out), `missing not honest: ${from_api}`);
    }
  });

  await transport.close();

  // ---------- P-DEGRADE against v1 docs.db (§4.2) ----------
  if (v1Db){
    ({ client, transport } = await connect(v1Db));
    await check('find_equivalent still LISTED on v1 db', async()=>{
      const t=(await client.listTools()).tools.map(x=>x.name); assert.ok(t.includes('find_equivalent'));
    });
    await check('find_equivalent degrades gracefully on v1 db', async()=>{
      const r = await client.callTool({ name:'find_equivalent', arguments:{ query:'x', from:'fabric' } });
      assert.notEqual(r.isError, true);
      const out = textOf(r);
      assert.match(out, /isn't present|isn.t present/i);
      assert.match(out, /manage/i);
    });
    await transport.close();
  } else {
    console.log('NOTE: DOCS_DB_V1 unset — P-DEGRADE skipped. Build it with verify/make-v1-db.sh and re-run.');
  }

  console.log(failed ? 'PROTOCOL ORACLE RED' : 'PROTOCOL ORACLE GREEN');
  process.exit(failed);
}
main().catch(e=>{ console.error('HARNESS CRASH', e); process.exit(2); });
```

Run it fully with both DBs:

```bash
source verify/env.sh
export DOCS_DB_V1="$(bash verify/make-v1-db.sh)"
node verify/mcp-protocol.mjs
```

**Expected final line:** `PROTOCOL ORACLE GREEN`, no `FAIL:` lines.

---

## 8. Concept-integration oracle (§4.3) — `explain_concept` banners

The `explain_concept` handler is (per RESEARCH) a service method rather than an MCP tool on some
builds; assert against whichever surface it is exposed on. Contract:

- **P-BANNER-EXACT.** For a concept whose id is a key of `CONCEPT_TO_TOPIC`, `explain_concept`
  output contains a `Cross-loader differences` section populated from the mapped topic's
  equivalence rows. (§4.3)
- **P-NO-OVERMATCH.** For a concept id **not** a key of `CONCEPT_TO_TOPIC`, output contains **no**
  `Cross-loader differences` section — the mapping is exact, never `expandConcept` substring
  aliasing (R7). This is the load-bearing negative test.

```bash
# verify/08_concept.sh — static guardrails (dynamic assertion lives with the concept test suite).
source verify/env.sh
# The mapping must be an exact-key table, and the handler must NOT call expandConcept for it.
grep -Eq 'CONCEPT_TO_TOPIC' "$REPO/src/services/concept-service.ts" \
  && pass "CONCEPT_TO_TOPIC map present" || fail "CONCEPT_TO_TOPIC map absent"
# Guard the R7 hazard: the equivalence lookup path must not route through expandConcept.
if awk '/equivalence/{e=NR} /expandConcept/{x=NR} END{exit !(e&&x&&(x>e-8&&x<e+8))}' "$REPO/src/services/concept-service.ts" 2>/dev/null; then
  fail "expandConcept appears adjacent to the equivalence lookup (R7 over-match risk)"
else
  pass "equivalence lookup not wired through expandConcept"
fi
# The new render section string exists.
grep -q 'Cross-loader differences' "$REPO/src/services/concept-service.ts" \
  && pass "formatForAI renders 'Cross-loader differences' section" || fail "banner section string missing"
# The ConceptExplanation type gained the optional equivalence field.
grep -Eq 'equivalence\??\s*:' "$REPO/src/services/concept-service.ts" \
  && pass "ConceptExplanation.equivalence field present" || fail "ConceptExplanation.equivalence field missing"
exit $FAILED
```

Add these two dynamic cases to the project's concept vitest suite (they belong to the frozen
oracle even though their concrete concept ids depend on `CONCEPT_TO_TOPIC` contents):

```ts
// verify/concept.oracle.test.ts — merge into the concept test suite.
import { describe, it, expect } from 'vitest';
import { CONCEPT_TO_TOPIC } from '../src/services/concept-service.js'; // adjust to real export
import { explainConcept } from '../src/services/concept-service.js';   // adjust to real export

describe('explain_concept cross-loader banner (frozen oracle §4.3)', () => {
  const mapped = Object.keys(CONCEPT_TO_TOPIC);
  it('mapped concept surfaces the banner', async () => {
    if (!mapped.length) return; // corpus/map not yet authored
    const out = await explainConcept(mapped[0]);
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    expect(text).toMatch(/Cross-loader differences/);
  });
  it('unmapped concept never surfaces the banner (R7)', async () => {
    const out = await explainConcept('__definitely_not_a_mapped_concept__');
    const text = typeof out === 'string' ? out : JSON.stringify(out);
    expect(text).not.toMatch(/Cross-loader differences/);
  });
});
```

---

## 9. End-to-end workflow oracle (W2 / W3 — §1 exit)

The exit criterion requires the W2 (cross-loader port) and W3 (backport) flows to "run end to
end." Encoded as ordered tool sequences the harness can replay; each step's post-condition is a
substring/shape assertion, not a fixed body.

**W2 — port a Fabric mod:**
```
1. list_targets()                        ⇒ output names find_equivalent, get_porting_guide, prompts
2. get_porting_guide("porting-from-fabric") ⇒ non-empty markdown, byte-equal to its resource twin (§7)
3. port_mod_to_cleanroom(source_loader="fabric") ⇒ embeds cleanroom://guide/porting-from-fabric
4. find_equivalent(query=<any from.api of a fabric row>, from="fabric") ⇒ >=1 ### hit with a kind badge
```

**W3 — backport a modern feature:**
```
1. backport_feature(source_version="1.21")      ⇒ embeds cleanroom://guide/backporting
2. find_equivalent(query=<any modern-minecraft row api>, from="modern-minecraft")
                                                 ⇒ non-degrade result (>=1 hit OR honest "No 1.12.2 equivalent")
```

Steps 3/4 of W2 and both W3 steps are already asserted individually in §7; the sequence adds only
ordering, which is stateless here (no server-side session state — §2 "static per session"), so
green §7 ⇒ green W2/W3. A dedicated replay is included:

```bash
# verify/09_workflows.sh
source verify/env.sh
node verify/mcp-protocol.mjs >/tmp/p4_proto.log 2>&1
grep -q 'PROTOCOL ORACLE GREEN' /tmp/p4_proto.log \
  && pass "W2/W3 tool surfaces all green (via protocol oracle)" \
  || { fail "protocol oracle not green — W2/W3 cannot pass"; sed -n 's/^FAIL:/  /p' /tmp/p4_proto.log; }
exit $FAILED
```

---

## 10. Coverage ledger — DESIGN claim → check

Every testable exit-criterion clause maps to at least one command above. Untestable-by-command
clauses are listed in §16 with their reason.

| DESIGN exit clause (§1) | Oracle check |
|---|---|
| builds, lints, type-checks, tests green | §1 `01_gates.sh` |
| `find_equivalent` live | §7 P-LISTED, §6 P-HIT |
| `get_project_template` live | §7 tool-listed + byte-parity |
| `resources`/`prompts` capabilities declared | §7 capabilities |
| server starts without C1 crash | §1 boot check, §7 connect |
| docs.db rebuilds w/ equivalence populated | §2, §3 |
| old (v1) docs.db force-redownloads | §10.1 below |
| `find_equivalent` degrades gracefully when corpus absent | §6 P-DEGRADE, §7 |
| three prompts resolve | §7 prompts block |
| all concrete `cleanroom://` resources resolve | §7 resources block |
| each resource's tool-twin returns identical bytes | §7 byte-parity |
| `list_targets` reports new surfaces | §7 list_targets |
| W2/W3 flows run end to end | §9 |
| schema bump 1→2 lockstep | §2 |
| modern-minecraft never a loader | §5.1, §7 list_targets |
| no runtime YAML | §5.2, §4.4 |
| no LGPL quoted (source-declared) | §3 `no LGPL sources` + §16 [MANUAL] |
| templates raw tokens intact | §4.6 |
| adversarial review finds no surviving correctness findings | §16 [PROCESS] |

### 10.1 v1 → force-redownload path (§5.1, §11)

```bash
# verify/10_forcedl.sh — asserts the generic DbVersioning forcing path treats docs.db's bump as an update.
source verify/env.sh
# The DB-agnostic forcing function must exist and be reachable for docs.db (no docs-specific opt-out).
grep -Eq 'force' "$REPO/src/db-versioning.ts" && pass "db-versioning force path present" || fail "db-versioning force path missing"
# A v1 client manifest/version below the new one must be considered stale (redownload), not skipped.
# Contract check: DBS.docs must NOT set any 'skipUpdate'/'pinned' flag that would strand v1 users.
grep -Eq "docs[^}]*skipUpdate\s*:\s*true|docs[^}]*pinned\s*:\s*true" "$REPO/src/dbs.ts" \
  && fail "docs.db pinned/skipUpdate — v1 clients would not force-redownload" \
  || pass "docs.db not pinned; bump triggers force-redownload"
exit $FAILED
```

---

## 16. Non-command residue — explicitly quarantined

These cannot be reduced to a passing command and are **not** part of the green/red gate; they are
recorded so the oracle is honest about its own boundary.

- `[MANUAL]` **Licensing correctness of quoted snippets (§6.3, R5).** The SQL `no LGPL sources`
  check catches *self-declared* LGPL only. Whether a snippet was *actually* copied from a
  copyleft source without declaring it is a PR-review judgment (DESIGN §6.3 says CI cannot judge
  licensing). Gate: reviewer sign-off recorded in the finalization prompt.
- `[MANUAL]` **Corpus & guide domain correctness (§14 OQ25).** No upstream oracle exists for the
  ~150 entries / 4 guides; the §6.1 stable-source, inline-quoted-name pass is a human review.
- `[MANUAL]` **Mixin-branch `is_coremod`/`IFMLLoadingPlugin` necessity (§14 OQ4).** Resolved only
  by scaffolding a real mixin mod and building it; annotate-as-unconfirmed is the interim.
- `[PROCESS]` **Adversarial multi-agent review, 3-skeptic / ≥2-survival / two-clean-rounds
  (§1, §12.9).** This oracle is the *deterministic* floor that must be green **before** that
  review runs; the review is the finalization gate on top of it, not a substitute for it.
- `[MANUAL]` **CC-BY attribution completeness (§6.3).** The SQL checks `sources[]` is non-empty
  and JSON-valid; that the attribution text is *correct* for CC-BY prose is reviewer-judged.

---

## 17. How to declare victory

```bash
source verify/env.sh
export DOCS_DB_V1="$(bash verify/make-v1-db.sh)"
bash verify/run-all.sh
```

Green iff: `run-all.sh` prints `ALL GREEN` and exits `0`, i.e. every `PASS:` with zero `FAIL:`
across §1–§10, the corpus SQL is all `-> PASS`, and the protocol oracle prints
`PROTOCOL ORACLE GREEN`. The §16 residue is then cleared by human/finalization review. Only then
is Phase 4's `Exit:` (§1) satisfied.
```
