/**
 * Cleanroom API database schema (v2) — the single source of truth for the DDL.
 *
 * v2: members.deprecation_note added; idx_types_simple uses COLLATE NOCASE.
 *
 * Indexes the framework API surface an agent codes against (com.cleanroommc.*,
 * zone.rong.mixinbooter.*, net.minecraftforge.*) as extracted from the published
 * `com.cleanroommc:cleanroom:<version>:sources` jar. Vanilla net.minecraft.*
 * symbols live in the mappings database, not here (DESIGN.md §5.3, Open
 * Question 6).
 *
 * The maintainer indexer (scripts/index-java-api.ts) creates databases through
 * this module; the runtime service reads them. Unlike the mappings DB there is
 * no on-device build path — this DB is always distributed prebuilt (§6.3).
 */

import fs from 'fs';
import Database from 'better-sqlite3';

export { readDbSchemaVersion } from '../mappings/schema.js';

/** Bump together with DBS['cleanroom-api'].schemaVersion in src/dbs.ts. */
export const CLEANROOM_API_SCHEMA_VERSION = 2;

export const CLEANROOM_API_SCHEMA = `
-- Metadata table for schema versioning and provenance
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per type declaration (top-level or nested).
-- fqn uses dotted source form throughout: nested types appear as
-- 'net.minecraftforge.event.entity.player.PlayerInteractEvent.RightClickBlock'
-- (no '$' binary names — this DB never joins against the mappings DB).
CREATE TABLE IF NOT EXISTS types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fqn TEXT NOT NULL UNIQUE,
  simple_name TEXT NOT NULL,
  package_name TEXT NOT NULL,
  outer_fqn TEXT,                    -- enclosing type FQN; NULL for top-level
  kind TEXT NOT NULL CHECK (kind IN ('class','interface','enum','annotation','record')),
  loader TEXT NOT NULL,              -- 'cleanroom' (com.cleanroommc.*, zone.rong.*) | 'forge' (net.minecraftforge.*)
  modifiers TEXT,                    -- 'public static abstract' (annotations excluded)
  signature TEXT NOT NULL,           -- normalized declaration line
  extends_raw TEXT,                  -- as written, incl. type args: 'GenericEvent<T>'
  extends_fqn TEXT,                  -- resolved corpus FQN (type args stripped); NULL when external/unresolved
  implements_raw TEXT,               -- JSON string[] as written (interface 'extends' lists land here too)
  implements_fqns TEXT,              -- JSON string[] of resolved corpus FQNs only
  annotations TEXT,                  -- JSON string[] of annotation names as written ('Cancelable', 'Mod.EventBusSubscriber')
  javadoc TEXT,                      -- cleaned body (comment markers stripped, block tags removed)
  javadoc_summary TEXT,              -- first sentence
  is_deprecated INTEGER NOT NULL DEFAULT 0,  -- @Deprecated annotation OR @deprecated javadoc tag
  deprecation_note TEXT,             -- text of the @deprecated javadoc tag, if any
  since TEXT,                        -- @since javadoc tag value
  is_event INTEGER NOT NULL DEFAULT 0,       -- transitive subclass of net.minecraftforge.fml.common.eventhandler.Event (incl. Event itself)
  is_cancelable INTEGER NOT NULL DEFAULT 0,  -- @Cancelable on self or any corpus-internal ancestor
  has_result INTEGER NOT NULL DEFAULT 0,     -- @HasResult / @Event.HasResult, same inheritance rule
  source_file TEXT NOT NULL,         -- jar-relative path of the declaring .java file
  search_text TEXT NOT NULL          -- lower-cased camel-split token bag driving FTS
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('method','constructor','field','enum_constant','annotation_element')),
  name TEXT NOT NULL,
  signature TEXT NOT NULL,           -- 'public static void register(Class<?> clazz)' / 'String value() default ""'
  return_type TEXT,                  -- return/field/element type; NULL for constructors and enum constants
  params TEXT,                       -- JSON [{type,name}] for methods/constructors; NULL otherwise
  modifiers TEXT,
  annotations TEXT,                  -- JSON string[]
  javadoc TEXT,
  javadoc_summary TEXT,
  is_deprecated INTEGER NOT NULL DEFAULT 0,
  deprecation_note TEXT,             -- text of the @deprecated javadoc tag, if any
  since TEXT,
  search_text TEXT NOT NULL,
  FOREIGN KEY (type_id) REFERENCES types(id) ON DELETE CASCADE
);

-- Popularity signal for the annotations catalog: how often each corpus-defined
-- annotation is applied across all indexed type and member declarations.
CREATE TABLE IF NOT EXISTS annotation_usage (
  annotation_fqn TEXT PRIMARY KEY,
  usage_count INTEGER NOT NULL
);

-- Lookup indexes
CREATE INDEX IF NOT EXISTS idx_types_simple    ON types(simple_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_types_package   ON types(package_name);
CREATE INDEX IF NOT EXISTS idx_types_kind      ON types(kind);
CREATE INDEX IF NOT EXISTS idx_types_outer     ON types(outer_fqn)   WHERE outer_fqn IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_types_extends   ON types(extends_fqn) WHERE extends_fqn IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_types_event     ON types(is_event)    WHERE is_event = 1;
CREATE INDEX IF NOT EXISTS idx_members_type    ON members(type_id);
CREATE INDEX IF NOT EXISTS idx_members_name    ON members(name);
CREATE INDEX IF NOT EXISTS idx_members_kind    ON members(kind);

-- Full-text search (external content; kept in sync by triggers)
CREATE VIRTUAL TABLE IF NOT EXISTS types_fts USING fts5(
  fqn, search_text, javadoc,
  content='types',
  content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS members_fts USING fts5(
  name, search_text, javadoc,
  content='members',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS types_ai AFTER INSERT ON types BEGIN
  INSERT INTO types_fts(rowid, fqn, search_text, javadoc)
  VALUES (new.id, new.fqn, new.search_text, new.javadoc);
END;

CREATE TRIGGER IF NOT EXISTS types_ad AFTER DELETE ON types BEGIN
  INSERT INTO types_fts(types_fts, rowid, fqn, search_text, javadoc)
  VALUES ('delete', old.id, old.fqn, old.search_text, old.javadoc);
END;

CREATE TRIGGER IF NOT EXISTS types_au AFTER UPDATE ON types BEGIN
  INSERT INTO types_fts(types_fts, rowid, fqn, search_text, javadoc)
  VALUES ('delete', old.id, old.fqn, old.search_text, old.javadoc);
  INSERT INTO types_fts(rowid, fqn, search_text, javadoc)
  VALUES (new.id, new.fqn, new.search_text, new.javadoc);
END;

CREATE TRIGGER IF NOT EXISTS members_ai AFTER INSERT ON members BEGIN
  INSERT INTO members_fts(rowid, name, search_text, javadoc)
  VALUES (new.id, new.name, new.search_text, new.javadoc);
END;

CREATE TRIGGER IF NOT EXISTS members_ad AFTER DELETE ON members BEGIN
  INSERT INTO members_fts(members_fts, rowid, name, search_text, javadoc)
  VALUES ('delete', old.id, old.name, old.search_text, old.javadoc);
END;

CREATE TRIGGER IF NOT EXISTS members_au AFTER UPDATE ON members BEGIN
  INSERT INTO members_fts(members_fts, rowid, name, search_text, javadoc)
  VALUES ('delete', old.id, old.name, old.search_text, old.javadoc);
  INSERT INTO members_fts(rowid, name, search_text, javadoc)
  VALUES (new.id, new.name, new.search_text, new.javadoc);
END;
`;

/** Create (or open) a Cleanroom API database and apply the v1 schema. */
export function initializeCleanroomApiDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(CLEANROOM_API_SCHEMA);
  db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)`).run(
    String(CLEANROOM_API_SCHEMA_VERSION)
  );
  return db;
}

/** Read a single metadata value from a Cleanroom API database, or null. */
export function readDbMetadata(dbPath: string, key: string): string | null {
  if (!fs.existsSync(dbPath)) {
    return null;
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.prepare(`SELECT value FROM metadata WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
