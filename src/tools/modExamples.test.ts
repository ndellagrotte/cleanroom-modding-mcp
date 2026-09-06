import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type * as ModExampleTools from './modExamples.js';
import {
  searchModExamplesTool,
  handleGetModExample,
  formatCategoryTable,
  formatEmptyModExampleSearch,
  formatQualitySuppression,
} from './modExamples.js';
import { EXAMPLE_CATEGORIES } from '../categories.js';
import type { CategoryInfo } from '../services/mod-examples-service.js';
import { DBS } from '../dbs.js';
import { initializeExamplesDb } from '../examples/schema.js';
import { exampleRecord, writeExampleFixture } from '../examples/test-fixture.js';
import { ModExamplesService } from '../services/mod-examples-service.js';

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
    const out = formatCategoryTable(categories({ capabilities: 0, sounds: 2 }), 120);
    expect(out).toContain(`${(EXAMPLE_CATEGORIES.length - 2) * 50 + 2 + 120} examples total`);
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

describe('quality suppression disclosure', () => {
  it('states the active threshold and exact suppressed count', () => {
    expect(formatQualitySuppression(0.5, 827)).toContain(
      '`min_quality` ≥ 0.5 suppressed 827 otherwise-matching examples'
    );
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

describe('mod example handlers with isolated databases', () => {
  let dir: string;
  let dbPath: string;
  let savedDataDir: string | undefined;
  let tools: typeof ModExampleTools;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'example-tools-'));
    dbPath = path.join(dir, DBS.examples.fileName);
    savedDataDir = process.env.CLEANROOM_MCP_DATA_DIR;
    process.env.CLEANROOM_MCP_DATA_DIR = dir;
    vi.resetModules();
    // The service captures its default DB path at module load; import after isolating the env.
    tools = await import('./modExamples.js');
  });

  afterEach(() => {
    if (savedDataDir === undefined) {
      delete process.env.CLEANROOM_MCP_DATA_DIR;
    } else {
      process.env.CLEANROOM_MCP_DATA_DIR = savedDataDir;
    }
    vi.resetModules();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function text(result: CallToolResult): string {
    expect(result.isError).not.toBe(true);
    return result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
  }

  function fixtureId(title: string): number {
    const service = new ModExamplesService(dbPath);
    try {
      const example = service.searchExamples({ limit: 200 }).find((row) => row.title === title);
      if (!example) throw new Error(`Missing fixture example: ${title}`);
      return example.id;
    } finally {
      service.close();
    }
  }

  it('renders class concepts as mappings calls and prose concepts as target documentation calls', () => {
    writeExampleFixture(dbPath, [
      exampleRecord('Block setup', {
        minecraftConcepts: ['Block', 'Material', 'CreativeTabs', 'block registration'],
      }),
    ]);

    const output = text(tools.handleGetModExample({ id: fixtureId('Block setup') }));
    for (const concept of ['Block', 'Material', 'CreativeTabs']) {
      expect(output).toContain(`resolve_symbol(symbol: "${concept}", minecraft_version: "1.12.2")`);
      expect(output).toContain(
        `get_class_details(class_name: "${concept}", minecraft_version: "1.12.2")`
      );
    }
    expect(output).toContain('search_docs(query: "block registration", scope: "target")');
  });

  it('renders persisted related examples only when requested', () => {
    writeExampleFixture(dbPath, [
      exampleRecord('Source block', { patternType: 'block-registration' }),
      exampleRecord('Related block', { patternType: 'block-registration' }),
    ]);
    const sourceId = fixtureId('Source block');
    const relatedId = fixtureId('Related block');

    const output = text(tools.handleGetModExample({ id: sourceId, include_related: true }));
    expect(output).toContain('## Related Examples');
    expect(output).toContain(`(ID: ${relatedId}, strength: 85%)`);
    expect(output).toContain('- Related block');

    const withoutRelated = text(
      tools.handleGetModExample({ id: sourceId, include_related: false })
    );
    expect(withoutRelated).not.toContain('## Related Examples');
    expect(withoutRelated).not.toContain('Related block');
  });

  it('excludes an identifier-only prose near-miss while returning a capability provider', () => {
    writeExampleFixture(dbPath, [
      exampleRecord('Capability provider implementation', {
        code: 'class Provider implements ICapabilityProvider {}',
        qualityScore: 0.6,
      }),
      exampleRecord('ICapabilityProvider ASM transformer', {
        caption: 'Rewrites bytecode using a class visitor.',
        qualityScore: 0.99,
      }),
    ]);

    const output = text(
      tools.handleSearchModExamples({
        query: 'capability provider ICapabilityProvider',
        limit: 5,
      })
    );
    expect(output).toContain(`**ID:** ${fixtureId('Capability provider implementation')} |`);
    expect(output).toContain('class Provider implements ICapabilityProvider');
    expect(output).not.toContain(`**ID:** ${fixtureId('ICapabilityProvider ASM transformer')} |`);
    expect(output).not.toContain('ASM transformer');
  });

  it('bounds pattern output and accurately reports eligible types and singleton suppression', () => {
    const db = initializeExamplesDb(dbPath);
    try {
      const mod = db
        .prepare('INSERT INTO mods (name, repo, loader, license) VALUES (?, ?, ?, ?)')
        .run('Fixture', 'fixture/patterns', 'forge', 'MIT');
      const insert = db.prepare(
        'INSERT INTO examples (mod_id, title, pattern_type) VALUES (?, ?, ?)'
      );
      // Synthetic labels exercise pagination independently of the evolving canonical taxonomy.
      for (let index = 0; index < 46; index++) {
        const pattern = `fixture-${String(index).padStart(2, '0')}`;
        const count = index === 0 ? 4 : index === 1 ? 3 : index < 43 ? 2 : 1;
        for (let example = 0; example < count; example++) {
          insert.run(mod.lastInsertRowid, `${pattern} example ${example}`, pattern);
        }
      }
    } finally {
      db.close();
    }

    const output = text(tools.handleGetModPatterns());
    const rows = output.match(/^\| `[^`]+` \| \d+ \|$/gm) ?? [];
    expect(rows).toHaveLength(40);
    expect(rows.slice(0, 2)).toEqual(['| `fixture-00` | 4 |', '| `fixture-01` | 3 |']);
    expect(output).toContain('Showing 40 of 46 pattern types; 3 have a single example.');
    expect(output).toContain('43 meet `min_count` ≥ 2.');
    expect(output).not.toContain('| `fixture-43` |');

    const restricted = text(tools.handleGetModPatterns({ limit: 1, min_count: 3 }));
    expect(restricted.match(/^\| `[^`]+` \| \d+ \|$/gm)).toEqual(['| `fixture-00` | 4 |']);
    expect(restricted).toContain('Showing 1 of 46 pattern types; 3 have a single example.');
    expect(restricted).toContain('2 meet `min_count` ≥ 3.');

    const all = text(tools.handleGetModPatterns({ limit: 200, min_count: 1 }));
    expect(all.match(/^\| `[^`]+` \| \d+ \|$/gm)).toHaveLength(46);
    expect(all).toContain('| `fixture-45` | 1 |');
  });

  it('successfully lists zero patterns for empty and entirely unlabeled current-schema databases', () => {
    initializeExamplesDb(dbPath).close();

    const empty = text(tools.handleGetModPatterns());
    expect(empty).toContain('Showing 0 of 0 pattern types; 0 have a single example.');
    expect(empty).toContain('0 meet `min_count` ≥ 2.');
    expect(empty.match(/^\| `[^`]+` \| \d+ \|$/gm) ?? []).toEqual([]);

    const db = initializeExamplesDb(dbPath);
    try {
      const mod = db
        .prepare('INSERT INTO mods (name, repo, loader, license) VALUES (?, ?, ?, ?)')
        .run('Fixture', 'fixture/unlabeled', 'forge', 'MIT');
      db.prepare('INSERT INTO examples (mod_id, title) VALUES (?, ?)').run(
        mod.lastInsertRowid,
        'No pattern label'
      );
    } finally {
      db.close();
    }

    const unlabeled = text(tools.handleGetModPatterns({ min_count: 1 }));
    expect(unlabeled).toContain('Showing 0 of 0 pattern types; 0 have a single example.');
    expect(unlabeled.match(/^\| `[^`]+` \| \d+ \|$/gm) ?? []).toEqual([]);
  });
});
