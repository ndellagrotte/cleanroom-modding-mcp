// Original authorship (no upstream NeoForge→Cleanroom guide exists). Grounded in the
// equivalence corpus + Forge 1.12.x docs. Load-bearing API names are quoted inline.
export default `# Porting a NeoForge / modern-Forge mod to Cleanroom (1.12.2)

NeoForge and modern Forge (1.16–1.21) are the *closest* starting point — the concepts line up,
but the 1.12.2 spellings are older and some subsystems are absent. Sweep topic by topic with
\`find_equivalent(query, from: "neoforge", topic)\`.

> 1.12.2 code and crash logs speak **SRG** names — resolve with \`resolve_symbol\`. The
> Cleanroom/Forge framework surface is in \`search_cleanroom_api\`.

## 0. Project & metadata
- \`neoforge.mods.toml\` / \`mods.toml\` → \`mcmod.info\` (\`get_project_template("mcmod.info")\`).
- The mod-bus \`@Mod\` constructor with \`IEventBus\` injection → an \`@Mod\` class plus
  \`@Mod.EventHandler\` lifecycle methods and \`@SidedProxy\`.
- 1.17+ Mojang package names (\`Level\`, \`BlockEntity\`, \`Player\`) → 1.12.2 MCP names
  (\`World\`, \`TileEntity\`, \`EntityPlayer\`). This class rename is the single biggest source of
  churn; \`find_equivalent(topic:"text-components")\` and friends quote both spellings.

## 1. Registration
\`DeferredRegister<T>\` + \`RegistryObject<T>\` → \`RegistryEvent.Register<T>\` handlers +
\`@ObjectHolder\`. Drop the deferred-registry plumbing; register inside the event and read
back through object holders. (\`find_equivalent(query:"DeferredRegister", from:"neoforge")\`.)

## 2. Events
Two buses (mod bus + game/forge bus) collapse to \`MinecraftForge.EVENT_BUS\` +
\`@Mod.EventHandler\` lifecycle. \`@SubscribeEvent\` survives; some event classes were renamed
or split — verify each with \`search_cleanroom_api\`.

## 3. Networking
The 1.16+ \`SimpleChannel\` builder
(\`NetworkRegistry.newSimpleChannel(...).messageBuilder(...).encoder(...).decoder(...)\`) →
1.12.2 \`SimpleNetworkWrapper\` (\`NetworkRegistry.INSTANCE.newSimpleChannel("modid")\`,
\`registerMessage(handler, message, discriminator, Side)\`). There is no protocol-version
negotiation; drop \`.networkProtocolVersion(...)\`. Main-thread work goes through
\`IThreadListener.addScheduledTask\` (the analog of \`context.enqueueWork(...)\`).

## 4. Item/block settings & capabilities
- \`Item.Properties\`/\`BlockBehaviour.Properties\` → constructor + setters (\`setMaxStackSize\`,
  \`setCreativeTab(CreativeTabs)\`, \`Block(Material)\`, \`setHardness\`).
- Capabilities: \`LazyOptional<T>\` + \`getCapability\` → 1.12.2 \`Capability<T>\`,
  \`ICapabilityProvider\`, \`@CapabilityInject\`, \`AttachCapabilitiesEvent\` (no \`LazyOptional\`).

## 5. Data components → NBT
Modern \`DataComponents\` / \`Codec\` serialization has **no 1.12.2 equivalent** — hand-roll
\`NBTTagCompound\` read/write. \`find_equivalent(from:"neoforge", topic:"serialization-nbt-codecs")\`
and \`topic:"data-components"\` return the NBT idiom.

## 6. Rendering & mixins
- \`BlockEntityRenderer\` → \`TileEntitySpecialRenderer\` (TESR); LWJGL3 is present but the API
  differs from modern \`RenderSystem\`. \`find_equivalent(topic:"block-entity-renderer")\`.
- Mixins port directly (CleanMix at \`org.spongepowered.asm\`); declare with \`MixinConfigs\`
  (\`get_porting_guide("mixin-setup")\`). MixinExtras is bundled on both sides.

## Finish
Scaffold with \`get_project_template\`, then iterate with \`search_docs\`,
\`search_cleanroom_api\`, and \`resolve_symbol\`.
`;
