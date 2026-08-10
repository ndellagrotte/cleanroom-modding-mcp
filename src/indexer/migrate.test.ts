import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { migrateCorpus } from './migrate.js';
import { CORPUS_REVISION, CORPUS_REVISION_KEY, DOCS_SCHEMA_VERSION } from './store.js';

/**
 * The migration exists so that a value-level corpus fix does not cost every
 * user an 818 MiB download. Its safety contract is the important part: it must
 * be atomic, idempotent, and must never leave a database worse than it found
 * it — because the fallback on failure is the download path that works today.
 */

let dir: string;
let dbPath: string;

/** A pre-migration docs.db: schema 2 shape, stale categories, S8 version values. */
function seed(): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      raw_html TEXT,
      category TEXT NOT NULL,
      loader TEXT NOT NULL,
      minecraft_version TEXT,
      hash TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO metadata (key, value) VALUES ('schema_version', '2')").run();

  const insert = db.prepare(
    'INSERT INTO documents (url, title, content, category, loader, minecraft_version, hash) VALUES (?,?,?,?,?,?,?)'
  );
  const rows: Array<[string, string, string | null]> = [
    // [url, stale category, stored minecraft_version]
    ['https://wiki.fabricmc.net/tutorial:blocks', 'general', null],
    ['https://wiki.fabricmc.net/tutorial:mixin_injects', 'general', '26.1'],
    ['https://docs.neoforged.net/docs/1.21.1/datastorage/capabilities', 'general', '1.21.1'],
    ['https://docs.fabricmc.net/26.1.2/develop/', 'general', '26.1.2'],
    ['https://docs.neoforged.net/toolchain/docs/plugins/ng/', 'general', '21.9'],
    ['https://docs.minecraftforge.net/en/1.12.x/items/items/', 'items', '1.12.2'],
  ];
  for (const [url, category, mc] of rows) {
    insert.run(url, 't', 'c', category, url.includes('forge.net') ? 'forge' : 'fabric', mc, 'h');
  }
  db.close();
}

function open<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

interface VersionRow {
  minecraft_version: string | null;
  loader_version: string | null;
}

/** `url -> category` for the whole fixture corpus. */
function categoriesByUrl(): Map<string, string> {
  return open((db) => {
    const rows = db.prepare('SELECT url, category FROM documents').all() as Array<{
      url: string;
      category: string;
    }>;
    return new Map(rows.map((r) => [r.url, r.category]));
  });
}

function versionsFor(url: string): VersionRow {
  return open(
    (db) =>
      db
        .prepare('SELECT minecraft_version, loader_version FROM documents WHERE url = ?')
        .get(url) as VersionRow
  );
}

function metadata(): Map<string, string> {
  return open((db) => {
    const rows = db.prepare('SELECT key, value FROM metadata').all() as Array<{
      key: string;
      value: string;
    }>;
    return new Map(rows.map((r) => [r.key, r.value]));
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
  dbPath = path.join(dir, 'docs.db');
  delete process.env.CLEANROOM_MCP_SKIP_MIGRATION;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('migrateCorpus', () => {
  it('recategorizes documents whose stored category is stale', () => {
    seed();
    const result = migrateCorpus(dbPath);

    expect(result.migrated).toBe(true);
    expect(result.fromRevision).toBe(0);
    expect(result.toRevision).toBe(CORPUS_REVISION);
    expect(result.recategorized).toBeGreaterThan(0);

    const byUrl = categoriesByUrl();
    expect(byUrl.get('https://wiki.fabricmc.net/tutorial:blocks')).toBe('blocks');
    expect(byUrl.get('https://wiki.fabricmc.net/tutorial:mixin_injects')).toBe('coremods-mixins');
    expect(byUrl.get('https://docs.neoforged.net/docs/1.21.1/datastorage/capabilities')).toBe(
      'capabilities'
    );
  });

  it('moves docs-site versions out of minecraft_version', () => {
    seed();
    migrateCorpus(dbPath);

    const row = versionsFor('https://docs.fabricmc.net/26.1.2/develop/');
    expect(row.minecraft_version).toBeNull();
    expect(row.loader_version).toBe('26.1.2');
  });

  it('clears version values the current rules reject', () => {
    seed();
    migrateCorpus(dbPath);

    // '21.9' is a ModDevGradle version scraped from prose, not a Minecraft one.
    expect(
      versionsFor('https://docs.neoforged.net/toolchain/docs/plugins/ng/').minecraft_version
    ).toBeNull();
    expect(
      versionsFor('https://wiki.fabricmc.net/tutorial:mixin_injects').minecraft_version
    ).toBeNull();
  });

  it('keeps a real Minecraft version the URL cannot re-derive', () => {
    seed();
    migrateCorpus(dbPath);

    expect(
      versionsFor('https://docs.minecraftforge.net/en/1.12.x/items/items/').minecraft_version
    ).toBe('1.12.2');
  });

  it('re-stamps the schema version so the download gate is satisfied', () => {
    seed();
    migrateCorpus(dbPath);

    const meta = metadata();
    expect(meta.get('schema_version')).toBe(String(DOCS_SCHEMA_VERSION));
    expect(meta.get(CORPUS_REVISION_KEY)).toBe(String(CORPUS_REVISION));
  });

  it('is idempotent — a second run does nothing', () => {
    seed();
    migrateCorpus(dbPath);
    const second = migrateCorpus(dbPath);

    expect(second.migrated).toBe(false);
    expect(second.reason).toBe('already current');
    expect(second.fromRevision).toBe(CORPUS_REVISION);
  });

  it('leaves the database untouched when it cannot migrate', () => {
    // A file that is not a database at all: the worst case the startup path can
    // hand it. It must report failure rather than throw, so the server starts.
    fs.writeFileSync(dbPath, 'this is not a sqlite file');
    const before = fs.readFileSync(dbPath);

    const result = migrateCorpus(dbPath);

    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('migration failed');
    expect(fs.readFileSync(dbPath)).toEqual(before);
  });

  it('honours the skip flag', () => {
    seed();
    process.env.CLEANROOM_MCP_SKIP_MIGRATION = '1';
    const result = migrateCorpus(dbPath);

    expect(result.migrated).toBe(false);
    expect(categoriesByUrl().get('https://wiki.fabricmc.net/tutorial:blocks')).toBe('general');
  });

  it('reports cleanly when there is no database', () => {
    const result = migrateCorpus(path.join(dir, 'absent.db'));
    expect(result.migrated).toBe(false);
    expect(result.reason).toBe('database not present');
  });
});
