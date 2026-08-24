/**
 * One category vocabulary for both agent-facing corpora.
 *
 * The tools route callers directly between documentation and mod examples, so
 * different enums make a valid category from one tool fail schema validation
 * in the other. Both exported aliases below are the same readonly value.
 *
 * `data-generation` is intentionally absent: it does not exist in 1.12.2.
 * Modern datagen documentation is filed under `resources`, the useful
 * cross-era subject. `datastorage` is retained as a real namespace category;
 * specific children such as capabilities and saved data still win.
 */
export const CORPUS_CATEGORIES = [
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
  'getting-started',
  'resources',
  'datastorage',
  'toolchain',
  'porting',
  'general',
] as const;

export const EXAMPLE_CATEGORIES = CORPUS_CATEGORIES;
export const DOC_CATEGORIES = CORPUS_CATEGORIES;

export type ExampleCategory = (typeof EXAMPLE_CATEGORIES)[number];
export type DocCategory = (typeof DOC_CATEGORIES)[number];

export function isExampleCategory(value: string): value is ExampleCategory {
  return (EXAMPLE_CATEGORIES as readonly string[]).includes(value);
}

export function isDocCategory(value: string): value is DocCategory {
  return isExampleCategory(value);
}

/**
 * Shared vocabulary entries whose primary destination is docs or a dedicated
 * porting tool rather than the 1.12.2 examples corpus.
 */
export const DOC_ONLY_CATEGORIES = [
  'getting-started',
  'resources',
  'datastorage',
  'toolchain',
  'porting',
  'general',
] as const satisfies readonly DocCategory[];

export type DocOnlyCategory = (typeof DOC_ONLY_CATEGORIES)[number];

/** Schema enum for doc-search tools ('all' disables the filter). */
export const DOC_CATEGORY_ENUM = [...DOC_CATEGORIES, 'all'] as const;

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
  'getting-started': {
    name: 'Getting Started',
    description: 'Development setup and first-mod workflows',
    icon: '🚀',
  },
  resources: {
    name: 'Resources',
    description: 'Resource packs, models, language files, tags, and loot',
    icon: '📄',
  },
  datastorage: {
    name: 'Data Storage',
    description: 'Persistent data APIs and data-storage namespaces',
    icon: '💾',
  },
  toolchain: {
    name: 'Toolchain',
    description: 'Gradle, mappings, debugging, testing, and publishing',
    icon: '🔧',
  },
  porting: {
    name: 'Porting',
    description: 'Version migration and cross-loader adaptation',
    icon: '↔',
  },
  general: {
    name: 'General',
    description: 'Documentation without a narrower subject category',
    icon: '📚',
  },
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
 * has the identical failure mode: several values are offered as `search_docs`
 * filters but hold zero documents at the default target scope, so filtering by
 * one can never match. See the note on DOC_ONLY_ROUTING for why that is
 * acceptable now in a way it was not before.
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
 * The doc category `categorizeDocPath` returns when no path segment matches.
 * Named rather than inlined because two different things care about it: the
 * mapping below, and the build gate that watches how much of the corpus ends up
 * here.
 */
export const DOC_FALLBACK_CATEGORY = 'general' satisfies DocCategory;

/** One `(loader, category)` bucket, as `SqliteStore.getCoverage()` reports it. */
export interface CategoryCountRow {
  loader: string;
  category: string;
  count: number;
}

export interface GeneralShare {
  general: number;
  total: number;
  byLoader: Array<{ loader: string; general: number; total: number }>;
}

/**
 * How much of a corpus fell through to DOC_FALLBACK_CATEGORY, overall and per
 * loader.
 *
 * The off-taxonomy audit cannot see this failure: 'general' *is* a member of
 * DOC_CATEGORIES, so a crawler that stopped recognizing every path segment would
 * emit nothing else and still pass. The share is the only signal that separates
 * "categorization is working, and this material genuinely has no home in the
 * taxonomy" from "categorization broke".
 *
 * Per-loader as well as overall because the two corpora behave differently by
 * design, and an aggregate alone would let one of them rot unnoticed.
 *
 * Pure, and lives here beside the taxonomy for the same reason auditCoverage
 * does: the maintainer indexer is not the only plausible caller, and `src/` must
 * never import pipeline code.
 */
export function summarizeGeneralShare(rows: readonly CategoryCountRow[]): GeneralShare {
  const perLoader = new Map<string, { general: number; total: number }>();
  let general = 0;
  let total = 0;

  for (const row of rows) {
    const bucket = perLoader.get(row.loader) ?? { general: 0, total: 0 };
    bucket.total += row.count;
    total += row.count;
    if (row.category === DOC_FALLBACK_CATEGORY) {
      bucket.general += row.count;
      general += row.count;
    }
    perLoader.set(row.loader, bucket);
  }

  const byLoader = [...perLoader.entries()]
    .map(([loader, counts]) => ({ loader, ...counts }))
    .sort((a, b) => b.total - a.total);

  return { general, total, byLoader };
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
 *  - `porting-tools` — the dedicated porting surface answers this better than any
 *                      corpus search would
 */
export type DocCategoryRouting =
  | { kind: 'examples'; category: ExampleCategory }
  | { kind: 'free-text' }
  | { kind: 'porting-tools' }
  | { kind: 'not-in-1.12.2'; reason: string };

/**
 * Routing for the doc-only categories. The shared ones need no table: a doc
 * category that is also an example category routes to its own name, which is
 * exactly what the superset definition buys.
 *
 * `Record<DocOnlyCategory, …>` keeps a future DOC_ONLY_CATEGORIES addition a
 * compile error rather than a silent hole.
 */
export const DOC_ONLY_ROUTING: Record<DocOnlyCategory, DocCategoryRouting> = {
  'getting-started': { kind: 'free-text' },
  general: { kind: 'free-text' },
  resources: { kind: 'free-text' },
  datastorage: { kind: 'free-text' },
  toolchain: { kind: 'free-text' },
  porting: { kind: 'porting-tools' },
};

/**
 * Doc category → the corpus that can answer when the docs cannot.
 *
 * NOTE ON A REVERSED DECISION. This module previously refused to promote
 * `resources`, `worldgen`, `recipes` and friends to DOC_CATEGORIES on the
 * grounds that they hold zero target-scope documents — "the exact failure this
 * taxonomy is being audited for". That objection was correct on its own terms
 * and the promotion still makes that particular count worse (9 of 27 values are
 * empty at target scope, against 3 of 12 before).
 *
 * It was reversed anyway, because the target corpus is 88 documents: *any*
 * taxonomy finer than about six values has empty target-scope buckets, and
 * refusing to name a subject does not create 1.12.2 documentation. What decides
 * it is whether an agent that filters into an empty bucket is helped or misled —
 * and under the superset definition every empty bucket now routes somewhere
 * real (`gui` → 69 examples, `api-design` → 30, `worldgen` → 15, `porting` → the
 * porting tools). Compare the state this replaced, where the single largest
 * value — `general`, half the corpus — routed to `free-text`, i.e. no help at
 * all.
 */
export function docCategoryRouting(category: DocCategory): DocCategoryRouting {
  if ((DOC_ONLY_CATEGORIES as readonly string[]).includes(category)) {
    return DOC_ONLY_ROUTING[category as DocOnlyCategory];
  }
  return { kind: 'examples', category };
}

/**
 * Tag vocabulary for concept explanations (superset of doc categories).
 * `capabilities`, `coremods-mixins` and `toolchain` used to be listed here
 * explicitly; they are members of DOC_CATEGORIES now, so only `mappings`
 * remains additive.
 */
export const CONCEPT_CATEGORIES = [...DOC_CATEGORIES, 'mappings'] as const;

/**
 * Path segments that name a *subject*. First match wins.
 *
 * Keys are matched against segments split on `/`, `:` and `_` — deliberately
 * NOT `-`, because several live slugs depend on the hyphen staying intact
 * (`getting-started`, `class-tweakers`, `transfer-api`, `custom-recipe-types`).
 */
const PATH_SEGMENT_CATEGORIES: Record<string, DocCategory> = {
  // blocks
  blocks: 'blocks',
  block: 'blocks',
  blockstate: 'blocks',
  blockstates: 'blocks',
  directionalblock: 'blocks',
  waterloggable: 'blocks',
  crops: 'blocks',
  blockappearance: 'blocks',
  // tile entities
  tileentity: 'tile-entities',
  tileentities: 'tile-entities',
  blockentity: 'tile-entities',
  blockentities: 'tile-entities',
  blockentityrenderers: 'tile-entities',
  tesr: 'tile-entities',
  // items
  items: 'items',
  item: 'items',
  armor: 'items',
  tools: 'items',
  shield: 'items',
  itemgroup: 'items',
  tooltip: 'items',
  spawn: 'items',
  enchantments: 'items',
  potions: 'items',
  // entities
  entities: 'entities',
  entity: 'entities',
  projectiles: 'entities',
  damagetypes: 'entities',
  // rendering
  render: 'rendering',
  rendering: 'rendering',
  models: 'rendering',
  model: 'rendering',
  textures: 'rendering',
  modularui: 'rendering',
  colorprovider: 'rendering',
  // gui
  gui: 'gui',
  guis: 'gui',
  screen: 'gui',
  screens: 'gui',
  screenhandler: 'gui',
  extendedscreenhandler: 'gui',
  containers: 'gui',
  container: 'gui',
  propertydelegates: 'gui',
  hud: 'gui',
  keybinds: 'gui',
  'key-mappings': 'gui',
  keymappings: 'gui',
  // networking
  networking: 'networking',
  network: 'networking',
  packets: 'networking',
  packet: 'networking',
  // world generation
  worldgen: 'worldgen',
  biomes: 'worldgen',
  biome: 'worldgen',
  chunkgenerator: 'worldgen',
  features: 'worldgen',
  structures: 'worldgen',
  ores: 'worldgen',
  trees: 'worldgen',
  dimensions: 'worldgen',
  dimensionconcepts: 'worldgen',
  jigsaw: 'worldgen',
  // recipes
  recipes: 'recipes',
  recipe: 'recipes',
  'custom-recipe-types': 'recipes',
  // events
  events: 'events',
  event: 'events',
  callbacks: 'events',
  // registry
  registry: 'registry',
  registries: 'registry',
  // capabilities
  capabilities: 'capabilities',
  capability: 'capabilities',
  attachments: 'capabilities',
  'data-attachments': 'capabilities',
  // coremods & mixins
  mixin: 'coremods-mixins',
  mixins: 'coremods-mixins',
  mixinheritance: 'coremods-mixins',
  coremods: 'coremods-mixins',
  coremod: 'coremods-mixins',
  'class-tweakers': 'coremods-mixins',
  accesstransformers: 'coremods-mixins',
  accesswideners: 'coremods-mixins',
  accesswidening: 'coremods-mixins',
  asm: 'coremods-mixins',
  reflection: 'coremods-mixins',
  extensibleenums: 'coremods-mixins',
  featureflags: 'coremods-mixins',
  // api design
  'api-design': 'api-design',
  api: 'api-design',
  behaviour: 'api-design',
  behavior: 'api-design',
  'game-object': 'api-design',
  mtms: 'api-design',
  permissionapi: 'api-design',
  // cross platform
  'cross-platform': 'cross-platform',
  sides: 'cross-platform',
  side: 'cross-platform',
  sidedness: 'cross-platform',
  proxy: 'cross-platform',
  // storage systems
  'storage-systems': 'storage-systems',
  storage: 'storage-systems',
  inventory: 'storage-systems',
  inventories: 'storage-systems',
  fluids: 'storage-systems',
  fluid: 'storage-systems',
  energy: 'storage-systems',
  'transfer-api': 'storage-systems',
  saveddata: 'storage-systems',
  'saved-data': 'storage-systems',
  nbt: 'storage-systems',
  codecs: 'storage-systems',
  codec: 'storage-systems',
  valueio: 'storage-systems',
  // animation, particles, sounds, commands
  animation: 'animation',
  animations: 'animation',
  particles: 'particles',
  particle: 'particles',
  sounds: 'sounds',
  sound: 'sounds',
  commands: 'commands',
  command: 'commands',
  // config
  config: 'config',
  configuration: 'config',
  gamerule: 'config',
  'game-rules': 'config',
  gamerules: 'config',
  'resource-conditions': 'config',
  updatechecker: 'config',
  // getting started
  'getting-started': 'getting-started',
  gettingstarted: 'getting-started',
  setup: 'getting-started',
  introduction: 'getting-started',
  start: 'getting-started',
  install: 'getting-started',
  installation: 'getting-started',
  terms: 'getting-started',
  loadstages: 'getting-started',
  // resources
  resource: 'resources',
  lang: 'resources',
  tags: 'resources',
  'text-and-translations': 'resources',
  translations: 'resources',
  resourcelocation: 'resources',
  identifier: 'resources',
  advancements: 'resources',
  loot: 'resources',
  statistics: 'resources',
  stats: 'resources',
  internationalization: 'resources',
  localization: 'resources',
  oredict: 'registry',
  oredictionary: 'registry',
  // toolchain
  gradle: 'toolchain',
  mappings: 'toolchain',
  kotlin: 'toolchain',
  cursegradle: 'toolchain',
  minotaur: 'toolchain',
  hotswapping: 'toolchain',
  gametest: 'toolchain',
  'automatic-testing': 'toolchain',
  debugging: 'toolchain',
  debugprofiler: 'toolchain',
  'ide-tips-and-tricks': 'toolchain',
  plugins: 'toolchain',
  dependencies: 'toolchain',
  jarsigning: 'toolchain',
  locations: 'toolchain',
  versioning: 'toolchain',
  // porting
  migration: 'porting',
  porting: 'porting',
};

/**
 * Segments that name a *container*, not a subject.
 *
 * These are consulted only after every segment has failed the specific table
 * above, so `/datastorage/capabilities` resolves to `capabilities` rather than
 * being swallowed by its container. This is the same failure `a64e14f` fixed for
 * the versioned-path heuristic, generalized to the segment matcher: NeoForge
 * files whole trees under words like `resources/`, `concepts/`, `advanced/` and
 * `datastorage/`, and matching those eagerly hides the segment that carries the
 * real subject.
 */
const CONTAINER_SEGMENT_CATEGORIES: Record<string, DocCategory> = {
  datastorage: 'datastorage',
  serialization: 'storage-systems',
  resources: 'resources',
  'data-generation': 'resources',
  datagen: 'resources',
  datamaps: 'config',
  loader: 'toolchain',
  loom: 'toolchain',
  toolchain: 'toolchain',
  primer: 'porting',
  porting: 'porting',
  advanced: 'coremods-mixins',
  player: 'getting-started',
  user: 'getting-started',
  'end-user-guide': 'getting-started',
  misc: 'general',
  concepts: 'general',
  tutorial: 'general',
  documentation: 'general',
  community: 'general',
  archive: 'general',
  faq: 'general',
  utilities: 'general',
  conventions: 'general',
  proposal: 'general',
  modpack: 'general',
  'cleanroom-mod-development': 'general',
  'forge-mod-development': 'general',
};

/**
 * Segments that carry no information at any tier — site scaffolding and
 * loader names that appear as path components.
 */
const NOISE_SEGMENTS = new Set([
  'en',
  'docs',
  'wiki',
  'develop',
  'tutorials',
  'legacy',
  'neo',
  'forge',
  'fabric',
  'ng',
]);

/** `1.12.2`, `1.21`, `1.12.x` — a version, never a subject. */
const VERSIONISH = /^\d+(\.\d+)*(\.x)?$/;

/**
 * Split a path into candidate segments.
 *
 * Splitting on `:` and `_` as well as `/` is load-bearing: the Fabric wiki is a
 * DokuWiki whose URLs are colon namespaces (`wiki.fabricmc.net/tutorial:blocks`,
 * `tutorial:blockentity_sync_itemstack`). A `/`-only split made 224 of those
 * pages *structurally* unmatchable — no mapping-table entry could ever reach
 * them — which is why they sat in 'general' through two rounds of remapping.
 */
function splitSegments(path: string): string[] {
  return path
    .split(/[/:_]/)
    .filter(Boolean)
    .filter((s) => !NOISE_SEGMENTS.has(s.toLowerCase()) && !VERSIONISH.test(s));
}

function matchSegments(segments: string[], table: Record<string, DocCategory>): DocCategory | null {
  for (const segment of segments) {
    const category = table[segment.toLowerCase()];
    if (category) {
      return category;
    }
  }
  return null;
}

/**
 * Map URL/repo path segments onto DOC_CATEGORIES. Specific subjects win over
 * containers; 'general' when nothing matches at either tier.
 */
export function categorizeDocPath(segments: string[]): DocCategory {
  const candidates = segments.flatMap((s) => splitSegments(s));
  return (
    matchSegments(candidates, PATH_SEGMENT_CATEGORIES) ??
    matchSegments(candidates, CONTAINER_SEGMENT_CATEGORIES) ??
    DOC_FALLBACK_CATEGORY
  );
}

/**
 * Map a documentation URL onto a DOC_CATEGORIES value.
 *
 * Stage 1 is the versioned-path heuristic (Fabric/NeoForge docs): take the
 * segment immediately after a version number and trust it *only* if it names a
 * specific subject. Stage 2 matches every segment of the path — the shape of the
 * Forge 1.12.x RTD tree ("1.12.x" defeats the version alternation), the
 * Cleanroom wiki routes, and the Fabric DokuWiki namespaces.
 *
 * Stage 1 must not short-circuit on a *container* match, only a specific one.
 * That is the same trap `a64e14f` documented: `/docs/concepts/events` resolved
 * to 'events' via stage 2 while its versioned twins `/docs/1.2x.y/concepts/events`
 * stopped at 'concepts' in stage 1. Stage 1 yields to stage 2 rather than
 * returning a category it has no specific evidence for.
 *
 * Free function rather than a method so the mapping is testable without standing
 * up a crawler, and it lives here rather than in src/indexer/crawler.ts so the
 * startup corpus migration can replay it without pulling the crawler's
 * dependencies into the MCP server process.
 */
export function extractCategoryFromUrl(url: string): DocCategory {
  const match = url.match(
    /https?:\/\/[^/]+\/(?:.*\/)?(?:(?:\d+(?:\.\d+)*|develop)\/([^/]+)|([^/:\\s]+):)/
  );
  if (match?.[1]) {
    const specific = matchSegments(splitSegments(match[1]), PATH_SEGMENT_CATEGORIES);
    if (specific) {
      return specific;
    }
  }

  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  return categorizeDocPath([path]);
}
