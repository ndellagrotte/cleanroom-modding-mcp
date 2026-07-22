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
