# Agent prompt — Phase 5 finalization & validation (Examples Rebuild)

> Copy everything below this line into a fresh agent session started in the repo root.

---

You are finalizing and validating **Phase 5 (Examples Rebuild)** of the redesign in
`docs/phase5/DESIGN.md`, whose frozen acceptance oracle is `docs/phase5/BLIND_SPEC.md`, for the
repo at `/home/nick/IdeaProjects/mcmodding-mcp`, branch `dev`. The implementation was written in
a prior session **blind** — no build/lint/test/run during authoring. Your job is to make Phase 5
actually work, prove it against the oracle, and adversarially review it. Adopt the Phase 3
finalization protocol (`docs/phase3/phase3-finalization-prompt.md`) as the standing convention.

## 1. What Phase 5 added (see `docs/phase5/IMPL_DOC.md` for the full inventory)

New: `src/examples/{schema,model,acquire,select,analyze,srg-link,ingest,golden-fixture}.ts`,
`src/examples/prompts/analyze-snippet.v1.md`, `scripts/index-mod-examples.ts`,
`scripts/build-golden-db.ts`, `data/examples-roster.json`, and the test suite.
Modified: `src/dbs.ts` (schemaVersion 2), `src/categories.ts` (`EXAMPLE_CATEGORY_INFO`),
`src/services/mod-examples-service.ts`, `src/services/mappings-service.ts` (`resolveSymbols`),
`src/tools/modExamples.ts`, `src/index.ts` (dispatch fix), `src/tools/listTargets.ts`.

## 2. Known-risk hotspots (start your skepticism here)

1. **Snippet region extraction** (`select.ts`) — brace-depth scanning ignores braces inside
   strings/comments/char-literals; verify against real roster files that regions don't split
   mid-token and that the line cap + whole-file fallback behave.
2. **SRG scanning breadth** (`srg-link.ts`) — the `func_/field_` regex; are param tokens (`p_…`)
   deliberately excluded? Do scanned tokens over-generate api_references rows?
3. **`api_kind` normalization** — only `event/annotation/class/interface/enum` are frozen; confirm
   nothing (e.g. `record`) escapes the set from a real cleanroom-api.db.
4. **`minecraft_version` filter** — the `LIKE '%"1.12.2"%'` match on the JSON array; false
   positives/negatives on multi-version arrays.
5. **Endpoint precedence + required-gate** — flags over env; a no-endpoint run must exit non-zero
   writing nothing, and resolve BEFORE any file I/O.
6. **Atomic ingest** — `runIngest` tmp/-wal/-shm cleanup on throw; Windows rename fallback.
7. **Schema gate caching** — `isAvailable(path)` only caches the default path; non-default paths
   must recompute (tests rely on this).
8. **Golden faithfulness** — the fixture exercises the real pipeline; confirm the `[CORPUS]`
   assertions that hold on `$GOLDEN_DB` will also hold on a real `examples.db`.
9. **npm tarball** — `scripts/index-mod-examples.ts` must not ship; `dist/examples/golden-fixture.js`
   ships (inert) — decide whether to exclude it.

## 3. Validation gates (all must pass, in order)

1. **Static:** `npx pnpm run typecheck` → `npx pnpm run lint` → `npx pnpm run build`. Confirm the
   runtime server import chain (`dist/index.js`) never pulls a pipeline-only module.
2. **Offline goldens:** `pnpm run build:golden-db` then `pnpm test` with the network unplugged
   (`HTTP_PROXY=http://127.0.0.1:1 HTTPS_PROXY=http://127.0.0.1:1`). Run the full suite serially
   (`--no-file-parallelism`) to avoid load-induced timeouts in the spawned-stdio integration tests.
3. **Acceptance oracle:** run `docs/phase5/BLIND_SPEC.md` §§2–12 end to end (source its harness
   header; `$GOLDEN_DB` from `build:golden-db`, `$SCHEMA_DB` from `initializeExamplesDb`). Every
   `[MUST]` must pass; `[CORPUS]` rows may SKIP until a real DB is built but MUST hold on `$GOLDEN_DB`.
4. **Real build + MCP e2e:** with a configured endpoint and `data/mappings.db` + `data/cleanroom-api.db`
   present, `pnpm run index-mod-examples:force`; then drive `node dist/index.js` over stdio:
   `search_mod_examples {query:"block", loader:"forge"}` → `get_mod_example {id}` showing
   `**Source:**` + license + `file_url` + an SRG cross-link. Verify the no-endpoint run exits
   non-zero writing nothing. Generate the manifest (`--db examples --bump minor`).

## 4. Adversarial agent review (mandatory — run as a Workflow)

After the gates pass, run a multi-agent adversarial review looping until dry (two consecutive
zero-finding rounds). Finder fan-out (one per dimension), then ≥3 skeptic verifiers per finding
prompted to REFUTE (survive only if ≥2 fail to refute), then fix + re-verify.

Dimensions: **pipeline correctness** (select/analyze/srg-link/ingest against real roster files);
**schema & SQL integrity** (FTS triggers, index coverage, placeholder order, atomic ingest);
**service/tool UX** (guard messages, filters, attribution, degrade paths vs the sibling tools);
**determinism** (analysis_version, up-to-date skip, temperature 0, no silent caps);
**licensing/attribution** (every snippet's license recorded + rendered; GPL-3.0 Fugue attribution);
**DESIGN/BLIND_SPEC conformance** (re-read both; flag every divergence).

## 5. Reporting (honesty over polish)

Report each gate with its actual result; every adversarial finding with verdict
(confirmed-and-fixed / refuted / deferred-with-reason); anything unvalidated stated explicitly
(e.g. live auto-update against a GitHub release; `manage` install of this DB — no release carries
the asset yet); and the exact endpoint/model pinned for any real build. Do not commit or push;
leave the tree ready for maintainer review and list every changed file.
