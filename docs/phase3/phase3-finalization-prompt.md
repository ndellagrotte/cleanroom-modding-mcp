# Agent prompt — Phase 3 finalization & validation (Cleanroom API DB)

> Copy everything below this line into a fresh agent session started in the repo root.

---

You are finalizing and validating **Phase 3 (Cleanroom API DB)** of the redesign described in `DESIGN.md` (§5.3, §6.1, §6.3, §8 "Phase 3") for the repo at `/home/nick/IdeaProjects/mcmodding-mcp`, branch `dev`. The implementation was written in a previous session **without any build, lint, test, or runtime validation — deliberately**. Nothing has been executed: not `tsc`, not eslint, not vitest, not the indexer. Assume any of it may be broken. Your job is to make Phase 3 actually work, prove it works, and adversarially review it.

## 1. What Phase 3 added (file inventory)

New files:

- `src/cleanroom-api/schema.ts` — DDL v1 for `cleanroom-api.db` (`types`, `members`, `annotation_usage`, FTS5 external-content tables `types_fts`/`members_fts` with ai/ad/au triggers), `CLEANROOM_API_SCHEMA_VERSION = 1` (must equal `DBS['cleanroom-api'].schemaVersion` in `src/dbs.ts`), `initializeCleanroomApiDb()`, `readDbMetadata()`, re-exported `readDbSchemaVersion`.
- `src/cleanroom-api/model.ts` — pipeline interfaces incl. the structural `TsNode`/`JavaParser` views that keep web-tree-sitter types out of public signatures.
- `src/cleanroom-api/java-parser.ts` — web-tree-sitter bootstrap loading `tree-sitter-java.wasm` out of the `tree-sitter-java` npm tarball (never executes that package's JS; it is in `pnpm.ignoredBuiltDependencies`).
- `src/cleanroom-api/extract.ts` — pass 1: per-file syntactic extraction (types incl. nesting, members, modifiers, annotations, javadoc/`@deprecated`/`@since`, signatures, camel-split `search_text`).
- `src/cleanroom-api/resolve.ts` — pass 2: FQN assignment, Java-precedence name resolution, events catalog (transitive `extends` closure from `net.minecraftforge.fml.common.eventhandler.Event`), inherited `@Cancelable`/`@HasResult` flags, loader attribution, annotation usage counts.
- `src/cleanroom-api/ingest.ts` — single-transaction DB writer + provenance metadata (`cleanroom_version`, `sources_jar_sha256`, `counts`, `parser`).
- `scripts/index-java-api.ts` — CI/maintainer orchestrator: maven-metadata latest-version lookup → sources-jar download from `https://repo.cleanroommc.com/releases/com/cleanroommc/cleanroom/<v>/cleanroom-<v>-sources.jar` → extract/resolve/ingest into `<db>.tmp` → atomic rename (no partial DB). Flags: `--cleanroom-version`, `--sources-jar` (offline), `--db-path`, `--force`. Has an up-to-date skip (metadata `cleanroom_version` + `schema_version` match → exit 0 untouched) that the weekly CI job relies on.
- `src/services/cleanroom-api-service.ts` — readonly service: schema-gated static `isAvailable()`/`isSchemaOutdated()` (mtime-cached), `search()` (FTS prefix-token query with camel splitting, LIKE fallback, kind/package filters, browse mode on empty query, rank = exact simple name → prefix → usage-count → bm25), `getTypeByName()` (FQN → unique simple name → dotted suffix; ambiguity returns candidates), `getClassDetails()` (recursive-CTE ancestor chain with external terminator, members capped, nested types, ≤20 known subclasses), `getStats()`.
- `src/tools/cleanroomApi.ts` — `CLEANROOM_API_TOOLS`: `search_cleanroom_api` and `get_api_class`, with not-installed/outdated-schema guards and Markdown output.
- Tests (written, never run): `src/cleanroom-api/extract.test.ts`, `src/cleanroom-api/resolve.test.ts`, `src/cleanroom-api/symbol-counts.test.ts` (DB-gated regression floors + sentinels), `src/services/cleanroom-api-service.test.ts` (fixture-DB unit layer through the real resolve+ingest pipeline, plus DB-gated integration layer).

Modified files:

- `package.json` — devDeps `web-tree-sitter ^0.26.11` + `tree-sitter-java 0.23.5` (exact pin), scripts `index-cleanroom-api`(`:force`), `pnpm.ignoredBuiltDependencies: ["tree-sitter-java"]`. `pnpm-lock.yaml` was regenerated (`pnpm install` did run — the only executed step).
- `src/index.ts` — imports, `ListTools` gate on `CleanroomApiService.isAvailable()`, two `CallTool` cases.
- `.github/workflows/release.yml` — new "Index and prepare Cleanroom API database" step (fresh index + carried-forward manifest + `--bump patch` + hash check), artifact copies, upload `files:` entries, release-body table row, summary row.
- `.github/workflows/update-docs-weekly.yml` — Cleanroom-maven canary, seed-previous-DB + before/after sha256 gate exporting `CLEANROOM_API_CHANGED`, gated manifest step, gated upload block, summary lines.
- `README.md` — tools-table row.

Registry groundwork that predates Phase 3 and needs **no** changes (do not "fix" these): `src/dbs.ts` (the `cleanroom-api` DbSpec already existed), `db-versioning.ts` `autoUpdateAll`, `manage` CLI, `postinstall.js`, `scripts/generate-manifest.ts`, `list_targets`.

Constraints that are design decisions, not bugs: the gitignored `cleanroom-src/` tree must never become a build/runtime input (DESIGN §6.3 — the indexer consumes the *published* sources jar); vanilla `net.minecraft.*` stays out of this DB (mappings DB owns it); there is no on-device build path for this DB; the runtime server (`dist/index.js` import chain) must never load `web-tree-sitter`.

## 2. Known-risk hotspots (start your skepticism here)

1. **web-tree-sitter ↔ wasm ABI pairing** — `Language.load()` of the 0.23-era wasm under web-tree-sitter 0.26 was never executed. If it fails, pin web-tree-sitter down until it loads and record the working pair.
2. **Grammar node/field names** in `extract.ts` — `superclass` (named-children extraction), `interfaces` field vs `extends_interfaces` child, `type_list`, `constant_declaration` (interface fields), `enum_body_declarations`, `annotation_type_element_declaration` `value` field, `spread_parameter` internals, `modifiers` iterated via `children` (anonymous keyword tokens). Verify against real parses, not the node-types JSON.
3. **Positional SQL parameter ordering** in `cleanroom-api-service.ts` — the rank `CASE` placeholders appear in the SELECT before the MATCH/LIKE placeholders; every `.all(...)` call's argument order must match SQL text order exactly. Off-by-one here fails silently or throws at runtime only.
4. **FTS5 external-content correctness** — triggers, `bm25()` on a joined MATCH, `'delete'` commands; verify `types_fts` count equals `types` count after a real index.
5. **Javadoc attachment** via `previousNamedSibling` — check against real Forge sources (annotated declarations, first member after `{`, enum constants).
6. **`.d.ts` leakage** — after `pnpm run build`, grep `dist/**/*.d.ts` for `web-tree-sitter`; any reference breaks consumers without the devDep.
7. **Weekly workflow env propagation** — `CLEANROOM_API_CHANGED` written via `$GITHUB_ENV` must actually gate the later steps (`if: env...` and the shell test in the upload step, which runs `if: always()`).
8. **`search()` result mixing** — with `kind: 'all'`, type hits can crowd members out of `limit` entirely; judge whether that harms real queries (e.g. `register`).

## 3. Validation gates (all must pass, in order)

Run from the repo root. Fix forward anything that fails, keeping to the house patterns (mirror `src/mappings/*`, `src/services/mappings-service.ts`, `src/tools/mappings.ts`).

1. **Static:** `npx pnpm install --frozen-lockfile` → `npx pnpm run typecheck` → `npx pnpm run lint` → `npx pnpm run build`. Then the `.d.ts` leak check (hotspot 6), and confirm `node -e "import('./dist/index.js')"` does not pull web-tree-sitter (e.g. temporarily `mv node_modules/web-tree-sitter{,.bak}` and start the server; restore after).
2. **Unit tests:** `npx pnpm test -- --run src/cleanroom-api src/services/cleanroom-api-service.test.ts`. The fixture-DB layer and both pure-helper suites must pass with **no** real DB installed. Then run the full suite (`npx pnpm test -- --run`) to prove no regression elsewhere.
3. **Indexer, live:** `npx pnpm run index-cleanroom-api:force`. It must resolve the latest Cleanroom tag from maven-metadata, download the sources jar, and produce `data/cleanroom-api.db` with a sane summary (~850+ types, ~700+ forge namespace, 150+ events). Then re-run **without** `--force` and confirm the up-to-date skip exits 0 without touching the file (compare sha256 before/after). Then test the offline path: `npx pnpm run index-cleanroom-api -- --sources-jar <downloaded jar> --cleanroom-version <v> --db-path /tmp/offline.db`.
4. **Symbol-count regression:** copy `data/cleanroom-api.db` into the platform data dir (`getDefaultDataDir()` — on Linux `~/.local/share/cleanroom-modding-mcp/`), then `npx pnpm test -- --run src/cleanroom-api/symbol-counts.test.ts src/services/cleanroom-api-service.test.ts`. Every floor and sentinel must pass, including the DB-gated integration layer. If a floor fails, determine whether extraction is losing declarations (fix the extractor) or the floor was mis-estimated (justify and adjust — but only with evidence from the actual sources jar).
5. **MCP end-to-end over stdio:** start `node dist/index.js` with the DB installed and drive it as an MCP client (initialize → `tools/list` must include both new tools → `tools/call`). Realistic W1 scenarios to exercise: `search_cleanroom_api {query: "right click block", kind: "event"}` (expect `PlayerInteractEvent.RightClickBlock`, Cancelable badge); `{query: "", kind: "annotation", limit: 30}` (annotations catalog browse — expect `@Mod`, `@SubscribeEvent`, usage counts); `{query: "EnumHackery"}`; `get_api_class {name: "PlayerInteractEvent.RightClickBlock"}` (hierarchy chain ending in an external vanilla parent or Event); `get_api_class {name: "Mod"}` (nested `Mod.EventHandler` etc. or an honest ambiguity list); a nonsense query (helpful empty-result message). Also verify the not-installed path: temporarily move the DB away, call `search_cleanroom_api`, expect the manage-CLI guidance message, restore.
6. **Distribution integration:** with the DB in the data dir, `list_targets` must report the Cleanroom API DB installed; `npx tsx scripts/generate-manifest.ts --db cleanroom-api --release-tag vTEST --db-path data/cleanroom-api.db` must produce a manifest whose hash matches `sha256sum`. Auto-update against a real GitHub release cannot be tested until a release ships the asset — verify the existing `db-versioning` tests still pass and say so honestly rather than claiming it was tested.
7. **CI dry-check:** lint both workflow YAMLs (e.g. `actionlint` if available, else `yq`/`python -c "import yaml,sys; yaml.safe_load(open(...))"`); trace the release job's step order and the weekly job's env-var gating by hand; confirm every filename in the upload lists matches `src/dbs.ts` exactly.

## 4. Adversarial agent review workflow (mandatory)

After the gates pass, run a multi-agent adversarial review using the Workflow tool (or, if unavailable, sequential subagents reproducing the same structure). Do not skip this because the gates are green — the gates prove it runs, the review proves it's right.

**Round structure (loop until dry):**

1. **Finder fan-out** — parallel reviewer agents, one per dimension, each returning structured findings (`file`, `line`, `claim`, `failure_scenario`, `severity`):
   - *Extraction correctness*: pick ≥15 diverse real files from the sources jar (annotation types, nested events, enums with bodies, records, generic classes, interfaces with constants, mixin-related files) and diff `extract.ts` output against the actual Java by hand.
   - *Resolution & catalogs*: verify `resolve.ts` semantics against Java scoping rules; spot-check ≥10 event classes' `is_event`/`is_cancelable`/`has_result` against the real Forge/Cleanroom source annotations (`@Cancelable` walks ancestors — compare with `Event.hasAnnotation` semantics).
   - *Schema & SQL integrity*: every prepared statement's placeholder count/order vs its `.run`/`.all` arguments; FTS trigger correctness; index coverage for the service's query shapes; recursive-CTE termination.
   - *Tool schema & UX consistency*: compare `CLEANROOM_API_TOOLS` against the sibling tools in `src/tools/mappings.ts` (guard messages, clamping, Markdown conventions, description honesty — does the description promise anything the implementation doesn't do?).
   - *CI/YAML*: step ordering, env propagation, failure modes (maven outage, first release with no previous manifest, `if: always()` interactions), filename drift.
   - *DESIGN conformance*: re-read DESIGN.md §5.3/§6.1/§6.3/§8 Phase 3 and Appendix A; flag every divergence (e.g. tool surface, namespace scope, no-cleanroom-src rule, schema-version pairing).
2. **Adversarial verification** — for every finding, spawn 3 independent skeptic agents prompted to **refute** it against the actual code/data ("Default to refuted unless the failure scenario is concretely reproducible"). A finding survives only if ≥2 of 3 fail to refute it. Kill everything else.
3. **Fix & re-verify** — fix each surviving finding (smallest correct change, house style), re-run the affected validation gate(s) from §3, then send the fix back through a skeptic pass confirming the fix and checking for collateral damage.
4. **Dry-loop** — repeat rounds until **two consecutive rounds produce zero surviving findings**. Deduplicate findings across rounds by (file, claim) so judged-and-killed findings do not resurrect.

## 5. Reporting requirements (honesty over polish)

Produce a final report containing: every gate with its actual result (paste failing output verbatim, before and after fixes); every adversarial finding with its verdict (confirmed-and-fixed / refuted / deferred with reason); anything you could NOT validate (e.g. live auto-update against a GitHub release, `manage` interactive download of this DB — no release carries the asset yet) stated explicitly as untested; any symbol-count floor you adjusted, with the measured value and justification; and the exact web-tree-sitter/tree-sitter-java version pair that works. If tests fail and you cannot fix them, report that plainly — do not soften it. Do not commit or push; leave the working tree ready for the maintainer's review and list every file you changed relative to the Phase 3 implementation.
