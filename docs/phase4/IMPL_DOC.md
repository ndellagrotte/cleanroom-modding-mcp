# IMPL_DOC: Phase 4 — Porting Layer

**What this is.** The record of what was actually built for Phase 4, closing the
RESEARCH → DESIGN → BLIND_SPEC → IMPL_DOC pipeline. It documents the delivered surfaces, the
places the implementation reconciled the blind oracle with real code, and the adversarial
review round and its fixes. The acceptance oracle ([BLIND_SPEC.md](BLIND_SPEC.md)) is
**ALL GREEN** (all shell gates + corpus SQL + `PROTOCOL ORACLE GREEN`).

## Delivered

- **Equivalence corpus** — 42 hand-curated entries across all 19 topics in
  `data/equivalence/*.yaml` (strong-seed scope; the ~150 target is follow-up). Compiled into a
  dedicated `equivalence` table (+ `equivalence_fts`) in `docs.db` via a new compile stage in
  `scripts/index-docs.ts`. Pure validator/compiler split so no YAML reaches `dist/`:
  `src/equivalence/{topics,validate,types}.ts` (dist-safe, no yaml) + `scripts/{equivalence-compile,validate-equivalence}.ts` (the only `yaml` importers).
- **Schema bump docs.db 1 → 2** — `src/indexer/store.ts` (`SCHEMA_VERSION`, DDL, FTS triggers,
  `replaceEquivalence`/`searchEquivalence`/`equivalenceByTopic`/`countEquivalence`/`getSchemaVersion`/
  `hasEquivalenceTable`/`stampSchemaVersion`) + `src/dbs.ts` (`DBS.docs.schemaVersion`), lockstep-commented.
- **`find_equivalent(query, from, topic?, limit?)`** — `src/tools/findEquivalent.ts` +
  `src/services/equivalence-service.ts`. Always listed; graceful degrade when the corpus is
  absent (schema < 2 or empty). `from` is a separate from-vocabulary, never a `Loader`.
- **`explain_concept` cross-loader banners** — `ConceptExplanation.equivalence` field, an
  exact-key `CONCEPT_TO_TOPIC` map (never `expandConcept` — R7), and a "Cross-loader
  differences" render section in `formatForAI`.
- **MCP resources** — `cleanroom://template/{9}` + `cleanroom://guide/{4}`, enumerated
  concretely (`src/resources.ts`), unknown URI → `McpError(-32002)`.
- **MCP prompts** — `scaffold_cleanroom_mod`, `port_mod_to_cleanroom`, `backport_feature`
  (`src/prompts.ts`), behind the newly-declared `prompts` capability; bad name / missing arg →
  `McpError(-32602)`. Each embeds the relevant resource + a tool plan.
- **`get_project_template` / `get_porting_guide`** — tool twins reading the same content
  modules as the resources (structural byte-parity, test-enforced). Templates vendored verbatim
  (blossom `{{ }}` tokens intact, annotated) by `scripts/vendor-template.ts` into
  `src/templates/*.ts`; the four guides are original authorship in `src/guides/*.ts`.
- **`list_targets` discovery** — surfaces prompts, resources, templates, and equivalence status;
  never lists `modern-minecraft` as a loader.
- **Packaging** — `yaml` devDependency only; templates/guides ship as `dist/` TS modules;
  `data/templates-pins.json` records per-branch template SHAs; `.gitignore` tracks the corpus +
  pins; `validate:equivalence` npm script.
- **Tests** — `src/server-protocol.test.ts` (spawned-stdio protocol net: capabilities, byte-parity,
  error codes, degrade), plus service/validator/concept-banner unit tests. Full runnable oracle
  materialized under `verify/`.

## Oracle ⇄ code reconciliations

- **`DOCS_DB` env var** — docs services now honor `dbPath ?? DB_PATH ?? DOCS_DB ?? default`.
- **`McpError`/`ErrorCode`** — introduced for the frozen `-32002` / `-32602` codes (no prior use).
- **`yaml` isolation** — YAML read lives only in `scripts/`; `src/equivalence/validate.ts` is pure.
- **Schema-version write** — runtime opens stay non-destructive (`INSERT OR IGNORE`); the build
  stamps authoritatively via `stampSchemaVersion()`.
- **BLIND_SPEC §2.5 defect** — the frozen flat `want`-string omitted `from_vocab`, contradicting
  its own §5.1 DDL and §3 `from_vocab enum` check; the materialized `verify/02_schema.sh` corrects
  it against the authoritative DDL (documented inline).

## Adversarial review round (3 skeptics) — findings & resolutions

- **[HIGH] FTS5 external-content delete triggers were wrong** (`equivalence_ad/_au`, and the
  pre-existing `documents_ad/_au`, `chunks_ad`). `DELETE FROM fts WHERE rowid=` leaves stale
  tokens on any rebuild-over-existing-db → phantom/wrong `find_equivalent` hits. **Fixed** to the
  `INSERT INTO fts(fts,rowid,…) VALUES('delete',…)` command form; reproduced and regression-tested.
- **[HIGH] Dead concept banner** — `CONCEPT_TO_TOPIC` keyed on topic slugs (`events`, `mixins`,
  `registration`) that never equal the canonical concept ids users type (`event`, `mixin`,
  `registry`, `gameregistry`). **Fixed** by rekeying on the canonical `KNOWN_CONCEPTS` ids; tested.
- **[HIGH] Schema-stale asset → infinite redownload loop** — a carry-forward release could ship a
  v1 docs.db to v2 clients, force-redownloading ~25MB every startup. **Fixed** in
  `db-versioning.ts`: reject a downloaded DB whose (readable) schema mismatches, write the
  failed-marker to break the loop; degrade stays graceful until a v2 asset lands.
- **[MED] Stamp-order footgun** — `stampSchemaVersion()` ran up-front; **moved** to after the
  crawl/compile succeed so an aborted rebuild never claims v2.
- **[MED] `readDbSchemaVersion` null contract** — the force-gate now treats a null (unreadable)
  schema on an existing file as a mismatch → force-replace.
- **[MED] Validation gaps** — `crossValidate` now resolves bare-entry_key related links (the refs
  the corpus actually uses); the LGPL guard matches spelled-out "Lesser GPL/General Public"; `slug`
  appends a hash on >120-char truncation to prevent silent entry_key collisions.
- **[LOW] Corpus domain fixes** — `ITESRFastRender` → `FastTESR<T>`; the actionbar note now cites
  `EntityPlayer.sendStatusMessage(ITextComponent, true)`. Reviewer spot-check otherwise validated
  the 1.12.2 API names.
- **[LOW, accepted]** Runtime `DocumentStore` construction still runs `CREATE TABLE IF NOT EXISTS
  equivalence` against an offline v1 db (adds an empty table; schema_version stays 1, gate stays
  closed, force-redownload intact) — harmless; a build-only-DDL refactor was judged out of scope.

## Required follow-up (operational, not code)

1. **Commit the corpus.** `data/equivalence/*.yaml` and `data/templates-pins.json` are `.gitignore`-
   whitelisted but must be `git add`ed — CI checks out a clean tree and an uncommitted corpus would
   ship an empty (dead) feature.
2. **Publish a v2 docs.db before the first post-bump release.** DESIGN §11's freshness coupling: the
   equivalence data ships only via the weekly rebuild (`rm -f data/docs.db && index-docs`); trigger
   it (workflow_dispatch) so a v2 asset exists before a tagged release carries forward v1. The
   db-versioning loop-break fix keeps clients graceful in the interim.
3. The production `docs.db` is rebuilt by CI (full crawl); the local verification used a
   representative v2 db (real crawled docs + the freshly compiled corpus).
