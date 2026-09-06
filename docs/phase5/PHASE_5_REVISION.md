# PHASE_5_REVISION — Maintainer-paid endpoint for corpus builds

**What this is.** The design delta that moves examples-corpus generation off GitHub Models
(free tier, tight rate limits — the reason only a 2-repo pilot `examples.db` exists) onto the
maintainer's own paid OpenAI-compatible API. It revises [`DESIGN.md`](DESIGN.md) §6.3/§6.4 in
exactly one respect — *who pays for and paces the endpoint* — and adds the cost machinery that
a metered endpoint makes necessary. Everything not listed in §5 keeps its frozen Phase 5 shape;
per the oracle-freeze rule ([`BLIND_SPEC.md`](BLIND_SPEC.md) §0), this document is the recorded
design-change event for the assertions listed in §8.

Written against the implementation at `67cf083` (the phase-5 commit; no examples code has
changed since). Verified anchors are cited as `file:line`.

## 1. Context and motivation

- The endpoint was designed pluggable from day one (`resolveEndpointConfig`,
  `src/examples/analyze.ts:75`): any OpenAI-compatible base URL + model + optional key works.
  The pilot proved it — GitHub Models dropped in with **zero pipeline code changes**, only
  rate-limit backoff (finalization notes). Switching providers is therefore **configuration,
  not code**.
- What GitHub Models could not provide is *throughput*: the pilot stalled at 2 of 8 roster
  repos (80 examples, `data/examples-roster.pilot.json`) against daily-window limits, and the
  full 8-repo build (~740–850 snippets) never ran.
- The maintainer elects to pay per token at release time. Payment changes the engineering
  requirements, not the pipeline contract:
  1. **Spend must be visible before it happens** (estimate) and **bounded during it** (budget cap).
  2. **Spend must not repeat** across runs — re-running the indexer after a roster bump or an
     aborted run must only bill for snippets that were never analyzed (cache).
  3. **Spend must be recorded** in the shipped DB's provenance metadata.

## 2. Locked decisions

| # | Decision |
|---|---|
| D1 | **Provider switch is configuration.** The `CLEANROOM_MCP_LLM_*` env vars and `--llm-*` flags remain the single mechanism. No provider-specific branches (`if openai … if github …`) are added anywhere. |
| D2 | **Cost guardrails are mandatory for real builds.** `--estimate` (dry-run, zero calls, zero writes) and `--llm-max-cost-usd` (hard cap) ship with this revision. A real run with a cap set but no pricing configured fails at startup, before any call. |
| D3 | **Analyses are cached content-addressably.** A maintainer-local, gitignored `data/examples-analysis-cache.db` keys each analysis by a hash of the prompt-visible snippet payload, gated on `analysis_version`. Cache hits cost nothing. This preserves DESIGN §6.4 invalidation semantics exactly: prompt/model/`PIPELINE_REV` changes still invalidate everything, because the cached row's `analysis_version` no longer matches. |
| D4 | **Model stays pinned and recorded.** `llm_model` metadata and `analysis_version` derivation (`src/examples/analyze.ts:35`) are untouched. Choosing the model is a maintainer act documented in the runbook; changing it knowingly re-bills the full corpus. |
| D5 | **CI stays LLM-free.** No workflow gains `CLEANROOM_MCP_LLM_*` or the new cost variables; `release.yml` remains carry-forward-only. Spend happens exclusively on the maintainer machine, at release time. The BLIND_SPEC §11 grep invariant continues to hold. |

## 3. What does not change

- Endpoint-required gate: no base URL + model → exit non-zero, **before any file I/O**, nothing
  written (`scripts/index-mod-examples.ts:162-164`). `--estimate` passes through the same gate —
  it needs the model id for pricing and the `analysis_version` preview — it merely performs no
  calls and writes no DB. BLIND_SPEC §6 assertions are unaffected.
- Determinism: committed versioned prompt, temperature 0 by default (`analyze.ts:279`),
  `analysis_version` over (prompt_version + model + pipeline rev + effective request knobs —
  see §4.1; the knob component was added with the Moonshot adoption so thinking-mode/temperature
  changes invalidate like a model change).
- Schema v2 stays frozen. New provenance (§4.7) is additive `metadata` key/value rows
  (`INSERT OR REPLACE`, `src/examples/ingest.ts:215-221`) — no DDL, no `schema_version` bump,
  no manifest-version implication.
- Up-to-date skip stays conjunctive over roster_pins ∧ analysis_version ∧ schema_version,
  and the stored corpus must be nonempty and satisfy the requested coverage policy.
  The cache sits *under* this: an accepted up-to-date DB no-ops; a rejected or out-of-date
  DB rebuilds but only pays for cache misses.
- Atomic ingest (tmp + rename + cleanup), per-repo and per-snippet error isolation, and
  the golden path (`build:golden-db` runs with the cache disabled and a fake client).
- Runtime: no LLM, no network, no sibling-DB opens, no `ATTACH`. None of this revision is
  reachable from shipped code.

## 4. Design

### 4.1 Endpoint and pricing configuration

Precedence (highest first): **CLI flag → env var → committed config file**. The config file is
a new, *non-secret* layer below today's two; when absent, behavior is byte-identical to today.

New committed file `data/examples-llm.json`:

```json
{
  "schema": 1,
  "baseUrl": "https://api.openai.com/v1",
  "model": "gpt-4o-mini",
  "pricing": { "inputPer1M": 0.15, "outputPer1M": 0.60, "currency": "USD" }
}
```

- `baseUrl`/`model` fill the same fields as `CLEANROOM_MCP_LLM_BASE_URL` / `--llm-base-url` etc.
  `resolveEndpointConfig` (`analyze.ts:75`) gains an optional third parameter carrying the
  file's values; the required-gate error text is unchanged.
- `pricing` is used **only** for estimation, budget enforcement, and provenance. It is the
  maintainer's declared list price — the pipeline never fetches prices.
- `temperature` (added with the Moonshot adoption): a number sends that value (some endpoints
  reject 0 with HTTP 400); an explicit `null` **omits the field entirely** (some endpoints,
  e.g. Moonshot's kimi-k2.6, reject or ignore any explicit temperature); absent keeps the
  frozen determinism default 0. Env/flag carriers exist for numbers only — the omit case is
  file-only.
- `extraBody` (added with the Moonshot adoption): an object merged verbatim into every
  chat-completions request body — the file-only carrier of provider-specific extensions such as
  Moonshot's `"thinking": {"type": "disabled"}`. Code-controlled keys (`model`, `messages`,
  `temperature`-when-set) always win on conflict, and the pipeline code stays provider-agnostic
  (D1): the quirk lives in the committed, PR-reviewed declaration, not in an `if moonshot …`
  branch.
- **Request knobs join `analysis_version`.** The effective `{ temperature, extraBody }` pair is
  canonicalized (stable key order) and hashed into `analysis_version` alongside
  prompt/model/pipeline-rev, so toggling a provider's thinking mode or changing temperature
  invalidates prior analyses and cache rows exactly like a model change — closing the gap where
  a temperature change silently reused the cache.
- **Secrets:** the API key is *never* in this file. It comes from
  `CLEANROOM_MCP_LLM_API_KEY` / `--llm-api-key` only; a gitignored `.env` (already covered by
  `.gitignore` `.env*`) is the recommended carrier. The key is never logged (today's client
  logs nothing; keep it that way).
- **`.gitignore` repair (carried-forward drift).** `data/*` currently swallows
  `data/examples-roster.json` — the roster is a *curated input* (license review!), not a
  generated artifact, and a fresh clone cannot run the indexer. Add negations:
  `!data/examples-roster.json`, `!data/examples-llm.json`, and commit both. The cache DB and
  built DBs stay ignored.

### 4.2 Usage capture

`LlmClient.complete` (`src/examples/model.ts:179`) currently returns `string`, discarding the
`usage` block every OpenAI-compatible response already sends. Widen it:

```ts
export interface Completion {
  text: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}
complete(prompt: string, opts?: { temperature?: number }): Promise<Completion>;
```

- `createOpenAiClient` (`analyze.ts:104`) parses `usage` (null-tolerant: local endpoints may
  omit it). `analyzeSnippet` returns `{ analysis, usage }`.
- Rationale for an interface change over a side-channel: the interface has exactly two
  implementations (real client + golden fake) and one call path (`analyzeSnippet` →
  orchestrator). The golden fake returns a fixed usage so golden accounting is deterministic.
- The orchestrator accumulates a run ledger: `promptTokens`, `completionTokens`, calls made,
  cache hits/writes, tokens saved by cache (sum of stored usage on hits), estimated cost.

### 4.3 Estimate mode

`--estimate`: runs acquire + select for all roster repos (network to GitHub permitted, or
`--repo-zip` offline), consults the cache for hit/miss projection, and prints a per-repo and
total table: snippets, cache hits, cache misses, projected input/output tokens (measured
heuristic below), projected cost, and the target `analysis_version`. Then exits 0. **Zero LLM
calls, zero writes** — no DB, no manifest, no cache mutation.

Token heuristic: `chars/4`, computed over the *actual* prompt bodies `buildPrompt`
(`analyze.ts:170`) would emit (template + snippet wrapper + code), plus a fixed output
allowance per snippet (default 350 tokens, overridable `--llm-est-output-tokens`). The
heuristic's inputs are exact on the input side; the output side is the only soft term and is
flagged as such in the table.

### 4.4 Budget cap

`--llm-max-cost-usd <n>` / `CLEANROOM_MCP_LLM_MAX_COST_USD`.

- Priced ledger: before each LLM call, if `ledger.estimatedCost ≥ cap`, analysis stops for all
  remaining snippets across all repos. Under `--llm-concurrency > 1` the gate stops *new
  starts*, not in-flight calls: lanes may legally start while sibling calls are in flight
  (their usage hasn't landed in the ledger yet), so spend may overshoot the cap by at most
  n−1 per-snippet costs — cents at corpus scale; pin `--llm-concurrency 1` if an exact ceiling
  ever matters.
- Completed analyses remain in the enabled analysis cache, but a budget-truncated run
  **publishes no database or manifest**. It prints the cost-ledger summary and exits **2**,
  leaving any installed corpus and manifest untouched. Resuming reuses cached analyses
  without paying again; `--no-cache` deliberately gives up that recovery.
- A cap without resolvable pricing (neither flags nor config file) → startup error before any
  call. Estimated tokens are never used for enforcement once real usage exists; enforcement
  uses actual usage only.
- Publication also rejects zero examples or missing required implementation-category
  coverage with **exit 3**, before ingestion and manifest writing. `--allow-empty-categories`
  permits a nonempty corpus with coverage gaps; it never permits an empty corpus.

### 4.5 Analysis cache

New maintainer-local store `data/examples-analysis-cache.db` (gitignored via existing `data/*`):

```sql
CREATE TABLE IF NOT EXISTS analysis_cache (
  snippet_hash      TEXT PRIMARY KEY,   -- sha256 over the canonical payload below
  analysis_version  TEXT NOT NULL,      -- read gate; mismatch = miss
  analysis_json     TEXT NOT NULL,      -- normalized Analysis (model.ts:111)
  usage_json        TEXT,               -- nullable Completion.usage
  created_at        TEXT NOT NULL
);
```

- Key: sha256 over the JSON of `{ repo, modName, filePath, startLine, endLine, code }` — the
  prompt-visible payload (`buildPrompt`, `analyze.ts:170-181`). *Not* the roster SHA: a pin
  bump whose files didn't change still hits. *Not* `analysis_version`: stored as a column and
  required to match on read, which reproduces DESIGN §6.4 invalidation with zero extra logic.
- Flow: select → hash → hit (matching `analysis_version`) ? reuse analysis, ledger +=
  tokens-saved : call → parse → write-through → ledger += actual usage.
- Knobs: `--analysis-cache <path>` (default `data/examples-analysis-cache.db`), `--no-cache`
  (bypasses reads *and* writes — a deliberate full re-spend, e.g. to purge suspect quality).
- Golden path (`scripts/build-golden-db.ts`) runs cache-disabled. Nothing in the cache is
  shipped: not in the npm tarball, not in `examples.db`, not uploaded by CI.
- Consequence worth stating: the *first* paid run is a full-price run (the pilot's 80 analyses
  predate the cache; see §10, OQ3, for an optional backfill). Every subsequent release pays
  only the delta.

### 4.6 Retry and concurrency policy

- **No double-pay on permanent failures.** The orchestrator's blanket
  catch-and-immediately-retry (`scripts/index-mod-examples.ts:261-265`) re-bills permanent
  errors (400/401/404, unparsable completions). Reclassify: transient (network error, 429,
  5xx) → existing backoff retry inside the client, then the orchestrator's single second
  attempt; permanent (other 4xx, JSON extraction failure) → skip immediately. Retries inside
  `createOpenAiClient` stay 429/503-only with the `Retry-After` cap (`analyze.ts:143-159`);
  `MAX_RETRIES` becomes `--llm-max-retries` (default 5).
- **Optional concurrency.** `--llm-concurrency <n>` (default **4** since OQ2 was resolved —
  originally 1, serial, for the first paid run). When >1, a small worker pool analyzes within
  a repo, but results are written into index-addressed slots and appended to `records` strictly
  in selection order, so example ids and the resulting DB remain order-deterministic regardless
  of completion order. Per-snippet isolation and the budget cap check are preserved inside the
  pool.

### 4.7 Provenance metadata additions

Additive `metadata` rows written at ingest (alongside the frozen eight):

| Key | Value |
|---|---|
| `llm_base_host` | Host of the endpoint (`new URL(baseUrl).host`; `''` on parse failure) — provenance without leaking internal network topology. |
| `llm_cost` | JSON run ledger: `{ prompt_tokens, completion_tokens, calls, cache_hits, cache_writes, tokens_saved, estimated_usd, pricing }`. |

## 5. Module-by-module changes

| File | Change |
|---|---|
| `src/examples/model.ts` | `Completion` interface; `LlmClient.complete` return widened; `AnalyzeOutcome { analysis, usage }`. |
| `src/examples/analyze.ts` | `resolveEndpointConfig` accepts config-file layer; `createOpenAiClient` parses `usage`, `--llm-max-retries`-driven retry count; `analyzeSnippet` returns `AnalyzeOutcome`; exported `estimateTokens(promptText)` helper (chars/4). |
| `src/examples/cache.ts` *(new)* | `openAnalysisCache(path)`, `hashSnippet(snippet)`, `getCached(hash, analysisVersion)`, `putCached(...)`. Pure, injectable, offline. |
| `scripts/index-mod-examples.ts` | Load `data/examples-llm.json`; new flags (`--estimate`, `--llm-max-cost-usd`, `--llm-max-retries`, `--llm-concurrency`, `--llm-est-output-tokens`, `--analysis-cache`, `--no-cache`); run ledger; cache wiring; error reclassification (§4.6); ordered-slot concurrency; cost summary block; exit code 2 on budget truncation. |
| `data/examples-llm.json` *(new, committed)* | Non-secret endpoint + pricing declaration (§4.1). |
| `data/examples-roster.json` | Now committed (`.gitignore` negation). Content unchanged. |
| `.gitignore` | Negations for the two curated JSON files. |
| `src/examples/golden-fixture.ts` | Fake client returns fixed `usage`; cache disabled explicitly. |
| Tests | Update `analyze.test.ts` (return shape, config precedence, retry classification), `golden.test.ts`; new `cache.test.ts` (hit/miss, `analysis_version` invalidation, `--no-cache`), plus orchestrator-level tests: estimate mode performs zero calls/writes; rejected budget/coverage/empty builds preserve the installed DB and manifest; resumption reuses cached analyses; concurrency preserves record order. |
| `docs/phase5/IMPL_DOC.md` | Append a "Revision 1" note linking here once implemented. |

Explicitly **not** touched: `schema.ts` (DDL frozen), `ingest.ts` except two additive
`insertMetadata.run` lines, `srg-link.ts`, `select.ts`, `acquire.ts`, all runtime services and
tools, all workflows.

## 6. Cost model (full 8-repo build)

Assumptions (measured, not guessed): prompt template 3,254 chars (`analyze-snippet.v1.md`);
snippet wrapper ~470 chars; pilot average snippet 416 chars code (cap 60 lines,
`maxFileBytes` 120–200k); roster caps sum 740 plus unbounded MBE — planning range
**700–850 snippets**; heuristic 4 chars/token.

| Term | Per snippet | Full build (~800) |
|---|---|---|
| Input | ~1,000 tok (template-dominated) | ~0.8M tok |
| Output (allowance) | ~350 tok | ~0.28M tok |

Illustrative totals at common list prices (**verify current prices and set them in
`data/examples-llm.json` — the config exists precisely so these numbers stay honest**):

| Model tier | $/1M in | $/1M out | Full build | Release delta (cache, ~5% churn) |
|---|---|---|---|---|
| mini-class (e.g. gpt-4o-mini) | 0.15 | 0.60 | **≈ $0.29** | ≈ $0.02 |
| mid-class (e.g. gpt-4.1-mini) | 0.40 | 1.60 | ≈ $0.77 | ≈ $0.04 |
| frontier-class (e.g. gpt-4o) | 2.50 | 10.00 | ≈ $4.80 | ≈ $0.24 |

Conclusion the design banks on: even a frontier model is single-digit dollars per *full*
corpus, and cents per release update — the maintainer's "few pennies" holds with margin, and
the cap exists for the day an estimate is wrong.

## 7. Maintainer runbook

**One-time setup**
1. `data/examples-llm.json`: set `baseUrl`, `model`, current list prices. Commit it (with the
   roster) after the `.gitignore` repair.
2. Key in environment: `export CLEANROOM_MCP_LLM_API_KEY=…` (or a gitignored `.env`).

**First full build (cache cold — full price)**
3. `pnpm index-mod-examples -- --estimate` → review the per-repo cost table.
4. `pnpm index-mod-examples:force -- --llm-max-cost-usd 5` (with `data/mappings.db` +
   `data/cleanroom-api.db` present for full SRG/framework enrichment).
5. Run the BLIND_SPEC §§2–12 oracle against the result; `[CORPUS]` rows now execute instead
   of SKIP — including the SRG assertion the pilot legitimately couldn't satisfy
   (`srgResolved: 0` was correct for MBE/ModularUI; TiCon/AE2/GregTech use raw `func_*` tokens).
6. `pnpm run manifest -- --db examples --bump minor --release-tag v<next>` — replaces the
   pilot's placeholder `vTEST` manifest. Publish; CI carries the asset forward from then on.

**Per-release update**
7. Bump roster SHAs as desired, re-run steps 3–6. Only changed snippets are billed (cache).
   A prompt/model change deliberately re-bills the full corpus — treat it as a corpus
   regeneration decision, not a drive-by.

## 8. Acceptance criteria (BLIND_SPEC delta)

This revision is the recorded design-change event for the following; all other frozen
assertions stand unchanged.

- **[MUST]** Existing oracle stays green: BLIND_SPEC §§2–12 pass with no edits other than the
  addenda below; full suite passes offline; `build:golden-db` unchanged in behavior.
- **[MUST]** §3 metadata: the frozen eight keys remain present (golden test's presence checks
  are unaffected by additive keys); `llm_base_host` + `llm_cost` present in real builds,
  absent-or-empty tolerated in golden.
- **[MUST]** §6 endpoint gate: no-endpoint run still exits non-zero writing nothing —
  including with `--estimate` and with `--llm-max-cost-usd` set but pricing unresolvable.
- **[MUST]** §11 CI: grep over `.github/workflows/` for `index-mod-examples|CLEANROOM_MCP_LLM_`
  still finds nothing.
- **[MUST]** Estimate mode: performs zero LLM calls and writes nothing (no DB, no manifest, no
  cache mutation); its input-token projection uses the real prompt bodies.
- **[MUST]** Budget cap: analysis stops at the actual-usage gate (§4.4), exits 2, and
  neither creates nor replaces the database or manifest; an uncapped run never exits 2.
- **[MUST]** Publication: zero examples or rejected category coverage exits 3 without
  changing installed artifacts. The explicit category override cannot publish zero examples.
- **[MUST]** Cache: identical re-run of a populated cache performs zero LLM calls; a
  prompt/model change (bumped `analysis_version`) misses every entry; `--no-cache` neither
  reads nor writes; golden builds never touch the cache.
- **[MUST]** No double-pay: a 400-response snippet incurs exactly one billable call; a 429
  honors the existing backoff/`Retry-After` semantics.
- **[MUST]** Determinism: with `--llm-concurrency 8`, example ids and content equal the serial
  run (modulo `indexed_at`/ledger metadata).
- **[SHOULD]** `.gitignore` negations committed; fresh clone can run the indexer and §5 roster
  assertions without local file recovery.

## 9. Non-goals

- No provider SDKs, no provider-specific features (structured outputs, batch API, prompt
  caching) — the OpenAI-compatible lowest common denominator is the contract (D1). If a
  provider's prompt-caching discount applies server-side to the repeated template prefix,
  that's free money requiring zero code.
- No embeddings/semantic search, no `example_relations` population, no roster changes.
- No runtime, tool, or `manage`-flow changes; no on-device builds (DESIGN §2 stands).
- No CI spend path, ever (D5).
- No schema v3.

## 10. Open questions

- **OQ1 — Model choice.** The config defaults to the pilot's `gpt-4o-mini` class; whether a
  mid-tier model's `quality_score` distribution justifies ~2.5× cost is a maintainer judgment
  call. Recommend: build once at mini, `--estimate` the mid tier, eyeball 20 samples, decide.
- **OQ2 — Concurrency default.** **Resolved:** default flipped to 4 after the first successful
  paid build (Moonshot kimi-k2.6, non-thinking). It stayed 1 (serial, maximally boring) for that
  first run; paid endpoints tolerate 4–8 easily, and determinism is protected either way (§4.6).
- **OQ3 — Pilot backfill.** The pilot's 80 analyses could be reconstructed into the cache from
  the existing `examples.db` (code ↔ analysis columns) *iff* the maintainer keeps the same
  model + prompt (same `analysis_version`). Optional `--backfill-cache <db>` utility; saves
  ~$0.03. Implement only if the model is *not* changing.
- **OQ4 — Ledger retention.** The `llm_cost` row is per-build, overwritten each ingest. If
  spend history is wanted, keep a gitignored `data/examples-cost-log.jsonl` append-only log.
  Deferred until someone asks.
