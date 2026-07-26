# DESIGN: Phase 5 — Examples Rebuild

**What this document is:** the implementation design for Phase 5, consuming
[docs/phase5/RESEARCH.md](RESEARCH.md) as its source of truth and
[PROJECT_DESIGN.md](../PROJECT_DESIGN.md) §5.6/§8/A.6 for macro scope. It makes the design
decisions RESEARCH deliberately deferred — resolving all 21 of its open questions — and
freezes them for a blind implementation pass. It does **not** re-derive RESEARCH's verified
facts; where it relies on them it cites the RESEARCH section rather than repeating the
evidence. Citations use `path:line` / commit / URL form and are consistent with RESEARCH's
re-verified working-tree findings (branch `dev` at `917e000`, verified 2026-07-22).

**Status:** Phases 0–4 implemented (distribution repair + rebrand; loader registry + corpus
retargeting; 1.12.2 MCP/SRG mappings with `resolve_symbol`; Cleanroom API DB with
`search_cleanroom_api`/`get_api_class`; porting layer). Phase 5 (this document) not yet
started. `docs/phase5/DESIGN.md` was a 0-byte stub before this document.

**How it was produced:** the RESEARCH recon plus a direct read of the current integration
surfaces ([mod-examples-service.ts](../../src/services/mod-examples-service.ts),
[dbs.ts](../../src/dbs.ts), [modExamples.ts](../../src/tools/modExamples.ts)) and the
Phase 3 `cleanroom-api` pipeline that Phase 5 mirrors structurally
([scripts/index-java-api.ts](../../scripts/index-java-api.ts),
[src/cleanroom-api/](../../src/cleanroom-api/),
[docs/phase3/phase3-finalization-prompt.md](../phase3/phase3-finalization-prompt.md)).

### Fixed inputs (maintainer decisions — treated as settled here)

These four decisions were made by the maintainer and drive the whole design:

1. **LLM execution — maintainer-run, no fallback tier.** Build-time analysis runs on the
   maintainer's machine against a pluggable OpenAI-compatible endpoint (a free local model
   *or* a cloud API). CI **never** calls an LLM; it carries the previous `examples.db`
   forward. A configured endpoint is *required* to (re)build the corpus — there is **no**
   no-LLM "metadata-only" degraded build mode.
2. **Licensing — full roster verbatim.** All eight roster repos' snippets are stored
   verbatim, including GPL-3.0 Fugue, each carrying a per-example source+license notice;
   `mods` gains a `license` column; DB metadata records the per-repo review outcome.
3. **Scope — maximal.** The core deliverables **plus** the coupled service/tool fixes, the
   N+1 enrichment fix, and the `api_references` ↔ `cleanroom-api.db` triple-DB join.
4. **SRG cross-links — index-time resolution.** SRG names in snippets are detected and
   resolved against the build machine's `mappings.db` at build time and stored; the
   formatter renders resolved names with a `resolve_symbol` pointer; runtime degrades to
   plain text when `mappings.db` is absent (no hard runtime coupling).

---

## 1. Goals, deliverables, and exit criterion

Phase 5 replaces the unrecoverable mod-examples pipeline (gitignored, never committed,
LM-Studio-bound — RESEARCH §2.5) and the vestigial 1-mod/3-example corpus (RESEARCH §2.2)
with a fully in-repo, reproducible pipeline and a real 1.12.2 corpus, and wires the
distribution so a genuine `examples.db` asset finally ships.

**Deliverables** (from [PROJECT_DESIGN.md:232-234,311-312](../PROJECT_DESIGN.md), expanded
by the maximal-scope decision):

1. A new **fully in-repo ingestion pipeline** — committed prompts, a pluggable
   OpenAI-compatible endpoint, and a golden-output test set (§6, §7).
2. The **reconstructed schema frozen** in a committed module, schema-versioned (§5).
3. **SRG-awareness** — snippets with `func_`/`field_` names cross-link to `resolve_symbol`
   (§8).
4. **Roster ingestion** — the eight-repo roster with per-repo license review recorded in
   the artifact (§3, §4).
5. **Coupled tool/corpus repair** — category-enum edits, loader/version filters, the
   schema gate, tool-copy rewrite, and the dispatch footgun (§9).
6. **The triple-DB join** — `api_references` resolved against `cleanroom-api.db` (§8.3).
7. **CI ships the examples asset** — carry-forward wired so a maintainer-published asset
   propagates (§10).

**Exit criterion** (RESEARCH OQ1 — Phase 5 has no `Exit:` clause in §8; this document adds
one, matching the §8 preamble that every phase "leaves the server building, testing, and
shipping"):

> The server builds, lints, type-checks, and tests green with the five example tools live.
> `examples.db` rebuilds **reproducibly** from committed prompts + roster manifest against a
> configured endpoint; the golden tests pass fully offline. A real roster-derived
> `examples.db` installs via `manage`, passes the runtime schema gate, and answers the W1
> "idiomatic 1.12.2 example" workflow end-to-end (`search_mod_examples` → `get_mod_example`
> with SRG cross-links rendered). Adversarial multi-agent review finds no surviving
> correctness findings.

**Process convention** (RESEARCH OQ2): Phase 5 **adopts the Phase 3 finalization protocol**
as the standing convention — blind implementation (no build/test/run during authoring) →
ordered validation gates → mandatory adversarial multi-agent review looping until dry, per
[docs/phase3/phase3-finalization-prompt.md](../phase3/phase3-finalization-prompt.md). This
resolves the question Phase 4 left unrecorded; a Phase 5 finalization prompt is authored as
a sibling to the Phase 3 one.

---

## 2. Non-goals

Stated explicitly so the implementation does not drift into them:

- **No on-device / user-machine examples build.** Unlike the mappings local-build path, there
  is no `manage` "build examples locally" flow — it would put an LLM endpoint and a
  multi-repo download in every user's startup path (RESEARCH C7, OQ19). This is a hard
  rejection, not a deferral.
- **No LLM at runtime, and none in CI.** The running MCP server only *queries* a prebuilt
  SQLite DB; the LLM is a build-time content-generation step on the maintainer's machine
  only. CI never calls an endpoint.
- **No no-LLM "metadata-only" build mode.** Per the maintainer decision, the pipeline
  requires a configured endpoint; there is no degraded build that skips analysis.
- **No semantic/embedding search or bm25 ranking for examples.** Search stays FTS5-prefix
  with curated ordering (`quality_score DESC, is_featured DESC`) — RESEARCH C3. Doc
  embeddings live in a different DB with a different schema; adding them here is new
  machinery, out of scope.
- **No coupling to `cleanroom-src/`.** The pipeline consumes *published* GitHub artifacts
  (repo zipballs at pinned refs), never the gitignored checkout — consistent with the
  Phase 3 no-`cleanroom-src` rule.
- **No modern-loader / reference examples.** The corpus is **pure 1.12.2 target** (RESEARCH
  OQ16). The vestigial Create example (a modern mod mislabeled `loader: "forge"`) is
  dropped, not migrated.
- **Not a general multi-version/multi-loader example encyclopedia.** Breadth beyond
  idiomatic 1.12.2 target code is out of scope ("orientation, not exclusion").
- **No new cross-DB *runtime* dependency is made mandatory.** The SRG and `cleanroom-api`
  joins are resolved at index time and degrade gracefully; `examples.db` remains
  self-contained and usable with neither `mappings.db` nor `cleanroom-api.db` installed
  (RESEARCH C4).

---

## 3. Corpus and roster

**Corpus scope:** pure 1.12.2 target code, ingested from the eight-repo roster below.
`loader` is assigned per repo (RESEARCH §2.7): classic Forge-1.12.2 mods → `'forge'`;
CleanroomMC-org mods → `'cleanroom'`. Both are `target`-role in the loader registry
([loaders.ts:17,41,47](../../src/loaders.ts:17)), so target-scope example queries catch
either.

**Final roster** (all facts verified live 2026-07-22 in RESEARCH §3.1; the design *corrects*
PROJECT_DESIGN §5.6's license errors per RESEARCH §4 deltas 1–3):

| Repo | Pinned ref | License | Loader | Role in corpus |
|---|---|---|---|---|
| `TheGreyGhost/MinecraftByExample` | branch `1-12-2-final` @ `01ac397d` | **Unlicense** (public domain) | `forge` | First-priority teaching corpus (MBE01–MBE75: blocks, items, tile entities/TESR, containers, recipes, HUD, particles, networking, config GUI) |
| `SlimeKnights/TinkersConstruct` | branch `1.12` @ `c01173c` | **MIT** | `forge` | Capabilities, TESR, networking. **Pin `1.12`** — default branch is `1.20.1` |
| `AppliedEnergistics/Applied-Energistics-2` | branch `rv6-1.12` @ `5554ba9` | **LGPL-3.0** | `forge` | Capabilities, networking. **Pin `rv6-1.12`** — `rv6-1.12.2` 404s; default `main` is modern |
| `GregTechCEu/GregTech` | `master` (=1.12.2) | **LGPL-3.0** | `forge` | Flagship ecosystem mod. **Scale case** (~160 MB git size) — package subsetting required (§6.2) |
| `CleanroomMC/ModularUI` | `master` (=1.12.2) | **LGPL-3.0** | `cleanroom` | Canonical Cleanroom-native UI code |
| `CleanroomMC/GroovyScript` | `master` (=1.12.2) | **LGPL-3.0** | `cleanroom` | Java + Groovy DSL surface |
| `CleanroomMC/Fugue` | `master` (=1.12.2) | **GPL-3.0** | `cleanroom` | Canonical real-world Cleanroom mixin consumer. Strongest copyleft (§4) |
| `ACGaming/UniversalTweaks` | `main` (=1.12.2) | **LGPL-3.0** | `forge` | Mixin-heavy compat mod — real-world mixin patterns |

**Pinning.** Most roster repos have no usable 1.12.2 release tags; branches are the unit
(RESEARCH §3.3). The design pins a **commit SHA per repo** recorded in the roster manifest,
and records the resolved SHAs in DB metadata — the same SHA-drift mitigation Phase 4 used,
and the change-detection key for the build skip (§6.4). Four repos are active (Fugue,
UniversalTweaks, GTCE, AE2); MBE and TiCon are frozen since 2021 — stable but stock-Forge-era
idiom, which the corpus must not mislabel as Cleanroom-native (loader assignment above keeps
them `forge`).

**Roster manifest — `data/examples-roster.json`** (committed; the pipeline's single source
of roster truth and the reviewable licensing gate):

```jsonc
{
  "schema": 1,
  "repos": [
    {
      "name": "MinecraftByExample",
      "repo": "TheGreyGhost/MinecraftByExample",
      "ref": "1-12-2-final",
      "sha": "01ac397d...",              // resolved + pinned at review time
      "loader": "forge",
      "license": "Unlicense",
      "licenseReview": { "verdict": "approved", "by": "<maintainer>", "date": "2026-07-22",
                         "notes": "README §Licence Info = Unlicense; root files are Forge MDK boilerplate" },
      "include": ["src/main/java/minecraftbyexample/**/*.java"],
      "exclude": [],
      "maxSnippetsPerRepo": null,        // null = unbounded (small teaching repo)
      "maxFileBytes": 200000
    },
    {
      "name": "GregTech",
      "repo": "GregTechCEu/GregTech",
      "ref": "master",
      "sha": "…",
      "loader": "forge",
      "license": "LGPL-3.0",
      "licenseReview": { "verdict": "approved", "by": "<maintainer>", "date": "…", "notes": "…" },
      "include": [                        // package subsetting — NOT the whole 160MB repo
        "src/main/java/gregtech/api/**/*.java",
        "src/main/java/gregtech/common/blocks/**/*.java"
      ],
      "exclude": ["**/integration/**", "**/generated/**"],
      "maxSnippetsPerRepo": 120,
      "maxFileBytes": 120000
    }
    // … one entry per roster repo
  ]
}
```

The manifest is what makes "per-repo license review" (PROJECT_DESIGN §6.1) a reviewable
in-repo artifact rather than a lost implementation-time act, and it carries the cost/scale
guardrails (RESEARCH OQ21): `include`/`exclude` globs for subsetting, `maxFileBytes`, and
`maxSnippetsPerRepo`. Silent truncation is prohibited — when a cap is hit, the indexer
`log()`s exactly which repo/files were dropped (RESEARCH's "no silent caps" principle).

---

## 4. Licensing and attribution

Per the maintainer decision, the corpus stores **verbatim snippets from every roster repo,
including GPL-3.0 Fugue**. The design's job is to make the shipped artifact self-describing
and correctly attributed (RESEARCH §3.2, R1; OQ14/15/17):

- **`mods.license` column** (new — §5). Every mod row records its verified license string
  from the roster manifest; the DB never contains a snippet whose license is unrecorded.
- **Per-example attribution in output.** `formatExampleForAI`
  ([mod-examples-service.ts:564-629](../../src/services/mod-examples-service.ts:564)) gains
  a source+license line, e.g. `**Source:** GregTech (GregTechCEu/GregTech, LGPL-3.0) —
  [file](file_url) lines N–M`. `list_canonical_mods`
  ([modExamples.ts:106-119](../../src/tools/modExamples.ts:106)) gains a per-mod license
  column. The `file_url` deep-link to upstream (already stored) is the canonical
  attribution/provenance pointer.
- **Review record in DB metadata.** The `metadata` table records the per-repo review
  outcome (repo → {license, verdict, by, date}) copied from `examples-roster.json` at ingest
  — so the artifact itself proves each repo was reviewed and by whom.
- **Snippet-length discipline.** Snippets are excerpts (method-/class-fragment scale), never
  whole files, keeping the redistributed portion small and pointing to `file_url` for the
  rest — the existing `search_mod_examples` 500-char display truncation
  ([modExamples.ts:202-203](../../src/tools/modExamples.ts:202)) already reflects this
  posture. A concrete per-snippet line cap is proposed but flagged for confirmation (§13).
- **GPL-3.0 note.** Fugue is the only strong-copyleft repo. It is included per the decision,
  but the residual — that GPL-3.0 material in a redistributed SQLite asset warrants an
  explicit legal acknowledgment — is surfaced in §13, not silently assumed away.
- **LLM-processing angle.** The pipeline sends upstream code to a third-party endpoint for
  analysis. The per-repo review record is the place to note copyleft-endpoint etiquette
  (RESEARCH §3.2); for a local endpoint the code never leaves the maintainer's machine,
  which the maintainer-run model (Fixed Input 1) makes the default-safe path.

---

## 5. Schema (frozen v2)

The DDL died with the lost pipeline; it is reconstructed from the service's SELECTs
(authoritative-by-observation, RESEARCH §2.2/A.6) and **frozen in a new committed module**
`src/examples/schema.ts` (named after the `examples` `DbId`, matching the Phase 3 sibling
`src/cleanroom-api/`), mirroring
[src/cleanroom-api/schema.ts](../../src/cleanroom-api/schema.ts): it owns
`EXAMPLES_SCHEMA_VERSION`, `initializeExamplesDb()`, and `readDbMetadata()`/
`readDbSchemaVersion()`, with `EXAMPLES_SCHEMA_VERSION` paired to
`DBS.examples.schemaVersion` in [dbs.ts](../../src/dbs.ts:65). This freezes RESEARCH C1/C2.

**All reconstructed tables are preserved** (RESEARCH OQ7 — A.6 directs preserving the
richness). The deliberate additions over the observed legacy schema are marked ⟵.

```sql
CREATE TABLE mods (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  repo TEXT NOT NULL,               -- rendered https://github.com/{repo}
  loader TEXT NOT NULL,             -- 'forge' | 'cleanroom' (target family)
  license TEXT NOT NULL,            -- ⟵ verified license id from roster manifest (§4)
  description TEXT,
  readme_summary TEXT,
  architecture_notes TEXT,
  star_count INTEGER,
  minecraft_versions TEXT,          -- JSON array
  priority INTEGER                  -- ORDER BY m.priority DESC (must be populated, §5 note)
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,        -- filter key; sourced from EXAMPLE_CATEGORIES (§9)
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  sort_order INTEGER
);

CREATE TABLE examples (
  id INTEGER PRIMARY KEY,
  mod_id INTEGER NOT NULL REFERENCES mods(id),
  category_id INTEGER REFERENCES categories(id),
  file_path TEXT, file_url TEXT,
  start_line INTEGER, end_line INTEGER,
  title TEXT NOT NULL,
  code TEXT,
  language TEXT,
  caption TEXT,
  explanation TEXT,                 -- LLM-produced
  pattern_type TEXT,
  complexity TEXT,                  -- beginner|intermediate|advanced|expert
  best_practices TEXT,              -- 5 JSON-array columns (LLM-produced)
  potential_pitfalls TEXT,
  use_cases TEXT,
  keywords TEXT,
  minecraft_concepts TEXT,
  quality_score REAL,               -- 0..1 (rubric §13)
  is_featured INTEGER               -- 0/1
);

CREATE TABLE example_relations (
  source_id INTEGER NOT NULL REFERENCES examples(id),
  target_id INTEGER NOT NULL REFERENCES examples(id),
  relation_type TEXT NOT NULL,      -- uses|extends|similar_to|alternative_to|requires|complements
  description TEXT,
  strength REAL
);

CREATE TABLE tags (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE);
CREATE TABLE example_tags (example_id INTEGER NOT NULL REFERENCES examples(id),
                           tag_id INTEGER NOT NULL REFERENCES tags(id),
                           PRIMARY KEY (example_id, tag_id));

CREATE TABLE example_imports (
  example_id INTEGER NOT NULL REFERENCES examples(id),
  import_path TEXT NOT NULL,
  import_type TEXT,
  is_critical INTEGER               -- 0/1; formatter renders critical-only
);

CREATE TABLE api_references (
  example_id INTEGER NOT NULL REFERENCES examples(id),
  class_name TEXT NOT NULL,
  method_name TEXT,                 -- NULL for class-only refs
  api_type TEXT,                    -- e.g. 'vanilla' | 'forge' | 'cleanroom'
  srg_name TEXT,                    -- ⟵ SRG token if class_name/method_name is SRG (§8)
  resolved_name TEXT,               -- ⟵ readable name from mappings.db (§8), NULL if unresolved
  api_fqn TEXT,                     -- ⟵ FQN from cleanroom-api.db if a framework symbol (§8.3), else NULL
  api_kind TEXT                     -- ⟵ 'event'|'annotation'|'class'|… from cleanroom-api.db, else NULL
);

-- FTS5 external-content over the curated prose columns (RESEARCH OQ8): raw `code` is
-- EXCLUDED — prefix-matching on identifiers is noisy and the LLM already extracts
-- keywords/minecraft_concepts as the searchable distillation of the code.
CREATE VIRTUAL TABLE examples_fts USING fts5(
  title, caption, explanation, best_practices, use_cases, keywords, minecraft_concepts,
  content='examples', content_rowid='id'
);  -- + ai/ad/au sync triggers, mirroring cleanroom-api's types_fts

CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);  -- ⟵ NEW: legacy DB lacked it
```

**Indexes** (implied by RESEARCH §2.2 query plans, made explicit):
`examples(mod_id)`, `examples(category_id)`, `examples(quality_score)`, `examples(is_featured)`,
`examples(pattern_type)`, `example_relations(source_id)`, `example_tags(example_id, tag_id)`,
`tags(slug)`, `example_imports(example_id)`, `api_references(example_id)`, plus a new
`api_references(srg_name)` for §8 rendering.

**Deliberate schema decisions:**

- **`examples_fts` columns** (OQ8): `title, caption, explanation, best_practices, use_cases,
  keywords, minecraft_concepts`. `code` excluded (above). Search mechanics stay as observed
  (FTS5 prefix `"tok"* OR "tok"*`, curated ordering — RESEARCH §2.2, C3); no ranking change.
- **`priority` populated** — RESEARCH §2.2 flags it as SELECTed-nowhere but
  `ORDER BY`-only, "the easiest column to lose in a rebuild." The ingest writes it from the
  roster manifest ordering so canonical mods rank first.
- **`metadata` table** carries: `schema_version`, `analysis_version`, `prompt_version`,
  `llm_model`, roster SHAs (`roster_pins` JSON), per-repo `license_review` JSON, `indexed_at`,
  `counts` — mirroring the cleanroom-api provenance set
  ([ingest.ts:138-147](../../src/cleanroom-api/ingest.ts:138)). Its presence is what makes
  the runtime schema gate and the auto-update forcing function work (RESEARCH C2, §2.3).

**Registry + version continuity** (RESEARCH §2.3, OQ9): bump
`DBS.examples.schemaVersion` **1 → 2** ([dbs.ts:71](../../src/dbs.ts:71)) and start the new
manifest line at **`0.3.0`** — above the legacy `0.1.1`/`0.2.0` manifests so version
comparison never treats a surviving old install as newer. Because the new `isAvailable()`
becomes schema-gated (§9) and legacy DBs lack a `metadata` table, an ancient 3-example DB
at the examples path now reads as *outdated → not installed → force-replaced*, closing the
"null-toothless forcing function" hole (RESEARCH §2.3, §4 delta 7).

**Dead-code disposition** (OQ7): with a real corpus, `getFeaturedExamples` gains a caller
(a `featured_only` path already exists via the tool), `example_relations` is populated only
if the relation pass ships (§13 — recommend empty in v1, table retained), and the remaining
dead methods (`getMod`, `getExamplesByPattern`, `formatExamplesForAI`) are **deleted**
deliberately rather than left as latent surface — the handlers re-implement formatting and
nothing calls them (RESEARCH §2.2).

---

## 6. The in-repo pipeline

The pipeline mirrors the Phase 3 `cleanroom-api` structure module-for-module (RESEARCH §2.5;
[scripts/index-java-api.ts](../../scripts/index-java-api.ts)):

```
src/examples/
  schema.ts      // §5: DDL, EXAMPLES_SCHEMA_VERSION, init, metadata readers
  model.ts       // pipeline interfaces (RawFile, Snippet, Analysis, …)
  acquire.ts     // §6.1 download roster repos at pinned SHAs
  select.ts      // §6.2 pick snippets + apply caps/subsetting
  analyze.ts     // §6.3 LLM analysis (committed prompts → structured JSON)
  srg-link.ts    // §8 detect + resolve SRG names, resolve api_references
  ingest.ts      // §6.5 single-transaction writer + provenance metadata
  prompts/       // §7 committed, versioned prompt files
scripts/index-mod-examples.ts   // orchestrator (maintainer/CI entry; NOT in npm package)
data/examples-roster.json        // §3 roster + license review + caps
```

`scripts/index-mod-examples.ts` is registered as `pnpm run index-mod-examples[:force]` in
[package.json](../../package.json) (the old scripts of that name were removed in `38f5715`;
no naming conflict — RESEARCH §4 delta 9). Like the cleanroom-api indexer it is **not
shipped in the npm tarball** (only `dist/` + `postinstall.js` ship — RESEARCH C7); there is
no on-device build (§2).

### 6.1 Acquire

Per-repo **zipball download** from `codeload.github.com/<owner>/<repo>/zip/<sha>`, honoring
`GITHUB_TOKEN` for rate limits (RESEARCH §3.3). This deliberately avoids the trees-API path
in [cleanroom-wiki.ts](../../src/indexer/cleanroom-wiki.ts) that hard-throws on
`tree.truncated` (:103-105) and fetches per-file sequentially — unworkable for GTCE-class
trees. The zipball is walked with `AdmZip`, exactly the shape the cleanroom-api indexer
already uses ([index-java-api.ts](../../scripts/index-java-api.ts) `entryPattern` walk).
Resolved SHAs (from the branch/`ref` in the manifest) are pinned and recorded in metadata.

### 6.2 Select

Snippet selection turns raw `.java` files into candidate `Snippet`s (a coherent
class/method/inner-region with file/line provenance and detected imports), constrained by
the roster manifest's `include`/`exclude` globs, `maxFileBytes`, and `maxSnippetsPerRepo`
(§3). This is the cost/scale guardrail for GTCE-scale repos (RESEARCH OQ21). Selection
heuristics prefer whole class/method units that map to a category (block, item, tile-entity,
capability, networking, mixin, …) and skip generated/integration packages. Dropped
files/caps are logged, never silent.

### 6.3 Analyze (the LLM step)

Each selected snippet is sent to a **pluggable OpenAI-compatible endpoint** with a
committed prompt (§7); the model returns **structured JSON** matching the analysis columns:
`caption, explanation, best_practices[], potential_pitfalls[], use_cases[], complexity,
quality_score, category, pattern_type, keywords[], minecraft_concepts[], tags[]`. The raw
snippet (code, file, lines, imports) is joined with this analysis to form the example row.

**Endpoint configuration surface** (RESEARCH OQ4; following the `GITHUB_REPO_URL`
env-override precedent [dbs.ts:25-27](../../src/dbs.ts:25) and the hand-rolled-flag
convention of the existing scripts):

| Setting | Env var | CLI flag |
|---|---|---|
| Base URL | `CLEANROOM_MCP_LLM_BASE_URL` | `--llm-base-url` |
| API key | `CLEANROOM_MCP_LLM_API_KEY` | `--llm-api-key` |
| Model | `CLEANROOM_MCP_LLM_MODEL` | `--llm-model` |

A configured endpoint is **required** (Fixed Input 1): with none set, the indexer exits with
a clear error and touches nothing — there is no no-LLM build mode. CI relies on this to
*not* attempt a build; it carries the previous asset forward instead (§10).

### 6.4 Determinism (RESEARCH R2, OQ6)

Reproducibility is the entire reason Phase 5 exists (the first pipeline died precisely
because its analysis was unrecoverable). The design pins:

- **Prompt files committed and versioned** under `src/examples/prompts/`; a
  `prompt_version` string recorded in DB metadata.
- **Model pinned** (`llm_model`) and **temperature 0** for the analysis calls.
- **`analysis_version`** = a version string over (prompt_version + model + pipeline logic),
  recorded in metadata. Changing the prompt or model **bumps `analysis_version` and
  invalidates prior analyses** (full re-run policy) — the field the up-to-date skip keys on.
  `prompt_version` is `<label>:<fingerprint>`, where the fingerprint is a sha256 prefix over
  the *rendered* prompt template. Without it the label is hand-maintained, and an edit to the
  prompt changes what the model sees while every cache row still hits — the invalidation
  guarantee above silently would not hold.
- **Up-to-date skip** (mirroring [index-java-api.ts](../../scripts/index-java-api.ts)'s
  metadata skip): the indexer no-ops when the existing DB's `roster_pins` (SHAs) **and**
  `analysis_version` **and** `schema_version` all match the target — the change-detection
  key (RESEARCH OQ18). `--force` overrides.

### 6.5 Ingest

Single-transaction writer into `<db>.tmp`, then **atomic rename** with tmp/`-wal`/`-shm`
cleanup on error — the exact durability pattern from
[index-java-api.ts](../../scripts/index-java-api.ts) (no partial DB ever visible at the
runtime path). Provenance metadata (§5) is written in the same transaction. Flags mirror the
cleanroom-api indexer: `--db-path`, `--force`, plus a `--roster <path>` override and an
offline `--repo-zip <path>` for testing without network.

---

## 7. Committed prompts and golden tests

**Prompts** live as versioned files under `src/examples/prompts/` (e.g.
`analyze-snippet.v2.md`), never inline in code — so a diff to a prompt is a reviewable,
version-bumping event (§6.4). The prompt instructs the model to return strict JSON for the
analysis columns and to score `quality_score` against a committed rubric (§13).

**Golden tests** (RESEARCH OQ5, R2) pin the *pipeline's* behavior, not the provider's:

- **Canned-response fixtures, fully offline & deterministic.** The analyze step is tested by
  injecting a fake endpoint that returns recorded JSON responses for known input snippets;
  no network, no real model. This is the same discipline as
  [cleanroom-api-service.test.ts:184-194](../../src/services/cleanroom-api-service.test.ts:184)
  (fixture corpus through the real pipeline into a `mkdtempSync` DB).
- **Fixture code style.** The full-verbatim licensing decision (§4) means goldens *may*
  include small pinned real snippets from permissive roster repos (MBE/TiCon), but the
  analysis-path goldens primarily use the synthetic, invented-names style of
  [mcp-ingest.test.ts:9-21](../../src/mappings/mcp-ingest.test.ts:9) to keep the license
  surface minimal while still exercising the real select→analyze→srg-link→ingest path end to
  end.
- **What the goldens assert:** a fixed input snippet + a canned analysis response produce an
  exact expected DB row set (example + tags + imports + api_references incl. resolved SRG),
  and the FTS/relation/formatter output is stable. A schema-gate mutation test (schema_version
  mismatch → not-installed) mirrors
  [cleanroom-api-service.test.ts:312-335](../../src/services/cleanroom-api-service.test.ts:312).

---

## 8. SRG cross-links and the cleanroom-api join

### 8.1 Index-time SRG resolution (Fixed Input 4; RESEARCH §2.6, OQ12)

At build time, `srg-link.ts` scans each snippet's code and detected symbols with the
**exported** `detectSymbolKind`/`extractSrgId`
([src/mappings/symbol-kind.ts:26-60](../../src/mappings/symbol-kind.ts:26)) — first-match
regexes for `srg-method` (`func_\d+_…`), `srg-field` (`field_…`), `srg-param` (`p_…`), etc.
Detected SRG names are resolved against the **build machine's** `mappings.db` and stored on
`api_references` (`srg_name`, `resolved_name`).

**Batch resolution.** `MappingsService.resolveSymbol` is single-shot and its exact-lookup
helpers are private ([mappings-service.ts:1377-1631](../../src/services/mappings-service.ts:1377)),
so the design **adds a batch `resolveSymbols(symbols, minecraftVersion?)`** to
`MappingsService` (looping the existing private helpers under one held connection) rather
than opening/closing a connection per name. This is a small, additive method — 1.12.2 rows
carry `minecraft_version = '1.12.2'`, `mapping_set = 'mcp'`
([mcp-ingest.ts:37](../../src/mappings/mcp-ingest.ts:37)).

**Runtime rendering + graceful degrade.** `formatExampleForAI` renders resolved names, e.g.
`func_180495_p → getBlockState` with a pointer to `resolve_symbol` for the rest. Because
resolution happens at *index time*, the rendered link is plain stored text — when
`mappings.db` is absent at runtime, examples still render (SRG token shown as-is with the
`resolve_symbol` pointer). `examples.db` never hard-depends on `mappings.db` (RESEARCH C4,
§2 non-goal).

### 8.2 What if the build machine lacks `mappings.db`?

The indexer logs a warning and stores the SRG token with `resolved_name = NULL`; the corpus
still ships (SRG names simply un-enriched). A CI/maintainer precondition documents that a
current `mappings.db` should be present for a fully-enriched build.

### 8.3 The `api_references` ↔ `cleanroom-api.db` triple-DB join (Fixed Input 3; RESEARCH OQ13)

A.6 calls `api_references` "the natural join point to `cleanroom-api.db` symbols." In scope
per the maximal decision. At index time, `srg-link.ts` also resolves framework symbols
(non-SRG class/method references in `com.cleanroommc.*`, `net.minecraftforge.*`,
`zone.rong.mixinbooter.*`) against the build machine's `cleanroom-api.db`, storing `api_fqn`
and `api_kind` (event/annotation/class) on `api_references`. `get_mod_example` output then
notes, e.g., "references `PlayerInteractEvent.RightClickBlock` (Cancelable event — see
`get_api_class`)."

Like the SRG join this is **index-time and degrades gracefully**: absent `cleanroom-api.db`
at build time → `api_fqn`/`api_kind` NULL; absent at runtime → the reference renders without
the enrichment. No triple-DB *runtime* query is introduced (RESEARCH notes triple-DB queries
have no precedent — this design keeps the join at build time precisely to avoid that
coupling).

---

## 9. Service and tool changes (coupled + maximal fixes)

All items below are in scope per the maximal-scope decision (RESEARCH R7, §4 deltas 5–7,
OQ7/10/11/17). Files: primarily
[mod-examples-service.ts](../../src/services/mod-examples-service.ts) and
[modExamples.ts](../../src/tools/modExamples.ts).

- **Schema gate** (OQ11): replace existsSync-only `isAvailable()`
  ([mod-examples-service.ts:104-106](../../src/services/mod-examples-service.ts:104)) with a
  schema-gated `isAvailable()` + `isSchemaOutdated()` (mtime-cached), aligning with
  [mappings-service.ts:562-577](../../src/services/mappings-service.ts:562) and
  [cleanroom-api-service.ts:169-185](../../src/services/cleanroom-api-service.ts:169) and the
  registry's own documented convention ([dbs.ts:38](../../src/dbs.ts:38)). Add the examples
  outdated-schema branch to `list_targets`
  ([listTargets.ts:63-71](../../src/tools/listTargets.ts:63)) that mappings/cleanroom-api
  already have.
- **Loader + version filters** (OQ10, A.1): add `loader` and `minecraft_version` filters to
  `searchExamples` (which today honors neither despite the data carrying them —
  [mod-examples-service.ts:281-331](../../src/services/mod-examples-service.ts:281)) and a
  `loader` param to the `search_mod_examples` tool schema.
- **Category-enum wiring** (OQ10, §2.7 drift): replace the hardcoded 20-value inline enum in
  `search_mod_examples` ([modExamples.ts:33-54](../../src/tools/modExamples.ts:33)) — which
  still lists `data-generation` and lacks `capabilities`/`coremods-mixins` — with values
  sourced from `EXAMPLE_CATEGORIES` ([categories.ts:28-55](../../src/categories.ts:28)),
  whose only current consumer is its own test. A test guards against future drift.
- **Tool-copy rewrite** (OQ17, §4 delta 5): the tool/file descriptions still advertise the
  dead "Create, Botania, Applied Energistics 2" corpus
  ([modExamples.ts:3,17,29](../../src/tools/modExamples.ts:3)). Rewrite to describe the real
  1.12.2 roster (or describe *categories* of examples rather than naming mods, to stay
  robust as the roster evolves). `list_canonical_mods` gains the license line (§4).
- **Dispatch footgun** ([index.ts:292](../../src/index.ts:292)): `id: (args?.id as number)
  || 0` silently turns a missing id into 0 → "not found" instead of a validation error. Fix
  to validate presence and return an MCP validation error.
- **N+1 enrichment** (RESEARCH R7, maximal scope): `enrichExample` runs 3 extra queries per
  example (tags/imports/api-refs —
  [mod-examples-service.ts:491-559](../../src/services/mod-examples-service.ts:491)). Batch
  these across a result set (one `WHERE example_id IN (…)` per child table, grouped in JS) —
  tolerable at 3 examples, painful at 300.
- **Availability message** (RESEARCH §2.1): the unavailability text points at the docs tools
  rather than `manage`; align it with the Phase 3 `NOT_INSTALLED_MESSAGE` convention
  ([cleanroomApi.ts:95-109](../../src/tools/cleanroomApi.ts:95)).
- **Dead-method deletion** (OQ7): delete `getMod`, `getExamplesByPattern`,
  `formatExamplesForAI` (§5).

---

## 10. Distribution and CI

**Publishing model (maintainer-run — Fixed Input 1).** The maintainer runs
`pnpm run index-mod-examples` locally against their endpoint, producing `data/examples.db`,
generates the manifest with the existing registry-driven
[scripts/generate-manifest.ts](../../scripts/generate-manifest.ts) (`--db examples`
already accepted, RESEARCH §2.3), and publishes both assets on the main `v{version}` release
(the one-release-for-all-DBs convention, [dbs.ts:8-10](../../src/dbs.ts:8)).

**CI stays carry-forward-only for examples** (RESEARCH §2.4, OQ20). CI **never** builds
`examples.db` (no LLM in CI). The release workflow's `carry_forward examples`
([release.yml:188-226](../../.github/workflows/release.yml:188)) already exists; the only
real change is that once the maintainer publishes the first asset, carry-forward finally has
something to propagate — today it soft-skips forever because no release has ever carried the
asset (RESEARCH §2.4, §4 delta 8). Examples deliberately does **not** gain the docs-style
fresh-build fallback ([release.yml:232-247](../../.github/workflows/release.yml:232)) — there
is nothing to freshly build without an endpoint. The weekly job is **not** modified to build
examples (it has no LLM); the cleanroom-api canary pattern is *not* applied here because the
change-key (roster SHAs + analysis_version) is only meaningful to the maintainer-run
indexer, which CI does not invoke.

**"CI finally uploads the examples asset"** (§8 deliverable) therefore means: the upload
plumbing already lists `examples.db` + `examples-manifest.json`
([release.yml:255-268](../../.github/workflows/release.yml:255)); the gap it closes is a
*real maintainer-published asset* existing for carry-forward to find and for `manage` to
install — ending the state where [README.md:53](../../README.md) promises an install that
"Remote version unavailable" defeats.

**Version continuity** (RESEARCH R5, OQ9): first manifest at `0.3.0`, `schemaVersion` 2
(§5). The manifest-continuity hazard (a failed previous-manifest fetch restarts numbering at
`0.1.0`) is the same as Phase 4 R1 and mitigated the same way — CI/the maintainer downloads
the previous release's manifest before `--bump`.

**Auto-update** ([db-versioning.ts:414-429](../../src/db-versioning.ts:414)) already covers
examples generically once installed; the schema forcing function
([db-versioning.ts:190-199](../../src/db-versioning.ts:190)) now works because the new DB
ships a `metadata` table with `schema_version` (§5) — closing the legacy null-toothless hole.

---

## 11. Implementation sequencing and exit

Each step leaves the server green (the §8 preamble). Recommended internal order:

1. **Registry + schema freeze** — bump `DBS.examples.schemaVersion` → 2; author
   `src/examples/schema.ts` (DDL, version, init, metadata readers).
2. **Service + tool fixes (§9)** — schema gate, filters, category wiring, tool-copy,
   dispatch fix, N+1, dead-method deletion. These stand alone and are testable without a
   corpus (fixture DB).
3. **Batch `resolveSymbols` on `MappingsService` (§8.1)** — additive, unit-testable.
4. **Pipeline modules (§6)** — `model → acquire → select → analyze → srg-link → ingest` +
   `scripts/index-mod-examples.ts`; committed prompts + golden tests (§7).
5. **Roster + licensing (§3, §4)** — `data/examples-roster.json` with resolved SHAs and
   review records; `mods.license` + attribution rendering.
6. **SRG + cleanroom-api joins (§8)** wired through srg-link/ingest and the formatter.
7. **CI wiring (§10)** — confirm carry-forward + upload lists; manifest continuity.
8. **Finalization protocol** — author the Phase 5 finalization prompt (sibling to Phase 3's)
   and run it: validation gates → adversarial multi-agent review → dry loop.

**Exit:** as §1.

---

## 12. Risks (carried from RESEARCH, under these decisions)

- **R1 — Roster licensing.** Full-verbatim incl. GPL-3.0 Fugue is chosen; mitigations are
  the `license` column, per-example attribution, recorded per-repo review, and excerpt-scale
  snippets (§4). Residual GPL-3.0 acknowledgment → §13.
- **R2 — Non-reproducible analysis** (the original failure). Mitigated by committed
  prompts, pinned model/temperature, `analysis_version`, and offline goldens (§6.4, §7).
- **R3 — CI cost/time.** Eliminated for CI by the maintainer-run model (no LLM in CI). Cost
  now lands on the maintainer's endpoint; the per-repo `maxSnippetsPerRepo`/`maxFileBytes`
  caps and package subsetting (§3, §6.2) bound token spend.
- **R4 — Roster drift.** SHA-pinning + recorded pins + the up-to-date skip (§3, §6.4). Frozen
  MBE/TiCon vs active Fugue/UT/GTCE/AE2 handled per-repo.
- **R5 — Manifest continuity.** §10 (download previous manifest before bump).
- **R6 — `quality_score` semantics undefined.** A committed rubric is required or the field
  and `min_quality`/`featured_only` filters are decoration → §13.
- **R7 — Service weaknesses at scale.** Addressed by the §9 fixes (filters, N+1, schema
  gate, dispatch).

**New risks from the maximal choices:**

- **GPL-3.0 redistribution reach.** GPL-3.0 material in a redistributed SQLite asset may
  impose obligations beyond attribution; flagged for explicit acknowledgment (§13).
- **Triple-DB build-time coupling.** A fully-enriched build wants `mappings.db` *and*
  `cleanroom-api.db` present on the build machine. Kept at build time (never runtime) and
  degrading to NULL enrichment so it never blocks a build or a query (§8).
- **No-fallback fragility.** With no no-LLM tier, a missing/broken endpoint blocks *all*
  corpus refresh; carry-forward keeps the last good asset shipping, but the corpus can go
  stale until the maintainer rebuilds. Accepted per Fixed Input 1.

---

## 13. Open questions (marked — for maintainer resolution)

These residuals remain after the four locked decisions; each has a recommendation but is
surfaced rather than silently assumed:

1. **Default LLM model to pin.** Maintainer-run, but which endpoint/model becomes the
   committed default (`llm_model`) that the golden `analysis_version` is computed against?
   *Recommendation:* pin a specific capable model the maintainer actually uses; a local
   model keeps copyleft code on-machine (§4). The exact string is the maintainer's to set.
2. **`quality_score` rubric (R6).** The 0–1 scale and "featured = ≥0.7" convention are
   recoverable from the dead corpus, but the rubric that produced them died. *Recommendation:*
   commit an explicit rubric (dimensions: correctness/idiomaticity/clarity/completeness) in
   the prompt; without it the field and its filters are meaningless. Needs sign-off.
3. **Snippet-length cap.** A concrete per-snippet ceiling keeps LGPL/GPL excerpts clearly in
   excerpt territory. *Recommendation:* a default cap (e.g. ≤~60 lines / one class or method
   unit) recorded in the roster manifest; confirm the value.
4. **GPL-3.0 Fugue redistribution comfort.** Included per decision, but GPL-3.0 in the
   shipped asset warrants an explicit legal acknowledgment (vs. LGPL/permissive). Confirm the
   maintainer is comfortable, or downgrade Fugue to metadata-only.
5. **`example_relations` population.** LLM-derived cross-snippet edges (`uses`/`extends`/…)
   are an expensive extra pass and were never exercised in the legacy corpus (0 relations).
   *Recommendation:* ship the table empty in v1 (schema retained), add a relation pass later
   if agents want it.
6. **Finalization-protocol confirmation (OQ2).** §1 adopts the Phase 3 protocol as standing
   convention; confirm this is the intended convention for Phase 5 and beyond.

---

## Appendix A — RESEARCH open-question → resolution map

Verifies that every one of RESEARCH §6's 21 open questions is resolved here.

| OQ | Topic | Resolution | Where |
|---|---|---|---|
| 1 | Exit clause | Added explicit exit criterion | §1 |
| 2 | Finalization protocol | Adopt Phase 3 protocol | §1 (confirm §13.6) |
| 3 | Who runs the LLM | Maintainer-run; CI carries forward | §6.3, §10 |
| 4 | Endpoint surface / no-LLM tier | Env+flags; **no** no-LLM tier | §6.3, §2 |
| 5 | Golden-test shape | Canned offline fixtures | §7 |
| 6 | Determinism machinery | Pinned model/temp, `analysis_version`, re-run policy | §6.4 |
| 7 | Fidelity vs cleanup | Preserve richness; delete 3 dead methods | §5 |
| 8 | `examples_fts` columns | Prose columns; exclude `code` | §5 |
| 9 | schemaVersion / version line | Bump → 2; start at `0.3.0` | §5, §10 |
| 10 | A.1 filters + category wiring | In scope | §9 |
| 11 | `isAvailable` schema gate | In scope | §9 |
| 12 | SRG links index vs query time | Index-time + batch method + degrade | §8.1 |
| 13 | `api_references` ↔ cleanroom-api | In scope, index-time | §8.3 |
| 14 | Final roster / snippet policy | Full verbatim, 8 repos | §3, §4 |
| 15 | Attribution mechanics | `license` col + line + metadata review | §4 |
| 16 | Corpus scope | Pure 1.12.2 target; drop Create | §2, §3 |
| 17 | Tool-copy rewrite | Rewrite to real roster + license line | §9 |
| 18 | Change-detection key | Roster SHAs + `analysis_version` | §6.4, §3 |
| 19 | On-device build | Rejected (non-goal) | §2 |
| 20 | Release-time fallback | Carry-forward-only, no fresh-build | §10 |
| 21 | Cost/scale guardrails | Caps + subsetting in roster manifest | §3, §6.2 |
