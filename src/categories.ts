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

export type DocCategory = (typeof DOC_CATEGORIES)[number];

export function isDocCategory(value: string): value is DocCategory {
  return (DOC_CATEGORIES as readonly string[]).includes(value);
}

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
 * Narrow a DB-sourced slug to the taxonomy. `categories.slug` is seeded from
 * EXAMPLE_CATEGORIES but read back as a plain string, and a corpus built by a
 * different indexer version may carry slugs this build does not know.
 */
export function isExampleCategory(value: string): value is ExampleCategory {
  return (EXAMPLE_CATEGORIES as readonly string[]).includes(value);
}

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
 * Below this count a category is "thin": it is advertised as a filter but backs
 * so few examples that the filter is close to useless. Tuned to the shipped
 * corpus, where it names exactly the set the beta report flagged (sounds 2,
 * worldgen 4, commands/entities/recipes 5) and leaves particles 14 /
 * storage-systems 18 alone.
 */
export const THIN_CATEGORY_THRESHOLD = 10;

export interface CategoryCoverage {
  /** Categories with zero examples — a `category` filter on these can never match. */
  empty: ExampleCategory[];
  /** Categories under THIN_CATEGORY_THRESHOLD (never zero — those are `empty`). */
  thin: Array<{ slug: ExampleCategory; count: number }>;
}

/**
 * Audit a slug→count map against the EXAMPLE_CATEGORIES taxonomy.
 *
 * Every category in the enum is a filter value the agent may pick, so one with
 * no examples behind it is a promise the corpus cannot keep — an agent that
 * filters, gets zero, and concludes the corpus holds nothing on the topic has
 * been actively misled (beta report N2). Both the runtime tools and the
 * maintainer indexer audit with this; it lives here, beside the taxonomy, so
 * neither has to reimplement it and `src/` never imports pipeline code.
 *
 * Pure: a missing key counts as 0, and keys outside the taxonomy are ignored.
 */
export function auditCategoryCoverage(counts: Record<string, number>): CategoryCoverage {
  return auditCoverage(EXAMPLE_CATEGORIES, counts);
}

/**
 * The taxonomy-agnostic form of the audit above, so the documentation corpus
 * gets the same disclosure without a second copy of the logic. `DOC_CATEGORIES`
 * has the identical failure mode: `entities`, `commands` and `data-generation`
 * are offered as `search_docs` filter values but hold zero documents at the
 * default target scope, so filtering by one can never match.
 *
 * Pure: a missing key counts as 0, and keys outside `slugs` are ignored.
 */
export function auditCoverage<T extends string>(
  slugs: readonly T[],
  counts: Record<string, number>,
  threshold: number = THIN_CATEGORY_THRESHOLD
): { empty: T[]; thin: Array<{ slug: T; count: number }> } {
  const empty: T[] = [];
  const thin: Array<{ slug: T; count: number }> = [];
  for (const slug of slugs) {
    const count = counts[slug] ?? 0;
    if (count === 0) {
      empty.push(slug);
    } else if (count < threshold) {
      thin.push({ slug, count });
    }
  }
  return { empty, thin };
}

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

/**
 * Where to send an agent whose doc-category filter came back empty.
 *
 *  - `examples`      — `search_mod_examples` has a category answering the same question
 *  - `free-text`     — no counterpart category; the corpus still helps unfiltered
 *  - `not-in-1.12.2` — the concept does not exist in this era. Reporting a corpus
 *                      gap here would be a lie by omission: no amount of indexing
 *                      will ever produce 1.12.2 datagen documentation.
 */
export type DocCategoryRouting =
  | { kind: 'examples'; category: ExampleCategory }
  | { kind: 'free-text' }
  | { kind: 'not-in-1.12.2'; reason: string };

/**
 * Doc category → the corpus that can answer when the docs cannot. Lives here
 * beside both taxonomies (the SSOT rule) so neither side hardcodes the other's
 * slugs; `Record<DocCategory, …>` makes a future DOC_CATEGORIES addition a
 * compile error rather than a silent hole, and the ExampleCategory values are
 * type-checked so `mixins → coremods-mixins` cannot rot.
 */
export const DOC_CATEGORY_ROUTING: Record<DocCategory, DocCategoryRouting> = {
  'getting-started': { kind: 'free-text' },
  items: { kind: 'examples', category: 'items' },
  blocks: { kind: 'examples', category: 'blocks' },
  entities: { kind: 'examples', category: 'entities' },
  rendering: { kind: 'examples', category: 'rendering' },
  networking: { kind: 'examples', category: 'networking' },
  commands: { kind: 'examples', category: 'commands' },
  sounds: { kind: 'examples', category: 'sounds' },
  events: { kind: 'examples', category: 'events' },
  mixins: { kind: 'examples', category: 'coremods-mixins' },
  general: { kind: 'free-text' },
  'data-generation': {
    kind: 'not-in-1.12.2',
    reason:
      'data generation does not exist in Minecraft 1.12.2 — models, blockstates, recipes and ' +
      'loot tables are hand-written JSON under `src/main/resources`',
  },
};

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

  // Aliases observed in the shipped corpus once stage 1 of extractCategory
  // stopped emitting raw path segments. Only segments with an unambiguous home
  // in the 12-value taxonomy are mapped; everything else falls to 'general'.
  //
  // Deliberately NOT added as new DOC_CATEGORIES members: 'resources',
  // 'worldgen', 'recipes' and friends exist only in the modern reference
  // corpora, so promoting them would add filter values holding zero target-scope
  // documents — the exact failure this taxonomy is being audited for.
  datagen: 'data-generation',
  blockentities: 'blocks',
  blockentity: 'blocks',
  tileentity: 'blocks',
  inventories: 'items',
  gui: 'rendering',
  guis: 'rendering',
  particles: 'rendering',
  textures: 'rendering',
  'class-tweakers': 'mixins',
  coremods: 'mixins',
  accesstransformers: 'mixins',
  command: 'commands',
  entity: 'entities',
  sound: 'sounds',
  item: 'items',
  block: 'blocks',
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
