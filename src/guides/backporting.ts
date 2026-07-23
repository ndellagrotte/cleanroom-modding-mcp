// Original authorship. Backporting a modern-Minecraft feature down to 1.12.2.
// Grounded in the equivalence corpus (from: modern-minecraft) + Forge 1.12.x docs.
export default `# Backporting a modern-Minecraft feature to Cleanroom (1.12.2)

Backporting brings a feature written for modern Minecraft (1.16–1.21) down to the 1.12.2 world.
The hard part is the platform delta: registries, serialization, rendering, and data formats all
changed. Sweep with \`find_equivalent(query, from: "modern-minecraft", topic)\` — many answers
are honestly \`kind: missing\` with the 1.12.2 idiom to hand-write.

> Phase 4 is **conceptual** backport support (equivalence rows). Symbol-level cross-version
> name translation (\`translate_symbol\`) is a later phase; for now resolve 1.12.2 names with
> \`resolve_symbol\` and modern names with \`search_mappings(minecraft_version: <modern>)\`.

## 1. Names & packages (1.17 "flattening")
The 1.17 repackaging renamed core types: \`Level\`→\`World\`, \`BlockEntity\`→\`TileEntity\`,
\`Player\`→\`EntityPlayer\`, \`Component\`→\`ITextComponent\`, \`ItemStack\` stays but its NBT/data
model differs. Translate names first; equivalence rows quote both spellings inline.

## 2. Registration & content
Modern registry helpers (\`DeferredRegister\`, \`Registry.register\`) → 1.12.2
\`RegistryEvent.Register<T>\` + \`@ObjectHolder\` + \`GameRegistry\`. Item/block "properties"
builders → constructor + setters (see \`find_equivalent(topic:"item-block-settings")\`).

## 3. Serialization: Codec/DataComponents → NBT (missing)
\`Codec\`/\`DataComponents\` have **no 1.12.2 equivalent**. Hand-roll \`NBTTagCompound\`
read/write and \`ItemStack\` NBT. \`find_equivalent(from:"modern-minecraft",
topic:"serialization-nbt-codecs")\` / \`topic:"data-components"\` give the idiom.

## 4. Rendering: BER → TESR (pattern change)
\`BlockEntityRenderer\` → \`TileEntitySpecialRenderer\`; the modern \`RenderSystem\`/\`PoseStack\`
pipeline → 1.12.2 GL/\`Tessellator\` drawing (LWJGL3 is present but the API is the old one).
\`find_equivalent(topic:"block-entity-renderer")\`.

## 5. Text & UI
\`Component\`/\`MutableComponent\` → \`ITextComponent\` / \`TextComponentString\` /
\`TextComponentTranslation\`. \`find_equivalent(topic:"text-components")\`.

## 6. Data-driven content
Datapacks and datagen do not exist in 1.12.2 — recipes, advancements, and loot are hand-written
JSON under the 1.12.2 conventions, or code-registered. \`find_equivalent(topic:"advancements")\`
and \`topic:"resources-datagen")\` mark these \`missing\` and give the 1.12.2 route.

## Finish
Scaffold the target mod with \`get_project_template\`, verify every symbol you land on with
\`resolve_symbol\` / \`search_cleanroom_api\`, and treat each \`kind: missing\` answer as
"there is no 1:1 port — here is the 1.12.2 idiom."
`;
