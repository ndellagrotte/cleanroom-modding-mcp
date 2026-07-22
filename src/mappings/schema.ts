/**
 * Mappings database schema (v2) — the single source of truth for the DDL.
 *
 * Two mapping eras share one database, distinguished by `classes.mapping_set`:
 *   - 'mcp'       — Minecraft 1.12.2 MCP/SRG (notch -> SRG -> readable)
 *   - 'parchment' — modern versions (Mojang official + Parchment)
 *
 * Invariant (enforced by the indexers, not the schema): all rows of one
 * minecraft_version share one mapping_set.
 *
 * Both the maintainer indexer (scripts/index-mappings.ts) and the on-device
 * build path (src/mappings/mcp-ingest.ts) create databases through this module,
 * so the DDL is defined exactly once and ships in dist/.
 */

import fs from 'fs';
import Database from 'better-sqlite3';

/** Bump together with DBS.mappings.schemaVersion in src/dbs.ts. */
export const MAPPINGS_SCHEMA_VERSION = 2;

export const MAPPINGS_SCHEMA = `
-- Metadata table for schema versioning
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- mapping_set: 'mcp' (1.12.2) | 'parchment' (modern).
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                -- simple name; inner classes as Outer$Inner
  package_name TEXT NOT NULL,        -- dotted; '' for default package
  notch_name TEXT,                   -- obfuscated name ('aab', 'bhy$a'); NULL if unknown
  javadoc TEXT,
  minecraft_version TEXT NOT NULL,
  mapping_set TEXT NOT NULL,
  UNIQUE(name, package_name, minecraft_version)
);

CREATE TABLE IF NOT EXISTS methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL,
  name TEXT NOT NULL,                -- readable name; '<init>' for constructors
  srg_name TEXT,                     -- 'func_12345_a'; NULL for modern rows,
                                     -- non-renamed 1.12.2 methods, and constructors
  notch_name TEXT,
  descriptor TEXT NOT NULL,          -- JVM descriptor with named class references
  javadoc TEXT,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  srg_name TEXT,                     -- 'field_12345_a'; NULL for modern / non-renamed
  notch_name TEXT,
  descriptor TEXT,                   -- NULLABLE: TSRG v1 field lines carry none
  javadoc TEXT,
  FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS parameters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method_id INTEGER NOT NULL,
  param_index INTEGER NOT NULL,      -- 0-based logical position (NOT the LVT slot)
  srg_token TEXT,                    -- 'p_78443_1_' / 'p_i46742_2_'; NULL for modern rows
  name TEXT NOT NULL,                -- readable name; falls back to the token itself
  javadoc TEXT,
  FOREIGN KEY (method_id) REFERENCES methods(id) ON DELETE CASCADE
);

-- Lookup indexes
CREATE INDEX IF NOT EXISTS idx_classes_name      ON classes(name);
CREATE INDEX IF NOT EXISTS idx_classes_package   ON classes(package_name);
CREATE INDEX IF NOT EXISTS idx_classes_version   ON classes(minecraft_version);
CREATE INDEX IF NOT EXISTS idx_classes_notch     ON classes(notch_name);
CREATE INDEX IF NOT EXISTS idx_methods_name      ON methods(name);
CREATE INDEX IF NOT EXISTS idx_methods_class     ON methods(class_id);
CREATE INDEX IF NOT EXISTS idx_methods_notch     ON methods(notch_name);
CREATE INDEX IF NOT EXISTS idx_methods_srg       ON methods(srg_name)     WHERE srg_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fields_name       ON fields(name);
CREATE INDEX IF NOT EXISTS idx_fields_class      ON fields(class_id);
CREATE INDEX IF NOT EXISTS idx_fields_notch      ON fields(notch_name);
CREATE INDEX IF NOT EXISTS idx_fields_srg        ON fields(srg_name)      WHERE srg_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_parameters_method ON parameters(method_id);
CREATE INDEX IF NOT EXISTS idx_parameters_srg    ON parameters(srg_token) WHERE srg_token IS NOT NULL;
`;

/** Create (or open) a mappings database and apply the v2 schema. */
export function initializeMappingsDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(MAPPINGS_SCHEMA);
  db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)`).run(
    String(MAPPINGS_SCHEMA_VERSION)
  );
  return db;
}

/**
 * Read the schema_version stored in a mappings database.
 * Returns null when the file is missing, unreadable, or has no metadata table —
 * callers treat that the same as a schema mismatch.
 */
export function readDbSchemaVersion(dbPath: string): number | null {
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    if (!row) {
      return null;
    }
    const parsed = Number.parseInt(row.value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
