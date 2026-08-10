# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP (Model Context Protocol) stdio server that makes an AI agent effective at building
**Cleanroom** mods (Minecraft 1.12.2). It ships TypeScript code plus prebuilt SQLite databases
(docs, mappings, mod examples, Cleanroom API) that are downloaded from GitHub Releases, not
committed. `docs/PROJECT_DESIGN.md` is the authoritative design; `docs/phase*/` records each
implementation phase (Phases 0–5 landed).

## Commands

Package manager is **pnpm** (`pnpm@11.17.0`); Node ≥24.18 (`.nvmrc` = 24, `engines.node` in
`package.json`, and every CI runner). pnpm 11 itself needs Node ≥22.13 and loads `node:sqlite`,
so a runner on Node 20 dies in `actions/setup-node`'s pnpm cache step. `CONTRIBUTING.md`'s
command list is stale — it predates the fork and uses npm; prefer the scripts below.

```bash
pnpm run build        # tsc → dist/  (prebuild wipes dist/ first)
pnpm run dev          # tsx watch src/index.ts
pnpm run validate     # typecheck + lint + test — run this before committing
pnpm run typecheck    # TWO passes: tsconfig.json (src) + tsconfig.scripts.json (scripts)
pnpm run lint         # eslint src scripts (type-aware, via tsconfig.eslint.json)
pnpm run format       # prettier over src/**/*.ts
```

Tests (vitest, `src/**/*.{test,spec}.ts`, 60s timeout):

```bash
pnpm test                                       # watch mode in a TTY
pnpm exec vitest run                            # one-shot (what CI does)
pnpm exec vitest run src/examples/select.test.ts              # single file
pnpm exec vitest run src/examples/select.test.ts -t "drops"   # single test by name
pnpm run test:coverage
```

If `pnpm` isn't on PATH, the same binaries work directly: `node_modules/.bin/vitest run …`,
`node_modules/.bin/eslint src scripts`, `npx tsx scripts/….ts`.

Database pipelines (maintainer/CI only — these scripts are **not** in the npm tarball):

```bash
pnpm run index-docs              # crawl+chunk+embed → data/docs.db
pnpm run index-mappings          # MCP/SRG 1.12.2 + Parchment/Mojang → data/mappings.db
pnpm run index-cleanroom-api     # tree-sitter over the published sources jar → data/cleanroom-api.db
pnpm run index-mod-examples      # LLM-analyzed roster snippets → data/examples.db (needs an endpoint)
pnpm run build:golden-db         # offline golden examples DB (fake LLM + fixture DBs)
pnpm run validate:equivalence    # CI gate over data/equivalence/*.yaml, no DB needed
pnpm run manifest -- --db docs --release-tag v0.5.0
pnpm run manage                  # interactive DB installer/refresher (also the shipped CLI)
```

`verify/` is a bash acceptance oracle (`REPO=$PWD DOCS_DB=data/docs.db bash verify/run-all.sh`);
`verify/env.sh` holds the frozen vocabularies the implementation must match — treat those as
spec, not as something to edit to match the code. Those frozen sets are the **equivalence**
vocabularies only (`TOPICS`, `KINDS`, `ERAS`, `FROM_VOCABS`, `TO_LOADERS`, plus template/guide/
prompt names). The doc and example **category** taxonomies are not frozen there and no verify
script asserts on them — they are guarded by `src/categories.test.ts` and the corpus lint.

`pnpm run lint:corpus [path]` is the pre-publish gate over a built `docs.db` (zero-width
characters, body-less sections, non-Minecraft version values, off-taxonomy categories, the
`general` share, orphaned rows, schema stamp). It runs from three places — `index-docs` after a
build (exit 5), `release.ts` before any manifest is written, and the weekly rebuild workflow —
because the failure it exists to stop is a *carried-forward* database that no run rebuilt.

⚠️ `pnpm run clean:all` deletes all of `data/`, including the git-tracked curated inputs.

## Architecture

### Request path

`src/index.ts` is the whole MCP surface: one `Server` over `StdioServerTransport`, handlers for
tools/resources/prompts, and a `manage` CLI branch before the server starts. It has four layers
beneath it:

- **`src/tools/*.ts`** — MCP tool schemas (`*_TOOLS` arrays) + `handle*` functions. Tools own
  input validation, argument marshalling, and AI-facing text formatting. `src/index.ts`'s
  `CallToolRequestSchema` switch does nothing but cast `args` and delegate.
- **`src/services/*.ts`** — business logic and all SQL. Each DB-backed service owns its
  `better-sqlite3` handle and exposes static `isAvailable()` / `isSchemaOutdated()`.
- **`src/<domain>/schema.ts`** — frozen DDL + a `*_SCHEMA_VERSION` constant per database
  (`indexer/store.ts`, `mappings/schema.ts`, `examples/schema.ts`, `cleanroom-api/schema.ts`).
- **`scripts/index-*.ts`** — the build pipelines that produce the databases. They import from
  `src/` (schema, services, registries) but nothing in `src/` imports them.

### Conditional tool registration

`ListTools` returns the 4 base tools + the porting tools always, then appends the mappings,
mod-examples, and Cleanroom-API tool groups only when `<Service>.isAvailable()` is true.
`isAvailable()` is a **schema gate, not a file-exists check**: it compares the DB's stored
`schema_version` against `DBS[id].schemaVersion` in `src/dbs.ts`. A version mismatch makes the
DB read as "not installed" and its tools silently disappear from the listing.

**Therefore: when you change a DB's DDL, bump both the `*_SCHEMA_VERSION` in that domain's
schema module and `DBS[id].schemaVersion` in `src/dbs.ts`.** The pairing is noted in comments
in `src/dbs.ts`; nothing enforces it mechanically.

### `CORPUS_REVISION` — the other counter on docs.db

`schema_version` answers "can this build read the file at all", and a mismatch forces a full
re-download. `CORPUS_REVISION` (`src/indexer/store.ts`) answers "were the stored *values*
produced by the current logic", and a mismatch runs `src/indexer/migrate.ts` in place instead.

That distinction matters because `docs.db` is ~818 MiB and whole-file replacement is the only
delivery mechanism. `documents.category`, `minecraft_version` and `loader_version` are pure
functions of `documents.url`, which the DB already stores, so replaying them locally takes a
few seconds and touches none of the ~249k embeddings. **Bump `CORPUS_REVISION` whenever you
change `extractCategoryFromUrl`, `PATH_SEGMENT_CATEGORIES`, or `detectVersions`** — otherwise
installed corpora keep values the current code would not produce.

The migration runs from `main()` in `src/index.ts` **before** `autoUpdateAll()`, and re-stamps
`schema_version` after its `ALTER TABLE`, so a migrated DB satisfies the download gate. It is
deliberately fail-safe: any error is logged and swallowed, the file is left untouched, and the
normal download path takes over. `CLEANROOM_MCP_SKIP_MIGRATION` disables it.

### Single-source-of-truth registries

These modules exist specifically to end duplication that previously spread across ~10 files.
Do not hardcode their values anywhere else — extend the registry instead:

| Module                                          | Owns                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/dbs.ts`                                    | package name, repo slug, DB filenames, manifest names, schema versions, release selection       |
| `src/loaders.ts`                                | loader ids, roles, doc hosts, default MC versions, scope→loader expansion, URL→loader detection |
| `src/categories.ts`                             | doc and example category taxonomies, URL→category mapping (feeds tool enums _and_ DB seeding)  |
| `src/equivalence/topics.ts`                     | the porting topic vocabulary                                                                    |
| `src/templates/index.ts`, `src/guides/index.ts` | template component and guide names                                                              |

### The two category taxonomies are one taxonomy

`DOC_CATEGORIES` is **defined as** `[...EXAMPLE_CATEGORIES, ...DOC_ONLY_CATEGORIES]`, so
`EXAMPLE_CATEGORIES ⊆ DOC_CATEGORIES` is a fact of the type system rather than a test
assertion. Keep it that way. The tool descriptions route agents from `list_mod_categories` into
`search_docs`, and before the two vocabularies converged, carrying a slug across that boundary
produced a schema error.

Consequences worth knowing before you edit either list:

- Adding a `DOC_ONLY_CATEGORIES` member is a compile error until you add it to
  `DOC_ONLY_ROUTING` — every doc-only category must say where an agent goes when it comes back
  empty. Shared categories route to themselves, derived, with no table entry.
- Several doc categories hold zero *target-scope* documents. That is expected: the target
  corpus is 88 documents, so any taxonomy finer than about six values has empty buckets. The
  `auditCoverage` / `formatEmptyCategory` machinery discloses them and routes onward; do not
  "fix" it by shrinking the enum.
- `categorizeDocPath` splits on `/`, `:` and `_` — **not** `-`. The Fabric wiki is a DokuWiki
  whose URLs are colon namespaces (`tutorial:blockentity_sync_itemstack`); several live slugs
  depend on the hyphen staying intact (`getting-started`, `class-tweakers`, `transfer-api`).
- Matching is two-tier: `PATH_SEGMENT_CATEGORIES` (subjects) is consulted for every segment
  before `CONTAINER_SEGMENT_CATEGORIES` (trees like `resources/`, `datastorage/`, `misc/`), so
  `/datastorage/capabilities` resolves to `capabilities` rather than to its container.

### The target/reference domain model

`src/loaders.ts` assigns every loader a **role**: `target` (cleanroom, forge — what the server
helps you _build_, pinned to 1.12.2), `reference` (fabric, neoforge — retained only as porting
source material), or `neutral` (`shared`). The agent-facing `scope` parameter
(`target`/`reference`/`all`) expands through `scopeToLoaders()`. `perspectiveToLoaders()` is
deliberately different from search's loader filter — see its comment before changing it. This
role split is the project's core orientation; new features should respect it rather than treat
loaders as co-equal.

### Databases

| DB                 | Base tools need it | Built by              | Notes                                                                                             |
| ------------------ | ------------------ | --------------------- | ------------------------------------------------------------------------------------------------- |
| `docs.db`          | yes                | `index-docs`          | FTS5 + 384-dim MiniLM embeddings, hybrid search                                                   |
| `mappings.db`      | no                 | `index-mappings`      | two eras in one DB, keyed by `classes.mapping_set` (`mcp` for 1.12.2 SRG, `parchment` for modern) |
| `cleanroom-api.db` | no                 | `index-cleanroom-api` | parsed from the published `:sources` jar                                                          |
| `examples.db`      | no                 | `index-mod-examples`  | LLM-analyzed snippets, SRG/API cross-links resolved at build time                                 |

**All four install themselves** — `scripts/postinstall.js` downloads every registry entry
during `npm install`, and `autoUpdateAll()` fetches whatever is still missing on startup.
`DbSpec.required` no longer gates that; it only marks the DB the base tools cannot work
without (failure messaging, the `[core]` badge in `manage`). `manage` is the manual
install/refresh path, not the only way the optional DBs arrive. Because clients now download
all four, `scripts/release.ts` fails closed unless every DB is present at release time.

Databases live in a platform data dir (`src/data-dir.ts`), overridable with
`CLEANROOM_MCP_DATA_DIR`. `src/db-versioning.ts` auto-updates them on startup unless
`CLEANROOM_MCP_SKIP_AUTO_UPDATE` is set; DBs marked `source: 'local-build'` are never
overwritten by auto-update. Distribution convention: **every** DB asset and its manifest
attach to the single `v{version}` GitHub release — there are no per-database tags.

Not everything needs a DB: `src/templates/` and `src/guides/` are package-shipped strings,
surfaced as tools (`get_project_template`, `get_porting_guide`), as MCP resources
(`cleanroom://template/…`, `cleanroom://guide/…`, see `src/resources.ts`), and inside prompts
(`src/prompts.ts`).

### Committed vs generated data

`data/` is gitignored **except** `data/equivalence/` (hand-curated porting YAML),
`data/examples-roster.json` (license-reviewed repo pins), `data/examples-llm.json` (non-secret
endpoint/pricing declaration), and `data/templates-pins.json`. Those four are PR-reviewed
inputs to the pipelines; everything else under `data/` is a build artifact.

`cleanroom-src/` is a gitignored read-only checkout of the Cleanroom loader, for human
reference only. **No code or pipeline may read it** — `index-cleanroom-api` downloads the
published sources jar from `repo.cleanroommc.com` instead.

The examples pipeline requires a configured OpenAI-compatible endpoint (flag → env
`CLEANROOM_MCP_LLM_*` → `data/examples-llm.json`) and exits non-zero with no endpoint; it has a
content-addressed analysis cache and a `--llm-max-cost-usd` budget cap. CI never runs it — the
release workflow carries the previous `examples.db` forward.

## Conventions

- **Never write to stdout on the server path.** stdout is the MCP stdio transport; all server
  logging goes through `console.error` with a `[Component]` prefix. The deliberate exceptions
  are `src/cli/manage.ts` (the `manage` CLI mode, which `process.exit`s before the server
  starts) and the build scripts / `EmbeddingGenerator.generateEmbeddings` progress output,
  which only the indexer calls.
- ESM with `module: Node16` — relative imports need explicit `.js` extensions.
- TypeScript is strict plus `noUncheckedIndexedAccess`, `noUnusedLocals`/`noUnusedParameters`,
  `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`. Tests are excluded
  from the build but covered by the eslint typecheck config.
- Tool handlers return errors as `{ content: [...], isError: true }`, not thrown exceptions.
- Conventional Commits are enforced by commitlint via a husky `commit-msg` hook; `pre-commit`
  runs lint-staged (eslint --fix + prettier).
- PRs target `dev`, never `prod`. `prod` is release-only.
