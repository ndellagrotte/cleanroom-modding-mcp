// Original authorship. Setting up mixins + access transformers on Cleanroom (1.12.2).
// Grounded in RESEARCH §3.1/§3.3 and the CleanroomModTemplate 'mixin' branch.
export default `# Mixins & access transformers on Cleanroom (1.12.2)

Cleanroom ships a mixin stack **built in** — you do not add MixinBooter as a dependency. It
provides **CleanMix** (a fork of Fabric Mixin targeting 1.12.2, at the standard
\`org.spongepowered.asm\` package) with **MixinExtras bundled**, and re-implements the
\`zone.rong.mixinbooter\` API for ecosystem compatibility.

## 1. Declare your mixin configs (the modern path)
Add the mixin config file(s) to your jar manifest with the **\`MixinConfigs\`** attribute
(comma-separated), read by Cleanroom's mod discoverer:

    MixinConfigs: modid.default.mixin.json,modid.mod.mixin.json

The legacy interfaces \`IEarlyMixinLoader\`, \`ILateMixinLoader\`, \`IMixinConfigHijacker\`, and
\`@MixinLoader\` are **all @Deprecated** — do not use them for new mods. Get a config skeleton
with \`get_project_template("mixins.json")\`.

## 2. The mixin config JSON
The template's config uses CleanMix phase targeting and \`compatibilityLevel JAVA_8\`. Phases
are PRE_INIT / DEFAULT / MOD (\`"target": "@env(DEFAULT)"\` / \`"@env(MOD)"\`). A config plugin
(e.g. gating a JEI mixin on \`Loader.isModLoaded("jei")\`) is optional. Refmaps are handled by
Unimined at build.

## 3. Write mixins against SRG
Mixins written against **SRG** names apply in production via Cleanroom's remapper chain
(\`Srg2McpRemapper\` in dev, an \`FMLDeobfuscatingRemapper\` wrapper in production). Use
\`resolve_symbol\` to turn a readable/notch name into the SRG name you \`@Shadow\`/\`@Inject\`
against. Crash reports are annotated with which mixins touched each class.

## 4. Dev ergonomics
- Inject extra dev-only configs with the system property \`crl.dev.mixin\`.
- The template's client run sets \`-Dmixin.debug.export=true\` and
  \`-Dmixin.checks.interfaces=true\`.

## 5. Coremods (only if you truly need one)
Setting \`is_coremod=true\` (gradle.properties) adds the \`FMLCorePlugin\` manifest attribute and
an \`IFMLLoadingPlugin\`. The template's mixin branch ships \`is_coremod=true\` with an **empty**
\`IFMLLoadingPlugin\` — whether that is strictly required for mixins or vestigial is unconfirmed
upstream; prefer the manifest \`MixinConfigs\` path and only add a coremod if you need
class-transformation before mod construction.

## 6. Access transformers
To widen \`private\`/\`final\` vanilla members instead of reflecting:
1. \`get_project_template("modid_at.cfg")\`, set \`use_access_transformer=true\`.
2. The template wires the \`FMLAT: modid_at.cfg\` manifest attribute from gradle.properties.
3. Entries are \`<modifier> <fully.qualified.Class> <member><descriptor>\`, written in **MCP**
   names; Unimined remaps them to SRG at build. Never remove \`final\` via a mixin — use the AT.

Related: \`cleanroom://template/mixins.json\`, \`cleanroom://template/modid_at.cfg\`,
\`find_equivalent(topic:"mixins-access-transformers")\`.
`;
