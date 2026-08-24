import { describe, it, expect } from 'vitest';
import {
  formatDocCoverage,
  formatDocSearchDiagnostics,
  formatScopeLine,
  type DocSearchRequest,
  type ExampleCounts,
} from './docCoverage.js';
import { summarizeCoverage } from '../services/corpus-coverage.js';
import type { DocCoverageRow } from '../indexer/store.js';
import type { Scope } from '../loaders.js';

function rows(...tuples: Array<[string, string, string | null, number]>): DocCoverageRow[] {
  return tuples.map(([loader, category, minecraftVersion, count]) => ({
    loader,
    category,
    minecraftVersion,
    count,
  }));
}

/** The shipped ratio in miniature: 88 target-scope documents out of 1,432. */
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
  ['neoforge', 'resources', '1.21.4', 36],
  ['neoforge', 'misc', '1.21.4', 224],
  ['neoforge', 'general', '21.9', 20],
  ['neoforge', 'items', '', 422],
  ['fabric', 'general', '1.21.1', 596]
);

const EXAMPLES: ExampleCounts = {
  byCategory: { items: 84, entities: 8, blocks: 238, 'coremods-mixins': 123 },
  total: 1365,
};

function coverage(scope: Scope, extra: { category?: string; minecraftVersion?: string } = {}) {
  return summarizeCoverage(CORPUS, { scope, ...extra });
}

function request(over: Partial<DocSearchRequest> = {}): DocSearchRequest {
  return { query: 'register items', scope: 'target', resultCount: 2, limit: 10, ...over };
}

describe('formatDocCoverage — the footer', () => {
  it('leads with in-scope reach, not the corpus total', () => {
    const out = formatDocCoverage(request(), coverage('target'));
    expect(out).toContain('**88 documents**');
    expect(out.indexOf('88 documents')).toBeLessThan(out.indexOf('1432'));
  });

  it('never presents the corpus total as the reachable figure', () => {
    const out = formatDocCoverage(request(), coverage('target'));
    const scopeLine = out.split('\n').find((l) => l.includes('holds')) ?? '';
    expect(scopeLine).toContain('88');
    expect(scopeLine).not.toContain('1432');
    // The corpus total must always be labelled as the whole corpus.
    expect(out).toMatch(/Whole docs corpus: 1432/);
  });

  it('reports the ceiling when a narrowing filter is active', () => {
    const out = formatDocCoverage(
      request({ category: 'items' }),
      coverage('target', { category: 'items' })
    );
    expect(out).toContain('**Documents this filter can reach: 2**');
  });

  it('omits the ceiling line when no narrowing filter is set', () => {
    const out = formatDocCoverage(request(), coverage('target'));
    expect(out).not.toContain('this filter can reach');
  });

  it('shows the zero-count loader rather than hiding it', () => {
    const out = formatDocCoverage(request(), coverage('target'));
    expect(out).toContain('shared 0');
  });

  it('names the categories a filter can never match at this scope', () => {
    const out = formatDocCoverage(request(), coverage('target'));
    expect(out).toMatch(/\*\*0 documents:\*\*.*entities/);
    expect(out).toMatch(/\*\*0 documents:\*\*.*datastorage/);
  });

  it('advertises only versions reachable in scope', () => {
    const target = formatDocCoverage(request(), coverage('target'));
    expect(target).toContain('Minecraft 1.12.2');
    // '21.9' is the phantom key that matched no document at any scope.
    expect(target).not.toContain('21.9');

    const reference = formatDocCoverage(request({ scope: 'reference' }), coverage('reference'));
    expect(reference).not.toContain('21.9');
  });

  it('caps the version list instead of printing all 29 reference versions', () => {
    const many = rows(
      ...Array.from(
        { length: 12 },
        (_, i) => ['neoforge', 'general', `1.21.${i}`, 1] as [string, string, string, number]
      )
    );
    const out = formatDocCoverage(
      request({ scope: 'reference' }),
      summarizeCoverage(many, { scope: 'reference' })
    );
    expect(out).toContain('(+6 older)');
    expect(out).toContain('1.21.11');
    expect(out).not.toContain('1.21.0');
  });

  it('reconciles categories outside the filter enum', () => {
    const out = formatDocCoverage(request({ scope: 'reference' }), coverage('reference'));
    // 224 `misc` documents no `category` value can express — the shape a corpus
    // built by a different indexer version can still take.
    expect(out).toMatch(/224 in-scope documents sit in categories outside/);
  });
});

describe('formatDocCoverage — the ceiling note (the anti-retry fix)', () => {
  it('states plainly when the corpus is exhausted', () => {
    const out = formatDocCoverage(
      request({ category: 'items', resultCount: 2 }),
      coverage('target', { category: 'items' })
    );
    expect(out).toMatch(/All 2 documents reachable under this filter were returned/);
    expect(out).toMatch(/Rephrasing the query cannot surface more/);
  });

  it('does not fall back to the old "try broader search terms" advice', () => {
    const out = formatDocCoverage(
      request({ category: 'items', resultCount: 2 }),
      coverage('target', { category: 'items' })
    );
    expect(out).not.toMatch(/broader search terms/i);
  });

  it('distinguishes a full page from an exhausted corpus', () => {
    const out = formatDocCoverage(request({ resultCount: 10, limit: 10 }), coverage('target'));
    expect(out).toMatch(/Result limit reached\*\* \(10 of 88 reachable documents\)/);
    expect(out).not.toMatch(/cannot surface more/);
  });

  it('says nothing when there is more to find and room to show it', () => {
    const out = formatDocCoverage(request({ resultCount: 4, limit: 10 }), coverage('target'));
    expect(out).not.toMatch(/cannot surface more/);
    expect(out).not.toMatch(/limit reached/i);
  });

  it('uses singular wording for a single reachable document', () => {
    const out = formatDocCoverage(
      request({ category: 'sounds', resultCount: 1 }),
      coverage('target', { category: 'sounds' })
    );
    expect(out).toMatch(/All 1 document reachable under this filter was returned/);
  });
});

describe('formatDocSearchDiagnostics — empty category', () => {
  it('reports the real count and refuses to blame the query', () => {
    const out = formatDocSearchDiagnostics(
      request({ category: 'entities', resultCount: 0 }),
      coverage('target', { category: 'entities' }),
      EXAMPLES
    );
    expect(out).toContain('`entities` holds 0 of the 88 documents');
    expect(out).toMatch(/can never return results, whatever the query/);
    expect(out).toMatch(/gap in the scraped documentation/);
    // It must not imply 1.12.2 lacks the API.
    expect(out).toMatch(/not evidence that 1\.12\.2 lacks the API/);
  });

  it('routes to the matching examples category with its live count', () => {
    const out = formatDocSearchDiagnostics(
      request({ category: 'entities', resultCount: 0 }),
      coverage('target', { category: 'entities' }),
      EXAMPLES
    );
    expect(out).toContain('search_mod_examples(query: "register items", category: "entities")');
    expect(out).toContain('8 curated examples');
  });

  it('routes coremods-mixins to the identically-named examples category', () => {
    // This used to be a `mixins` → `coremods-mixins` remap. The doc taxonomy is
    // a superset of the examples taxonomy now, so the two corpora share the
    // slug and the routing is an identity — which is the point of converging
    // them: an agent can carry a category name between the tools unchanged.
    const cov = summarizeCoverage(rows(['forge', 'general', '1.12.2', 54]), {
      scope: 'target',
      category: 'coremods-mixins',
    });
    const out = formatDocSearchDiagnostics(
      request({ category: 'coremods-mixins', resultCount: 0 }),
      cov,
      EXAMPLES
    );
    expect(out).toContain('category: "coremods-mixins"');
    expect(out).toContain('123 curated examples');
  });

  it('routes without a category when no examples category answers it', () => {
    const cov = summarizeCoverage(rows(['forge', 'general', '1.12.2', 54]), {
      scope: 'target',
      category: 'getting-started',
    });
    const out = formatDocSearchDiagnostics(
      request({ category: 'getting-started', resultCount: 0 }),
      cov,
      EXAMPLES
    );
    expect(out).toContain('search_mod_examples(query: "register items")');
    expect(out).not.toContain('category: "getting-started"');
  });

  it('degrades to name-only routing when no example counts are available', () => {
    const out = formatDocSearchDiagnostics(
      request({ category: 'entities', resultCount: 0 }),
      coverage('target', { category: 'entities' }),
      undefined
    );
    expect(out).toContain('search_mod_examples');
    expect(out).not.toMatch(/\d+ curated/);
  });
});

describe('formatDocSearchDiagnostics — no results', () => {
  it('blames corpus size rather than the phrasing at target scope', () => {
    const out = formatDocSearchDiagnostics(
      request({ resultCount: 0 }),
      coverage('target'),
      EXAMPLES
    );
    expect(out).toMatch(/88 documents are in scope/);
    expect(out).toMatch(/usually means the topic is undocumented, not that the query was wrong/);
    expect(out).toContain('1365 curated examples');
  });

  it('explains a thin-but-nonempty result set', () => {
    const out = formatDocSearchDiagnostics(
      request({ resultCount: 2 }),
      coverage('target'),
      EXAMPLES
    );
    expect(out).toMatch(/2 of 88 reachable documents scored above the relevance floor/);
  });

  it('stays silent when the results are healthy', () => {
    const out = formatDocSearchDiagnostics(
      request({ resultCount: 7 }),
      coverage('target'),
      EXAMPLES
    );
    expect(out).toBe('');
  });
});

describe('formatScopeLine', () => {
  it('fits the scope disclosure on one line and routes onward', () => {
    const out = formatScopeLine(coverage('target'));
    expect(out).toContain('**88 of 1432 indexed documents**');
    expect(out).toContain('search_mod_examples');
    expect(out.split('\n')).toHaveLength(1);
  });
});
