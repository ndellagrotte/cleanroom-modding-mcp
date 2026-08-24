/**
 * Category taxonomy drift guards: the schema enums published by tools must
 * stay subsets of the central lists, and 1.12.2-era edits must hold.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import {
  DOC_CATEGORIES,
  DOC_CATEGORY_ENUM,
  DOC_ONLY_CATEGORIES,
  docCategoryRouting,
  EXAMPLE_CATEGORIES,
  EXAMPLE_CATEGORY_INFO,
  CONCEPT_CATEGORIES,
  THIN_CATEGORY_THRESHOLD,
  auditCategoryCoverage,
  buildCategoryPromptBlock,
  categorizeDocPath,
  summarizeGeneralShare,
  DOC_FALLBACK_CATEGORY,
} from './categories.js';
import { CATEGORY_LIST_PLACEHOLDER, renderPromptTemplate } from './examples/analyze.js';
import { getAvailableCategories } from './tools/searchDocs.js';

describe('doc categories', () => {
  it('DOC_CATEGORY_ENUM is DOC_CATEGORIES plus "all"', () => {
    expect(DOC_CATEGORY_ENUM).toEqual([...DOC_CATEGORIES, 'all']);
  });

  it('includes the crawler fallback category "general"', () => {
    expect(DOC_CATEGORIES).toContain('general');
  });

  it('getAvailableCategories returns the central list', () => {
    expect(getAvailableCategories()).toEqual([...DOC_CATEGORIES]);
  });

  it('has no duplicates', () => {
    expect(new Set(DOC_CATEGORIES).size).toBe(DOC_CATEGORIES.length);
  });

  it('uses exactly the same category set as mod examples', () => {
    expect(DOC_CATEGORIES).toEqual(EXAMPLE_CATEGORIES);
  });

  it('routes implementation categories to the same examples category', () => {
    for (const slug of EXAMPLE_CATEGORIES.filter(
      (category) => !DOC_ONLY_CATEGORIES.includes(category as never)
    )) {
      expect(docCategoryRouting(slug)).toEqual({ kind: 'examples', category: slug });
    }
  });

  it('gives every docs-primary category somewhere to send the agent', () => {
    for (const slug of DOC_ONLY_CATEGORIES) {
      const routing = docCategoryRouting(slug);
      expect(['free-text', 'porting-tools']).toContain(routing.kind);
    }
  });
});

describe('example categories (1.12.2 edits)', () => {
  it('drops data-generation (datagen does not exist in 1.12.2)', () => {
    expect(EXAMPLE_CATEGORIES).not.toContain('data-generation');
  });

  it('adds capabilities and coremods-mixins', () => {
    expect(EXAMPLE_CATEGORIES).toContain('capabilities');
    expect(EXAMPLE_CATEGORIES).toContain('coremods-mixins');
  });

  it('has no duplicates', () => {
    expect(new Set(EXAMPLE_CATEGORIES).size).toBe(EXAMPLE_CATEGORIES.length);
  });
});

describe('auditCategoryCoverage', () => {
  /** Every category populated well past the thin threshold. */
  const healthy = (): Record<string, number> =>
    Object.fromEntries(EXAMPLE_CATEGORIES.map((slug) => [slug, 100]));

  it('reports nothing for a corpus that populates every category', () => {
    expect(auditCategoryCoverage(healthy())).toEqual({ empty: [], thin: [] });
  });

  it('treats an absent key as zero, not as unknown', () => {
    const counts = healthy();
    delete counts.capabilities;
    expect(auditCategoryCoverage(counts).empty).toEqual(['capabilities']);
  });

  it('counts an explicit zero as empty, never as thin', () => {
    const { empty, thin } = auditCategoryCoverage({ ...healthy(), capabilities: 0 });
    expect(empty).toEqual(['capabilities']);
    expect(thin).toEqual([]);
  });

  it('places the thin boundary just under THIN_CATEGORY_THRESHOLD', () => {
    const { thin } = auditCategoryCoverage({
      ...healthy(),
      sounds: THIN_CATEGORY_THRESHOLD - 1,
      commands: THIN_CATEGORY_THRESHOLD,
    });
    expect(thin).toEqual([{ slug: 'sounds', count: THIN_CATEGORY_THRESHOLD - 1 }]);
  });

  it('returns empties in EXAMPLE_CATEGORIES order, not insertion order', () => {
    // 'items' precedes 'capabilities' in the registry; the map lists it last.
    expect(auditCategoryCoverage({ ...healthy(), capabilities: 0, items: 0 }).empty).toEqual([
      'items',
      'capabilities',
    ]);
  });

  it('ignores counts for slugs outside the taxonomy', () => {
    // 'data-generation' is a DOC category, deliberately absent from the example
    // taxonomy — a zero there must not be reported against the example corpus.
    expect(auditCategoryCoverage({ ...healthy(), 'data-generation': 0, nonsense: 3 })).toEqual({
      empty: [],
      thin: [],
    });
  });

  it('reproduces the shipped corpus verdict', () => {
    // Per-category counts read from the shipped examples.db. The earlier
    // snapshot here recorded `capabilities` as empty; the LLM re-analysis has
    // since populated it (21), so the corpus now has no empty category at all —
    // only thin ones.
    const shipped: Record<string, number> = {
      'coremods-mixins': 195,
      rendering: 170,
      blocks: 163,
      'tile-entities': 156,
      events: 103,
      items: 84,
      'cross-platform': 80,
      gui: 69,
      registry: 56,
      networking: 50,
      'api-design': 30,
      'storage-systems': 29,
      capabilities: 21,
      recipes: 20,
      worldgen: 15,
      config: 12,
      entities: 8,
      particles: 8,
      commands: 7,
      sounds: 5,
      animation: 2,
    };
    const { empty, thin } = auditCategoryCoverage(shipped);
    expect(empty).toEqual([
      'getting-started',
      'resources',
      'datastorage',
      'toolchain',
      'porting',
      'general',
    ]);
    expect([...thin].map((t) => t.slug).sort()).toEqual([
      'animation',
      'commands',
      'entities',
      'particles',
      'sounds',
    ]);
  });
});

describe('concept categories', () => {
  it('is a superset of doc categories', () => {
    for (const cat of DOC_CATEGORIES) {
      expect(CONCEPT_CATEGORIES).toContain(cat);
    }
  });
});

describe('categorizeDocPath', () => {
  it('maps RTD 1.12.x segments', () => {
    // 'concepts' is a container, so the subject inside it wins.
    expect(categorizeDocPath(['concepts', 'registries'])).toBe('registry');
    expect(categorizeDocPath(['gettingstarted'])).toBe('getting-started');
    expect(categorizeDocPath(['models', 'files'])).toBe('rendering');
    expect(categorizeDocPath(['tileentities', 'tesr'])).toBe('tile-entities');
  });

  it('maps Cleanroom wiki route segments (first hit wins)', () => {
    expect(categorizeDocPath(['forge-mod-development', 'event'])).toBe('events');
    expect(categorizeDocPath(['forge-mod-development', 'mixin', 'preface'])).toBe(
      'coremods-mixins'
    );
    expect(categorizeDocPath(['modularui', 'json', 'theme'])).toBe('rendering');
    expect(categorizeDocPath(['forge-mod-development', 'sidedness'])).toBe('cross-platform');
  });

  it('prefers a specific segment over the container it sits in', () => {
    // The whole point of the two-tier match: 'datastorage' has a container
    // mapping, but 'capabilities' names the actual subject.
    expect(categorizeDocPath(['datastorage', 'capabilities'])).toBe('capabilities');
    expect(categorizeDocPath(['misc', 'config'])).toBe('config');
    // …and the container still answers when nothing specific is present.
    expect(categorizeDocPath(['datastorage'])).toBe('datastorage');
    expect(categorizeDocPath(['misc'])).toBe('general');
  });

  it('splits DokuWiki colon namespaces and underscore slugs', () => {
    expect(categorizeDocPath(['tutorial:blocks'])).toBe('blocks');
    expect(categorizeDocPath(['tutorial:blockentity_sync_itemstack'])).toBe('tile-entities');
    expect(categorizeDocPath(['tutorial:mixin_injects'])).toBe('coremods-mixins');
  });

  it('always returns a DOC_CATEGORIES value', () => {
    expect(DOC_CATEGORIES).toContain(categorizeDocPath(['end-user-guide', 'introduction']));
    expect(categorizeDocPath([])).toBe('general');
  });
});

describe('summarizeGeneralShare', () => {
  it('is the fallback categorizeDocPath actually returns', () => {
    expect(categorizeDocPath(['nothing', 'matches', 'here'])).toBe(DOC_FALLBACK_CATEGORY);
    expect(DOC_CATEGORIES).toContain(DOC_FALLBACK_CATEGORY);
  });

  it('totals the fallback bucket across loaders', () => {
    const share = summarizeGeneralShare([
      { loader: 'neoforge', category: 'general', count: 381 },
      { loader: 'neoforge', category: 'rendering', count: 200 },
      { loader: 'fabric', category: 'general', count: 307 },
      { loader: 'fabric', category: 'items', count: 100 },
    ]);
    expect(share.general).toBe(688);
    expect(share.total).toBe(988);
  });

  it('sums the several rows one loader/category pair spans', () => {
    // getCoverage() groups by (loader, category, minecraft_version), so one
    // category shows up once per version rather than once overall.
    const share = summarizeGeneralShare([
      { loader: 'neoforge', category: 'general', count: 10 },
      { loader: 'neoforge', category: 'general', count: 10 },
      { loader: 'neoforge', category: 'general', count: 9 },
    ]);
    expect(share.general).toBe(29);
    expect(share.byLoader).toEqual([{ loader: 'neoforge', general: 29, total: 29 }]);
  });

  it('orders loaders by corpus size, largest first', () => {
    const share = summarizeGeneralShare([
      { loader: 'cleanroom', category: 'general', count: 12 },
      { loader: 'cleanroom', category: 'rendering', count: 22 },
      { loader: 'neoforge', category: 'general', count: 381 },
      { loader: 'neoforge', category: 'blocks', count: 367 },
      { loader: 'forge', category: 'general', count: 16 },
    ]);
    expect(share.byLoader.map((row) => row.loader)).toEqual(['neoforge', 'cleanroom', 'forge']);
    expect(share.byLoader[0]).toEqual({ loader: 'neoforge', general: 381, total: 748 });
  });

  it('reports zeroes rather than dividing by nothing on an empty corpus', () => {
    expect(summarizeGeneralShare([])).toEqual({ general: 0, total: 0, byLoader: [] });
  });

  it('counts a corpus with no fallback documents at zero, not as missing', () => {
    const share = summarizeGeneralShare([{ loader: 'forge', category: 'items', count: 54 }]);
    expect(share.general).toBe(0);
    expect(share.byLoader).toEqual([{ loader: 'forge', general: 0, total: 54 }]);
  });

  it('stays under the 60% build ceiling on the post-fix corpus', () => {
    // Frozen from data/docs.db after the stage-1 fall-through landed. If a
    // future crawler change pushes this over 0.6, scripts/index-docs.ts exits 4
    // and this test says so first.
    const share = summarizeGeneralShare([
      { loader: 'neoforge', category: 'general', count: 381 },
      { loader: 'neoforge', category: 'other', count: 367 },
      { loader: 'fabric', category: 'general', count: 307 },
      { loader: 'fabric', category: 'other', count: 289 },
      { loader: 'forge', category: 'general', count: 16 },
      { loader: 'forge', category: 'other', count: 38 },
      { loader: 'cleanroom', category: 'general', count: 12 },
      { loader: 'cleanroom', category: 'other', count: 22 },
    ]);
    expect(share.total).toBe(1432);
    expect(share.general).toBe(716);
    expect(share.general / share.total).toBeLessThan(0.6);
  });
});

describe('buildCategoryPromptBlock', () => {
  const block = buildCategoryPromptBlock();

  it('renders every slug with its description', () => {
    for (const slug of EXAMPLE_CATEGORIES) {
      expect(block).toContain(`\`${slug}\``);
      expect(block).toContain(EXAMPLE_CATEGORY_INFO[slug].description);
    }
    expect(block.split('\n')).toHaveLength(EXAMPLE_CATEGORIES.length);
  });

  it('is what the committed analysis prompt actually consumes', () => {
    // The v1 prompt hand-copied the slug list as prose, so the taxonomy the
    // model saw could drift from EXAMPLE_CATEGORIES with nothing failing.
    // Substitution is now the only path — assert the placeholder is still there.
    const promptPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'examples/prompts/analyze-snippet.v2.md'
    );
    const template = fs.readFileSync(promptPath, 'utf-8');
    expect(template).toContain(CATEGORY_LIST_PLACEHOLDER);
    expect(renderPromptTemplate(template)).toContain(block);
  });
});
