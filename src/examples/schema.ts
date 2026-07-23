/**
 * Mod-examples database schema (v2) — the single source of truth for the DDL.
 *
 * The legacy examples pipeline (and its DDL) were never committed and are lost;
 * this schema is reconstructed from the service's SELECTs (authoritative by
 * observation — DESIGN.md §5, RESEARCH §2.2/A.6) and frozen here, mirroring the
 * Phase 3 sibling src/cleanroom-api/schema.ts.
 *
 * The maintainer indexer (scripts/index-mod-examples.ts) creates databases
 * through this module; the runtime service reads them. Like the cleanroom-api
 * DB there is no on-device build path — this DB is always distributed prebuilt
 * (DESIGN.md §2, §6.3).
 *
 * v2 additions over the observed legacy schema (marked below): mods.license,
 * api_references.{srg_name,resolved_name,api_fqn,api_kind}, the metadata table.
 */

import fs from 'fs';
import Database from 'better-sqlite3';

export { readDbSchemaVersion } from '../mappings/schema.js';

/** Bump together with DBS.examples.schemaVersion in src/dbs.ts. */
export const EXAMPLES_SCHEMA_VERSION = 2;

export const EXAMPLES_SCHEMA = `
-- Metadata table for schema versioning and provenance (NEW in v2; the legacy DB
-- lacked it, which is what makes the runtime schema gate + auto-update work).
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  repo TEXT NOT NULL,                -- 'owner/name'; rendered https://github.com/{repo}
  loader TEXT NOT NULL,              -- 'forge' | 'cleanroom' (target family)
  license TEXT NOT NULL,             -- verified license id from the roster manifest (NEW)
  description TEXT,
  readme_summary TEXT,
  architecture_notes TEXT,
  star_count INTEGER,
  minecraft_versions TEXT,           -- JSON array
  priority INTEGER                   -- ORDER BY m.priority DESC; written from roster ordering
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,         -- filter key; sourced from EXAMPLE_CATEGORIES
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  sort_order INTEGER
);

CREATE TABLE IF NOT EXISTS examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mod_id INTEGER NOT NULL REFERENCES mods(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id),
  file_path TEXT,
  file_url TEXT,
  start_line INTEGER,
  end_line INTEGER,
  title TEXT NOT NULL,
  code TEXT,
  language TEXT,
  caption TEXT,
  explanation TEXT,                  -- LLM-produced
  pattern_type TEXT,
  complexity TEXT,                   -- beginner|intermediate|advanced|expert
  best_practices TEXT,               -- JSON array (LLM-produced)
  potential_pitfalls TEXT,           -- JSON array
  use_cases TEXT,                    -- JSON array
  keywords TEXT,                     -- JSON array
  minecraft_concepts TEXT,           -- JSON array
  quality_score REAL,                -- 0..1 (rubric in the analysis prompt)
  is_featured INTEGER                -- 0/1
);

CREATE TABLE IF NOT EXISTS example_relations (
  source_id INTEGER NOT NULL REFERENCES examples(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES examples(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,       -- uses|extends|similar_to|alternative_to|requires|complements
  description TEXT,
  strength REAL
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS example_tags (
  example_id INTEGER NOT NULL REFERENCES examples(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (example_id, tag_id)
);

CREATE TABLE IF NOT EXISTS example_imports (
  example_id INTEGER NOT NULL REFERENCES examples(id) ON DELETE CASCADE,
  import_path TEXT NOT NULL,
  import_type TEXT,
  is_critical INTEGER                -- 0/1; the formatter renders critical-only
);

CREATE TABLE IF NOT EXISTS api_references (
  example_id INTEGER NOT NULL REFERENCES examples(id) ON DELETE CASCADE,
  class_name TEXT NOT NULL,
  method_name TEXT,                  -- NULL for class-only refs
  api_type TEXT,                     -- 'vanilla' | 'forge' | 'cleanroom'
  srg_name TEXT,                     -- SRG token if class_name/method_name is SRG (NEW)
  resolved_name TEXT,                -- readable name from mappings.db (NEW), NULL if unresolved
  api_fqn TEXT,                      -- FQN from cleanroom-api.db if a framework symbol (NEW), else NULL
  api_kind TEXT                      -- 'event'|'annotation'|'class'|… from cleanroom-api.db (NEW), else NULL
);

-- Lookup indexes (implied by the service's query plans; made explicit).
CREATE INDEX IF NOT EXISTS idx_examples_mod         ON examples(mod_id);
CREATE INDEX IF NOT EXISTS idx_examples_category    ON examples(category_id);
CREATE INDEX IF NOT EXISTS idx_examples_quality     ON examples(quality_score);
CREATE INDEX IF NOT EXISTS idx_examples_featured    ON examples(is_featured);
CREATE INDEX IF NOT EXISTS idx_examples_pattern     ON examples(pattern_type);
CREATE INDEX IF NOT EXISTS idx_relations_source     ON example_relations(source_id);
CREATE INDEX IF NOT EXISTS idx_imports_example      ON example_imports(example_id);
CREATE INDEX IF NOT EXISTS idx_apirefs_example      ON api_references(example_id);
CREATE INDEX IF NOT EXISTS idx_apirefs_srg          ON api_references(srg_name) WHERE srg_name IS NOT NULL;

-- Full-text search over the curated prose columns only (external content; kept
-- in sync by triggers). Raw code is EXCLUDED — prefix-matching identifiers is
-- noisy and the LLM already distills keywords/minecraft_concepts (DESIGN §5, OQ8).
CREATE VIRTUAL TABLE IF NOT EXISTS examples_fts USING fts5(
  title, caption, explanation, best_practices, use_cases, keywords, minecraft_concepts,
  content='examples',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS examples_ai AFTER INSERT ON examples BEGIN
  INSERT INTO examples_fts(rowid, title, caption, explanation, best_practices, use_cases, keywords, minecraft_concepts)
  VALUES (new.id, new.title, new.caption, new.explanation, new.best_practices, new.use_cases, new.keywords, new.minecraft_concepts);
END;

CREATE TRIGGER IF NOT EXISTS examples_ad AFTER DELETE ON examples BEGIN
  INSERT INTO examples_fts(examples_fts, rowid, title, caption, explanation, best_practices, use_cases, keywords, minecraft_concepts)
  VALUES ('delete', old.id, old.title, old.caption, old.explanation, old.best_practices, old.use_cases, old.keywords, old.minecraft_concepts);
END;

CREATE TRIGGER IF NOT EXISTS examples_au AFTER UPDATE ON examples BEGIN
  INSERT INTO examples_fts(examples_fts, rowid, title, caption, explanation, best_practices, use_cases, keywords, minecraft_concepts)
  VALUES ('delete', old.id, old.title, old.caption, old.explanation, old.best_practices, old.use_cases, old.keywords, old.minecraft_concepts);
  INSERT INTO examples_fts(rowid, title, caption, explanation, best_practices, use_cases, keywords, minecraft_concepts)
  VALUES (new.id, new.title, new.caption, new.explanation, new.best_practices, new.use_cases, new.keywords, new.minecraft_concepts);
END;
`;

/** Create (or open) a mod-examples database and apply the v2 schema. */
export function initializeExamplesDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(EXAMPLES_SCHEMA);
  db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)`).run(
    String(EXAMPLES_SCHEMA_VERSION)
  );
  return db;
}

/** Read a single metadata value from a mod-examples database, or null. */
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
