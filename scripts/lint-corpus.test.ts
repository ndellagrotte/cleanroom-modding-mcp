import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { lintCorpus } from './lint-corpus.js';
import { DBS } from '../src/dbs.js';

/**
 * A gate that cannot fail is not a gate. v2.2.3 passed every check the release
 * had and still shipped a corpus with 9,867 known contaminations, because none
 * of those checks opened a table (beta report V8). These tests assert that each
 * check actually fires on the defect it is named for.
 */

const ZWSP = '​';

let dir: string;
let dbPath: string;

interface Seed {
  category?: string;
  minecraftVersion?: string | null;
  documentTitle?: string;
  documentContent?: string;
  heading?: string;
  sectionContent?: string;
  chunkContent?: string;
  hasCodeBlock?: boolean;
}

/** A minimal but structurally complete docs.db that passes every check. */
function seed(overrides: Seed = {}): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, category TEXT NOT NULL, loader TEXT NOT NULL,
      minecraft_version TEXT, loader_version TEXT, hash TEXT NOT NULL
    );
    CREATE TABLE sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL,
      heading TEXT NOT NULL, level INTEGER NOT NULL, content TEXT NOT NULL, order_num INTEGER NOT NULL
    );
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY, document_id INTEGER NOT NULL, content TEXT NOT NULL
    );
    CREATE TABLE code_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, section_id INTEGER NOT NULL,
      language TEXT NOT NULL, code TEXT NOT NULL, caption TEXT
    );
  `);
  db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run(
    'schema_version',
    String(DBS.docs.schemaVersion)
  );
  db.prepare(
    'INSERT INTO documents (url, title, content, category, loader, minecraft_version, hash) VALUES (?,?,?,?,?,?,?)'
  ).run(
    'https://docs.minecraftforge.net/en/1.12.x/items/items/',
    overrides.documentTitle ?? 'Items',
    overrides.documentContent ?? 'A complete document body for item registration.',
    overrides.category ?? 'items',
    'forge',
    overrides.minecraftVersion === undefined ? '1.12.2' : overrides.minecraftVersion,
    'h'
  );
  db.prepare(
    'INSERT INTO sections (document_id, heading, level, content, order_num) VALUES (?,?,?,?,?)'
  ).run(
    1,
    overrides.heading ?? 'Items',
    2,
    overrides.sectionContent ?? 'A complete section body for item registration.',
    0
  );
  db.prepare('INSERT INTO chunks (id, document_id, content) VALUES (?,?,?)').run(
    'c1',
    1,
    overrides.chunkContent ?? 'A complete searchable chunk for item registration.'
  );
  if (overrides.hasCodeBlock) {
    db.prepare(
      'INSERT INTO code_blocks (section_id, language, code, caption) VALUES (?,?,?,?)'
    ).run(1, 'java', 'public final class Example {}', null);
  }
  db.close();
}

function failedNames(): string[] {
  return lintCorpus(dbPath).failed.map((c) => c.name);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-corpus-test-'));
  dbPath = path.join(dir, 'docs.db');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('lintCorpus', () => {
  it('passes a clean corpus', () => {
    seed();
    const report = lintCorpus(dbPath);
    expect(report.failed).toEqual([]);
    expect(report.checks.length).toBeGreaterThan(10);
  });

  it.each([
    ['sections.heading', { heading: `Items${ZWSP}` }],
    [
      'sections.content',
      { sectionContent: `A complete section body${ZWSP} for item registration.` },
    ],
    ['documents.title', { documentTitle: `Items${ZWSP}` }],
    [
      'documents.content',
      { documentContent: `A complete document body${ZWSP} for item registration.` },
    ],
    [
      'chunks.content',
      { chunkContent: `A complete searchable chunk${ZWSP} for item registration.` },
    ],
  ] as Array<[string, Seed]>)('fails on zero-width characters in %s', (column, overrides) => {
    seed(overrides);
    expect(failedNames()).toContain(`no zero-width chars in ${column}`);
  });

  it('fails on a body-less section', () => {
    seed({ sectionContent: '   ' });
    expect(failedNames()).toContain('no body-less or too-short sections');
  });

  it('fails on a prose section shorter than 25 characters', () => {
    seed({ sectionContent: 'See mappings.' });
    expect(failedNames()).toContain('no body-less or too-short sections');
  });

  it('accepts a code-only section', () => {
    seed({ sectionContent: '', hasCodeBlock: true });
    expect(lintCorpus(dbPath).failed).toEqual([]);
  });

  it('fails on semantically identical duplicate sections', () => {
    seed();
    const db = new Database(dbPath);
    db.prepare(
      'INSERT INTO sections (document_id, heading, level, content, order_num) VALUES (?,?,?,?,?)'
    ).run(1, 'Items', 2, 'A complete section body for item registration.', 1);
    db.close();
    expect(failedNames()).toContain('no unexpected duplicate section groups');
  });

  it('fails on a loader version stored as a Minecraft version', () => {
    seed({ minecraftVersion: '26.1.2' });
    expect(failedNames()).toContain('minecraft_version holds only Minecraft versions');
  });

  it('fails on the phantom 21.9 independently of the shape check', () => {
    seed({ minecraftVersion: '21.9' });
    const failed = failedNames();
    expect(failed).toContain('no phantom minecraft_version 21.9');
    expect(failed).toContain('minecraft_version holds only Minecraft versions');
  });

  it('fails on a NULL minecraft_version', () => {
    seed({ minecraftVersion: null });
    expect(failedNames()).toContain('no NULL minecraft_version');
  });

  it('fails on a category outside the enum', () => {
    seed({ category: 'datastorage' });
    expect(failedNames()).toContain('every category is in DOC_CATEGORIES');
  });

  it('fails when the fallback category swallows the corpus', () => {
    seed({ category: 'general' });
    const failed = failedNames();
    expect(failed).toContain('fallback category under 15% of the corpus');
    // 'general' is a valid enum value, so the off-taxonomy check cannot see
    // this — which is exactly why the share check exists separately.
    expect(failed).not.toContain('every category is in DOC_CATEGORIES');
  });

  it('fails on orphaned child rows', () => {
    seed();
    const db = new Database(dbPath);
    db.prepare(
      'INSERT INTO sections (document_id, heading, level, content, order_num) VALUES (?,?,?,?,?)'
    ).run(999, 'Orphan', 2, 'body', 1);
    db.close();
    expect(failedNames()).toContain('no orphaned sections rows');
  });

  it('fails when the schema stamp does not match the registry', () => {
    seed();
    const db = new Database(dbPath);
    db.prepare("UPDATE metadata SET value = '1' WHERE key = 'schema_version'").run();
    db.close();
    expect(failedNames()).toContain('schema_version matches the registry');
  });
});
