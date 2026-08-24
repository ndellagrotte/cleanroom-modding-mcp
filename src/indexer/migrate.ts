/**
 * In-place corpus migration for docs.db.
 *
 * `docs.db` is 818 MiB and whole-file replacement is the only delivery
 * mechanism the project has, so every value-level fix used to cost every user a
 * full re-download. But the values this module repairs — `category`,
 * `minecraft_version`, `loader_version` — are *pure functions of
 * `documents.url`*, which the database already stores. Replaying them locally
 * takes about a second and touches none of the 248,653 embeddings.
 *
 * Verified before this was written: replaying the previous build's
 * `extractCategoryFromUrl` over all 1,432 stored URLs reproduced every stored
 * category with zero mismatches. Categorization carries no crawl-time state.
 *
 * Safety contract:
 *  - One transaction. SQLite makes it atomic, so a crash leaves the file
 *    untouched rather than half-migrated.
 *  - Any failure is logged and swallowed. The DB is left exactly as it was, the
 *    schema gate in db-versioning then fires, and the client re-downloads — the
 *    behaviour it has today. Migration can only ever save work, never block it.
 *  - Never writes to stdout: that is the MCP stdio transport.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import { extractCategoryFromUrl } from '../categories.js';
import { detectVersions } from './sitemap.js';
import { detectLoaderFromUrl, isMinecraftVersion, UNKNOWN_MINECRAFT_VERSION } from '../loaders.js';
import { CORPUS_REVISION, CORPUS_REVISION_KEY, DOCS_SCHEMA_VERSION } from './store.js';

/** Env flag mirroring CLEANROOM_MCP_SKIP_AUTO_UPDATE, for the same reasons. */
const SKIP_ENV = 'CLEANROOM_MCP_SKIP_MIGRATION';

export interface MigrationResult {
  /** True when the file was actually rewritten. */
  migrated: boolean;
  /** Revision found on disk before the run. */
  fromRevision: number;
  /** Revision now recorded. Equals `fromRevision` when nothing ran. */
  toRevision: number;
  /** Documents whose stored category changed. */
  recategorized: number;
  /** Documents whose version columns changed. */
  reversioned: number;
  /** Set when the migration was skipped or failed; the DB is untouched. */
  reason?: string;
}

function readIntMeta(db: Database.Database, key: string): number {
  try {
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    const parsed = Number.parseInt(row?.value ?? '', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    // No metadata table at all — a pre-versioning file. Treat as revision 0.
    return 0;
  }
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/**
 * Bring a docs.db's derived columns up to CORPUS_REVISION.
 *
 * Returns a result rather than throwing: the caller is server startup, and a
 * migration failure must never prevent the server from running.
 */
export function migrateCorpus(dbPath: string): MigrationResult {
  const untouched = (reason: string, from = 0): MigrationResult => ({
    migrated: false,
    fromRevision: from,
    toRevision: from,
    recategorized: 0,
    reversioned: 0,
    reason,
  });

  if (process.env[SKIP_ENV]) {
    return untouched(`${SKIP_ENV} is set`);
  }
  if (!fs.existsSync(dbPath)) {
    return untouched('database not present');
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');

    const fromRevision = readIntMeta(db, CORPUS_REVISION_KEY);
    if (fromRevision >= CORPUS_REVISION) {
      return untouched('already current', fromRevision);
    }

    const documents = db.prepare('SELECT id, url, category FROM documents').all() as Array<{
      id: number;
      url: string;
      category: string;
    }>;
    if (documents.length === 0) {
      return untouched('corpus is empty', fromRevision);
    }

    let recategorized = 0;
    let reversioned = 0;

    const run = db.transaction(() => {
      // ALTER TABLE ADD COLUMN is a metadata-only operation in SQLite, so this
      // is O(1) regardless of corpus size.
      if (!hasColumn(db!, 'documents', 'loader_version')) {
        db!.exec('ALTER TABLE documents ADD COLUMN loader_version TEXT');
      }

      const setCategory = db!.prepare('UPDATE documents SET category = ? WHERE id = ?');
      const setVersions = db!.prepare(
        'UPDATE documents SET minecraft_version = ?, loader_version = ? WHERE id = ?'
      );
      const readVersions = db!.prepare(
        'SELECT minecraft_version, loader_version FROM documents WHERE id = ?'
      );

      for (const doc of documents) {
        const category = extractCategoryFromUrl(doc.url);
        if (category !== doc.category) {
          setCategory.run(category, doc.id);
          recategorized++;
        }

        // Content is not replayed here: `detectVersions` only consults page
        // content as a last resort, and every value it produced that way was a
        // loader version this build now rejects. URL evidence alone is both
        // sufficient and strictly more trustworthy.
        const loader = detectLoaderFromUrl(doc.url);
        const next = detectVersions(doc.url, '', loader);
        const current = readVersions.get(doc.id) as {
          minecraft_version: string | null;
          loader_version: string | null;
        };
        const mc = next.minecraftVersion ?? UNKNOWN_MINECRAFT_VERSION;
        const lv = next.loaderVersion ?? null;
        // URL evidence wins. Otherwise a previously established real Minecraft
        // version survives; rejected loader/plugin values become explicit
        // `unknown`, never NULL and never an invented 1.12.2.
        const keepStoredMc =
          mc === UNKNOWN_MINECRAFT_VERSION &&
          current.minecraft_version !== null &&
          isMinecraftVersion(current.minecraft_version);
        const nextMc = keepStoredMc ? current.minecraft_version : mc;
        if (nextMc !== current.minecraft_version || lv !== current.loader_version) {
          setVersions.run(nextMc, lv, doc.id);
          reversioned++;
        }
      }

      const stamp = db!.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)');
      stamp.run(CORPUS_REVISION_KEY, CORPUS_REVISION.toString());
      // The ALTER above gave the file the current schema, so record it. This is
      // what lets a migrated database satisfy the schema gate in
      // db-versioning's isUpdateAvailable() and skip the 818 MiB download. If
      // any part of this transaction failed, the stamp rolls back with it, the
      // gate fires, and the client downloads exactly as it does today.
      stamp.run('schema_version', DOCS_SCHEMA_VERSION.toString());
    });

    run();

    // The FTS mirror carries `category`, and every changed row rewrote its
    // entry through the documents_au trigger. Compact the index once rather
    // than leaving it fragmented.
    try {
      db.exec("INSERT INTO documents_fts(documents_fts) VALUES('optimize')");
    } catch {
      // Optimization is a nicety; a corpus without the FTS mirror still works.
    }

    return {
      migrated: true,
      fromRevision,
      toRevision: CORPUS_REVISION,
      recategorized,
      reversioned,
    };
  } catch (error) {
    // Deliberately swallowed — see the safety contract above.
    console.error(
      `[Migrate] docs.db migration failed, leaving the database unchanged: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return untouched('migration failed');
  } finally {
    db?.close();
  }
}

/**
 * Migrate and report. Called from server startup, before the update check, so a
 * successfully migrated database satisfies the schema gate and skips the
 * download entirely.
 */
export function migrateCorpusWithLogging(dbPath: string): MigrationResult {
  const result = migrateCorpus(dbPath);
  if (result.migrated) {
    console.error(
      `[Migrate] docs.db corpus revision ${result.fromRevision} → ${result.toRevision}: ` +
        `${result.recategorized} recategorized, ${result.reversioned} reversioned`
    );
  }
  return result;
}
