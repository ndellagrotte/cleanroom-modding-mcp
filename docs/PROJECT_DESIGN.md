# DESIGN: Reorienting mcmodding-mcp into a Cleanroom Mod-Development MCP Server

**Status:** Phases 0–3 implemented (distribution repair + rebrand, loader registry + corpus retargeting, 1.12.2 MCP/SRG mappings with `resolve_symbol` and on-device generation, Cleanroom API DB with `search_cleanroom_api` + `get_api_class`). Phases 4+ (porting layer, examples rebuild) not yet started.
**Scope of this document:** the complete design for transforming this fork of `mcmodding-mcp` into an MCP server whose mission is enabling AI agents to build the best possible **Cleanroom** mods (Minecraft 1.12.2).

How this document was produced: the entire server source (`src/`, `scripts/`, `.github/`) and the entire Cleanroom Loader reference tree (`cleanroom-src/`, gitignored, read-only) were read and inventoried; every design-critical claim was then adversarially re-verified against the source. Citations use `path:line` form. Where a citation refers to `cleanroom-src/`, remember that directory is reference material only — nothing in this design makes the server's code or build depend on it.

Decisions already made by the maintainer (and treated as fixed inputs here): **full rebrand** (new identity, no upstream merge-ability goal); **prebuilt SQLite DBs** delivered via this fork's GitHub Releases; **public npm package**; **rebuild the mod-examples corpus for 1.12.2**.

---

## 1. Vision and scope

### 1.1 Mission

The server's mission is to make an AI agent as effective as a veteran 1.12.2 modder with the Cleanroom wiki, the Forge 1.12.x docs, a mapped decompilation, and a folder of canonical mods open in another window. Concretely, it exists to serve three workflows, in strict priority order:

1. **From-scratch Cleanroom mod development** (primary). Scaffolding a project on Cleanroom's actual toolchain, answering API questions about Forge-1.12.2 and Cleanroom's additions, resolving SRG names in code and crash logs, and supplying idiomatic 1.12.2-era example code.
2. **Cross-loader ports to Cleanroom.** An agent converting a Fabric or NeoForge mod needs both sides of the translation: searchable source-loader documentation *and* an explicit equivalence layer that says what the Cleanroom-side counterpart of each source-loader concept is (or that none exists).
3. **Backports to Cleanroom.** An agent bringing a modern-Minecraft mod down to 1.12.2 needs version-delta knowledge (registries, rendering, networking, data formats) and, where feasible, symbol-level name translation between modern Mojang/Parchment names and 1.12.2 MCP/SRG names.

This is **orientation, not exclusion**. Fabric, NeoForge, and modern-Minecraft knowledge remain in the server — repositioned from co-equal targets to *reference material for translation*. The current corpus already covers them well ([sitemap.ts:208-292](src/indexer/sitemap.ts:208)); nearly all of it serves workflows 2 and 3 and is retained.

### 1.2 Non-goals

- **The server does not assist development that targets other loaders as the end product.** A Fabric mod is an input to a port, never an output the server optimizes for.
- **No runtime or build coupling to `cleanroom-src/`.** It stays gitignored human-reference material; the server's data pipelines consume Cleanroom's *published* artifacts instead (§6.3).
- **No launcher, modpack, or end-user tooling.** Cleanroom's installer/MMC-pack/relauncher ecosystem ([cleanroom-src/README.md:32-40](cleanroom-src/README.md)) is documented knowledge the server can answer questions about, not something the server automates.
- **No attempt to build a general "all versions, all loaders" modding encyclopedia.** Reference corpora are kept because they serve porting/backporting; breadth beyond that is out of scope.

### 1.3 Identity

Per the rebrand decision, the server gets a new identity — recommended name **`cleanroom-mcp`** (final name is Open Question 1, §9). Tool names shed the misleading Fabric branding (`search_fabric_docs` searches all loaders today — [index.ts:58-87](src/index.ts:58), [searchDocs.ts](src/tools/searchDocs.ts)), the npm package and DB-release hosting move to this fork's identity, and upstream (`OGMatrix/mcmodding-mcp`) is treated as an ancestor, not a merge partner.

---

## 2. Current-state summary

The server ([src/index.ts](src/index.ts), MCP SDK over stdio) exposes **15 tools, zero MCP resources, zero MCP prompts**. Resources are declared but empty (`ListResources` returns `[]`, `ReadResource` always throws — [index.ts:323-333](src/index.ts:323)); no prompt handlers exist at all. Tools arrive in three groups: 4 base tools always on, 5 mod-examples tools and 6 mappings tools gated on optional DBs being present ([index.ts:175-192](src/index.ts:175)).

### 2.1 Tool inventory mapped to the three workflows

Legend: **W1** = from-scratch Cleanroom, **W2** = ports, **W3** = backports.

| # | Tool | What it does today | Serves W1 today? | Serves W2/W3 today? |
|---|---|---|---|---|
| 1 | `search_fabric_docs` | Hybrid FTS5+embedding search over Fabric/NeoForge docs ([searchDocs.ts](src/tools/searchDocs.ts), [search-service.ts:127-211](src/services/search-service.ts:127)) | No — no 1.12.2/Forge/Cleanroom content indexed | Yes — this *is* the source-loader reference for W2 |
| 2 | `get_doc_snippet` | Doc-derived code examples, filterable by `loader: fabric\|neoforge\|shared` ([index.ts:107](src/index.ts:107)) | No | Yes (source-side examples for W2) |
| 3 | `explain_fabric_concept` | Concept synthesis from the docs DB; explicitly Fabric-biased (semantic query is literally `"Explain X in Minecraft modding with Fabric"` — [concept-service.ts:320](src/services/concept-service.ts:320), fallback at [:670](src/services/concept-service.ts:670)) | No | Partially (explains source-loader concepts) |
| 4 | `get_minecraft_version` | Latest/all indexed doc versions ([getMinecraftVersion.ts](src/tools/getMinecraftVersion.ts)) | No — version universe is 1.20/1.21 only | Marginal |
| 5–9 | `search_mod_examples`, `get_mod_example`, `list_canonical_mods`, `list_mod_categories`, `get_mod_patterns` | Curated-mod example DB ([modExamples.ts](src/tools/modExamples.ts)) | No | In principle — but see the corpus reality below |
| 10–15 | `search_mappings`, `get_class_details`, `lookup_obfuscated`, `get_method_signature`, `list_mapping_versions`, `browse_package` | Parchment + Mojang-official mappings, single-version-scoped ([mappings.ts](src/tools/mappings.ts), [mappings-service.ts](src/services/mappings-service.ts)) | No — zero 1.12.2 data (see below) | Yes for W3's *modern* side (the source of a backport) |

**Infrastructure inventory** (not agent-visible, but the design's raw material):

- **Ingestion backbone** — crawl ([crawler.ts](src/indexer/crawler.ts)) → chunk ([chunker.ts](src/indexer/chunker.ts)) → embed (`Xenova/all-MiniLM-L6-v2`, 384-dim — [embeddings.ts:34](src/indexer/embeddings.ts:34)) → SQLite store with FTS5 ([store.ts:38-158](src/indexer/store.ts:38)). Source-agnostic and directly reusable.
- **Distribution** — three DBs (`mcmodding-docs.db`, `parchment-mappings.db`, `mod-examples.db`) shipped as GitHub Release assets; postinstall download ([postinstall.js](scripts/postinstall.js)), startup auto-update for the docs DB only ([db-versioning.ts](src/db-versioning.ts)), and an interactive `manage` installer for the rest ([manage.ts:59-88](src/cli/manage.ts:59)). Platform-standard shared data dir ([data-dir.ts:27-47](src/data-dir.ts:27)).
- **CI** — weekly full docs+mappings re-index ([update-docs-weekly.yml](.github/workflows/update-docs-weekly.yml)), release workflow publishing npm + DB assets ([release.yml](.github/workflows/release.yml)).

### 2.2 Facts that constrain the design (all verified against source)

- **The loader model is a closed, stringly-typed 3-value union** `'fabric' | 'neoforge' | 'shared'` duplicated across ~10 sites with no registry: [types.ts:11](src/indexer/types.ts:11) and [:77-81](src/indexer/types.ts:77), [crawler.ts:739-760](src/indexer/crawler.ts:739) (`detectLoader` knows only `fabricmc.net`/`neoforged.net` hosts), [store.ts:396-405](src/indexer/store.ts:396) (stats silently drop unknown loaders), [search-service.ts:819](src/services/search-service.ts:819), [example-service.ts:572](src/services/example-service.ts:572), [searchDocs.ts:216-218](src/tools/searchDocs.ts:216), [index.ts:107](src/index.ts:107), plus per-loader sitemap functions and test fixtures. There is **no `forge` and no `cleanroom` value anywhere**; a grep for non-Neo `forge`, `1.12`, `cleanroom`, `srg` across `src/` and `scripts/` returns zero hits.
- **Zero 1.12.2 mappings capability.** The pipeline ingests only Parchment (parameter names/Javadoc) and Mojang official ProGuard mappings ([index-mappings.ts:36-42](scripts/index-mappings.ts:36)). Parchment has no 1.12.2 data; Mojang mappings begin at 1.14.4. Worse, `lookup_obfuscated` *advertises* SRG-style examples (`m_46859_`, [mappings.ts:97](src/tools/mappings.ts:97)) that the DB cannot contain — the stored `obfuscated_name` values are Mojang short tokens (`a`, `csy`), parsed at [index-mappings.ts:619-693](scripts/index-mappings.ts:619). The advertised input format does not match the indexed data even for modern versions.
- **The mappings model is single-version-scoped with no cross-version identity.** Every query filters one `minecraft_version` ([mappings-service.ts:632](src/services/mappings-service.ts:632)); the schema keys classes `UNIQUE(name, package_name, minecraft_version)` ([index-mappings.ts:228](scripts/index-mappings.ts:228)) with no correspondence across versions. Backporting name-translation is not merely missing — the schema cannot express it.
- **The mod-examples subsystem is vestigial.** Its ingestion script `scripts/index-mod-examples.ts` is gitignored, requires a maintainer-local LM Studio setup, and was never committed (`.gitignore:157-160`; `git log --all` shows nothing). Git history of the deleted manifest reveals the real shipped corpus: **one mod (Create), three examples** — not the advertised "1000+ examples from Create, Botania, AE2" ([modExamples.ts:3,17,29](src/tools/modExamples.ts:3), [README.md:283](README.md)). The schema and tools are sound; the corpus and pipeline effectively do not exist. `package.json` also references a missing `scripts/analyze-mappings.ts`.
- **The optional-DB distribution machinery is broken today.** CI uploads all assets to the main `v{version}` release ([release.yml:154-181](.github/workflows/release.yml)) but **never uploads `mod-examples.db` at all**; the manifest generators template dead download URLs under tags CI never creates (`mappings-v{version}`, `examples-v{version}` — [generate-mappings-manifest.ts:23-24](scripts/generate-mappings-manifest.ts:23)); `manage.ts` filters releases by `tagPrefix: 'v'` ([manage.ts:66-88](src/cli/manage.ts:66)), which makes Parchment work only by coincidence and mod-examples uninstallable; and `manage.test.ts` asserts a *different* `tagPrefix` (`examples-v`) against its own local copy of the config, hiding the regression. Startup auto-update covers only the docs DB ([db-versioning.ts:28-30](src/db-versioning.ts:28)).
- **Published tool schemas are incomplete.** `search_fabric_docs` accepts `loader`, `minecraft_version`, `include_code`, `limit` in its dispatcher ([index.ts:199-208](src/index.ts:199)) but advertises only `query` and `category` ([index.ts:61-86](src/index.ts:61)) — agents cannot discover the filters that matter most.
- **Hardcoded modern-version fallbacks:** unknown pages default to `minecraft_version = '1.21.10'` ([sitemap.ts:345](src/indexer/sitemap.ts:345)); `getLatestMinecraftVersion` falls back to `'1.21.4'` ([example-service.ts:168-188](src/services/example-service.ts:168)). Both would mislabel 1.12.2-era content.
- **The incremental updater is Fabric-only** ([updater.ts:7-9,122-136](src/indexer/updater.ts:7)) — it never refreshes NeoForge or wiki content.
- **Category taxonomy is triplicated with inconsistent value sets** across the two doc-tool schemas and `getAvailableCategories()` ([index.ts:71-80](src/index.ts:71), [index.ts:116-126](src/index.ts:116), [searchDocs.ts:197-211](src/tools/searchDocs.ts:197)).

Bottom line: **today, no capability serves W1 at all.** The reference corpus and infra serve W2 well and W3 partially, and the ingestion/distribution backbone is genuinely reusable — but its distribution layer must be repaired before anything new ships on it.

---

## 3. Cleanroom knowledge summary

Everything below is grounded in `cleanroom-src/` (Cleanroom `0.6.2-alpha`, 2026-07-20 per [CHANGELOG.md:7](cleanroom-src/CHANGELOG.md)). This is the factual substrate the server's tools and data must reflect.

### 3.1 Identity and compatibility promise

Cleanroom is a continuation/revamp of MinecraftForge + FML for Minecraft 1.12.2 ([README.md:20-30](cleanroom-src/README.md)), forked from the final stock Forge build `14.23.5.2864` ([gradle.properties:4](cleanroom-src/gradle.properties)), which it still stamps as `FORGE_VERSION` in manifests ([projects/cleanroom/build.gradle:859,966](cleanroom-src/projects/cleanroom/build.gradle)). Headline: **"1.12.2 on Java 25+"** with "Compatibility to 99% of Forge mods" ([README.md:8,12](cleanroom-src/README.md)). License LGPL-2.1. It is alpha software with an active release cadence (multiple releases per month).

### 3.2 Toolchain and project setup (what W1 scaffolding must encode)

- **Java 25 to build and run.** Build toolchain `JavaLanguageVersion.of(25)` ([projects/cleanroom/build.gradle:44-46](cleanroom-src/projects/cleanroom/build.gradle)); launcher JSON pins `majorVersion: 25`; the MMC pack declares `compatibleJavaMajors: [25, 26]` ([mmcpack-template/patches/net.minecraft.json](cleanroom-src/mmcpack-template/patches/net.minecraft.json)). Runtime relies on `--add-opens java.base/...` JVM args and compile-time `--add-exports` ([buildSrc/.../ProjectConstants.groovy:4-14](cleanroom-src/buildSrc/src/main/groovy/com/cleanroommc/gradle/helpers/ProjectConstants.groovy)).
- **Gradle plugin: a ForgeGradle 6 fork** — `top.outlands.gradle:ForgeGradle:6.0.57` from `maven.outlands.top` ([build.gradle:12-13](cleanroom-src/build.gradle)). **Contrary to a plausible assumption, RetroFuturaGradle appears nowhere in the tree, and CleanroomGradle is only a planned replacement** ([README.md:16](cleanroom-src/README.md)). Gradle wrapper 9.6.1.
- **Mappings: classic MCP, channel `stable`, version `39-1.12`** ([gradle.properties:7-8](cleanroom-src/gradle.properties)), applied via `mappings channel: …` ([projects/minecraft/build.gradle:30](cleanroom-src/projects/minecraft/build.gradle)); the notch→SRG layer comes from a **Cleanroom-rebuilt `mcp_config 1.12.2-20260220.202731`** hosted on the Outlands maven ([gradle.properties:10](cleanroom-src/gradle.properties), [projects/mcp/build.gradle:13-15](cleanroom-src/projects/mcp/build.gradle)). Mod code and crash logs therefore speak **SRG** (`func_12345_a`, `field_12345_a`, `p_12345_1_`).
- **Mod-dev artifacts:** the build publishes `userdev`, `universal`, `sources`, `installer` classifiers plus the MMC pack zip to `https://repo.cleanroommc.com/releases` under `com.cleanroommc:cleanroom` ([projects/cleanroom/build.gradle:1066-1089](cleanroom-src/projects/cleanroom/build.gradle)). **No Javadoc jar exists** — no `withJavadocJar()`/`javadocJar` anywhere; the sources jar is the only machine-consumable API reference.
- **The official mod template is external** (`github.com/CleanroomMC/CleanroomModTemplate`, [README.md:92](cleanroom-src/README.md)); this repo's `templates/` directory contains only the loader's own version-class template ([templates/CleanroomVersion.java](cleanroom-src/templates/CleanroomVersion.java)) — *not* a mod scaffold. The porting guide link in the README ([README.md:94](cleanroom-src/README.md)) currently 404s (verified live); the wiki's dev-guide section exists but that slug is stale.
- **Metadata is 1.12.2-era:** `mcmod.info`, not `mods.toml` (no `mods.toml` exists in the tree; reference examples at [src/main/resources/cleanmix.info](cleanroom-src/src/main/resources/cleanmix.info) and [src/test/resources/mcmod.info](cleanroom-src/src/test/resources/mcmod.info)).
- One assumption in the project brief is contradicted by source: **CFP is "Cleanroom Feature Proposal"** — community etiquette for proposals ([CFP_GUIDELINES.md:1-7](cleanroom-src/CFP_GUIDELINES.md)) — not a fork-patching process. The actual patching mechanism is ForgeGradle `genPatches`/`applyPatches` over VineFlower-decompiled vanilla ([README.md:82-88](cleanroom-src/README.md), [projects/cleanroom/build.gradle:109-235](cleanroom-src/projects/cleanroom/build.gradle)).

### 3.3 The mixin stack (a W1 first-class concern)

Mixin is **built in**, in two layers:

- **CleanMix** (`com.cleanroommc:cleanmix:0.4.6`, [gradle.properties:23](cleanroom-src/gradle.properties)) — self-described "Fork of Fabric Mixin that aims to target 1.12.2 environments" ([cleanmix.info](cleanroom-src/src/main/resources/cleanmix.info)). It keeps the `org.spongepowered.asm.*` package names so existing mixin mods work unchanged, registers via ServiceLoader ([META-INF/services](cleanroom-src/src/main/resources/META-INF/services)), and reports max compatibility level `JAVA_25` ([CleanMixService.java:42-43](cleanroom-src/src/main/java/com/cleanroommc/cleanmix/service/CleanMixService.java)). **MixinExtras is bundled** as an annotation processor (`mixinextras-common:0.5.4`, [projects/cleanroom/build.gradle:382](cleanroom-src/projects/cleanroom/build.gradle)).
- **MixinBooter API parity** — Cleanroom re-implements the de-facto 1.12.2 ecosystem API `zone.rong.mixinbooter` at MixinBooter 11.5 parity ([mixinbooter.info](cleanroom-src/src/main/resources/mixinbooter.info); CHANGELOG 0.6.0/0.6.1). Critically for guidance: **the legacy interfaces (`IEarlyMixinLoader`, `ILateMixinLoader`, `IMixinConfigHijacker`, `@MixinLoader`) are all `@Deprecated`**; the modern declaration path is JAR-manifest attributes **`MixinConfigs`** (comma-separated config list) and **`MixinConnector`** (an `IMixinConnector` implementation), read by the rewritten mod discoverer ([CleanroomModDiscoverer.java:62-63,128,278](cleanroom-src/src/main/java/com/cleanroommc/discovery/CleanroomModDiscoverer.java)). External `<jar>.meta` sidecar manifests let packs add these attributes to third-party jars without editing them ([CleanroomModDiscoverer.java:577-587](cleanroom-src/src/main/java/com/cleanroommc/discovery/CleanroomModDiscoverer.java)).
- Mixins written against SRG names still apply in production via a remapper chain (`Srg2McpRemapper` in dev, `FMLDeobfuscatingRemapper` wrapper in production — [CleanMixService.java:52-56](cleanroom-src/src/main/java/com/cleanroommc/cleanmix/service/CleanMixService.java)). Crash reports are annotated with which mixins touched each class (`CleanMixHooks.addMixinMetadataToCrashReport`).

### 3.4 API deltas and new namespaces (what `search_cleanroom_api` must cover)

- **`com.cleanroommc.*`** — new code: `discovery` (full mod-discovery rewrite), `hackery` (`EnumHackery.addEnumEntry`, reflection shims replacing `sun.reflect` idioms via `StackWalker`), `configanytime` (`ConfigAnytime.register`), `loader` (language-adapter registry, `UUIDFix`, standalone-Nashorn scripting), `client` (Catalogue-derived mod-list UI, per-platform IME incl. Wayland, Windows DWM theming), `boot`, `common` ([src/main/java/com/cleanroommc/](cleanroom-src/src/main/java/com/cleanroommc/) — 52 files).
- **`net.minecraftforge.*`** — the forked Forge API, 697 files shipped as source (not patches). Mostly the familiar 1.12.2 surface (events, capabilities, registries, `GameRegistry`, OreDict, fluids/energy), with additions like **`ForgeEarlyConfig`** ([net/minecraftforge/common/ForgeEarlyConfig.java](cleanroom-src/src/main/java/net/minecraftforge/common/ForgeEarlyConfig.java)): GLFW/OpenGL/window options, Windows theming, input handling, and the **coremod blacklist** that neutralizes jars Cleanroom has integrated (MixinBooter, ConfigAnytime, Forgelin, JEID, the relauncher…). Config file `forge_early.cfg`.
- **Event system rewritten**: listeners are built with `LambdaMetafactory`/`MethodHandle` instead of Forge's runtime-ASM `ASMEventHandler` subclass generation ([net/minecraftforge/fml/common/eventhandler/EventListenerFactory.java](cleanroom-src/src/main/java/net/minecraftforge/fml/common/eventhandler/EventListenerFactory.java)) — semantics preserved, internals different; tooling that reflected into generated handler classes breaks.
- **`zone.rong.mixinbooter`** (10 files) — the mixin developer API above.
- **Launch stack**: main class is `top.outlands.foundation.boot.Foundation` (LaunchWrapper replacement), with `com.cleanroommc.bouncepad.Bouncepad` in the MMC patch ([mmcpack-template/patches/net.minecraftforge.json](cleanroom-src/mmcpack-template/patches/net.minecraftforge.json)) — not `net.minecraft.launchwrapper.Launch`.

### 3.5 Bundled-library modernization (agents must target these versions, not stock-Forge's)

| Library | Stock Forge 1.12.2 | Cleanroom | Declared at |
|---|---|---|---|
| Java | 8 | **25+** | [projects/cleanroom/build.gradle:44-46](cleanroom-src/projects/cleanroom/build.gradle) |
| LWJGL | 2.9.4 | **3.4.1** (+ `lwjglx`/`lwjglxx` LWJGL2-compat shim, applied by `LWJGLTransformer` class-merging) | [gradle.properties:22](cleanroom-src/gradle.properties); [fml/common/asm/transformers/LWJGLTransformer.java](cleanroom-src/src/main/java/net/minecraftforge/fml/common/asm/transformers/LWJGLTransformer.java) |
| ASM | 5.0.3 | **9.10.1** (+ `asm-deprecated:7.1` re-added for old coremods) | [gradle.properties:19-20](cleanroom-src/gradle.properties) |
| Netty | 4.1.9 | **4.2.15.Final** | [gradle.properties:21](cleanroom-src/gradle.properties) |
| Guava | 21.0 | **33.6.0-jre** | [projects/cleanroom/build.gradle:311](cleanroom-src/projects/cleanroom/build.gradle) |
| Mixin | none (external MixinBooter) | **CleanMix 0.4.6 + MixinExtras 0.5.4, built in** | [gradle.properties:23](cleanroom-src/gradle.properties) |
| Log4j / Gson / fastutil | 2.8.1 / 2.8.0 / 7.1.0 | 2.26.0 / 2.14.0 / 8.5.18 | [projects/cleanroom/build.gradle:313-363](cleanroom-src/projects/cleanroom/build.gradle) |
| New additions | — | Foundation 0.19.8, lenni0451 Reflect 1.6.4, Javassist, JLine 4, OSHI 7.3.2+JNA, ICU4J 78.3, Jakarta EE/JAXB, Nashorn 15.7, HttpClient 4+5, ClassGraph, JOML | [projects/cleanroom/build.gradle:285-379](cleanroom-src/projects/cleanroom/build.gradle) |

Scala 3 / Kotlin 2 mod development is supported via the companion ecosystem (Scalar provides Scala; Forgelin-Continuous for Kotlin — [README.md:29-30](cleanroom-src/README.md)).

### 3.6 Vanilla patch surface (where Cleanroom's behavior diverges most)

540 unified-diff patches, all against decompiled MCP-named vanilla under `patches/minecraft/net/minecraft/` (Forge/FML itself ships as source, not patches). Hotspots: `client` 138 (renderer 60, gui 35), `world` 97 (gen 42, storage 18), `entity` 77, `block` 75 (single largest patch: `Block.java.patch`, 68 KB), `item` 44, `network` 15. This distribution tells the assistant where Cleanroom-vs-vanilla behavior differences concentrate: rendering (LWJGL3 adaptation) and worldgen.

### 3.7 Ecosystem and distribution facts an assistant must know

- Packs need companion mods: **Fugue** (compat patches for incompatible mods) and **Scalar** (Scala provider) — warned at startup if absent ([README.md:37-38](cleanroom-src/README.md); `PatchModPresentChecker`).
- Officially supported install path is MultiMC-family launchers via the MMC pack; other launchers use the **Cleanroom Relauncher** ([README.md:32-36](cleanroom-src/README.md)).
- Cross-compat rule of thumb: Cleanroom-only mods are ignored by Forge and vice versa (MixinBooter/ConfigAnytime jars are no-ops under Cleanroom) ([README.md:61-65](cleanroom-src/README.md)).
- Documentation lives at `cleanroommc.com/wiki` — a **VitePress** site (same engine family as Fabric/NeoForge docs) with **no sitemap.xml** (verified live: 404, no `Sitemap:` in robots.txt), on the order of dozens of pages, some stale. CleanroomMC also maintains ModularUI, GroovyScript, and related ecosystem projects whose docs are natural additions to the target corpus.

---

## 4. Gap analysis and disposition table

Dispositions: **Keep** (as-is), **Modify** (changed behavior/data), **Reframe** (retained, repositioned as porting/backporting reference), **Remove** (serves none of the three workflows). Consistent with "orientation, not exclusion," almost nothing is removed wholesale — removals are limited to dead code.

### 4.1 Agent-visible tools

| Current capability | Disposition | Rationale (vs. workflow priorities) |
|---|---|---|
| `search_fabric_docs` | **Modify + rename → `search_docs`** | The engine is loader-generic already; the name and defaults are wrong. Gains a `scope` param (`target` \| `reference` \| `all`, default `target` = cleanroom+forge+shared @ 1.12.2); publishes the currently-hidden `loader`/`minecraft_version`/`include_code`/`limit` params ([index.ts:199-208](src/index.ts:199)); reference-scope results carry an explicit "porting reference — verify the Cleanroom equivalent via `find_equivalent`" banner. Serves W1 (target scope) and W2/W3 (reference scope). |
| `get_example` → `get_doc_snippet` | **Modify** | Same engine; loader enum comes from the new registry, defaults to target scope / 1.12.2. Renamed in 2.2.0 (red-team finding N1) because agents confused it with `search_mod_examples`; the old name remains an unlisted dispatch alias until 3.0.0. |
| `explain_fabric_concept` | **Modify + rename → `explain_concept`** | Remove the hardcoded Fabric bias ([concept-service.ts:320,670](src/services/concept-service.ts:320)); add a `loader` param defaulting to `cleanroom`; extend `KNOWN_CONCEPTS` ([concept-service.ts:57-142](src/services/concept-service.ts:57)) with 1.12.2-era entries (capabilities, SRG names, coremods, `mcmod.info`, `CreativeTabs`, OreDict, CleanMix/MixinBooter, `@ObjectHolder`); when a concept matches the equivalence corpus (§5.4), embed the cross-loader comparison. |
| `get_minecraft_version` | **Modify + rename → `list_targets`** | Becomes the agent's orientation call: the loader/version matrix, which roles they play (target vs reference), and which optional DBs are installed. |
| `search_mappings`, `get_class_details`, `get_method_signature`, `browse_package`, `list_mapping_versions` | **Modify** | Names kept. Default version becomes 1.12.2; output gains SRG columns; modern versions remain queryable as backport reference (W3). Requires the schema change in §5.5. |
| `lookup_obfuscated` | **Modify + rename → `resolve_symbol`** | Today it advertises SRG examples it cannot resolve ([mappings.ts:97](src/tools/mappings.ts:97)). Replacement auto-detects the name kind by pattern (`func_/field_/p_…` → SRG; short token → notch; else readable) and returns all layers. This is the crash-log workhorse for W1. |
| `search_mod_examples`, `get_mod_example`, `list_canonical_mods`, `list_mod_categories`, `get_mod_patterns` | **Keep tools, rebuild corpus** | Schema and tools are loader-agnostic (loader is a data value — [mod-examples-service.ts:148-175](src/services/mod-examples-service.ts:148)). The corpus (1 mod / 3 examples) and the unrecoverable pipeline are replaced per §5.6 and §6. Category enum gets 1.12.2-appropriate edits (drop `data-generation` as a category of *examples to emulate* — datagen doesn't exist in 1.12.2 — add `capabilities` and `coremods-mixins`). |

### 4.2 Infrastructure

| Capability | Disposition | Rationale |
|---|---|---|
| Crawler/chunker/embeddings/store backbone ([crawler.ts](src/indexer/crawler.ts), [chunker.ts](src/indexer/chunker.ts), [embeddings.ts](src/indexer/embeddings.ts), [store.ts](src/indexer/store.ts)) | **Keep** | Verified source-agnostic; the VitePress selector-stripping ([crawler.ts:26-92](src/indexer/crawler.ts:26)) directly covers cleanroommc.com. |
| `SitemapParser` + Fabric/NeoForge sitemap fetchers ([sitemap.ts](src/indexer/sitemap.ts)) | **Reframe** | Kept to refresh the *reference* corpus; joined by new target-corpus discovery (§6.1). Default-version fallback `'1.21.10'` ([sitemap.ts:345](src/indexer/sitemap.ts:345)) becomes per-loader. |
| `detectLoader` + the 3-value loader union (~10 sites, §2.2) | **Modify** | Replaced by the loader registry (§5.2) — the single highest-leverage structural change. |
| Incremental `DocumentUpdater` ([updater.ts](src/indexer/updater.ts)) | **Modify** | Currently Fabric-only; generalized to iterate registry sources or folded into the weekly full re-index. |
| Parchment/Mojang mappings pipeline ([index-mappings.ts](scripts/index-mappings.ts)) | **Reframe + extend** | Modern data kept as W3 reference; gains the MCP/SRG era branch (§5.5). |
| `DbVersioning`, `data-dir`, `manage` CLI, postinstall | **Modify** | Mechanism kept; conventions repaired (Phase 0, §8): one release-tag scheme, dead URL templates deleted, auto-update generalized beyond docs-only, stale test fixed, repo slug moved off hardcoded `OGMatrix/mcmodding-mcp` ([db-versioning.ts:31-34](src/db-versioning.ts:31), [manage.ts:701](src/cli/manage.ts:701), [postinstall.js:42](scripts/postinstall.js)). |
| CI: weekly re-index, release workflow | **Modify** | Retargeted to the new corpus set + fixed asset uploads; publishing under the rebranded npm identity. |
| Disabled `semantic-release.yml`; dead `mappings:analyze` script reference; stale manifest URL templates; `manage.test.ts` local-copy assertions | **Remove** | Dead code serving no workflow. |
| Fabric/NeoForge/modern-MC indexed content itself | **Reframe** | The heart of "orientation, not exclusion": retained verbatim as the reference corpus powering W2/W3. |

---

## 5. New capabilities

### 5.1 A design premise: two target corpora, not one

"Cleanroom knowledge" is really two bodies of knowledge, and the data model must distinguish them:

- **`forge`** — classic Forge-1.12.2 knowledge: ~99% of the API surface an agent uses (`GameRegistry`, `@SubscribeEvent`, capabilities, `mcmod.info`, SRG names), documented by the mcforge 1.12.x docs, old tutorials, and most example mods.
- **`cleanroom`** — the delta: Java 25, CleanMix/MixinBooter, Foundation, `ForgeEarlyConfig`, manifest-attribute mixin declaration, LWJGL3 quirks, the library-version table in §3.5 — documented only by the Cleanroom wiki and Cleanroom's own sources.

Both are *target* corpora; conflating them under one loader value would either exclude the Forge corpus or mislabel it. Agents ask questions across both constantly ("how do I register an item" is `forge`; "which Java do I target and how do I declare mixins" is `cleanroom`).

### 5.2 Loader registry (replaces the string union)

A single module `src/loaders.ts`:

```ts
type Loader = 'cleanroom' | 'forge' | 'fabric' | 'neoforge' | 'shared';
interface LoaderInfo {
  id: Loader;
  role: 'target' | 'reference' | 'neutral';
  defaultVersion: string;      // cleanroom/forge → '1.12.2'
  docHosts: string[];          // drives detectLoader()
  displayName: string;
}
const TARGET_FAMILY: Loader[] = ['cleanroom', 'forge', 'shared'];
```

All ~10 duplication sites (§2.2) import from it. `IndexStats.loaders` becomes a dynamic `Record<string, number>` so unknown values are never silently dropped ([store.ts:402-405](src/indexer/store.ts:402)). "Latest version" becomes family-scoped: within the target family it is always `1.12.2`; within reference it is computed as today. The `scope` parameter on search tools expands to loader sets via `TARGET_FAMILY`.

### 5.3 W1 — from-scratch development

- **`get_project_template(component)`** — serves vendored, annotated snapshots of the official `CleanroomModTemplate` files plus curated companions: `build.gradle` (Outlands ForgeGradle 6.0.57 coordinates, repo.cleanroommc.com, Java-25 toolchain), `gradle.properties`, `mcmod.info`, mixin config + the manifest `MixinConfigs`/`MixinConnector` wiring, main mod class, and a workspace checklist. Templates are refreshed from the upstream template repo by the weekly job and pinned to a Cleanroom version.
- **`search_cleanroom_api(query, package_filter?, kind?, limit?)`** — full-text + structured search over a new **`cleanroom-api.db`**: every class/interface/annotation/method/field in `com.cleanroommc.*`, `zone.rong.mixinbooter.*`, and `net.minecraftforge.*` (the 697-file forked Forge API is most of the value), with signatures, modifiers, deprecation (`@deprecated`/`@since`), and attached Javadoc comments. Two derived catalogs make the dominant idioms first-class: an **events catalog** (transitive subclasses of `…eventhandler.Event`) and an **annotations catalog** (`@Mod`, `@SubscribeEvent`, `@ObjectHolder`, `@CapabilityInject`, `@Config`, …). Vanilla `net.minecraft.*` symbols stay in the mappings DB — the API DB covers the *framework*.
- **`get_api_class(name, include_members?)`** — single-type drill-down companion to `search_cleanroom_api`: declaration, Javadoc, deprecation, members with signatures (truncated with an overflow note), nested types, superclass chain (with external terminator), and known subclasses (capped, with the total).
- **MCP resources, finally used** ([index.ts:323-333](src/index.ts:323) currently returns nothing): `cleanroom://template/{build.gradle,mcmod.info,mixins.json,…}` mirroring `get_project_template`, and `cleanroom://guide/{porting-from-fabric,porting-from-neoforge,backporting,mixin-setup}` — curated markdown checklists. Resources are the right channel for whole-file artifacts an agent embeds verbatim; every resource keeps a tool-shaped twin because client support for resources is uneven.
- **MCP prompts**: `scaffold_cleanroom_mod(mod_id, …)`, `port_mod_to_cleanroom(source_loader)`, `backport_feature(source_version)` — parameterized workflow openers that pre-load the relevant checklist and tool plan.

### 5.4 W2 — cross-loader porting

Verified: no cross-loader equivalence data exists anywhere in the codebase, and the porting *target* side (`forge`/`cleanroom`) doesn't even exist as a loader value. This layer is therefore **hand-curated data, embraced as such** — automatic derivation of API equivalence is not realistic, and curation is reviewable.

- Source of truth: **in-repo YAML files** (`data/equivalence/*.yaml`, one per topic), compiled into the docs DB at index time. Entry shape: `topic`, `from {loader, api, versions}`, `to {loader, api}`, `kind: direct | analog | pattern-change | missing`, markdown `notes`, `code_before`/`code_after`, `caveats[]`, `related[]` links (wiki pages, `api://` symbols).
- Seed corpus (~150 entries) covering: **registration** (Fabric `Registry.register` / Neo `DeferredRegister` → `RegistryEvent.Register` + `@ObjectHolder`/`GameRegistry`), **events** (Fabric callbacks / Neo bus → `@SubscribeEvent` + `@Mod.EventHandler` lifecycle), **networking** (payloads/`ServerPlayNetworking` → `SimpleNetworkWrapper`/`IMessage`), **mixins & access wideners** (`fabric.mod.json` mixins + AW → manifest `MixinConfigs` + `_at.cfg` access transformers; MixinExtras available on both sides), **capabilities/attachments** (→ `Capability`/`ICapabilityProvider`), **item/block settings** (`Item.Properties`/`AbstractBlock.Settings` → constructors + setters, `Material`, `CreativeTabs`), **resources/datagen** (`kind: missing` — hand-write JSON in 1.12.2), plus backport rows with `from: modern-minecraft` (Codec → hand-rolled NBT, DataComponents → ItemStack NBT, BER → TESR, `Component` → `ITextComponent`).
- Exposed via **`find_equivalent(query, from: 'fabric' | 'neoforge' | 'modern-minecraft', topic?)`**; consumed by `explain_concept` (difference banners) and the porting prompts (checklists render the topic list). Honesty is a feature: `kind: missing` answers "there is no equivalent; here is the 1.12.2 idiom instead."

### 5.5 W3 — backports: three-layer mappings + best-effort symbol translation

**Schema.** One `mappings.db` (renamed from `parchment-mappings.db`), two eras distinguished by a `mapping_set` column:

```sql
classes(id, name, package_name, notch_name, javadoc, minecraft_version, mapping_set)
methods(id, class_id, name, srg_name, notch_name, descriptor, javadoc)
fields (id, class_id, name, srg_name, notch_name, descriptor, javadoc)
parameters(id, method_id, param_index, srg_token, name, javadoc)
```

`obfuscated_name` is renamed to `notch_name` (that is what it actually holds — [index-mappings.ts:619-693](scripts/index-mappings.ts:619)); `srg_name` is NULL for modern rows; classes get no `srg_name` (1.12.2 SRG does not rename classes); parameters key on the SRG token (`p_78443_1_`). An index on `srg_name` makes `resolve_symbol` fast.

**1.12.2 pipeline.** A new era branch in the indexer ingests exactly what Cleanroom pins, so the server's names match the agent's dev environment: `de.oceanlabs.mcp:mcp_config:1.12.2-20260220.202731@zip` (`joined.tsrg`, notch→SRG) from `maven.outlands.top/releases` with `maven.minecraftforge.net` as fallback, and `de.oceanlabs.mcp:mcp_stable:39-1.12@zip` (`fields.csv`/`methods.csv`/`params.csv`, SRG→readable) resolved the way ForgeGradle does ([cleanroom-src/gradle.properties:7-10](cleanroom-src/gradle.properties), [projects/mcp/build.gradle:13-15](cleanroom-src/projects/mcp/build.gradle)). Note: `cleanroom-src`'s own `forge.srg`/`forge.exc` are tiny Forge-injected extras, not the mapping source. Modern versions keep the existing Parchment+Mojang path unchanged, coexisting in the same DB.

**Cross-version translation (`translate_symbol`, stretch).** Verified: no correspondence data exists and the schema cannot express symbol identity across versions. But full "conceptual guidance only" is too pessimistic — there is a real pivot: **Forge SRG IDs are stable 1.12.2→1.16.5**, and 1.16.5 has both MCPConfig TSRG (obf→SRG) and Mojang ProGuard mappings (obf→Mojang, published since 1.14.4). Joining on obfuscated name+descriptor at 1.16.5 yields SRG⇄Mojang pairs; SRG-ID equality joins down to 1.12.2; Mojang-name equality (plus a small curated class-rename table for the 1.17 repackaging: `World`→`Level`, `TileEntity`→`BlockEntity`, `EntityPlayer`→`Player`, …) joins up to modern versions. Result: a `correspondence(modern_version, modern_symbol, srg_name, v1122_name, confidence, method)` table with tiers `exact`/`fuzzy`/`none`. Symbols that didn't survive the journey get `none` and fall back to `find_equivalent` conceptual guidance — the tool must say so honestly rather than guess. This ships last (§8, Phase 6); everything else works without it.

### 5.6 Examples rebuild (per maintainer decision)

A new, **fully in-repo** pipeline replacing the unrecoverable one: committed prompts, a pluggable OpenAI-compatible LLM endpoint (no hard LM Studio dependency), the reconstructed schema (fully derivable from [mod-examples-service.ts](src/services/mod-examples-service.ts)), a golden-output test set so analysis is reproducible, and SRG-awareness (snippets containing `func_`/`field_` names get cross-links to `resolve_symbol`). Candidate roster, prioritizing license clarity and idiomatic coverage: **MinecraftByExample 1.12.2 branch (MIT)** first — a purpose-built teaching corpus; **CleanroomMC's own ModularUI, GroovyScript, Fugue** — canonical Cleanroom-native code including real MixinBooter usage; **GregTech CE Unofficial (LGPL)** — the flagship 1.12.2-ecosystem mod; **Applied Energistics 2 rv6 (LGPL)** and **Tinkers' Construct 1.12 (MIT)** — capabilities, TESRs, networking; mixin-heavy compat mods (UniversalTweaks-class) for real-world mixin patterns. Final roster selection is an implementation-time task with license review per repo.

---

## 6. Data strategy

### 6.1 Sources per database

| DB | Content | Source | Discovery/refresh |
|---|---|---|---|
| `docs.db` (target scope) | Cleanroom wiki | `cleanroommc.com/wiki` — VitePress, **no sitemap** (verified) | **Primary:** ingest markdown directly from the site's source repo (`CleanroomMC/Website`) — raw fidelity, git-diff change detection, clear provenance. **Fallback:** same-origin BFS link crawl seeded at `/wiki/`, plus probing VitePress's emitted `hashmap.json` route manifest. Extraction reuses the existing VitePress selectors ([crawler.ts:26-92](src/indexer/crawler.ts:26)). |
| `docs.db` (target scope) | Forge 1.12.x docs | mcforge ReadTheDocs 1.12.x archive (`docs.minecraftforge.net/en/1.12.x/`) | RTD serves per-version sitemaps → the existing sitemap-first path works with one new entry; generic `h1–h6` extraction covers Sphinx/MkDocs. |
| `docs.db` (target scope) | Ecosystem docs | ModularUI / GroovyScript wikis (CleanroomMC org), selected 1.12.2 tutorials (e.g. McJty's 1.12 series) — license permitting | Per-source; skip forum scraping entirely (noise). |
| `docs.db` (reference scope) | Fabric/NeoForge docs + Fabric wiki | unchanged ([sitemap.ts:208-292](src/indexer/sitemap.ts:208)) | Existing weekly pipeline. |
| `mappings.db` | 1.12.2 MCP/SRG + modern Parchment/Mojang | maven.outlands.top / maven.minecraftforge.net; maven.parchmentmc.org; piston-meta.mojang.com | §5.5; weekly CI. |
| `cleanroom-api.db` | Cleanroom/Forge-fork API symbols | **Published `com.cleanroommc:cleanroom:<tag>:sources` jar from repo.cleanroommc.com** | New `scripts/index-java-api.ts` using **tree-sitter-java** (robust Java 8–25 parsing, no JVM in the TS toolchain): packages/types/members/modifiers/inheritance + Javadoc blocks → symbols table + FTS + events/annotations catalogs. Re-run on new Cleanroom tags. |
| `examples.db` | Curated 1.12.2 mod examples | GitHub repos per the §5.6 roster | New in-repo pipeline; manual roster review. |
| equivalence corpus | Cross-loader/version translations | Hand-curated YAML in this repo | PR review; compiled at index time. |

### 6.2 Delivery

Per the maintainer decision: **prebuilt DBs**, built in CI and attached to this fork's GitHub Releases, with postinstall + startup auto-update — the existing model, after the Phase 0 repairs (§8). All repo-slug references currently hardcode upstream `OGMatrix/mcmodding-mcp` ([db-versioning.ts:31-34](src/db-versioning.ts:31), [manage.ts:701](src/cli/manage.ts:701), [postinstall.js:42](scripts/postinstall.js)) and must move to the rebranded fork's slug (configurable via the existing `GITHUB_REPO_URL` override pattern).

**Licensing, stated plainly rather than papered over:**

- *Cleanroom API DB* — metadata derived from LGPL-2.1 sources; redistributable with attribution/notice. Lowest risk.
- *mcforge RTD docs* — Forge documentation repo (MIT-licensed docs); verify per-source at implementation time.
- *Cleanroom wiki content* — **no license is published in-repo or on the site that we could find.** Action item (Phase 0): ask CleanroomMC for explicit blessing; they benefit directly, and the CleanroomMC-adjacent examples roster wants the same conversation.
- *MCP mapping CSVs* (`mcp_stable:39-1.12`) — **redistribution rights are genuinely unresolved** (nothing in `cleanroom-src` or upstream grants them; historically MCP data carried restrictive terms). Mitigations: the data is publicly served from the Forge/Outlands mavens and Cleanroom itself redistributes a rebuilt MCP snapshot — strong precedent; and the era-branch indexer ships inside the npm package so **on-device generation** (`manage` → "Build 1.12.2 mappings locally, ~1 min") is a first-class fallback that removes redistribution entirely if review fails. See Open Question 2.

### 6.3 How `cleanroom-src/` is used

**As human reference only — never as a build input.** The pipelines consume Cleanroom's *published* artifacts (sources jar, mavens, wiki/site repo) rather than the local checkout, because: (a) published artifacts are versioned and reproducible — the local checkout is whatever was last pulled; (b) it keeps this repo hermetic — no code path may reference a gitignored directory that CI and other contributors don't have; (c) the sources jar is exactly what modders compile against. The tradeoff (an extra download in the maintainer pipeline) is trivial. Runtime indexing on user machines was rejected for the API DB: it would put a Java parser and a multi-MB download in every user's startup path for data that changes only when Cleanroom tags a release; build-time extraction into a distributed DB wins on startup cost, determinism (content-hash manifests), and simplicity. Staleness against Cleanroom's alpha cadence is handled by the weekly CI job re-indexing on new tags.

---

## 7. Architecture changes

### 7.1 Internal model

The pervasive structural change is **privileging by default, not by exclusion**:

- The loader registry (§5.2) makes `cleanroom`+`forge` the `target` family and `fabric`/`neoforge` `reference`; every tool default resolves to the target family at 1.12.2.
- Per-loader default versions kill the modern-version fallbacks ([sitemap.ts:345](src/indexer/sitemap.ts:345), [example-service.ts:168-188](src/services/example-service.ts:168)); the crawler passes its detected loader so 1.12.2-era pages label correctly.
- The `scope` parameter is the agent-facing projection of loader roles: `target` for building, `reference` for translating, `all` for comparative work. Reference-scope output is visually marked as porting material.
- One docs DB continues to hold all loaders (the schema's `loader` column is already free TEXT — [store.ts:47-59](src/indexer/store.ts:47)); privileging is a query/default concern, not a storage split. New knowledge kinds get their own DBs (`cleanroom-api.db`) following the existing optional-DB pattern.
- The category taxonomy is unified into one registry-adjacent module, ending the current triplication (§2.2).

### 7.2 Agent interaction flows

**W1 — from scratch:** `list_targets` (orient: Cleanroom 0.6.x, Java 25, DBs installed) → `get_project_template` / `cleanroom://template/*` (scaffold on FG-6.0.57-fork + Java 25 + `mcmod.info` + manifest-attribute mixins) → iterate with `search_docs` (target scope), `search_cleanroom_api` (events/annotations/framework symbols), `search_mappings`/`resolve_symbol` (vanilla internals, SRG in code and crash logs), `search_mod_examples` (idiomatic 1.12.2 patterns).

**W2 — port:** agent reads the source mod → `search_docs(scope: reference)` / `explain_concept(loader: fabric)` to understand source-side constructs → `find_equivalent` per construct (registration, events, networking, mixins…) → target-side flow as W1. The `port_mod_to_cleanroom` prompt front-loads the checklist of topics to sweep.

**W3 — backport:** as W2 with `from: modern-minecraft` equivalences (Codec→NBT, BER→TESR, …) plus `search_mappings(minecraft_version: <modern>)` to understand the source symbols and — once Phase 6 lands — `translate_symbol` for name-level mapping with honest `none` fallbacks.

---

## 8. Implementation plan

Each phase leaves the server building, testing, and shipping. Phase 0 is blocking for everything that distributes a new DB.

**Phase 0 — Repair distribution + groundwork (blocking).**
Adopt one convention: *all DB assets on the main `v{version}` release* (what CI already does — [release.yml:154-181](.github/workflows/release.yml)); delete the dead `mappings-v`/`examples-v` URL templates ([generate-mappings-manifest.ts:23-24](scripts/generate-mappings-manifest.ts:23), [generate-mod-examples-manifest.ts:23-24](scripts/generate-mod-examples-manifest.ts:23)); make `manage.test.ts` import the real `AVAILABLE_DBS`; generalize startup auto-update from docs-only ([db-versioning.ts:28-30](src/db-versioning.ts:28)) to all installed DBs; move repo slugs to the fork; execute the rebrand (package name, server name, README). In parallel: contact CleanroomMC (wiki blessing + roster licensing), record the MCP-data licensing decision. *Risk if skipped: every new DB silently fails to install — the current mod-examples DB already does.*

**Phase 1 — Loader registry + corpus retargeting.**
`src/loaders.ts`; migrate the ~10 union sites; per-loader defaults; tool renames + `scope` semantics + published-schema fixes; ingest the Cleanroom wiki (repo-markdown primary, BFS fallback) and mcforge 1.12.x RTD; generalize or retire the Fabric-only updater. *Exit: the server answers Cleanroom/Forge-1.12.2 prose questions; Fabric/NeoForge reframed as reference.*

**Phase 2 — 1.12.2 mappings.**
Schema migration (`notch_name`, `srg_name`, `mapping_set`, `srg_token`); MCP era branch in the indexer; `resolve_symbol`; on-device generation path in `manage`. *Exit: crash-log and decompiled-code workflows function. Risk: Outlands maven availability — add a CI mirror-check and the Forge-maven fallback.*

**Phase 3 — Cleanroom API DB.**
tree-sitter indexer over the pinned sources jar; `search_cleanroom_api` + `get_api_class`; events/annotations catalogs. Depends only on Phase 0. *Risk: parser edge cases on modern Java syntax — mitigated by tree-sitter's error tolerance and a symbol-count regression test.*

**Phase 4 — Porting layer.**
Equivalence YAML corpus (~150 seed entries) + `find_equivalent`; MCP resources + prompts; template vendoring from `CleanroomModTemplate`. Pure data plus thin tools — low risk, highest leverage for W2/W3.

**Phase 5 — Examples rebuild.**
In-repo pipeline (committed prompts, pluggable endpoint, golden tests); roster ingestion with per-repo license review; CI finally uploads the examples asset.

**Phase 6 (stretch) — Cross-version correspondence.**
The 1.16.5-pivot table + `translate_symbol`. Riskiest data engineering (join quality, the 1.17 repackaging table); everything earlier works without it.

**Cross-cutting risks:** Cleanroom is alpha — pin all indexed data to Cleanroom tags and refresh weekly; the wiki is thin and partly stale, so the mcforge RTD corpus and API DB must carry more weight than the wiki; LLM-dependent example analysis must never again be unrecoverable (prompts and goldens committed); licensing items tracked as explicit gates, not assumptions.

---

## 9. Open questions

1. **Final name.** Recommendation: **`cleanroom-mcp`** (npm + server name). Short, findable, states the mission. Needs an npm availability check.
2. **MCP CSV redistribution.** Ship prebuilt `mappings.db` (per your delivery decision) after a good-faith license review, with the on-device generation path implemented in the same phase as insurance? **Recommendation: yes** — precedent is strong (public mavens; Cleanroom redistributes a rebuilt MCP snapshot), and the fallback fully de-risks a negative review.
3. **Keep the Fabric *wiki* corpus (DokuWiki, 226+ pages) alongside the official Fabric docs?** It is the noisiest source and serves only W2. **Recommendation: keep** — tutorials there cover concepts the official docs skip, and porting agents benefit; revisit if search quality suffers.
4. **Embedding model.** `Xenova/all-MiniLM-L6-v2` is dated but cheap and already wired ([embeddings.ts:34](src/indexer/embeddings.ts:34)). **Recommendation: keep for now**; a model swap forces full re-embedding of ~185K chunks and is orthogonal to the reorientation.
5. **Cleanroom version-pinning policy for the API DB and templates.** **Recommendation: track the latest *tagged* release (currently 0.6.x alphas), refreshed by the weekly job** — matching what mod devs actually build against; never track main.
6. **`net.minecraft` coverage in the API DB.** The design scopes the API DB to framework namespaces and leaves vanilla symbols to the mappings DB. If agents turn out to need patched-vanilla *bodies* (e.g., to see Forge hook points), a later addition could index Cleanroom's patched `net.minecraft` sources too. **Recommendation: defer** until real usage shows the need.

---

## Appendix A — Fine-grained findings from the source investigation

The investigation behind this document surfaced many details that are too fine for the body but likely to matter during implementation — subtle behaviors, exact limits, latent bugs, and Cleanroom quirks an implementer would otherwise rediscover the hard way. They are preserved here. This appendix deliberately **excludes** everything the body already covers (the loader union, distribution faults, mapping-scheme facts, etc.); every item below is additive.

### A.1 Tool behavior: limits, defaults, and guards

- Result caps vary per tool and are enforced in handlers, not schemas: `search_docs` clamps `limit` to 1–20 ([searchDocs.ts:57](src/tools/searchDocs.ts:57)); `get_doc_snippet` to 1–10 ([getExample.ts:46](src/tools/getExample.ts:46)); `search_mappings` to 1–50, default 15 ([mappings.ts:201](src/tools/mappings.ts:201)); `search_mod_examples` to 1–20 ([modExamples.ts:179](src/tools/modExamples.ts:179)). Output truncations: `get_class_details` lists at most 30 methods ([mappings.ts:313-342](src/tools/mappings.ts:313)); `browse_package` at most 50 classes per sub-package ([mappings.ts:637-649](src/tools/mappings.ts:637)); `search_mod_examples` truncates code to 500 chars and defers to `get_mod_example` for the rest.
- `explain_concept`'s handler rejects empty input and input over 100 characters ([explainConcept.ts:31-56](src/tools/explainConcept.ts:31)) — worth keeping in mind when concept names grow ("manifest MixinConfigs attribute" fits; a sentence does not).
- `get_mod_example.include_related` is treated as true unless explicitly `false` ([modExamples.ts:264](src/tools/modExamples.ts:264)); `min_quality` defaults to 0.5 in the handler ([modExamples.ts:177](src/tools/modExamples.ts:177)); "featured" is defined as quality ≥ 0.7 ([mod-examples-service.ts:451-457](src/services/mod-examples-service.ts:451)).
- `searchExamples` never filters by the `loader` or `minecraft_versions` columns even though the data carries them — only `mod`, `category`, `pattern_type`, `complexity`, `quality`, `featured`, `tags` are honored ([mod-examples-service.ts:237-338](src/services/mod-examples-service.ts:237)). When the 1.12.2 example corpus lands, loader/version filters must be *added*, not just populated.
- `DB_PATH` is honored only by the three docs services ([search-service.ts:118](src/services/search-service.ts:118), [concept-service.ts:154](src/services/concept-service.ts:154), [example-service.ts:77](src/services/example-service.ts:77)); `MappingsService` and `ModExamplesService` use the default data-dir path unconditionally. The mappings DB is opened read-only at runtime ([mappings-service.ts:518](src/services/mappings-service.ts:518)).
- Unknown tool names throw a bare `Error('Unknown tool: …')` ([index.ts:317-318](src/index.ts:317)) — no MCP error envelope.

### A.2 Search and ranking internals

- The docs search is a 4-strategy merge (chunks-FTS, documents-LIKE, sections, embeddings); semantic hits are kept only when cosine-similarity × 100 > 50, and only the best chunk per document survives ([search-service.ts:228-294](src/services/search-service.ts:228)).
- Version handling is heuristic: a regex `VERSION_PATTERN` extracts versions *from the query text itself* ([search-service.ts:111,299-302](src/services/search-service.ts:111)); two-part versions expand to a `LIKE '1.21%'` filter ([search-service.ts:216-223](src/services/search-service.ts:216)); results get +50/+30/+10 boosts for exact/minor/major version match and are deduplicated by URL-path-minus-version, keeping the best-matching version ([search-service.ts:307-401](src/services/search-service.ts:307)). `1.12.2` already matches the pattern (`1\.(?:2[0-9]|1[0-9]|[0-9])`), so query-side detection works for the new target unchanged.
- Relevance scoring weights ([search-utils.ts:304-413](src/services/search-utils.ts:304)): exact phrase in title +100 / heading +80 / caption +70; per-token title +20, heading +18, caption +15, URL +12, category +10, content +5; code-pattern match +25; synonym match +8; and `COMMON_TERMS` (fabric, neoforge, minecraft, mod…) are down-weighted ×0.1 ([search-utils.ts:51-63](src/services/search-utils.ts:51)) — `cleanroom` and `forge` must join that list or they will dominate scores.
- `MINECRAFT_SYNONYMS` ([search-utils.ts:68-119](src/services/search-utils.ts:68)) already maps `blockentity` ↔ `tile-entity`, which is exactly the 1.12.2↔modern vocabulary bridge the reoriented corpus needs — extend it (e.g. `itemstack meta`/`damage value`, `capability`/`attachment`) rather than building a new mechanism. FTS queries are built as a phrase attempt plus AND for ≤3 terms, else OR ([search-utils.ts:212-250](src/services/search-utils.ts:212)).
- `ConceptService` runs batch semantic search over embeddings in batches of 500, keeping top-30 by cosine ([concept-service.ts:273-391](src/services/concept-service.ts:273)); its hardcoded `conceptPatterns` Java-token hints are Fabric API names (`FabricItemSettings`, `ServerPlayNetworking` — [concept-service.ts:550-571](src/services/concept-service.ts:550)) and need 1.12.2 counterparts (`GameRegistry`, `SimpleNetworkWrapper`, `ICapabilityProvider`, …).
- **The mappings service never uses its FTS5 tables.** The indexer builds `classes_fts`/`methods_fts`/`fields_fts` with sync triggers ([index-mappings.ts:277-323](scripts/index-mappings.ts:277)), but runtime search generates wide `LIKE` pattern sets — including single-character deletion/insertion fuzzy variants — then re-ranks in JS with Levenshtein-based scoring, keeping score > 10 ([mappings-service.ts:613-723,736-796](src/services/mappings-service.ts:613)). Query tokenization splits CamelCase/snake/kebab and expands abbreviations via an `ABBREVIATION_MAP` ([mappings-service.ts:24-86,110-236](src/services/mappings-service.ts:24)). Any schema work should either wire the FTS tables in or stop building them.
- `findSimilarChunks` is an **in-memory full scan** of the entire embeddings table with per-row cosine computation ([store.ts:934-1011](src/indexer/store.ts:934)) — ~185K vectors today. Adding large new corpora multiplies per-query cost linearly; an ANN index or pre-filtering by loader scope is the escape hatch if latency degrades.

### A.3 Crawler, chunker, and store specifics

- Crawler politeness settings: concurrency 3, 1000 ms delay, 3 retries, UA `mcmodding-mcp-indexer/0.1.0` ([crawler.ts:165-174](src/indexer/crawler.ts:165)). It strips ~60 UI selectors (VitePress `.VP*`, DokuWiki chrome — [crawler.ts:26-92](src/indexer/crawler.ts:26)) and supports exactly two DOM shapes: standard `h1–h6` sectioning and DokuWiki `sectionedit`/`level` structure ([crawler.ts:404-471](src/indexer/crawler.ts:404)). Change detection uses a 16-char truncated SHA-256 of content ([crawler.ts:717-719](src/indexer/crawler.ts:717)).
- Static fallback URL lists exist and fire only when a sitemap fetch fails or returns zero: ~40 hardcoded Fabric doc URLs ([crawler.ts:773-834](src/indexer/crawler.ts:773)) and ~16 Fabric-wiki URLs ([sitemap.ts:297-317](src/indexer/sitemap.ts:297)). The Cleanroom BFS-crawl fallback (§6.1) should follow this same seed-list pattern.
- Chunker parameters: max 1000 chars, 100 overlap, min 50 ([chunker.ts:31-39](src/indexer/chunker.ts:31)); a `title` chunk is always emitted, a `full` chunk only when a document has no sections.
- The embeddings `dimension` column is written from `embedding.length` — 384 is *not* hardcoded ([store.ts:446-447](src/indexer/store.ts:446)), so a future model swap needs no schema change (but does need full re-embedding; mixed-dimension rows would silently break cosine math).
- The README's documented schema is a simplified subset: it omits the `metadata`, `sections`, and `code_blocks` tables, all 7 indexes, and all 5 FTS-sync triggers ([README.md:414-452](README.md) vs [store.ts:38-158](src/indexer/store.ts:38)). Store metadata keys: `schema_version` (=1), `index_version` (`'0.1.0'`), `last_updated` ([store.ts:167-172](src/indexer/store.ts:167)).
- The three category enums actually differ in content, not just duplication: the search tool has 8 values (incl. `all`), `get_doc_snippet` has 9 (adds `commands`, `sounds`), `getAvailableCategories()` has 11 (adds `events`, `mixins`) ([index.ts:71-80](src/index.ts:71), [index.ts:116-126](src/index.ts:116), [searchDocs.ts:197-211](src/tools/searchDocs.ts:197)).

### A.4 Distribution and CI subtleties

- `release.yml` **does not re-index docs on release** — it downloads the *previous* release's `mcmodding-docs.db`, regenerates its manifest, and hard-fails CI if the sha256 mismatches ([release.yml:110-149](.github/workflows/release.yml)); mappings, by contrast, *are* freshly re-indexed on every release ([release.yml:88-98](.github/workflows/release.yml)). Fresh docs come only from the weekly job.
- `update-docs-weekly.yml` uploads assets to the **latest existing release** with `--clobber` ([update-docs-weekly.yml:112-121](.github/workflows/update-docs-weekly.yml)) — so a release's DB assets mutate after publication. Its summary text claims results are "committed to dev branch," but no `git commit`/`push` step exists ([update-docs-weekly.yml:136](.github/workflows/update-docs-weekly.yml)).
- `release.yml`'s `sync-to-dev` job opens a `prod → dev` PR that carries the DBs through **Git LFS** ([release.yml:206-254](.github/workflows/release.yml)) — LFS bandwidth/quota is a real operational dependency of the release flow.
- `DbVersioning` writes a `db-download-failed.json` marker after a hash-mismatched download so a broken release isn't re-fetched in a loop, cleared on the next success ([db-versioning.ts:184-196,238-272](src/db-versioning.ts:184)); it also backs up the old DB to `<db>.backup` before replacing ([db-versioning.ts:217-221](src/db-versioning.ts:217)). Auto-update targets the *default* path even when `DB_PATH` is set — the README's claim that `DB_PATH` enables manual update management ([README.md:488-493](README.md)) is wrong.
- `postinstall.js` selects the first release having **both** the DB and manifest assets, honors `GITHUB_TOKEN`, and never fails the install (every error path exits 0) ([postinstall.js:672-687,908-911](scripts/postinstall.js)). It **duplicates** the data-dir resolution logic of [data-dir.ts](src/data-dir.ts) ([postinstall.js:20-35](scripts/postinstall.js)) — the two must be changed in lockstep.
- The npm tarball ships only `dist/` + `postinstall.js` ([package.json:11-14](package.json)); no indexer code reaches users today. The on-device mappings-generation path (§6.2) therefore requires deliberately *adding* the era-branch indexer to the published files.
- The README's env-var table omits `MCMODDING_DATA_DIR` and `MCMODDING_SKIP_AUTO_UPDATE`, both of which exist ([data-dir.ts:29-31](src/data-dir.ts:29), [index.ts:338](src/index.ts:338)).

### A.5 Mappings pipeline subtleties

- Parchment version discovery regex-scrapes the Maven **HTML directory listing** for `href="parchment-<ver>/"` ([index-mappings.ts:426-470](scripts/index-mappings.ts:426)) — fragile against maven-server HTML changes. Pre-releases/snapshots are filtered out unless `--pre-releases`/`--snapshots` is passed; explicit versions can be given as CLI args. Mojang data can be skipped with `--skip-mojang`. Zips are extracted with `adm-zip`.
- **Overload hazard, twice:** obfuscated-name matching during indexing is name-only, ignoring descriptors — overloaded methods get the obfuscated name of whichever overload parses first ([index-mappings.ts:877-886](scripts/index-mappings.ts:877)); and `get_method_signature` resolves with `LIMIT 1`, returning only the first overload ([mappings-service.ts:1124-1179](src/services/mappings-service.ts:1124)). The 1.12.2 rebuild should key on descriptors and return all overloads.
- `classes.name` stores the **simple** class name with the package split into `package_name` ([index-mappings.ts:840-843](scripts/index-mappings.ts:840)); `browse_package` matches by prefix `LIKE`, so querying `net.minecraft.world` silently includes every sub-package ([mappings-service.ts:1362-1385](src/services/mappings-service.ts:1362)).
- Index-time PRAGMAs: WAL, `synchronous=NORMAL`, `foreign_keys=ON` ([index-mappings.ts:786-789](scripts/index-mappings.ts:786)); DB metadata records `versions_indexed` (JSON) and `has_obfuscated_mappings` ([index-mappings.ts:1120-1139](scripts/index-mappings.ts:1120)).
- `mappings-service.test.ts` re-implements the pure helpers inline instead of importing them, and gates integration tests on DB existence via `describe.runIf` — so unit tests can pass while the real implementations drift.

### A.6 Mod-examples forensics

- The real corpus is recoverable from git history even though the pipeline is not: the manifest was committed in `dbf4596`/`c5a8a94` and deleted in `79d5607`; `git show c5a8a94:data/mod-examples-manifest.json` shows 1 mod (`Creators-of-Create/Create`, `loader: "forge"`), 3 examples, 20 categories, avgQuality 0.9, ~200 KB. The `.db` blob itself is only an LFS pointer in history.
- The DDL lives in the missing script; the schema in §5.6 is reconstructed entirely from the service's SELECTs — treat it as authoritative-by-observation, and freeze it in a committed migration when rebuilding.
- Useful schema richness to preserve in the rebuild: `example_relations` with typed edges (`uses | extends | similar_to | alternative_to | requires | complements`) and a `strength` weight ([mod-examples-service.ts:56-64,427-446](src/services/mod-examples-service.ts:56)); `example_imports` with an `is_critical` flag; `api_references` (`class_name`/`method_name`/`api_type`) — the natural join point to `cleanroom-api.db` symbols. The examples FTS query is built as `"tok"* OR "tok"*` prefix matching ([mod-examples-service.ts:284-294](src/services/mod-examples-service.ts:284)).

### A.7 Cleanroom build and toolchain quirks

- The loader's own workspace ritual encodes a known ForgeGradle instability: `gradlew setup`, then `gradlew --stop` "to prevent ForgeGradle gone wrong," then build ([cleanroom-src/README.md:71-88](cleanroom-src/README.md)); the Gradle daemon is disabled outright ([cleanroom-src/gradle.properties:43](cleanroom-src/gradle.properties)).
- `projects/kirino` is an **empty, un-checked-out git submodule** (Kirino-Engine); yet `CleanroomModDiscoverer` imports `KirinoCommonCore` and calls `identifyMods` ([CleanroomModDiscoverer.java:7,199](cleanroom-src/src/main/java/com/cleanroommc/discovery/CleanroomModDiscoverer.java)), and the mod-list config reserves `kirino_ecs`/`kirino_engine`/`kirino_gl` slots — the loader tree does not compile without the submodule.
- **Version inconsistency to not propagate:** the MMC pack template pins LWJGL3 `3.3.1` ([mmcpack-template/mmc-pack.json](cleanroom-src/mmcpack-template/mmc-pack.json)) while the build uses `3.4.1` ([gradle.properties:22](cleanroom-src/gradle.properties)); `CreateMMCPackTask` rewrites the patch JSONs with real versions at build time, so the template values are placeholders.
- The generated launcher JSON embeds a comment asking people **not to automate downloads** ("Our efforts are supported by ads from the download page" — [projects/cleanroom/build.gradle:657-661](cleanroom-src/projects/cleanroom/build.gradle)) — relevant etiquette for any pipeline touching Cleanroom release artifacts; prefer the maven (`repo.cleanroommc.com`), which is explicitly published "for mod development."
- The `userdev` artifact bundles `net.minecraftforge:legacydev:0.2.3.+:fatjar` for IDE run support ([projects/cleanroom/build.gradle:951](cleanroom-src/projects/cleanroom/build.gradle)); run configs wire `FMLTweaker`/`FMLServerTweaker` with Foundation as boot main ([projects/cleanroom/build.gradle:944-981](cleanroom-src/projects/cleanroom/build.gradle)). The installer shell is fetched as `com.cleanroommc:installer:2.0.+:shrunk` ([projects/cleanroom/build.gradle:867-870](cleanroom-src/projects/cleanroom/build.gradle)). A third resolve repo, `maven.arcseekers.com`, appears alongside Outlands and CleanroomMC ([projects/cleanroom/build.gradle:79-89](cleanroom-src/projects/cleanroom/build.gradle)).
- Versioning is derived from git tags via the palantir git-version plugin (no version constant in-tree); `buildSrc` compiles against ASM 9.9 while the runtime bundles 9.10.1. The `installer` dependency configuration is **non-transitive**, which is why every bundled library is pinned explicitly ([projects/cleanroom/build.gradle:245-248](cleanroom-src/projects/cleanroom/build.gradle)).
- The universal jar embeds `binpatches.pack.lzma` and `deobf_data-1.12.2.tsrg`, with `Main-Class: net.minecraftforge.fml.relauncher.ServerLaunchWrapper` ([projects/cleanroom/build.gradle:827-865](cleanroom-src/projects/cleanroom/build.gradle)); the LWJGL core artifact uses an `:unsafe` classifier, and `CreateMMCPackTask` injects an ARM64 natives rule into the pack.
- `buildSrc` carries dormant, unwired validator tasks (`CheckPatches`, `CheckAccessTransformers`, `CheckSAS`, `CheckExcs`, `BytecodeFinder`, `FieldCompareFinder`, `CrowdinTask`) — only `CreateMMCPackTask`, `GenVersionTask`, `ProjectConstants`, and `Util` are referenced by build scripts; separate inline tasks `checkAccessTransformers`/`checkSAS` in the cleanroom build script *are* live ([projects/cleanroom/build.gradle:521-624](cleanroom-src/projects/cleanroom/build.gradle)).
- The MMC instance template sets `IgnoreJavaCompatibility=true` and leaves a `JavaPath` placeholder the user must fill ([mmcpack-template/instance.cfg](cleanroom-src/mmcpack-template/instance.cfg)); the bug-report template states the Java floor plainly: "You need 25+ on 0.5.x and later."

### A.8 Cleanroom runtime fine points

- Generated classes are emitted at bytecode level **V21**, not V25 (`ASMTransformerWrapper.java:162` emits `Opcodes.V21`), even though CleanMix advertises `JAVA_25` compatibility — mods can rely on ≥21 features in generated-code interop, not 25.
- The LWJGL2 shim works by **class-node merging**: any `org.lwjgl.*` class is looked up as `org.lwjglx.*`, the two ClassNodes are merged (methods+fields), and re-emitted with `COMPUTE_FRAMES | COMPUTE_MAXS` ([LWJGLTransformer.java](cleanroom-src/src/main/java/net/minecraftforge/fml/common/asm/transformers/LWJGLTransformer.java)); the LWJGL2 group `org.lwjgl.lwjgl` is globally excluded from resolution ([projects/cleanroom/build.gradle:239-242](cleanroom-src/projects/cleanroom/build.gradle)).
- The exact coremod blacklist (`ForgeEarlyConfig.LOADING_PLUGIN_BLACKLIST`): ConfigAnytime's plugin, `zone.rong.mixinbooter.MixinBooterPlugin`, JEID's `JEIDLoadingPlugin`, Forgelin's `ForgelinPlugin`, `ilib.asm.Loader`, `advancedshader.core.Core`, a skin plugin, and the relauncher entrypoint — an assistant advising on pack composition should know these jars are deliberately neutralized, not broken.
- `ForgeEarlyConfig` defaults worth knowing when debugging rendering/input: OpenGL context requested at **4.6 compatibility profile**, plus raw-input, force-Wayland, borderless-fullscreen, sRGB, `KHR_no_error`, and HRTF toggles; it also pins the *reported versions* of the built-in MixinBooter/ConfigAnytime mods (configurable in `forge_early.cfg`, per [cleanroom-src/README.md:65](cleanroom-src/README.md)).
- Mixin dev ergonomics: extra mixin configs can be injected in dev via the system property `crl.dev.mixin` ([CleanMixService.java:52](cleanroom-src/src/main/java/com/cleanroommc/cleanmix/service/CleanMixService.java)); the client run config sets `-Dmixin.debug.export=true` and `-Dmixin.checks.interfaces=true` ([projects/cleanroom/build.gradle:142](cleanroom-src/projects/cleanroom/build.gradle)); the MixinBooter plugin registers at `SortingIndex(Integer.MIN_VALUE + 1)` — effectively first.
- Modern-Java survival machinery an agent may encounter in stack traces: `EnumHackery.addEnumEntry` (runtime enum extension via lenni0451 Reflect), a `StackWalker`-based `sun.reflect.Reflection` stand-in whose `ensureMemberAccess` is deliberately a no-op, `ReflectionHackery` with `getDeclaredFields0` and an IBM-JVM branch ([com/cleanroommc/hackery/](cleanroom-src/src/main/java/com/cleanroommc/hackery/)), `UUIDFix` restoring Java-8-lenient UUID parsing, and a standalone-Nashorn script-engine manager (Nashorn was removed from the JDK).
- `com.cleanroommc.boot.Main`/`MainClient`/`MainServer` are thin legacy-dev entry points that read the real main class from a `mainClass` env var — relevant when reproducing Cleanroom's dev run configs in a mod template.
- FML's discoverer exposes `presentMods()` tracking consumed by `CleanMixHooks` and the (deprecated) `IEarlyMixinLoader.Context` — mixin loaders can condition on which mods are present *before* mod construction.
- `FMLThrowingEventBus` still extends the Guava `EventBus` — the event *bus* lineage is intact even though listener dispatch was rewritten (§3.4).
- Vendored source trees to expect inside the loader jar: `paulscode/sound`, `ibxm` (audio), alongside the MixinBooter API package.

### A.9 Patch-system details

- Patch hygiene rules encoded in the (dormant) `CheckPatches` linter: no tabs, no `import`-statement changes (patches use inline fully-qualified names instead), no whitespace-only hunks, and no access-widening or `final`-removal via patch — that belongs in the access transformer `forge_at.cfg`. These conventions explain the patch style an agent will see when reading `cleanroom-src/patches/`.
- Patcher config specifics: `srgPatches = false`, `notchObf = true` — patches are maintained in MCP-named form; decompiled source is post-processed by `net.minecraftforge:mcpcleanup:2.3.2` ([projects/cleanroom/build.gradle:109-235](cleanroom-src/projects/cleanroom/build.gradle), [ProjectConstants.groovy:16-20](cleanroom-src/buildSrc/src/main/groovy/com/cleanroommc/gradle/helpers/ProjectConstants.groovy)).
- Size landmarks for "where does Cleanroom diverge most" questions: `Block.java.patch` 68.4 KB (largest), `World` 53.9 KB, `Item` 34 KB, `Minecraft` 30 KB (injects the FML loading sequence), `EntityPlayer` 28 KB, `EntityLivingBase` 25.8 KB; the fully patched source tree totals **772 Java files**.
- `forge.srg` in the loader resources is a 424-byte single-`MD:`-line stub and `forge.exc` is 82 lines of exceptor parameter overrides — anyone hunting for the 1.12.2 mapping tables in `cleanroom-src` will find only these Forge-injected extras (the real data lives on the mavens, §5.5).
