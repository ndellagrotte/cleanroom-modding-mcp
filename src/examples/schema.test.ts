import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initializeExamplesDb, EXAMPLES_SCHEMA_VERSION, readDbSchemaVersion } from './schema.js';
import { DBS } from '../dbs.js';

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'examples-schema-'));
  dbPath = path.join(dir, 'schema.db');
  initializeExamplesDb(dbPath).close();
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('examples schema v3', () => {
  it('pairs EXAMPLES_SCHEMA_VERSION with DBS.examples.schemaVersion at 3', () => {
    expect(EXAMPLES_SCHEMA_VERSION).toBe(3);
    expect(DBS.examples.schemaVersion).toBe(3);
    expect(readDbSchemaVersion(dbPath)).toBe(3);
  });

  it('creates the frozen table set', () => {
    const db = new Database(dbPath, { readonly: true });
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    for (const t of [
      'api_references',
      'categories',
      'example_imports',
      'example_relations',
      'example_tags',
      'examples',
      'metadata',
      'pattern_aliases',
      'mods',
      'tags',
    ]) {
      expect(tables).toContain(t);
    }
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='examples_fts'").get()
    ).toBeDefined();
    db.close();
  });

  it('mods.license is NOT NULL', () => {
    const db = new Database(dbPath, { readonly: true });
    const col = db
      .prepare("SELECT \"notnull\" AS nn FROM pragma_table_info('mods') WHERE name='license'")
      .get() as { nn: number };
    expect(col.nn).toBe(1);
    db.close();
  });

  it('examples_fts indexes the 7 prose columns and excludes raw code', () => {
    const db = new Database(dbPath, { readonly: true });
    const sql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name='examples_fts'").get() as { sql: string }
    ).sql;
    for (const c of [
      'title',
      'caption',
      'explanation',
      'best_practices',
      'use_cases',
      'keywords',
      'minecraft_concepts',
    ]) {
      expect(sql).toContain(c);
    }
    expect(/(^|[^a-z_])code([^a-z_]|$)/.test(sql)).toBe(false);
    expect(sql).toContain("content='examples'");
    db.close();
  });

  it('has exactly 3 FTS sync triggers on examples', () => {
    const db = new Database(dbPath, { readonly: true });
    const n = (
      db
        .prepare(
          "SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger' AND tbl_name='examples'"
        )
        .get() as { c: number }
    ).c;
    expect(n).toBe(3);
    db.close();
  });

  it('covers the query-plan indexes incl. api_references(srg_name)', () => {
    const db = new Database(dbPath, { readonly: true });
    const covered = (table: string, column: string): boolean =>
      !!db
        .prepare(
          `SELECT 1 FROM sqlite_master m JOIN pragma_index_info(m.name) i ON 1
           WHERE m.type='index' AND m.tbl_name=? AND i.name=? LIMIT 1`
        )
        .get(table, column);
    expect(covered('examples', 'mod_id')).toBe(true);
    expect(covered('examples', 'category_id')).toBe(true);
    expect(covered('examples', 'quality_score')).toBe(true);
    expect(covered('examples', 'is_featured')).toBe(true);
    expect(covered('examples', 'pattern_type')).toBe(true);
    expect(covered('example_relations', 'source_id')).toBe(true);
    expect(covered('example_relations', 'target_id')).toBe(true);
    expect(covered('pattern_aliases', 'canonical_pattern')).toBe(true);
    expect(covered('example_imports', 'example_id')).toBe(true);
    expect(covered('api_references', 'example_id')).toBe(true);
    expect(covered('api_references', 'srg_name')).toBe(true);
    expect(covered('tags', 'slug')).toBe(true);
    db.close();
  });
});
