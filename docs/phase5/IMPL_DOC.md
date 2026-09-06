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
| `src/examples/analyze.ts` | `resolveEndpointConfig()` (env + flags, **required**), `createOpenAiClient()` (temperature 0), `parseAnalysis()`, `analyzeSnippet()`, `computeAnalysisVersion()`, `PIPELINE_REV`, `normalizeCategory()` / `normalizeTagSlug()`, `renderPromptTemplate()`. |
| `src/examples/srg-link.ts` | Index-time SRG resolution (`MappingsService.resolveSymbols`) + framework resolution (`CleanroomApiService.getTypeByName`) → `api_references` enrichment; degrades to NULL. `toExampleRecord()`. |
| `src/examples/ingest.ts` | `ingest()` (single transaction), `runIngest()` (tmp + atomic rename + cleanup), `isUpToDate()` (roster_pins ∧ analysis_version ∧ schema_version). `example_relations` empty (v1). |
| `src/examples/prompts/analyze-snippet.v2.md` | Committed, versioned analysis prompt with the strict-JSON contract + `quality_score` rubric. The allowed-category block is a `{{CATEGORY_LIST}}` placeholder rendered from `EXAMPLE_CATEGORIES` at build time, not a hand-copied list. |
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

## Revision 1 — maintainer-paid endpoint (see [PHASE_5_REVISION.md](PHASE_5_REVISION.md))

Implemented per the revision's §5 module table; the frozen Phase 5 shape above stands except
as listed there.

- **New files:** `src/examples/cache.ts` (content-addressed analysis cache: `hashSnippet` over
  the prompt-visible payload, `analysis_version`-gated reads, write-through), and the committed,
  non-secret `data/examples-llm.json` (endpoint + declared list prices; the API key is never in
  it). `data/examples-roster.json` is now committed too (`.gitignore` negations added; cache DB
  and built DBs stay ignored).
- **`model.ts`:** `LlmClient.complete` widened to `Promise<Completion>` (text + nullable usage);
  `AnalyzeOutcome`, `LlmPricing`; `IngestMeta` gains optional `llmBaseHost`/`llmCost` (additive
  metadata keys; absent in golden).
- **`analyze.ts`:** `resolveEndpointConfig` accepts the config-file layer (flags → env → file,
  gate text unchanged) — including an optional `temperature` (default 0; some endpoints reject
  0 with HTTP 400); `createOpenAiClient` parses `usage` and takes `--llm-max-retries`;
  `LlmHttpError` + `isTransientLlmError` (transient = network/429/5xx; permanent = other 4xx and
  JSON-extraction failures — no double-pay); `analyzeSnippet` returns `AnalyzeOutcome`; exported
  `buildPrompt` + `estimateTokens` (chars/4) for the estimate projection.
- **`ingest.ts`:** two additive `insertMetadata.run` lines (`llm_base_host`, `llm_cost`) — no
  DDL, no schema bump.
- **`golden-fixture.ts`:** fake client returns fixed usage; the golden path stays cache-free.
- **`index-mod-examples.ts`:** loads `data/examples-llm.json`; new flags `--estimate`,
  `--llm-max-cost-usd`, `--llm-max-retries`, `--llm-concurrency`, `--llm-est-output-tokens`,
  `--analysis-cache`, `--no-cache`; run ledger (tokens/calls/cache/tokens-saved); estimate mode
  (real prompt bodies, zero calls/writes); budget cap (actual-usage gate, exit 2 before
  publication); ordered-slot worker pool (order-deterministic at any concurrency); cost-ledger summary.
- **Tests:** `analyze.test.ts` (outcome shape, config precedence, retry classification, usage
  parsing/backoff), new `cache.test.ts` (hit/miss, version invalidation, readonly mode), new
  `indexer.orchestrator.test.ts` (spawned end-to-end against a fake endpoint: startup gates,
  estimate purity, cache re-run/version-invalidation/`--no-cache`, rejected builds preserving
  installed artifacts and resuming cached work, no-double-pay 400/429/unparsable, concurrency determinism); `golden.test.ts` locks the
  Revision 1 keys absent in golden.
- Explicitly untouched, as specified: `schema.ts`, `srg-link.ts`, `select.ts`, `acquire.ts`, all
  runtime services/tools, all workflows (CI stays LLM-free; `release.yml` carry-forward only).

### Revision 1 addendum — Moonshot endpoint (kimi-k2.6, non-thinking)

The first maintainer-paid endpoint is Moonshot (`data/examples-llm.json`: `kimi-k2.6` with
thinking disabled). Two config-file keys landed with it (PHASE_5_REVISION §4.1), both
provider-agnostic in code (D1 — the quirk lives in the committed file):

- `"temperature": null` omits the field from the request entirely (Moonshot rejects/ignores an
  explicit temperature for kimi-k2.6); a number sends it; absent keeps the frozen default 0.
  `EndpointConfig.temperature: number | null` — null = omit.
- `"extraBody"` merges verbatim into every request body (Moonshot:
  `"thinking": {"type": "disabled"}`); code-controlled keys win on conflict.
- `computeAnalysisVersion` now also hashes the canonicalized effective request knobs
  `{ temperature, extraBody }` — a thinking/temperature toggle re-bills the full corpus like a
  model change and auto-invalidates the analysis cache.
- `createOpenAiClient` warns once (injectable `onModelMismatch`, wired to the orchestrator's
  logger) when the server echoes a different model id than the pinned one — surfaces silent
  provider-side model aliasing. Provenance still records the *requested* id.
- OQ2 resolved with the first successful paid build: `--llm-concurrency` default flipped from
  1 (serial) to 4. Order-determinism is unchanged (index-addressed slots); the orchestrator
  test's serial leg now pins `--llm-concurrency 1` explicitly.

### Revision 1 addendum 2 — endpoint switch: OpenAI `gpt-5.4-nano`

Moonshot was abandoned (billing opacity). `data/examples-llm.json` now points at OpenAI
Chat Completions (`https://api.openai.com/v1`, `gpt-5.4-nano`) — no code change, D1 holds:
the model page confirms Chat Completions + structured outputs support and reasoning effort
defaulting to `none`, so no `extraBody` is needed; `"temperature": null` is kept (gpt-5.x
rejects non-default temperature). Pricing 0.20/1.25 USD per 1M in/out per the OpenAI pricing
page (2026-07-25); the ledger conservatively ignores the cheaper cached-input rate. New
`analysis_version` — Moonshot-era cache rows are dead weight under their old version keys.

### Publication safety and deterministic example regressions

Empty, budget-truncated, and coverage-rejected builds leave the installed database and
manifest untouched. Matching provenance is insufficient for the up-to-date skip: actual
rows and requested category coverage are checked. Successful analyses remain cached for
resumption, and `--allow-empty-categories` never permits an empty corpus.

`get_mod_patterns` normalizes empty SQL aggregates to zero, including when examples exist
but none has a pattern label. Service and handler regressions use controlled temporary
SQLite fixtures rather than generated example IDs, LLM titles, or release-corpus ordering.
