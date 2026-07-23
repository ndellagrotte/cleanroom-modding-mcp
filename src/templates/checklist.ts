// Hand-authored companion (NOT vendored). A workspace setup checklist for a fresh
// Cleanroom 1.12.2 mod, sequencing the template files and the server's tools.
export default `# Cleanroom mod scaffolding checklist

A from-scratch Cleanroom (Minecraft 1.12.2, Java 25+) mod, in order.

## 1. Toolchain
- [ ] Install a Java 25+ JDK. Cleanroom builds and runs on Java 25+ (not Java 8).
- [ ] Use the official template (uses **Unimined 1.4.26-kappa**, NOT ForgeGradle):
      \`get_project_template("build.gradle")\`, \`get_project_template("settings.gradle")\`,
      \`get_project_template("gradle.properties")\`.
- [ ] In gradle.properties set the blossom tokens: \`mod_id\`, \`mod_name\`, \`root_package\`,
      \`mod_version\`, and (if needed) \`is_coremod\`, \`use_access_transformer\`.
- [ ] Point the Unimined \`cleanroom "<version>"\` pin at the Cleanroom release you target
      (the template ships an older pin).

## 2. Metadata & entry point
- [ ] \`get_project_template("mcmod.info")\` — 1.12.2 metadata (NOT mods.toml).
- [ ] \`get_project_template("ExampleMod.java")\` — \`@Mod\` main class with the
      \`@Mod.EventHandler\` lifecycle (\`FMLPreInitializationEvent\`, Init, PostInit) and
      \`@SidedProxy\` client/common proxies.

## 3. Registration & content
- [ ] Register blocks/items via \`RegistryEvent.Register<T>\` + \`@ObjectHolder\`
      (\`search_cleanroom_api "RegistryEvent"\`).
- [ ] Resolve any SRG names you meet in code or crash logs with \`resolve_symbol\`.
- [ ] Pull idiomatic patterns from \`search_docs\` (target scope) and \`search_cleanroom_api\`.

## 4. Access transformers (optional)
- [ ] If you need to widen vanilla access: \`get_project_template("modid_at.cfg")\`,
      set \`use_access_transformer=true\`, and add the \`FMLAT\` manifest attribute
      (the template wires it from gradle.properties). ATs are written in MCP names.

## 5. Mixins (optional)
- [ ] Read \`get_porting_guide("mixin-setup")\` / \`cleanroom://guide/mixin-setup\`.
- [ ] \`get_project_template("mixins.json")\` — a CleanMix config; declare it with the
      \`MixinConfigs\` jar-manifest attribute (the modern path; \`IEarlyMixinLoader\` etc.
      are deprecated). MixinExtras is bundled.

## 6. Build & run
- [ ] \`gradlew setup\`, then (if ForgeGradle-style tasks misbehave) \`gradlew --stop\`,
      then build/run. The Gradle daemon is disabled in the template.

Related: \`cleanroom://template/checklist\`, \`cleanroom://guide/mixin-setup\`.
`;
