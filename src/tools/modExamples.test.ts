import { describe, it, expect } from 'vitest';
import {
  MOD_EXAMPLES_TOOLS,
  searchModExamplesTool,
  handleGetModExample,
  formatCategoryTable,
  formatEmptyModExampleSearch,
} from './modExamples.js';
import { EXAMPLE_CATEGORIES } from '../categories.js';
import type { CategoryInfo } from '../services/mod-examples-service.js';

describe('search_mod_examples tool schema', () => {
  it('sources its category enum from EXAMPLE_CATEGORIES (no drift)', () => {
    const props = searchModExamplesTool.inputSchema.properties as {
      category: { enum: string[] };
      loader: { enum: string[] };
    };
    expect([...props.category.enum].sort()).toEqual([...EXAMPLE_CATEGORIES].sort());
  });

  it('exposes a loader filter param (forge | cleanroom)', () => {
    const props = searchModExamplesTool.inputSchema.properties as { loader: { enum: string[] } };
    expect(props.loader.enum).toEqual(['forge', 'cleanroom']);
  });
});

describe('tool copy', () => {
  it('no longer advertises the dead Create / Botania / AE2 corpus', () => {
    const text = JSON.stringify(MOD_EXAMPLES_TOOLS);
    expect(/create|botania|applied energistics/i.test(text)).toBe(false);
  });
});

describe('cross-tool routing', () => {
  it('points back at get_doc_snippet and never at the old get_example name', () => {
    expect(searchModExamplesTool.description).toContain('get_doc_snippet');
    expect(searchModExamplesTool.description).not.toContain('get_example');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Coverage disclosure (beta report N2)
// ─────────────────────────────────────────────────────────────────────────────

/** A CategoryInfo row per slug, with counts overridden by the caller. */
function categories(counts: Record<string, number>): CategoryInfo[] {
  return EXAMPLE_CATEGORIES.map((slug) => ({
    slug,
    name: slug,
    description: `${slug} description`,
    icon: '🔧',
    exampleCount: counts[slug] ?? 50,
  }));
}

describe('formatCategoryTable', () => {
  it('names a zero-count category as unreachable by the filter', () => {
    const out = formatCategoryTable(categories({ capabilities: 0 }), 120);
    expect(out).toContain('Empty categor');
    expect(out).toContain('`capabilities`');
    expect(out).toMatch(/never return results/i);
  });

  it('names thin categories with their counts', () => {
    const out = formatCategoryTable(categories({ sounds: 2, worldgen: 4 }), 0);
    expect(out).toContain('Thin categories');
    expect(out).toContain('`sounds` (2)');
    expect(out).toContain('`worldgen` (4)');
  });

  it('adds no caveat lines when every category is populated', () => {
    const out = formatCategoryTable(categories({}), 0);
    expect(out).not.toContain('Empty categor');
    expect(out).not.toContain('Thin categories');
  });

  it('still reconciles the counts to the corpus total', () => {
    // 21 categories × 50, minus the two overrides, plus 120 uncategorized.
    const out = formatCategoryTable(categories({ capabilities: 0, sounds: 2 }), 120);
    expect(out).toContain(`${19 * 50 + 2 + 120} examples total`);
    expect(out).toContain('120 are uncategorized');
  });
});

describe('formatEmptyModExampleSearch', () => {
  it('reports the true count when the filtered category is empty', () => {
    const out = formatEmptyModExampleSearch(
      { query: 'capability provider', category: 'capabilities' },
      categories({ capabilities: 0 }),
      120
    );
    expect(out).toContain('`capabilities`');
    expect(out).toContain('0 of the');
    expect(out).toMatch(/never return results/i);
    // The point of N2: the agent must not read this as "1.12.2 has no such thing".
    expect(out).toMatch(/gap in the\s+corpus/);
    // The generic advice is actively misleading here — a broader query cannot help.
    expect(out).not.toContain('Try broader search terms');
  });

  it('points the agent at the query that would actually work', () => {
    const out = formatEmptyModExampleSearch(
      { category: 'capabilities' },
      categories({ capabilities: 0, blocks: 238 }),
      120
    );
    expect(out).toContain('without `category`');
    expect(out).toContain('`blocks` (238)');
    expect(out).toContain('120 uncategorized');
  });

  it('blames the other filters when the category is populated', () => {
    const out = formatEmptyModExampleSearch(
      { query: 'zzzz', category: 'blocks', loader: 'cleanroom' },
      categories({ blocks: 238 }),
      0
    );
    expect(out).toContain('`blocks` category holds 238 examples');
    expect(out).toContain('`min_quality` ≥ 0.5');
    expect(out).toContain('loader `cleanroom`');
    expect(out).toContain('Try broader search terms');
  });

  it('surfaces the min_quality default that silently filters half the corpus', () => {
    const out = formatEmptyModExampleSearch({ query: 'zzzz' }, categories({}), 0);
    expect(out).toContain('currently 0.5');
    expect(out).toContain('Try broader search terms');
  });

  it('reports an explicit min_quality rather than the default', () => {
    const out = formatEmptyModExampleSearch({ query: 'zzzz', min_quality: 0.9 }, categories({}), 0);
    expect(out).toContain('currently 0.9');
  });

  it('treats a category missing from the DB rows as empty', () => {
    // An older DB may predate a category the enum already offers.
    const rows = categories({}).filter((c) => c.slug !== 'capabilities');
    const out = formatEmptyModExampleSearch({ category: 'capabilities' }, rows, 0);
    expect(out).toMatch(/never return results/i);
  });
});

describe('get_mod_example dispatch validation', () => {
  it('treats a missing id as a validation error, not id=0', () => {
    const res = handleGetModExample({} as { id: number });
    expect(res.isError).toBe(true);
    const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(/invalid|required/i.test(text)).toBe(true);
    expect(text).not.toMatch(/example 0/i);
  });
});
