# IMPL_DOC: Phase 5 — Examples Rebuild

**What this is.** The record of what the blind Phase 5 implementation actually built, mapped
to [`DESIGN.md`](DESIGN.md) and the acceptance oracle in [`BLIND_SPEC.md`](BLIND_SPEC.md).
Written after the blind pass; the finalization/validation record lives alongside in
[`phase5-finalization-prompt.md`](phase5-finalization-prompt.md).

The pipeline mirrors the Phase 3 `cleanroom-api` structure module-for-module.

## New files

| File | Role |
|---|---|
| `src/examples/schema.ts` | Frozen v2 DDL, `EXAMPLES_SCHEMA_VERSION=2`, `initializeExamplesDb()`, `readDbMetadata()`, re-exported `readDbSchemaVersion`. Paired with `DBS.examples.schemaVersion`. |
| `src/examples/model.ts` | Pipeline interfaces: `Roster`/`RosterRepo`, `RawFile`, `Snippet`, `Analysis`, `AnalyzedSnippet`, `ResolvedApiReference`, `ExampleRecord`, `LlmClient`, `IngestMeta`. |
| `src/examples/acquire.ts` | Per-repo zipball download (`codeload.github.com`, honours `GITHUB_TOKEN`) + AdmZip walk; offline `zipPath`. |
| `src/examples/select.ts` | Pure `selectSnippets()` — glob include/exclude, `maxFileBytes`, `maxSnippetsPerRepo`, per-snippet line cap, brace-depth region extraction, import detection. **No silent caps** (every drop logged). |
| `src/examples/analyze.ts` | `resolveEndpointConfig()` (env + flags, **required**), `createOpenAiClient()` (temperature 0), `parseAnalysis()`, `analyzeSnippet()`, `computeAnalysisVersion()`, `PIPELINE_REV`. |
| `src/examples/srg-link.ts` | Index-time SRG resolution (`MappingsService.resolveSymbols`) + framework resolution (`CleanroomApiService.getTypeByName`) → `api_references` enrichment; degrades to NULL. `toExampleRecord()`. |
| `src/examples/ingest.ts` | `ingest()` (single transaction), `runIngest()` (tmp + atomic rename + cleanup), `isUpToDate()` (roster_pins ∧ analysis_version ∧ schema_version). `example_relations` empty (v1). |
| `src/examples/prompts/analyze-snippet.v1.md` | Committed, versioned analysis prompt with the strict-JSON contract + `quality_score` rubric. |
| `src/examples/golden-fixture.ts` | Offline golden builder: fake `LlmClient`, fixture mappings/cleanroom-api DBs, `buildGoldenDb()`. |
| `scripts/index-mod-examples.ts` | Maintainer/CI orchestrator (pnpm `index-mod-examples[:force]`); **not** in the npm tarball. |
| `scripts/build-golden-db.ts` | pnpm `build:golden-db` — emits `$GOLDEN_DB` fully offline. |
| `data/examples-roster.json` | The 8-repo roster (schema 1) with resolved SHAs, per-repo license review, include/exclude globs, byte caps, GregTech subset. |
| Tests | `src/examples/{select,analyze,ingest,schema,golden}.test.ts`, `src/tools/modExamples.test.ts`, `src/services/mappings-service.resolveSymbols.test.ts`. |

## Modified files

- `src/dbs.ts` — `DBS.examples.schemaVersion` 1 → 2.
- `src/categories.ts` — added `EXAMPLE_CATEGORY_INFO` (name/description/icon) to seed the `categories` table.
- `src/services/mod-examples-service.ts` — schema-gated `isAvailable(path?)`/`isSchemaOutdated(path?)`; `license` on `ModInfo`/`ModExample`; `loader` + `minecraft_version` filters; batched `enrichExamples()` (one `WHERE example_id IN (…)` per child table); `api_references` SRG/API columns; `formatExampleForAI` attribution + SRG/framework cross-links; deleted dead `getMod`/`getExamplesByPattern`/`formatExamplesForAI`; `manage`-pointing availability text. Opens no sibling DB at runtime.
- `src/services/mappings-service.ts` — additive batch `resolveSymbols(symbols, mcVersion?)`.
- `src/tools/modExamples.ts` — category enum from `EXAMPLE_CATEGORIES`; `loader` param; roster/category tool copy (dead Create/Botania/AE2 mentions removed); license column in `list_canonical_mods`; `manage` messages; `get_mod_example` id-presence validation.
- `src/index.ts` — dispatch footgun `id: … || 0` removed (raw id passed; handler validates).
- `src/tools/listTargets.ts` — examples outdated-schema branch.
- `package.json` — `index-mod-examples`, `index-mod-examples:force`, `build:golden-db` scripts.

## Distribution / CI (verified, no change needed)

`release.yml` already carries examples forward (`carry_forward examples …`), uploads
`examples.db` + `examples-manifest.json`, and has **no** examples fresh-build fallback. No
workflow invokes `index-mod-examples` or sets `CLEANROOM_MCP_LLM_*`. First manifest starts at
`0.3.0`; `generate-manifest.ts` already accepts `--db examples`.

## Key design realizations

- **Endpoint required, resolved first.** The orchestrator calls `resolveEndpointConfig` before
  touching any file, so a no-endpoint run exits non-zero and writes nothing (no metadata-only mode).
- **Index-time enrichment, runtime-decoupled.** SRG readable names and framework FQNs are resolved
  at build time against the build machine's mappings/cleanroom-api DBs and stored; the runtime
  service opens no sibling DB and renders stored text, degrading gracefully.
- **Golden = real path, no network.** `buildGoldenDb` runs the real select→analyze→srg-link→ingest
  path with a fake `LlmClient` + fixture sibling DBs; the acceptance oracle's `[CORPUS]` rows hold
  on it until a real `examples.db` is built.

## Real corpus build (maintainer step)

`pnpm run index-mod-examples:force` against a configured OpenAI-compatible endpoint, with
`data/mappings.db` + `data/cleanroom-api.db` present for full enrichment, then
`pnpm run manifest -- --db examples --bump minor --release-tag v<next>`. Recorded outcome in
the finalization notes.
