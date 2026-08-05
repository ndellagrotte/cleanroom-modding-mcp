import { describe, it, expect } from 'vitest';
import {
  summarizeCoverage,
  categoryCount,
  expandVersionFilter,
  pickLatestVersion,
} from './corpus-coverage.js';
import type { DocCoverageRow } from '../indexer/store.js';

/** Terse row builder: [loader, category, version, count]. */
function rows(...tuples: Array<[string, string, string | null, number]>): DocCoverageRow[] {
  return tuples.map(([loader, category, minecraftVersion, count]) => ({
    loader,
    category,
    minecraftVersion,
    count,
  }));
}

/**
 * The shipped corpus in miniature: 88 target-scope documents against 1,432
 * total, which is the exact ratio that made the old footer misleading.
 */
const CORPUS = rows(
  ['forge', 'rendering', '1.12.2', 20],
  ['forge', 'general', '1.12.2', 16],
  ['forge', 'blocks', '1.12.2', 5],
  ['forge', 'getting-started', '1.12.2', 5],
  ['forge', 'networking', '1.12.2', 4],
  ['forge', 'items', '1.12.2', 2],
  ['forge', 'sounds', '1.12.2', 1],
  ['forge', 'events', '1.12.2', 1],
  ['cleanroom', 'rendering', '1.12.2', 15],
  ['cleanroom', 'general', '1.12.2', 12],
  ['cleanroom', 'mixins', '1.12.2', 5],
  ['cleanroom', 'networking', '1.12.2', 1],
  ['cleanroom', 'events', '1.12.2', 1],
  ['neoforge', 'entities', '1.21.11', 46],
  ['neoforge', 'commands', '1.21.11', 15],
  ['neoforge', 'data-generation', '1.21.4', 36],
  ['neoforge', 'resources', '1.21.4', 224],
  ['neoforge', 'misc', '', 54],
  ['neoforge', 'general', '21.9', 20],
  ['neoforge', 'items', null, 353],
  ['fabric', 'items', '1.21.11', 117],
  ['fabric', 'general', '1.21.1', 479]
);

const TARGET_TOTAL = 88;
const CORPUS_TOTAL = 1432;

/** Unfiltered coverage for a scope. */
function cov(scope: 'target' | 'reference' | 'all') {
  return summarizeCoverage(CORPUS, { scope });
}

describe('summarizeCoverage — scope arithmetic', () => {
  it('counts only the target family at the default scope', () => {
    const cov = summarizeCoverage(CORPUS, { scope: 'target' });
    expect(cov.inScope).toBe(TARGET_TOTAL);
    expect(cov.corpusDocuments).toBe(CORPUS_TOTAL);
    expect(cov.outOfScope).toBe(CORPUS_TOTAL - TARGET_TOTAL);
  });

  it('reports per-loader counts, keeping zero-count loaders visible', () => {
    const cov = summarizeCoverage(CORPUS, { scope: 'target' });
    expect(cov.loaders).toEqual([
      { loader: 'cleanroom', count: 34 },
      { loader: 'forge', count: 54 },
      // `shared` is an offered `loader` value backed by nothing — dropping the
      // row would hide exactly the gap this change exists to disclose.
      { loader: 'shared', count: 0 },
    ]);
  });

  it('reconciles: in-scope plus out-of-scope is the corpus total', () => {
    for (const scope of ['target', 'reference', 'all'] as const) {
      const cov = summarizeCoverage(CORPUS, { scope });
      expect(cov.inScope + cov.outOfScope).toBe(cov.corpusDocuments);
    }
  });

  it('an explicit loader overrides the scope', () => {
    const cov = summarizeCoverage(CORPUS, { scope: 'target', loader: 'cleanroom' });
    expect(cov.inScope).toBe(34);
    expect(cov.loaders).toEqual([{ loader: 'cleanroom', count: 34 }]);
  });
});

describe('summarizeCoverage — categories', () => {
  it('names the categories a target-scope filter can never match', () => {
    const cov = summarizeCoverage(CORPUS, { scope: 'target' });
    expect(cov.emptyCategories).toEqual(['entities', 'data-generation', 'commands']);
  });

  it('keeps off-enum categories counted separately, never folded into general', () => {
    const cov = summarizeCoverage(CORPUS, { scope: 'reference' });
    // `resources` 224 + `misc` 54 are unreachable by the `category` filter.
    expect(cov.offTaxonomy).toBe(278);
    expect(categoryCount(cov, 'resources')).toBe(224);
    // 479 fabric + 20 neoforge — the off-enum rows did not leak in.
    expect(categoryCount(cov, 'general')).toBe(499);
  });

  it('marks enum membership so the formatter can explain unreachability', () => {
    const cov = summarizeCoverage(CORPUS, { scope: 'reference' });
    expect(cov.categories.find((c) => c.category === 'resources')?.inEnum).toBe(false);
    expect(cov.categories.find((c) => c.category === 'items')?.inEnum).toBe(true);
  });

  it('flags thin categories without calling them empty', () => {
    const cov = summarizeCoverage(CORPUS, { scope: 'target' });
    const sounds = cov.thinCategories.find((t) => t.slug === 'sounds');
    expect(sounds).toEqual({ slug: 'sounds', count: 1 });
    expect(cov.emptyCategories).not.toContain('sounds');
  });
});

describe('summarizeCoverage — inFilter is the result ceiling', () => {
  it('narrows to the intersection of scope and category', () => {
    const cov = summarizeCoverage(CORPUS, { scope: 'target', category: 'items' });
    expect(cov.inFilter).toBe(2);
    // The scope figure is unaffected by the category filter.
    expect(cov.inScope).toBe(TARGET_TOTAL);
  });

  it('is zero for a category that holds nothing in scope', () => {
    const cov = summarizeCoverage(CORPUS, { scope: 'target', category: 'entities' });
    expect(cov.inFilter).toBe(0);
    expect(cov.inScope).toBe(TARGET_TOTAL);
  });

  it("treats category 'all' as no filter", () => {
    const cov = summarizeCoverage(CORPUS, { scope: 'target', category: 'all' });
    expect(cov.inFilter).toBe(TARGET_TOTAL);
  });

  it('applies the same version semantics the SQL uses', () => {
    // Exact match for a three-segment version.
    expect(
      summarizeCoverage(CORPUS, { scope: 'target', minecraftVersion: '1.12.2' }).inFilter
    ).toBe(TARGET_TOTAL);
    // Two-segment versions prefix-match: 1.21 reaches 1.21.11, 1.21.4 and 1.21.1.
    const prefixed = summarizeCoverage(CORPUS, { scope: 'reference', minecraftVersion: '1.21' });
    expect(prefixed.inFilter).toBe(46 + 15 + 36 + 224 + 117 + 479);
    // ...and not the loader-versioned or untagged rows.
    expect(prefixed.inFilter).toBeLessThan(cov('reference').inScope);
  });

  it('combines category and version', () => {
    const cov = summarizeCoverage(CORPUS, {
      scope: 'reference',
      category: 'items',
      minecraftVersion: '1.21.11',
    });
    expect(cov.inFilter).toBe(117);
  });
});

describe('summarizeCoverage — versions', () => {
  it('offers only versions reachable in scope', () => {
    const cov = summarizeCoverage(CORPUS, { scope: 'target' });
    expect(cov.versions).toEqual(['1.12.2']);
  });

  it('never advertises loader versions or empty version tags', () => {
    const cov = summarizeCoverage(CORPUS, { scope: 'reference' });
    // '21.9' is the phantom key from the beta report; '' is stored for 54 rows.
    expect(cov.versions).not.toContain('21.9');
    expect(cov.versions).not.toContain('');
    expect(cov.versions[0]).toBe('1.21.11');
  });

  it('accounts for documents with no usable version rather than dropping them', () => {
    const cov = summarizeCoverage(CORPUS, { scope: 'reference' });
    expect(cov.unversionedInScope).toBe(54 + 20 + 353);
  });
});

describe('summarizeCoverage — forward compatibility', () => {
  it('preserves loader ids that are not in the registry', () => {
    const cov = summarizeCoverage(rows(['quilt', 'blocks', '1.20.1', 7]), { scope: 'all' });
    expect(cov.corpusLoaders).toContain('quilt');
    expect(cov.corpusDocuments).toBe(7);
  });

  it('handles an empty corpus without dividing by zero or throwing', () => {
    const cov = summarizeCoverage([], { scope: 'target' });
    expect(cov.inScope).toBe(0);
    expect(cov.corpusDocuments).toBe(0);
    expect(cov.emptyCategories.length).toBeGreaterThan(0);
  });
});

describe('version helpers', () => {
  it('expands two-segment versions to a prefix and leaves three exact', () => {
    expect(expandVersionFilter('1.21')).toBe('1.21%');
    expect(expandVersionFilter('1.12.2')).toBe('1.12.2');
  });

  it("resolves 'latest' to a Minecraft version, not a loader version", () => {
    // The naive numeric max here is 26.2 — a loader version matching ~1 document.
    expect(pickLatestVersion(['26.2', '21.9', '1.21.11', '1.12.2'])).toBe('1.21.11');
  });

  it('falls back to the newest value when nothing is Minecraft-shaped', () => {
    expect(pickLatestVersion(['26.2', '21.9'])).toBe('26.2');
    expect(pickLatestVersion([])).toBeUndefined();
  });
});
