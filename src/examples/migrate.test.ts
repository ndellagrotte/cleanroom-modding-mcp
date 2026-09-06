import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DOC_ONLY_CATEGORIES, EXAMPLE_CATEGORIES, EXAMPLE_CATEGORY_INFO } from '../categories.js';
import { ModExamplesService } from '../services/mod-examples-service.js';
import { initializeExamplesDb } from './schema.js';
import { migrateExampleCategories } from './migrate.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'example-categories-'));
  dbPath = path.join(dir, 'examples.db');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The pre-unification taxonomy with non-sequential IDs already used by examples. */
function seed(): void {
  const db = initializeExamplesDb(dbPath);
  try {
    const insert = db.prepare(
      'INSERT INTO categories (id, slug, name, description, icon, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    );
    let count = 0;
    for (const [order, slug] of EXAMPLE_CATEGORIES.entries()) {
      if (DOC_ONLY_CATEGORIES.includes(slug as never)) continue;
      const info = EXAMPLE_CATEGORY_INFO[slug];
      insert.run(100 + order * 3, slug, info.name, info.description, info.icon, order);
      count++;
    }
    db.exec(`
      INSERT INTO mods (id, name, repo, loader, license) VALUES (1, 'Fixture', 'test/mod', 'forge', 'MIT');
      INSERT INTO examples (id, mod_id, category_id, title, code, explanation, quality_score)
      VALUES (7, 1, 100, 'Beacon synchronization', 'class Beacon {}', 'Reviewed analysis', 0.9),
             (8, 1, NULL, 'Uncategorized example', 'class Other {}', 'Original analysis', 0.8);
      INSERT INTO example_imports (example_id, import_path) VALUES (7, 'net.minecraft.block.Block');
      INSERT INTO example_relations (source_id, target_id, relation_type) VALUES (7, 8, 'similar_to');
      INSERT INTO metadata (key, value) VALUES ('analysis_version', 'reviewed-v1');
    `);
    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run(
      'counts',
      JSON.stringify({ categories: count, examples: 2, uncategorized: 1 })
    );
  } finally {
    db.close();
  }
}

describe('migrateExampleCategories', () => {
  it('exposes newly shared categories without changing examples, their IDs, or search results', () => {
    seed();
    const before = new Database(dbPath, { readonly: true });
    const examples = before.prepare('SELECT * FROM examples ORDER BY id').all();
    const categories = before.prepare('SELECT id, slug FROM categories ORDER BY id').all();
    const imports = before.prepare('SELECT * FROM example_imports').all();
    const relations = before.prepare('SELECT * FROM example_relations').all();
    before.close();

    expect(migrateExampleCategories(dbPath)).toBe(DOC_ONLY_CATEGORIES.length);
    const service = new ModExamplesService(dbPath);
    try {
      const listed = service.listCategories();
      expect(listed.map((row) => row.slug)).toEqual(EXAMPLE_CATEGORIES);
      for (const slug of DOC_ONLY_CATEGORIES) {
        expect(listed.find((row) => row.slug === slug)?.exampleCount).toBe(0);
      }
      expect(
        service.searchExamples({ query: 'Beacon', category: 'blocks' }).map((row) => row.id)
      ).toEqual([7]);
      expect(service.getExample(7)).toMatchObject({
        id: 7,
        category: 'blocks',
        code: 'class Beacon {}',
        explanation: 'Reviewed analysis',
      });
      expect(service.countUncategorized()).toBe(1);
    } finally {
      service.close();
    }

    const after = new Database(dbPath, { readonly: true });
    try {
      expect(after.prepare('SELECT * FROM examples ORDER BY id').all()).toEqual(examples);
      expect(after.prepare('SELECT id, slug FROM categories ORDER BY id').all()).toEqual(
        expect.arrayContaining(categories)
      );
      expect(after.prepare('SELECT * FROM example_imports').all()).toEqual(imports);
      expect(after.prepare('SELECT * FROM example_relations').all()).toEqual(relations);
      expect(after.pragma('foreign_key_check')).toEqual([]);
      const counts = after.prepare("SELECT value FROM metadata WHERE key = 'counts'").get() as {
        value: string;
      };
      expect(JSON.parse(counts.value)).toEqual({
        categories: EXAMPLE_CATEGORIES.length,
        examples: 2,
        uncategorized: 1,
      });
      expect(
        after.prepare("SELECT value FROM metadata WHERE key = 'analysis_version'").get()
      ).toEqual({ value: 'reviewed-v1' });
    } finally {
      after.close();
    }

    const migratedBytes = fs.readFileSync(dbPath);
    expect(migrateExampleCategories(dbPath)).toBe(0);
    expect(fs.readFileSync(dbPath)).toEqual(migratedBytes);
  });

  it('refreshes display metadata without replacing an assigned category ID', () => {
    seed();
    const db = new Database(dbPath);
    db.prepare(
      "UPDATE categories SET name = 'Old name', sort_order = 99 WHERE slug = 'blocks'"
    ).run();
    db.close();

    migrateExampleCategories(dbPath);
    const service = new ModExamplesService(dbPath);
    try {
      expect(service.listCategories()[0]).toMatchObject({
        slug: 'blocks',
        name: EXAMPLE_CATEGORY_INFO.blocks.name,
        exampleCount: 1,
      });
      expect(service.getExample(7)?.category).toBe('blocks');
    } finally {
      service.close();
    }
  });

  it('rolls back earlier category writes when a later insert fails', () => {
    seed();
    const db = new Database(dbPath);
    db.exec(`CREATE TRIGGER reject_category BEFORE INSERT ON categories
      WHEN new.slug = 'general' BEGIN SELECT RAISE(ABORT, 'category rejected'); END`);
    db.close();
    const originalBytes = fs.readFileSync(dbPath);

    expect(() => migrateExampleCategories(dbPath)).toThrow('category rejected');
    expect(fs.readFileSync(dbPath)).toEqual(originalBytes);
  });

  it('does not create missing databases or mutate incompatible schemas', () => {
    expect(migrateExampleCategories(dbPath)).toBe(0);
    expect(fs.existsSync(dbPath)).toBe(false);

    seed();
    const db = new Database(dbPath);
    db.prepare("UPDATE metadata SET value = '999' WHERE key = 'schema_version'").run();
    db.close();
    const originalBytes = fs.readFileSync(dbPath);
    expect(migrateExampleCategories(dbPath)).toBe(0);
    expect(fs.readFileSync(dbPath)).toEqual(originalBytes);
  });
});
