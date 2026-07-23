import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { buildGoldenDb } from './golden-fixture.js';
import { ModExamplesService } from '../services/mod-examples-service.js';

let dir: string;
let goldenDb: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examples-golden-test-'));
  goldenDb = path.join(dir, 'examples.db');
  await buildGoldenDb(goldenDb);
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function sq<T = { [k: string]: unknown }>(sql: string): T {
  const db = new Database(goldenDb, { readonly: true });
  try {
    return db.prepare(sql).get() as T;
  } finally {
    db.close();
  }
}

describe('golden DB shape & content', () => {
  it('has both a forge and a cleanroom mod', () => {
    expect(sq<{ c: number }>('SELECT COUNT(*) c FROM mods').c).toBe(2);
    expect(sq<{ c: number }>("SELECT COUNT(*) c FROM mods WHERE loader='forge'").c).toBe(1);
    expect(sq<{ c: number }>("SELECT COUNT(*) c FROM mods WHERE loader='cleanroom'").c).toBe(1);
  });

  it('leaves example_relations empty in v1', () => {
    expect(sq<{ c: number }>('SELECT COUNT(*) c FROM example_relations').c).toBe(0);
  });

  it('records provenance metadata incl. schema_version 2', () => {
    const db = new Database(goldenDb, { readonly: true });
    for (const k of [
      'schema_version',
      'analysis_version',
      'prompt_version',
      'llm_model',
      'roster_pins',
      'license_review',
      'indexed_at',
      'counts',
    ]) {
      expect(db.prepare('SELECT 1 FROM metadata WHERE key=?').get(k)).toBeDefined();
    }
    expect(db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()).toEqual({
      value: '2',
    });
    db.close();
  });

  it('never stores an example whose mod has no license', () => {
    expect(
      sq<{ c: number }>(
        "SELECT COUNT(*) c FROM examples e JOIN mods m ON m.id=e.mod_id WHERE m.license IS NULL OR m.license=''"
      ).c
    ).toBe(0);
  });

  it('resolves SRG tokens at index time (func_180495_p -> getBlockState)', () => {
    expect(
      sq<{ c: number }>('SELECT COUNT(*) c FROM api_references WHERE srg_name IS NOT NULL').c
    ).toBeGreaterThanOrEqual(1);
    expect(
      sq<{ resolved_name: string }>(
        "SELECT resolved_name FROM api_references WHERE srg_name='func_180495_p' LIMIT 1"
      ).resolved_name
    ).toBe('getBlockState');
  });

  it('links framework symbols to cleanroom-api (api_fqn/api_kind in the frozen set)', () => {
    expect(
      sq<{ c: number }>('SELECT COUNT(*) c FROM api_references WHERE api_fqn IS NOT NULL').c
    ).toBeGreaterThanOrEqual(1);
    expect(
      sq<{ c: number }>(
        `SELECT COUNT(*) c FROM api_references WHERE api_kind IS NOT NULL
         AND api_kind NOT IN ('event','annotation','class','method','field','interface','enum')`
      ).c
    ).toBe(0);
  });
});

describe('ModExamplesService against the golden DB', () => {
  it('filters by loader and minecraft_version', () => {
    const svc = new ModExamplesService(goldenDb);
    try {
      const cleanroom = svc.searchExamples({ query: 'block', loader: 'cleanroom' });
      expect(cleanroom.length).toBeGreaterThan(0);
      expect(cleanroom.every((r) => r.loader === 'cleanroom')).toBe(true);

      const versioned = svc.searchExamples({ query: 'block', minecraftVersion: '1.12.2' });
      expect(versioned.length).toBeGreaterThan(0);
    } finally {
      svc.close();
    }
  });

  it('batches child enrichment to O(1) queries (N+1 fix)', () => {
    const svc = new ModExamplesService(goldenDb);
    try {
      const db = (svc as unknown as { db: Database.Database }).db;
      const realPrepare = db.prepare.bind(db);
      let childPrepares = 0;
      db.prepare = (sql: string) => {
        if (/example_id IN/i.test(sql)) childPrepares++;
        return realPrepare(sql);
      };
      const results = svc.searchExamples({ minQualityScore: 0 });
      expect(results.length).toBeGreaterThan(1);
      expect(childPrepares).toBeLessThanOrEqual(4);
    } finally {
      svc.close();
    }
  });

  it('does not throw on a query containing a double-quote', () => {
    const svc = new ModExamplesService(goldenDb);
    try {
      expect(() => svc.searchExamples({ query: 'render "block"' })).not.toThrow();
    } finally {
      svc.close();
    }
  });

  it('renders attribution + SRG cross-links in formatExampleForAI', () => {
    const svc = new ModExamplesService(goldenDb);
    try {
      const srgExample = svc
        .searchExamples({ loader: 'forge', minQualityScore: 0 })
        .find((e) => e.apiReferences.some((r) => r.srgName === 'func_180495_p'));
      expect(srgExample).toBeDefined();
      const out = svc.formatExampleForAI(srgExample!);
      expect(out).toMatch(/\*\*Source:\*\*/);
      expect(out).toMatch(/Unlicense|MIT|LGPL-3\.0|GPL-3\.0/);
      expect(out).toMatch(/https:\/\/github\.com\//);
      expect(out).toMatch(/func_180495_p\s*(->|→)\s*getBlockState/);
      expect(out).toMatch(/resolve_symbol/);
    } finally {
      svc.close();
    }
  });

  it('degrades gracefully with no sibling mappings DB at runtime', () => {
    const svc = new ModExamplesService(goldenDb, { mappingsDb: null });
    try {
      const example = svc
        .searchExamples({ loader: 'forge', minQualityScore: 0 })
        .find((e) => e.apiReferences.some((r) => r.srgName === 'func_180495_p'))!;
      expect(() => svc.formatExampleForAI(example)).not.toThrow();
      const out = svc.formatExampleForAI(example);
      expect(out).toContain('func_180495_p');
      expect(out).toMatch(/resolve_symbol/);
    } finally {
      svc.close();
    }
  });
});

describe('schema gate', () => {
  it('reads a schema_version mismatch as outdated / not-installed', async () => {
    const p = path.join(dir, 'mutated.db');
    await buildGoldenDb(p);
    const w = new Database(p);
    w.prepare("UPDATE metadata SET value='1' WHERE key='schema_version'").run();
    w.close();
    expect(ModExamplesService.isAvailable(p)).toBe(false);
    expect(ModExamplesService.isSchemaOutdated(p)).toBe(true);
  });

  it('reads a legacy DB with no metadata table as not installed', () => {
    const p = path.join(dir, 'legacy.db');
    const h = new Database(p);
    h.exec('CREATE TABLE mods(id INTEGER); CREATE TABLE examples(id INTEGER);');
    h.close();
    expect(ModExamplesService.isAvailable(p)).toBe(false);
  });
});
