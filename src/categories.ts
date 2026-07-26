/**
 * Category taxonomies — one home, ending the previous triplication of
 * inconsistent enums across tool schemas and helper functions.
 *
 * DOC_CATEGORIES must stay a superset of what the crawler actually emits
 * (it falls back to 'general' when a URL matches no known category).
 */

/** Categories for indexed documentation pages. */
export const DOC_CATEGORIES = [
  'getting-started',
  'items',
  'blocks',
  'entities',
  'rendering',
  'networking',
  'data-generation',
  'commands',
  'sounds',
  'events',
  'mixins',
  'general',
] as const;

/** Schema enum for doc-search tools ('all' disables the filter). */
export const DOC_CATEGORY_ENUM = [...DOC_CATEGORIES, 'all'] as const;

/**
 * Categories for the curated mod-examples corpus, edited for the 1.12.2 era:
 * 'data-generation' removed (datagen does not exist in 1.12.2 — resources are
 * hand-written JSON), 'capabilities' and 'coremods-mixins' added.
 */
export const EXAMPLE_CATEGORIES = [
  'blocks',
  'items',
  'entities',
  'tile-entities',
  'rendering',
  'gui',
  'networking',
  'worldgen',
  'recipes',
  'events',
  'registry',
  'capabilities',
  'coremods-mixins',
  'api-design',
  'cross-platform',
  'storage-systems',
  'animation',
  'particles',
  'sounds',
  'commands',
  'config',
] as const;

export type ExampleCategory = (typeof EXAMPLE_CATEGORIES)[number];

/**
 * Display metadata for the mod-examples categories, seeded into the DB's
 * `categories` table at index time (icon/name/description drive
 * `list_mod_categories`). `sort_order` follows EXAMPLE_CATEGORIES order.
 */
export const EXAMPLE_CATEGORY_INFO: Record<
  ExampleCategory,
  { name: string; description: string; icon: string }
> = {
  blocks: { name: 'Blocks', description: 'Block registration, states, and behavior', icon: '🧱' },
  items: { name: 'Items', description: 'Item registration, properties, and behavior', icon: '🍎' },
  entities: { name: 'Entities', description: 'Entity registration, AI, and rendering', icon: '🐺' },
  'tile-entities': {
    name: 'Tile Entities',
    description: 'TileEntity logic, TESR rendering, and NBT persistence',
    icon: '📦',
  },
  rendering: { name: 'Rendering', description: 'Models, TESRs, and client rendering', icon: '🎨' },
  gui: { name: 'GUI', description: 'Containers, screens, and ModularUI', icon: '🖥️' },
  networking: {
    name: 'Networking',
    description: 'SimpleNetworkWrapper / IMessage packet handling',
    icon: '📡',
  },
  worldgen: {
    name: 'World Generation',
    description: 'Features, structures, and ore gen',
    icon: '🌍',
  },
  recipes: {
    name: 'Recipes',
    description: 'Crafting, smelting, and custom recipe types',
    icon: '⚗️',
  },
  events: { name: 'Events', description: '@SubscribeEvent handlers and the event bus', icon: '⚡' },
  registry: {
    name: 'Registry',
    description: 'GameRegistry, @ObjectHolder, and RegistryEvent',
    icon: '📇',
  },
  capabilities: {
    name: 'Capabilities',
    description: 'Capability / ICapabilityProvider patterns',
    icon: '🔌',
  },
  'coremods-mixins': {
    name: 'Coremods & Mixins',
    description: 'CleanMix / MixinBooter and coremod patterns',
    icon: '🧬',
  },
  'api-design': {
    name: 'API Design',
    description: 'Cross-mod API surfaces and addons',
    icon: '🏛️',
  },
  'cross-platform': {
    name: 'Cross-Platform',
    description: 'Sided proxies and client/server separation',
    icon: '🔀',
  },
  'storage-systems': {
    name: 'Storage Systems',
    description: 'Inventories, fluid tanks, and energy storage',
    icon: '🗄️',
  },
  animation: { name: 'Animation', description: 'Animated models and state machines', icon: '🎞️' },
  particles: { name: 'Particles', description: 'Particle effects and spawning', icon: '✨' },
  sounds: { name: 'Sounds', description: 'Sound events and registration', icon: '🔊' },
  commands: { name: 'Commands', description: 'ICommand implementations', icon: '⌨️' },
  config: { name: 'Config', description: '@Config and configuration handling', icon: '⚙️' },
};

/**
 * Render the allowed-category block for the analysis prompt, one bullet per
 * slug with its EXAMPLE_CATEGORY_INFO description.
 *
 * The prompt template carries a `{{CATEGORY_LIST}}` placeholder that
 * `buildPrompt` (src/examples/analyze.ts) fills with this. Generating it is the
 * point: the v1 prompt hand-copied the 21 slugs as prose with nothing enforcing
 * sync, and it handed the model bare slugs with no descriptions — 36% of the
 * corpus came back uncategorized as a result.
 */
export function buildCategoryPromptBlock(): string {
  return EXAMPLE_CATEGORIES.map((slug) => {
    const info = EXAMPLE_CATEGORY_INFO[slug];
    return `- \`${slug}\` — ${info.description}`;
  }).join('\n');
}

/** Tag vocabulary for concept explanations (superset of doc categories). */
export const CONCEPT_CATEGORIES = [
  ...DOC_CATEGORIES,
  'capabilities',
  'coremods-mixins',
  'toolchain',
  'mappings',
] as const;

/**
 * Map URL/repo path segments onto DOC_CATEGORIES (first matching segment
 * wins; 'general' when nothing matches). Used for corpora whose URLs don't
 * fit the crawler's versioned-path heuristic: the Forge 1.12.x RTD tree and
 * the Cleanroom wiki routes.
 */
const PATH_SEGMENT_CATEGORIES: Record<string, (typeof DOC_CATEGORIES)[number]> = {
  event: 'events',
  events: 'events',
  mixin: 'mixins',
  mixins: 'mixins',
  render: 'rendering',
  rendering: 'rendering',
  models: 'rendering',
  animation: 'rendering',
  modularui: 'rendering',
  networking: 'networking',
  sidedness: 'networking',
  blocks: 'blocks',
  tileentities: 'blocks',
  items: 'items',
  gettingstarted: 'getting-started',
  'getting-started': 'getting-started',
  sounds: 'sounds',
  commands: 'commands',
  entities: 'entities',
  'data-generation': 'data-generation',
};

export function categorizeDocPath(segments: string[]): (typeof DOC_CATEGORIES)[number] {
  for (const segment of segments) {
    const category = PATH_SEGMENT_CATEGORIES[segment.toLowerCase()];
    if (category) {
      return category;
    }
  }
  return 'general';
}
