# DESIGN: Phase 4 — Porting Layer

**What this document is:** the implementation design for Phase 4, consuming
[docs/phase4/RESEARCH.md](RESEARCH.md) as its source of truth and
[PROJECT_DESIGN.md](../PROJECT_DESIGN.md) §5.3/§5.4/§8 for macro scope. It makes the design
decisions RESEARCH deliberately deferred — resolving all 26 of its open questions
(Appendix A) — and freezes them for a blind implementation pass. It does **not** re-derive
RESEARCH's verified facts; where it relies on them it cites the RESEARCH section rather than
repeating the evidence. Citations use `path:line` / commit / URL form and are consistent
with RESEARCH's re-verified findings (branch `dev` at `c00c09d` plus uncommitted changes);
this document is authored against HEAD `76c911a`.

**Status:** Phases 0–3 implemented (distribution repair + rebrand; loader registry + corpus
retargeting; 1.12.2 MCP/SRG mappings with `resolve_symbol`; Cleanroom API DB with
`search_cleanroom_api`/`get_api_class`). Phase 4 (this document) not yet started;
`docs/phase4/DESIGN.md` was a 0-byte stub before this document, alongside empty
`BLIND_SPEC.md`/`IMPL_DOC.md` siblings.

**How it was produced:** the RESEARCH recon (multi-agent fan-out over the working tree and
external sources, re-verified 2026-07-22) plus a direct read of the integration surfaces it
cites — [src/index.ts](../../src/index.ts), [src/dbs.ts](../../src/dbs.ts),
[src/indexer/store.ts](../../src/indexer/store.ts),
[src/services/concept-service.ts](../../src/services/concept-service.ts),
[src/tools/cleanroomApi.ts](../../src/tools/cleanroomApi.ts) — and the committed
[docs/phase5/DESIGN.md](../phase5/DESIGN.md) as the structural precedent this document mirrors.

### Fixed inputs (maintainer decisions — treated as settled here)

Four decisions were made by the maintainer and drive the whole design:

1. **Scope — maximal.** The full Phase 4 deliverable set (equivalence corpus +
   `find_equivalent`, `explain_concept` difference banners, MCP resources for templates *and*
   the four porting guides, MCP prompts, template vendoring) **plus** the coupled fixes the
   surface requires: the `prompts` capability declaration (RESEARCH C1), `list_targets`
   discovery for the new surfaces, and the npm-packaging of non-TS assets (RESEARCH C2).
2. **Corpus storage — dedicated tables in `docs.db`.** The ~150 entries compile into a new
   `equivalence` table (plus FTS) inside `docs.db`, forcing the **first-ever docs.db
   `schema_version` bump (1 → 2)** through the existing generic force-redownload path
   (RESEARCH §2.2, C5, OQ7). Rejected: overloading the free-TEXT `documents`/`chunks` tables
   (fights URL-uniqueness, version-dedup, NULL-version exclusion, single-loader routing —
   RESEARCH §2.3); rejected: a separate optional `equivalence.db` (contradicts
   PROJECT_DESIGN §5.4's "compiled into the docs DB" fixed input).
3. **`from: 'modern-minecraft'` — a separate from-vocabulary.** It is modeled as its own
   enum on `find_equivalent`/the corpus (`'fabric' | 'neoforge' | 'modern-minecraft'`),
   **not** a `Loader` registry value — keeping it out of `LOADER_IDS`, `scopeToLoaders`, both
   families, and `list_targets` (RESEARCH §2.3, OQ5).
4. **Template vendoring — raw upstream bytes.** Vendored `CleanroomModTemplate` snapshots are
   served **verbatim with unexpanded `{{ }}` blossom tokens**, annotated to explain each
   token — the highest-fidelity form and exactly what the modder's Unimined + blossom build
   expands (RESEARCH §3.1, OQ23).

---

## 1. Goals, deliverables, and exit criterion

Phase 4 adds the **porting/backporting layer** — the highest-leverage work for workflows W2
(cross-loader ports) and W3 (backports) — as hand-curated data plus thin tools, and finally
lights up the MCP `resources` wiring (stubbed since inception — RESEARCH §2.1) and the
absent `prompts` surface.

**Deliverables** (from [PROJECT_DESIGN.md:308-309](../PROJECT_DESIGN.md) §5.3/§5.4, under the
maximal-scope decision):

1. **Equivalence corpus** — hand-curated `data/equivalence/*.yaml` (~150 seed entries),
   validated at build time, compiled into a **dedicated `equivalence` table in `docs.db`**
   (§3, §5).
2. **`find_equivalent(query, from, topic?)`** — the corpus front door, gated on the docs
   schema bump with graceful degrade (§4).
3. **`explain_concept` integration** — cross-loader difference banners when a concept maps to
   a corpus topic (§4.3).
4. **MCP resources** — `cleanroom://template/{…}` and `cleanroom://guide/{porting-from-fabric,
   porting-from-neoforge,backporting,mixin-setup}`, enumerated concretely, each with a
   tool-shaped twin (§7).
5. **MCP prompts** — `scaffold_cleanroom_mod`, `port_mod_to_cleanroom`, `backport_feature`
   (§8), behind the newly-declared `prompts` capability (§10).
6. **`get_project_template(component)`** — raw vendored template snapshots + curated
   companions (§9).
7. **Coupled wiring** — `prompts` capability, resource/tool-twin parity enforcement,
   `list_targets` discovery for the new surfaces, and TS-module packaging of all non-TS
   assets so they reach npm users (§10).

**Exit criterion** (RESEARCH OQ2 — Phase 4 has no `Exit:` clause in PROJECT_DESIGN §8; this
document adds one, matching the §8 preamble that every phase "leaves the server building,
testing, and shipping"):

> The server builds, lints, type-checks, and tests green with `find_equivalent` and
> `get_project_template` live, the `resources`/`prompts` capabilities declared, and the
> server object starting without the C1 capability crash. `docs.db` rebuilds with the
> equivalence table populated from validated YAML; an old (v1) `docs.db` force-redownloads,
> and `find_equivalent` degrades gracefully when the corpus is absent. The three prompts and
> all concrete `cleanroom://` resources resolve, each resource's tool-twin returns identical
> bytes (enforced by test), and `list_targets` reports the new surfaces. The W2/W3 flows
> (PROJECT_DESIGN §7.2) run end to end. Adversarial multi-agent review finds no surviving
> correctness findings.

**Process convention** (RESEARCH OQ1, OQ3): PROJECT_DESIGN.md is the standing objective (no
`OBJECTIVE.md` exists or ever did — RESEARCH §Scope); the per-phase pipeline is
RESEARCH → DESIGN → BLIND_SPEC → IMPL_DOC. Phase 4 **adopts the Phase 3 finalization
protocol** — blind implementation → ordered validation gates → adversarial multi-agent review
(3-skeptic / ≥2-survival / two-clean-rounds) looping until dry
([docs/phase3/phase3-finalization-prompt.md](../phase3/phase3-finalization-prompt.md)); a
Phase 4 finalization prompt is authored as a sibling. The `DESIGN.md → docs/PROJECT_DESIGN.md`
rename (RESEARCH OQ4, §4 delta 9) should be committed before this document's citations go
live, fixing the broken [README.md:22](../../README.md) link.

---

## 2. Non-goals

Stated explicitly so the implementation does not drift into them:

- **No automatic derivation of API equivalence.** The corpus is hand-curated and embraced as
  such (PROJECT_DESIGN §5.4); no scraper/LLM generates equivalence rows. Curation is the
  feature — it is reviewable and honest about `kind: missing`.
- **`modern-minecraft` is not a loader.** It is a from-vocabulary only (Fixed Input 3); it
  gains no `Loader` registry entry, no `LOADER_IDS` slot, no family membership, and does not
  appear in any tool's `loader`/`scope` enum or in `list_targets`' matrix.
- **Equivalence entries are not indexed into the documents/chunks FTS corpus.** They live in
  their own table (Fixed Input 2); `search_docs` stays doc-only and is not polluted with
  synthetic equivalence "documents" (avoids the URL-collision/dedup/routing hazards of
  RESEARCH §2.3). Discovery is via `find_equivalent` + cross-link banners, not via mixing.
- **No runtime YAML parsing.** YAML is a build-time input compiled into `docs.db`; no `dist/`
  code reads YAML, so the YAML dependency is **build-only** (RESEARCH OQ11, C2).
- **No `resources/subscribe` / `listChanged` notifications.** Claude surfaces don't support
  resource subscriptions and the server emits no notifications; the new surfaces are static
  per session (RESEARCH §3.3, §2.1, OQ19).
- **No reliance on `resources/templates/list`.** No surveyed client surfaces RFC-6570 resource
  templates (RESEARCH §3.3, OQ17); every `cleanroom://` URI is enumerated concretely in
  `resources/list`.
- **No copying of copyleft source into snippets.** LGPL/LGPL-2.1 material (Architectury,
  MixinBooter, GTCE, …) is never pasted into `code_before`/`code_after`; only
  MIT/Apache/Unlicense/public-domain sources are quoted, CC-BY prose is attributed (§6).
- **Templates are the only vendored upstream bytes.** Only `CleanroomModTemplate` (MIT) is
  vendored verbatim. The four porting guides are **original authorship**, not adaptations of
  any wiki (no upstream porting-from-Fabric/NeoForge source exists — RESEARCH §3.2).
- **No `translate_symbol` / cross-version symbol mapping.** That is Phase 6 (PROJECT_DESIGN
  §8); Phase 4's backport support is conceptual (`from: modern-minecraft` equivalence rows)
  only.

---

## 3. The equivalence corpus

### 3.1 YAML source shape (`data/equivalence/*.yaml`, one file per topic)

The authored form, matching PROJECT_DESIGN §5.4 and extended for the four verified source
eras (RESEARCH §3.4.1) and the citation/attribution requirements (§6):

```yaml
topic: networking            # canonical topic id (§3.2)
entries:
  - from:
      vocab: fabric          # 'fabric' | 'neoforge' | 'modern-minecraft'  (from-vocabulary)
      era: fabric-pre-1.20.5 # era tag (§3.3); drives which spelling agents will paste
      api: "ServerPlayNetworking.registerGlobalReceiver(Identifier, PlayChannelHandler)"
      api_alt:               # alternate-era spellings so find_equivalent matches any paste (OQ6)
        - "ClientPlayNetworking.send(Identifier, PacketByteBuf)"
      versions: "1.16–1.20.4 (Yarn-named); package net.fabricmc.fabric.api.client.networking.v1"
    to:
      loader: cleanroom      # target Loader: 'cleanroom' | 'forge'
      api: "NetworkRegistry.INSTANCE.newSimpleChannel → SimpleNetworkWrapper; IMessage + IMessageHandler"
    kind: pattern-change     # direct | analog | pattern-change | missing
    notes: |
      1.12.2 packets run on the network thread; main-thread work must go through
      IThreadListener.addScheduledTask (maps to Fabric execute()/Neo enqueueWork()).
    code_before: |           # source-side snippet (permissive-license source only, §6)
      ...
    code_after: |            # 1.12.2 idiom
      ...
    caveats:
      - "registerMessage takes a discriminator byte + Side."
    related:                 # entry_keys / cleanroom:// / api:// links (§3.4)
      - "cleanroom://guide/porting-from-fabric#networking"
    sources:                 # citation + attribution (OQ14/15)
      - url: "https://docs.minecraftforge.net/en/1.12.x/networking/simpleimpl/"
        license: "MIT-docs"
        quote: "packets are handled on the network thread"
    validated_against: "cleanroom 0.6.3-alpha; fabric-api 0.92.11+1.20.1"   # R3
```

`entry_key` is derived at compile time as `<topic>/<from.vocab>/<slug(from.api)>` — a stable,
unique id used for `related[]` linking and the entry's `cleanroom://equivalence/<entry_key>`
citation URL (§3.4). Load-bearing API names are **quoted inline** in `from.api`/`to.api`/
`notes` (RESEARCH R4: linked pages silently re-render into wrong-era names — inline quoting is
the robust pattern).

### 3.2 Topic taxonomy

A canonical topic vocabulary is defined in a new `src/equivalence/topics.ts` — the authoritative
list `find_equivalent(topic?)` validates against and the porting prompts enumerate. Seed
topics (PROJECT_DESIGN §5.4 + RESEARCH §3.4.5 gap analysis): `registration`, `events`,
`networking`, `mixins-access-transformers`, `capabilities-attachments`, `item-block-settings`,
`resources-datagen` (`kind: missing`), plus the prior-art-derived additions the roster needs —
`fluids`, `serialization-nbt-codecs`, `resource-loading`, `energy-transfer`, `enchantments`,
`advancements`, `permissions`, `particles`, `config`, and the backport-only `data-components`,
`block-entity-renderer`, `text-components`.

This topic set is **decoupled from `KNOWN_CONCEPTS`** (RESEARCH OQ16): the corpus taxonomy is
broader than what `explain_concept` answers. A curated `CONCEPT_TO_TOPIC` map (§4.3) links the
subset of concepts that should surface banners — not alias expansion (avoids R7 over-match).

### 3.3 Era model (`from.era` / `from.versions`)

The four verified source eras (RESEARCH §3.4.1) are a fixed enum `from.era`:
`yarn-<=1.21.11` (Yarn-named Fabric), `mojang-26x` (Mojang-named Fabric 26.x),
`fabric-pre-1.20.5` (Identifier channels + PacketByteBuf), `legacy-modern-forge-1.16-1.20.1`
(DeferredRegister/RegistryObject, SimpleChannel, LazyOptional). Fabric rows carry **both**
Yarn and Mojang spellings where they differ (`api` + `api_alt`) so `find_equivalent` matches
whatever an agent pastes from real mod source (OQ6). `from.versions` is free prose recording
the exact version window and package.

### 3.4 Compiled URL/reference scheme

Entries carry no `documents.url` (they are not documents). Their citation URL is
`cleanroom://equivalence/<entry_key>` — the same custom scheme as the resources (§7), so
`related[]` links, `explain_concept` banners, and prompt checklists all speak one namespace
(OQ8). `related[]` may also point at `cleanroom://guide/*`, `cleanroom://template/*`, or
`api://<fqn>` (the latter noted as **not-yet-implemented** — RESEARCH §4 delta 7; treated as a
forward-reference label, not a live resolver, in Phase 4).

---

## 4. `find_equivalent` and consumer integration

### 4.1 The tool

`find_equivalent(query, from: 'fabric' | 'neoforge' | 'modern-minecraft', topic?, limit?)` —
a new module `src/tools/findEquivalent.ts` + service `src/services/equivalence-service.ts`,
following the Phase 3 tool conventions (RESEARCH §2.1): exported `{name, description,
inputSchema}` with `type: 'object' as const`, a `FROM_VALUES`/`TOPIC_VALUES` const shared
between schema and runtime guard, `limit` clamped `Math.min(Math.max(limit||15,1),50)`, a
typed exported `FindEquivalentParams`, and a service that opens `docs.db` and closes in
`try/finally`. `from` is the **separate from-vocabulary** (Fixed Input 3), independent of
`LOADER_IDS`.

**Query mechanics:** FTS5 over `equivalence_fts` (topic + both API spellings + notes +
keywords), filtered by `from_vocab` and optional `topic`. Markdown output follows the house
format (RESEARCH §2.1): `Found N equivalents for …` header; `###` per hit with a `kind` badge
(`direct`/`analog`/`pattern-change`/`missing`); `**Source:**` → `**Target:**` lines with the
quoted APIs; `code_before`/`code_after` fenced blocks; caveats list; `related[]` links; a
trailing next-step hint. `kind: missing` renders honestly: *"No 1.12.2 equivalent — here is the
idiom instead."*

### 4.2 Gating and graceful degrade (OQ10)

`docs.db` is the required, postinstall-downloaded, always-auto-updated DB (RESEARCH §2.2). The
equivalence table arrives via the **schema bump 1 → 2** (§5). Because the docs services have no
`isAvailable()` gate (RESEARCH C5), `EquivalenceService` guards explicitly: it probes for the
`equivalence` table / `schema_version >= 2` on open. If absent (a user on an old docs.db that
has not yet auto-updated, or an offline user), `find_equivalent` returns **normal guidance
text** (not `isError`) — *"The porting corpus isn't present in this `docs.db` build; run
`npx cleanroom-modding-mcp manage` / restart to update"* — mirroring the Phase 3
`NOT_INSTALLED_MESSAGE`/`OUTDATED_SCHEMA_MESSAGE` convention
([cleanroomApi.ts:95-109](../../src/tools/cleanroomApi.ts:95)). The tool is **always listed**
(not gated out of `ListTools`) since docs.db is required; only its data may be transiently
absent.

### 4.3 `explain_concept` banners (OQ12, R7)

Add an optional `equivalence?: EquivalenceMatch[]` field to `ConceptExplanation`
([concept-service.ts:18-42](../../src/services/concept-service.ts:18)). The concept handler
maps the requested concept → corpus topic via a curated `CONCEPT_TO_TOPIC` table (exact
concept-id / `KNOWN_CONCEPTS`-key match — **never** `expandConcept`'s bidirectional-substring
aliasing, which RESEARCH R7 warns over-matches), queries `EquivalenceService` for that topic,
and populates the field. `formatForAI` ([concept-service.ts:916-974](../../src/services/concept-service.ts:916))
renders a new **"Cross-loader differences"** section when the field is non-empty — the
new-field approach, not handler prefix-concatenation, keeping rendering in one place.

---

## 5. Compiled form: dedicated docs.db tables

### 5.1 Schema (docs.db `SCHEMA_VERSION` 1 → 2)

Added to [src/indexer/store.ts](../../src/indexer/store.ts) schema init; `SCHEMA_VERSION` at
[store.ts:9](../../src/indexer/store.ts:9) bumps to `2` and gains the "bump together with
`DBS.docs.schemaVersion`" link-comment the mappings/cleanroom-api DDL already carry (RESEARCH
§2.2 notes docs.db lacks it). `DBS.docs.schemaVersion` ([dbs.ts:44-54](../../src/dbs.ts:44))
bumps in lockstep.

```sql
CREATE TABLE equivalence (
  id INTEGER PRIMARY KEY,
  entry_key TEXT NOT NULL UNIQUE,   -- <topic>/<from_vocab>/<slug>; also cleanroom:// tail
  topic TEXT NOT NULL,
  from_vocab TEXT NOT NULL,         -- 'fabric' | 'neoforge' | 'modern-minecraft'  (NOT a Loader)
  from_era TEXT,                    -- era enum (§3.3)
  from_api TEXT NOT NULL,
  from_api_alt TEXT,                -- JSON array of alternate-era spellings
  from_versions TEXT,
  to_loader TEXT NOT NULL,          -- 'cleanroom' | 'forge'
  to_api TEXT,                      -- NULL when kind='missing'
  kind TEXT NOT NULL CHECK (kind IN ('direct','analog','pattern-change','missing')),
  notes TEXT,
  code_before TEXT,
  code_after TEXT,
  caveats TEXT,                     -- JSON array
  related TEXT,                     -- JSON array
  keywords TEXT,                    -- JSON array (compile-derived: split identifiers)
  sources TEXT,                     -- JSON array {url,license,quote}
  validated_against TEXT
);
CREATE VIRTUAL TABLE equivalence_fts USING fts5(
  topic, from_api, from_api_alt, to_api, notes, keywords,
  content='equivalence', content_rowid='id');   -- + ai/ad/au sync triggers
CREATE INDEX idx_equivalence_topic ON equivalence(topic);
CREATE INDEX idx_equivalence_from  ON equivalence(from_vocab);
```

No migration code exists anywhere in the tree (RESEARCH §2.2); consistent with house
convention, the bump is handled by **full rebuild** (the weekly job) + client
force-redownload via the generic `DbVersioning` forcing function
([db-versioning.ts:187-199](../../src/db-versioning.ts:187)), which is DB-agnostic and covers
docs.db. Note the `metadata` `INSERT OR IGNORE` caveat (RESEARCH §2.2): an in-place-opened v1
DB never rewrites `schema_version`, so correctness relies on the force-redownload replacing
the file — which is exactly the path the version bump triggers.

### 5.2 Compile stage

A new **compile-equivalence stage** in [scripts/index-docs.ts](../../scripts/index-docs.ts),
parallel to the existing `prebuiltPages` merge hook (RESEARCH §2.2 — the established point
where non-crawled corpora enter): read `data/equivalence/*.yaml`, validate (§6.2), derive
`entry_key`/`keywords`, and bulk-insert into `equivalence`. Runs unconditionally on every docs
build; gated behind a `--equivalence`/`--no-equivalence` flag consistent with the existing flag
style. `clean:all` deletes `data/` (RESEARCH R6) — a `data/equivalence/` note is added to the
script/README warning; the corpus is git-committed and recoverable.

---

## 6. Corpus authoring policy

### 6.1 Citation-source rules (OQ13, OQ14, R4)

Adopt RESEARCH §3.4.2's verified-stable source set as the authoring rule, recorded in the
Phase 4 finalization/authoring checklist:

- **Quote load-bearing names inline** in the entry (the primary defense against silent
  re-rendering — `docs.fabricmc.net` re-renders even old pages into Mojang names).
- **Cite versioned/immutable URLs** — page-level `docs.minecraftforge.net/en/1.12.x/…` (never
  section-landing, which 404), per-version `maven.fabricmc.net/docs/yarn-<v>/` javadocs (≤1.21.1
  for Yarn spellings), versioned `docs.neoforged.net/docs/<v>/…`, `ForgeJavaDocs-NG` for 1.12.2
  symbols. Avoid `mcforge.readthedocs.io` (a redirect, not a mirror — false redundancy).
- **1.12.2 access-transformer authoring** (OQ13, no live authoritative doc): cite the
  template's `modid_at.cfg` + `gradle.properties` comments and the Cleanroom wiki mixin pages,
  and carry the load-bearing `<modifier> <fq-class> <member><descriptor>` syntax inline; the
  `mixin-setup` guide (§7) is the primary authored home for it.
- **Link-checking CI** is recommended but not made blocking in Phase 4 (surfaced as OQ, §14).

### 6.2 YAML validation + parser (OQ11)

A build-only YAML dependency enters the tree (`yaml`, caret-ranged, devDependency — no `dist/`
code reads it, per the non-goal). Validation lives in `src/equivalence/validate.ts` — a
hand-rolled schema check (in the dependency-averse house style of the minimal frontmatter
parser at [markdown.ts:41-42](../../src/indexer/markdown.ts:41)) asserting required keys, the
`from.vocab`/`from.era`/`kind` enums, `to.api` present unless `kind: missing`, and non-empty
`sources[]`. A new CI step (`pnpm run validate:equivalence`) runs it before indexing, alongside
the existing typecheck/lint/vitest gates.

### 6.3 Licensing + attribution (OQ15, R5)

- `code_before`/`code_after` may quote **only** MIT/Apache-2.0/Unlicense/public-domain
  sources (Fabric API, Forgified Fabric API, MinecraftByExample, williewillus primers,
  template). **Never** LGPL (Architectury, GTCE) or LGPL-2.1 (MixinBooter).
- CC-BY-4.0 primer prose, if quoted in `notes`, carries attribution in the entry's `sources[]`
  (`license: CC-BY-4.0` + `url`).
- Enforcement is a **PR-review checklist** item (CI cannot judge licensing) recorded in the
  finalization prompt; the `sources[]` field makes each entry's provenance reviewable.
- The four guides are original authorship (§2 non-goal) — they do not derive from the
  unlicensed CleanroomMC wiki, so they do not depend on the wiki-blessing gate (OQ24, §14).

---

## 7. MCP resources

### 7.1 Enumeration (OQ17)

No surveyed client surfaces `resources/templates/list` (RESEARCH §3.3); **every `cleanroom://`
URI is enumerated concretely** in the `ListResources` handler
([index.ts:383-387](../../src/index.ts:383), currently `{ resources: [] }`). A
`ListResourceTemplates` handler is registered for spec-completeness but nothing depends on it.
`ReadResource` ([index.ts:390-393](../../src/index.ts:390), currently always throws) resolves:

- `cleanroom://template/{build.gradle, gradle.properties, settings.gradle, mcmod.info,
  ExampleMod.java, mixins.json, modid_at.cfg, README, checklist}` — raw vendored snapshots (§9).
- `cleanroom://guide/{porting-from-fabric, porting-from-neoforge, backporting, mixin-setup}` —
  authored markdown checklists.

Not-found returns spec code `-32002` (RESEARCH §3.3). The `resources` capability is already
declared ([index.ts:61-72](../../src/index.ts:61)), so resource handlers need no capability
change; only the empty stubs are filled.

### 7.2 Tool-twins and parity (OQ20)

Every resource keeps a tool-shaped twin (PROJECT_DESIGN §5.3): `get_project_template(component)`
mirrors `cleanroom://template/*`, and a new `get_porting_guide(name)` mirrors
`cleanroom://guide/*`. **Parity is structural, not duplicated:** the resource handler and the
tool read the **same content module** (§7.3), and a test asserts the resource body and the
tool body are byte-identical for each component/guide.

### 7.3 npm-packaging the content (C2)

Non-TS assets never reach npm users (tarball ships only `dist/` + `postinstall.js`; plain
`tsc` copies nothing — RESEARCH C2). Therefore template snapshots and guide markdown are
**generated into committed TS modules** under `src/templates/` and `src/guides/` (each exporting
a string constant), by a vendoring script (§9). Because they are `.ts`, `tsc` emits them into
`dist/`. This both fixes C2 and provides the single content source the resource and tool read
(§7.2). Payloads are per-component (never one giant blob) to stay under client result caps
(~25K tokens Claude Code / ~150K chars Claude.ai — RESEARCH C4).

---

## 8. MCP prompts (OQ18)

Three prompts (PROJECT_DESIGN §5.3), registered via `ListPrompts`/`GetPrompt` handlers behind
the newly-declared `prompts` capability (§10, C1). Arguments are **few, simple strings** (the
protocol allows only flat `Record<string,string>` — RESEARCH C3):

| Prompt | Args | Returns |
|---|---|---|
| `scaffold_cleanroom_mod` | `mod_id`, `mod_name?` | messages embedding `cleanroom://template/checklist` + a text plan sequencing `get_project_template` → `search_cleanroom_api` → `resolve_symbol` |
| `port_mod_to_cleanroom` | `source_loader` (`fabric`\|`neoforge`) | messages embedding `cleanroom://guide/porting-from-<loader>` + a topic-sweep checklist driving `find_equivalent` per topic |
| `backport_feature` | `source_version` | messages embedding `cleanroom://guide/backporting` + a `find_equivalent(from: modern-minecraft)` checklist |

Each `GetPromptResult` returns `{description, messages}` where a message embeds the relevant
resource (spec-blessed `type: 'resource'` embedded content — RESEARCH §2.1) plus a text
message laying out the tool plan. Invalid name / missing required arg → `-32602`.

---

## 9. Template vendoring (OQ21, OQ22, OQ23)

**Form (Fixed Input 4):** raw upstream bytes with `{{ }}` blossom tokens intact, each snapshot
prefixed with an annotation block explaining the tokens (`mod_id`, `root_package`,
`is_coremod`, `use_access_transformer`, …) and where they expand from (`gradle.properties` at
the modder's build time). This matches exactly what the modder's Unimined 1.4.26-kappa +
blossom build produces — emitting expanded or ForgeGradle-shaped files would break real builds
(RESEARCH §3.1: the template uses **Unimined, not ForgeGradle** — correcting PROJECT_DESIGN
§5.3's material error, RESEARCH §4 delta 1).

**Branch mapping (OQ22):** the upstream repo has four branches, zero tags/releases. Components
map by branch:
- `main` → base components (`build.gradle`, `gradle.properties`, `mcmod.info`, `ExampleMod.java`,
  `modid_at.cfg`, README).
- `mixin` → mixin-wiring components (`mixins.json`, the `MixinConfigs` manifest wiring) — the
  only branch with mixin setup (RESEARCH §3.1).
- `kotlin` / `scala` → optional language-variant components.

**Pinning (OQ21):** since there are no tags, the vendoring script records **per-branch commit
SHAs** in a `data/templates-pins.json` manifest (the SHA-drift mitigation the phase pattern
uses). Upstream's own loader pin (`0.5.17-alpha`, five releases behind the loader's
`0.6.3-alpha`) is **kept verbatim for fidelity** and the lag is called out in the snapshot
annotation. The weekly job refreshes both `main` and `mixin` SHAs (correcting PROJECT_DESIGN's
"MixinConnector wiring" overstatement — the template uses `MixinConfigs` only; RESEARCH §4
delta 2). The mixin branch's `is_coremod=true` + empty `IFMLLoadingPlugin` is annotated as
"present upstream; whether strictly required is unconfirmed" (RESEARCH OQ21 — surfaced in §14).

**Vendoring path (§7.3):** a `scripts/vendor-template.ts` fetches the pinned files from
`raw.githubusercontent.com` (honoring `GITHUB_TOKEN`, reusing the retry pattern of
[cleanroom-wiki.ts](../../src/indexer/cleanroom-wiki.ts)) and generates the committed
`src/templates/*.ts` content modules. It is a maintainer/CI tool, **not** shipped in the npm
tarball. The weekly job is currently git-write-free (RESEARCH §2.2); a template refresh that
commits regenerated modules is its first git-writing step (or lands via a PR) — noted in §11.

---

## 10. Capability and discovery wiring

- **`prompts` capability (C1 — hard blocker).** Add `prompts: {}` to the capabilities object
  at [index.ts:61-72](../../src/index.ts:61). Registering `ListPrompts`/`GetPrompt` without it
  throws *"Server does not support prompts"* at startup (SDK `assertRequestHandlerCapability`
  — RESEARCH §2.1, C1). No `listChanged` flags (§2 non-goal).
- **`list_targets` discovery (OQ19).** Extend [listTargets.ts:15-95](../../src/tools/listTargets.ts:15)
  — which today reports nothing about resources/prompts/templates/equivalence — to add a
  section listing the available prompts, resource URIs, template components, and the
  equivalence-corpus status (present / needs-update), so the "call this first" orientation tool
  actually surfaces the Phase 4 capabilities.
- **Protocol-level tests (R8).** No test exercises the server object today (RESEARCH §2.1, R8).
  Add tests that instantiate the server and assert: capabilities include `prompts` + `resources`;
  `ListResources` enumerates the concrete URIs; `ReadResource` and each tool-twin return
  identical bytes; `GetPrompt` returns the embedded resource; the server starts without the C1
  crash — the safety net the new wiring otherwise lacks.

---

## 11. Distribution and CI

- **Equivalence** ships **inside `docs.db`** (Fixed Input 2) — no new release asset. It reaches
  users through the existing docs pipeline: merged to `dev` → next weekly rebuild
  ([update-docs-weekly.yml](../../.github/workflows/update-docs-weekly.yml), Sun 02:00 UTC) →
  user's next server start (RESEARCH §2.2). The schema bump means clients force-redownload the
  new docs.db. **R1 freshness coupling applies:** equivalence updates ride the 180-minute
  weekly crawl and are invisible to release publishing (release.yml carries docs.db forward
  verbatim — RESEARCH §2.2); `workflow_dispatch` is the manual escape hatch.
- **Templates + guides** ship **inside the npm package** as `dist/` TS modules (§7.3) — no DB,
  no release asset. The weekly template-refresh regenerates the committed modules (§9) via PR.
- **Manifest continuity (R1).** The docs manifest bump must download the previous manifest
  before `--bump` (a failed fetch restarts numbering at `0.1.x` and higher-versioned clients
  silently skip updates — RESEARCH §2.2); the schema bump is a deliberate version event, not a
  regression.

---

## 12. Implementation sequencing and exit

Each step leaves the server green (the §8 preamble). Recommended internal order:

1. **Schema bump + registry** — docs.db `SCHEMA_VERSION` 1→2 with the `equivalence` DDL/FTS;
   pair `DBS.docs.schemaVersion`; add the link-comment. Testable with a fixture DB.
2. **Corpus scaffolding** — `src/equivalence/{topics,validate}.ts`, the `yaml` build-dep, the
   `validate:equivalence` CI step, and the `index-docs.ts` compile stage. Seed a handful of
   entries to prove the pipeline before authoring all ~150.
3. **`find_equivalent`** — service + tool + graceful-degrade gate (§4.1/§4.2); unit-tested
   against the fixture corpus.
4. **`explain_concept` integration** — `equivalence` field + `CONCEPT_TO_TOPIC` + `formatForAI`
   section (§4.3).
5. **Template vendoring** — `scripts/vendor-template.ts` + generated `src/templates/*.ts` +
   `get_project_template` (§9).
6. **Guides** — author the four `src/guides/*.ts` + `get_porting_guide` (§6, §7).
7. **MCP resources + prompts + capability** — fill the resource stubs, register prompts, add
   `prompts: {}`, enforce tool-twin parity, extend `list_targets` (§7, §8, §10).
8. **Protocol-level tests** (§10) + **corpus authoring** to ~150 entries under the §6 policy.
9. **Finalization protocol** — author the Phase 4 finalization prompt (sibling to Phase 3's)
   and run it: validation gates → adversarial multi-agent review → dry loop.

**Exit:** as §1.

---

## 13. Risks (carried from RESEARCH, under these decisions)

- **C1 — prompts-capability crash.** Mitigated by declaring `prompts: {}` (§10) and a startup
  protocol test (R8).
- **C2 — npm asset blind spot.** Mitigated by generating templates/guides into `dist/` TS
  modules (§7.3); no runtime file reads.
- **C5 / R-schema — first docs.db schema bump.** The force-redownload path is generic and
  works, but old-schema docs.db paired with new code fails at query time and offline users stay
  on v1 indefinitely — handled by `find_equivalent`'s explicit gate + graceful message (§4.2),
  not by assuming the bump always lands.
- **R1 — freshness coupling.** Equivalence rides the weekly crawl and is invisible to releases;
  `workflow_dispatch` is the escape hatch (§11).
- **R2 — template drift.** Kappa Unimined fork on a third-party maven, CleanroomGradle looming,
  manually-merged branches, no tags — pinned per-branch SHAs + verbatim raw bytes + annotated
  loader-pin lag (§9).
- **R3 — corpus staleness.** Cleanroom's alpha cadence + churny Fabric/NeoForge names —
  `validated_against` per entry and inline-quoted names (§3, §6).
- **R4 — link rot / silent re-rendering.** Inline-quoting load-bearing names + versioned/immutable
  URLs (§6.1).
- **R5 — licensing gates.** LGPL never quoted; CC-BY attributed; wiki-blessing does not gate the
  original-authored guides; PR-review enforcement (§6.3, §2).
- **R6 — `clean:all` deletes `data/`.** Committed + recoverable; a warning is added (§5.2).
- **R7 — alias over-match.** `explain_concept` matching uses an exact `CONCEPT_TO_TOPIC` map,
  never `expandConcept` (§4.3).
- **R8 — no protocol test net.** Added in §10.

---

## 14. Open questions (marked — for maintainer resolution)

Residuals after the four fixed inputs; each has a recommendation but is surfaced rather than
silently assumed:

1. **CleanroomMC wiki-content blessing (RESEARCH OQ24).** The design routes *around* it (guides
   are original authorship; equivalence quotes only permissive sources), but the pre-existing
   docs.db wiki ingestion still depends on it. *Recommendation:* confirm/obtain the blessing as
   part of the standing CleanroomMC conversation; it is not a Phase 4 blocker under this design.
2. **Corpus + guide correctness review (RESEARCH OQ25).** No upstream porting-from-Fabric/NeoForge
   material exists to check ~150 entries + 4 guides against. *Recommendation:* the maintainer
   authors; the adversarial finalization review + a domain-correctness pass (inline-quoted names
   verified against the §6.1 stable sources) is the gate. Who performs the domain pass needs
   sign-off.
3. **Link-checking CI (OQ14).** Not made blocking in Phase 4. *Recommendation:* add a
   non-blocking weekly link-check over `sources[]` URLs in a follow-up; inline-quoted names are
   the load-bearing defense regardless.
4. **Mixin-branch `is_coremod=true` + empty `IFMLLoadingPlugin` (RESEARCH OQ21).** Unresolved
   whether required or vestigial — determines what `mixin-setup` says. *Recommendation:*
   annotate as "present upstream, necessity unconfirmed"; resolve by testing a scaffolded mixin
   mod before asserting it in the guide.
5. **`api://` scheme in `related[]` (RESEARCH §4 delta 7).** Referenced as a forward-label but no
   resolver exists. *Recommendation:* keep as an inert label in Phase 4; wire a resolver only if
   `cleanroom-api.db` cross-linking is scoped into a later phase.
6. **Report the upstream English porting-guide 404 (RESEARCH OQ26).** *Recommendation:* yes, as
   part of the CleanroomMC contact — this server's guides would otherwise be the only English
   source.

---

## Appendix A — RESEARCH open-question → resolution map

Verifies that every one of RESEARCH §6's 26 open questions is resolved here.

| OQ | Topic | Resolution | Where |
|---|---|---|---|
| 1 | OBJECTIVE.md / pipeline convention | PROJECT_DESIGN is the objective; RESEARCH→DESIGN→BLIND_SPEC→IMPL_DOC | §1 |
| 2 | Exit clause | Added explicit exit criterion | §1 |
| 3 | Finalization protocol | Adopt Phase 3 protocol | §1 |
| 4 | Commit DESIGN.md rename | Recommend committing before citations go live | §1 |
| 5 | `modern-minecraft` model | Separate from-vocabulary, not a Loader | Fixed Input 3, §2, §3.1 |
| 6 | `from.versions` era model | Era enum + dual Yarn/Mojang spellings | §3.3 |
| 7 | Compiled form | Dedicated `equivalence` table; docs.db schema bump 1→2 | Fixed Input 2, §5 |
| 8 | loader/version/category/URL values | Own table (no documents row); `cleanroom://equivalence/<key>` | §3.4, §5.1 |
| 9 | Discoverable via search_docs? | No — `find_equivalent` + banners only; not in documents FTS | §2, §4.3 |
| 10 | `find_equivalent` gating | Schema-gated with graceful degrade; always listed | §4.2 |
| 11 | YAML validation + parser | Build-only `yaml` dep; hand-rolled validator + CI step | §6.2 |
| 12 | explain_concept match + attach | Exact CONCEPT_TO_TOPIC map; new `ConceptExplanation` field | §4.3 |
| 13 | 1.12.2 AT authoring citation | Template `modid_at.cfg` + wiki + authored mixin-setup guide | §6.1 |
| 14 | Citation-source policy / link-check | Adopt stable-source rules; link-check deferred | §6.1, §14 |
| 15 | CC-BY / anti-LGPL enforcement | `sources[]` field + PR-review checklist | §6.3 |
| 16 | Missing taxonomy slots | Corpus topic set (broad); concept subset via map | §3.2, §4.3 |
| 17 | Resource templates support | None — enumerate concrete `cleanroom://` URIs | §7.1 |
| 18 | Prompt args / return shape | Few string args; embedded resource + text plan | §8 |
| 19 | Capability / discovery story | `prompts: {}`; no listChanged; extend `list_targets` | §10 |
| 20 | Resource/tool-twin parity | Single content module both read; byte-identity test | §7.2 |
| 21 | Template "pinned to version" / coremod | Per-branch SHAs + verbatim loader pin; coremod → OQ | §9, §14 |
| 22 | Four-branch mapping / refresh | main=base, mixin=wiring, kotlin/scala optional; refresh both | §9 |
| 23 | Raw vs expanded snapshots | Raw bytes, tokens intact, annotated | Fixed Input 4, §9 |
| 24 | CleanroomMC blessing | Routed around; tracked gate | §2, §14 |
| 25 | Corpus/guide reviewer | Maintainer authors; finalization + domain pass | §14 |
| 26 | Upstream 404 report | Recommend reporting as part of contact | §14 |
