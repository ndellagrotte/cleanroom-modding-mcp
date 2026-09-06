import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  isUpToDate,
  runIngest,
  upgradeExamplesDataSide,
  type ModMeta,
  type SkipState,
} from './ingest.js';
import type { ExampleRecord, IngestMeta } from './model.js';
import { DOC_ONLY_CATEGORIES, EXAMPLE_CATEGORIES } from '../categories.js';

const META: IngestMeta = {
  analysisVersion: 'av1-test',
  promptVersion: 'v1',
  llmModel: 'test',
  rosterPins: { 'o/r': 'sha1' },
  licenseReview: {},
};

function record(overrides: Partial<ExampleRecord> = {}): ExampleRecord {
  return {
    modName: 'R',
    modRepo: 'o/r',
    loader: 'forge',
    license: 'MIT',
    filePath: 'X.java',
    fileUrl: 'https://github.com/o/r/blob/sha/X.java#L1-L2',
    startLine: 1,
    endLine: 2,
    title: 'T',
    code: 'class X {}',
    language: 'java',
    caption: 'c',
    explanation: 'e',
    patternType: 'p',
    complexity: 'beginner',
    categorySlug: 'blocks',
    bestPractices: [],
    potentialPitfalls: [],
    useCases: [],
    keywords: ['x'],
    minecraftConcepts: [],
    qualityScore: 0.5,
    isFeatured: false,
    tags: ['t'],
    imports: [{ path: 'a.B', type: 'library', isCritical: false }],
    apiReferences: [],
    ...overrides,
  };
}

const MOD: ModMeta = {
  name: 'R',
  repo: 'o/r',
  loader: 'forge',
  license: 'MIT',
  minecraftVersions: ['1.12.2'],
  priority: 1,
};

describe('isUpToDate', () => {
  const base: SkipState = {
    roster_pins: { a: 'sha1' },
    analysis_version: 'av1',
    schema_version: 2,
  };
  it('no-ops only when all three keys match', () => {
    expect(isUpToDate(base, base)).toBe(true);
    expect(isUpToDate(base, { ...base, roster_pins: { a: 'sha2' } })).toBe(false);
    expect(isUpToDate(base, { ...base, analysis_version: 'av2' })).toBe(false);
    expect(isUpToDate(base, { ...base, schema_version: 1 })).toBe(false);
  });
  it('--force overrides a match', () => {
    expect(isUpToDate(base, base, true)).toBe(false);
  });
});

describe('runIngest', () => {
  it('writes a populated DB and is atomic on success', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-ok-'));
    const dbPath = path.join(dir, 'examples.db');
    const counts = runIngest({ dbPath, records: [record()], mods: [MOD], meta: META });
    expect(counts.examples).toBe(1);
    expect(fs.existsSync(`${dbPath}.tmp`)).toBe(false);

    const db = new Database(dbPath, { readonly: true });
    expect((db.prepare('SELECT COUNT(*) c FROM examples').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM example_relations').get() as { c: number }).c).toBe(
      0
    );
    expect(db.prepare("SELECT value FROM metadata WHERE key='analysis_version'").get()).toEqual({
      value: 'av1-test',
    });
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('normalizes aliases, stores canonical patterns, and creates deterministic relations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-v3-'));
    const dbPath = path.join(dir, 'examples.db');
    const records = [
      record({ filePath: 'A.java', patternType: 'block-getActualState-override' }),
      record({ filePath: 'B.java', patternType: 'block-actual-state-noop' }),
      record({ filePath: 'C.java', patternType: 'nbtn-guarded-inventory-initialization' }),
    ];
    const counts = runIngest({ dbPath, records, mods: [MOD], meta: META });

    expect(counts.canonicalPatterns).toBe(2);
    expect(counts.patternAliases).toBe(3);
    expect(counts.relations).toBe(6);

    const db = new Database(dbPath, { readonly: true });
    const patterns = db
      .prepare('SELECT DISTINCT pattern_type FROM examples ORDER BY pattern_type')
      .all() as Array<{ pattern_type: string }>;
    expect(patterns.map((row) => row.pattern_type)).toEqual(['block-state', 'nbt-serialization']);
    expect(
      db
        .prepare(
          "SELECT canonical_pattern FROM pattern_aliases WHERE alias_pattern='block-get-actual-state-override'"
        )
        .get()
    ).toEqual({ canonical_pattern: 'block-state' });
    expect(
      db
        .prepare("SELECT alias_pattern FROM pattern_aliases WHERE alias_pattern LIKE '%nbtn%'")
        .get()
    ).toBeUndefined();
    const relationCount = db.prepare('SELECT COUNT(*) AS count FROM example_relations').get() as {
      count: number;
    };
    expect(relationCount.count).toBe(6);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('upgrades existing analyses in place while preserving example IDs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-upgrade-'));
    const dbPath = path.join(dir, 'examples.db');
    runIngest({
      dbPath,
      records: [
        record({ filePath: 'A.java', patternType: 'legacy-a' }),
        record({ filePath: 'B.java', patternType: 'legacy-b' }),
      ],
      mods: [MOD],
      meta: META,
    });

    const before = new Database(dbPath);
    before.exec(`
      UPDATE examples
      SET pattern_type = CASE id
        WHEN 1 THEN 'block-getActualState-override'
        ELSE 'nbtn-guarded-inventory-initialization'
      END;
      DELETE FROM pattern_aliases;
      DELETE FROM example_relations;
      UPDATE metadata SET value = '2' WHERE key = 'schema_version';
    `);
    for (const slug of DOC_ONLY_CATEGORIES) {
      before.prepare('DELETE FROM categories WHERE slug = ?').run(slug);
    }
    before.close();

    const counts = upgradeExamplesDataSide(dbPath);
    expect(counts).toMatchObject({
      examples: 2,
      patternAliases: 2,
      canonicalPatterns: 2,
      relations: 2,
    });
    const after = new Database(dbPath, { readonly: true });
    expect(after.prepare('SELECT id FROM examples ORDER BY id').all()).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
    expect(after.prepare("SELECT value FROM metadata WHERE key='schema_version'").get()).toEqual({
      value: '3',
    });
    expect(after.prepare('SELECT slug FROM categories ORDER BY sort_order').all()).toEqual(
      EXAMPLE_CATEGORIES.map((slug) => ({ slug }))
    );
    after.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves no partial DB when the build throws mid-transaction', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-fail-'));
    const dbPath = path.join(dir, 'examples.db');
    // A record whose mod repo is absent from `mods` throws inside the transaction.
    expect(() =>
      runIngest({ dbPath, records: [record({ modRepo: 'missing/repo' })], mods: [MOD], meta: META })
    ).toThrow();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}.tmp`]) {
      expect(fs.existsSync(p)).toBe(false);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
