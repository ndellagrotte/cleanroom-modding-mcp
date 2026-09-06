/** Repair registry-derived category metadata without re-running example analyses. */
import Database from 'better-sqlite3';
import { EXAMPLE_CATEGORIES, EXAMPLE_CATEGORY_INFO } from '../categories.js';
import { EXAMPLES_SCHEMA_VERSION, readDbSchemaVersion } from './schema.js';

interface CategoryRow {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  sort_order: number | null;
}

/**
 * Shared by fresh ingest and in-place migrations. Preserve category IDs and
 * example assignments; unknown slugs remain for the corpus lint to reject.
 * Compare before writing so an already-current DB is a physical no-op too.
 * Returns the number of category rows inserted or updated.
 */
export function syncExampleCategories(db: Database.Database): number {
  return db.transaction(() => {
    const rows = db.prepare('SELECT * FROM categories').all() as CategoryRow[];
    const existing = new Map(rows.map((row) => [row.slug, row]));
    const insert = db.prepare(
      'INSERT INTO categories (slug, name, description, icon, sort_order) VALUES (?, ?, ?, ?, ?)'
    );
    const update = db.prepare(
      'UPDATE categories SET name = ?, description = ?, icon = ?, sort_order = ? WHERE id = ?'
    );
    let added = 0;
    let updated = 0;
    for (const [sortOrder, slug] of EXAMPLE_CATEGORIES.entries()) {
      const info = EXAMPLE_CATEGORY_INFO[slug];
      const row = existing.get(slug);
      if (!row) {
        insert.run(slug, info.name, info.description, info.icon, sortOrder);
        added++;
      } else if (
        row.name !== info.name ||
        row.description !== info.description ||
        row.icon !== info.icon ||
        row.sort_order !== sortOrder
      ) {
        update.run(info.name, info.description, info.icon, sortOrder, row.id);
        updated++;
      }
    }

    const storedCounts = db.prepare("SELECT value FROM metadata WHERE key = 'counts'").get() as
      | { value: string }
      | undefined;
    if (storedCounts) {
      const counts = JSON.parse(storedCounts.value) as Record<string, unknown>;
      const categoryCount = rows.length + added;
      if (counts.categories !== categoryCount) {
        counts.categories = categoryCount;
        db.prepare("UPDATE metadata SET value = ? WHERE key = 'counts'").run(
          JSON.stringify(counts)
        );
      }
    }
    return added + updated;
  })();
}

/**
 * Synchronize an installed/current-schema DB, or skip an absent/incompatible
 * one. Build callers fail on errors; server startup catches them to stay usable.
 * No schema bump: only registry-derived values change, never the corpus or DDL.
 */
export function migrateExampleCategories(dbPath: string): number {
  if (readDbSchemaVersion(dbPath) !== EXAMPLES_SCHEMA_VERSION) return 0;

  const db = new Database(dbPath, { fileMustExist: true });
  try {
    const changed = syncExampleCategories(db);
    if (changed > 0) {
      console.error(`[Migrate] ${dbPath}: synchronized ${changed} example categories`);
    }
    return changed;
  } finally {
    db.close();
  }
}
