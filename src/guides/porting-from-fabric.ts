// Original authorship (no upstream Fabric→Cleanroom guide exists). Grounded in the
// equivalence corpus + Forge 1.12.x docs. Load-bearing API names are quoted inline.
export default `# Porting a Fabric mod to Cleanroom (1.12.2)

Cleanroom is Forge 1.12.2 continued on Java 25+. Porting from Fabric is a full rewrite of the
loader-facing layer, not a mapping — the two ecosystems share almost no API. Work topic by
topic with \`find_equivalent(query, from: "fabric", topic)\`; this guide is the sweep order.

> Cleanroom/Forge-1.12.2 mod code and crash logs speak **SRG** names (\`func_…\`, \`field_…\`).
> Resolve any you meet with \`resolve_symbol\`. Vanilla types are in the mappings tools; the
> Cleanroom/Forge framework is in \`search_cleanroom_api\`.

## 0. Project & metadata
- Fabric \`fabric.mod.json\` → 1.12.2 \`mcmod.info\` (\`get_project_template("mcmod.info")\`).
- \`ModInitializer.onInitialize()\` → an \`@Mod\` class with \`@Mod.EventHandler\` lifecycle
  (\`FMLPreInitializationEvent\` → Init → PostInit) and \`@SidedProxy\` for client/common split.
- Yarn/Mojang names → MCP/SRG. Java 8 → Java 25+.

## 1. Registration
Fabric \`Registry.register(Registries.ITEM, id, obj)\` → Forge \`RegistryEvent.Register<T>\`
handlers plus \`@ObjectHolder\` for references. There is no free-floating registry; you must
register inside the event. See \`find_equivalent(query:"Registry.register", from:"fabric",
topic:"registration")\`.

## 2. Events
Fabric callbacks (\`UseItemCallback.EVENT.register(...)\`) → a class with \`@SubscribeEvent\`
methods registered on \`MinecraftForge.EVENT_BUS\`. Fabric's per-event registries become one
bus; event class names differ (e.g. \`PlayerInteractEvent.RightClickBlock\`). Cleanroom builds
listeners with \`LambdaMetafactory\` internally — semantics are preserved.

## 3. Networking
Fabric \`ServerPlayNetworking.registerGlobalReceiver(Identifier, handler)\` /
\`ClientPlayNetworking.send(...)\` → \`SimpleNetworkWrapper\` via
\`NetworkRegistry.INSTANCE.newSimpleChannel("modid")\` with \`IMessage\` + \`IMessageHandler\`.
**Threading:** 1.12.2 packets run on the network thread; main-thread work must go through
\`IThreadListener.addScheduledTask\` (the analog of Fabric's \`execute(...)\`).

## 4. Item/block settings
\`Item.Settings\`/\`FabricItemSettings\` and \`AbstractBlock.Settings\` → constructor + setter
idioms: \`Item.setMaxStackSize\`, \`Item.setCreativeTab(CreativeTabs)\`, \`Block(Material)\`,
\`setHardness\`, \`setHarvestLevel\`. Creative-tab grouping is \`CreativeTabs\`, not item groups.

## 5. Capabilities
Fabric component/attachment APIs → Forge **Capabilities**: \`@CapabilityInject\`,
\`ICapabilityProvider\`, \`Capability<T>\`, \`ICapabilitySerializable\`. No attachment API; you
attach via \`AttachCapabilitiesEvent\`.

## 6. Mixins & access
Fabric mixins already use the same \`org.spongepowered.asm\` API — Cleanroom bundles **CleanMix**
(Fabric-Mixin fork) at that package, so most mixins port directly. Declare configs with the
**\`MixinConfigs\`** jar-manifest attribute (see \`get_porting_guide("mixin-setup")\`).
**Access wideners → access transformers:** rewrite \`accesswidener\` entries as a
\`_at.cfg\` in \`<modifier> <fq-class> <member><descriptor>\` syntax (MCP names).

## 7. Data & resources (no direct equivalent)
Fabric datagen has **no 1.12.2 equivalent** — hand-write \`assets/\`/\`data\`-style JSON
(models, blockstates, recipes, lang). \`find_equivalent(from:"fabric", topic:"resources-datagen")\`
returns \`kind: missing\` with the 1.12.2 idiom.

## Finish
Scaffold with \`get_project_template\` / \`cleanroom://template/checklist\`, then iterate with
\`search_docs\`, \`search_cleanroom_api\`, and \`resolve_symbol\`.
`;
