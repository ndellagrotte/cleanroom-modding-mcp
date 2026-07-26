/**
 * Ingest (pipeline stage 5).
 *
 * Writes analyzed+linked records into a fresh examples.db in a single
 * transaction (FTS stays in sync via the schema triggers), records provenance
 * metadata, and — via runIngest — ingests into a temp path then atomically
 * renames, so no partial DB is ever visible at the runtime path (DESIGN §6.5,
 * mirroring scripts/index-java-api.ts).
 *
 * example_relations is intentionally left empty in v1 (DESIGN §13.5); the table
 * is retained for a later relation pass.
 */

import fs from 'fs';
import { EXAMPLE_CATEGORIES, EXAMPLE_CATEGORY_INFO } from '../categories.js';
import { initializeExamplesDb } from './schema.js';
import type { ExampleRecord, IngestCounts, IngestMeta } from './model.js';

export interface ModMeta {
  name: string;
  repo: string;
  loader: string;
  license: string;
  description?: string;
  readmeSummary?: string;
  architectureNotes?: string;
  starCount?: number;
  minecraftVersions: string[];
  /** ORDER BY priority DESC — higher = ranked first. Written from roster order. */
  priority: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Up-to-date skip predicate (drives the indexer no-op)
// ─────────────────────────────────────────────────────────────────────────────

export interface SkipState {
  roster_pins: Record<string, string>;
  analysis_version: string;
  schema_version: number;
}

function stablePins(pins: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(pins)
      .sort()
      .map((k) => [k, pins[k]])
  );
}

/**
 * True only when the existing DB already matches the target on all three keys —
 * roster SHAs, analysis_version, and schema_version (DESIGN §6.4, OQ18).
 * `--force` (force=true) always rebuilds.
 */
export function isUpToDate(existing: SkipState, target: SkipState, force = false): boolean {
  if (force) return false;
  return (
    existing.analysis_version === target.analysis_version &&
    existing.schema_version === target.schema_version &&
    stablePins(existing.roster_pins) === stablePins(target.roster_pins)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest
// ─────────────────────────────────────────────────────────────────────────────

/** Write mods + examples + children into dbPath (created/overwritten by init). */
export function ingest(
  dbPath: string,
  records: ExampleRecord[],
  mods: ModMeta[],
  meta: IngestMeta
): IngestCounts {
  const db = initializeExamplesDb(dbPath);
  try {
    const insertCategory = db.prepare(
      `INSERT INTO categories (slug, name, description, icon, sort_order) VALUES (?, ?, ?, ?, ?)`
    );
    const insertMod = db.prepare(
      `INSERT INTO mods (name, repo, loader, license, description, readme_summary,
        architecture_notes, star_count, minecraft_versions, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertExample = db.prepare(
      `INSERT INTO examples (mod_id, category_id, file_path, file_url, start_line, end_line,
        title, code, language, caption, explanation, pattern_type, complexity,
        best_practices, potential_pitfalls, use_cases, keywords, minecraft_concepts,
        quality_score, is_featured)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertImport = db.prepare(
      `INSERT INTO example_imports (example_id, import_path, import_type, is_critical) VALUES (?, ?, ?, ?)`
    );
    const insertApiRef = db.prepare(
      `INSERT INTO api_references (example_id, class_name, method_name, api_type,
        srg_name, resolved_name, api_fqn, api_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertTag = db.prepare(`INSERT INTO tags (slug) VALUES (?)`);
    const insertExampleTag = db.prepare(
      `INSERT OR IGNORE INTO example_tags (example_id, tag_id) VALUES (?, ?)`
    );
    const insertMetadata = db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`);

    const counts: IngestCounts = {
      mods: 0,
      examples: 0,
      categories: 0,
      tags: 0,
      imports: 0,
      apiReferences: 0,
      srgResolved: 0,
      apiResolved: 0,
      byLoader: {},
      uncategorized: 0,
      byCategory: {},
    };

    const run = db.transaction(() => {
      // Categories from the single-source EXAMPLE_CATEGORIES registry.
      const categoryId = new Map<string, number>();
      EXAMPLE_CATEGORIES.forEach((slug, i) => {
        const info = EXAMPLE_CATEGORY_INFO[slug];
        const res = insertCategory.run(slug, info.name, info.description, info.icon, i);
        categoryId.set(slug, res.lastInsertRowid as number);
        counts.categories++;
      });

      // Mods (deduped by repo; priority written from roster order).
      const modId = new Map<string, number>();
      for (const mod of mods) {
        if (modId.has(mod.repo)) continue;
        const res = insertMod.run(
          mod.name,
          mod.repo,
          mod.loader,
          mod.license,
          mod.description ?? null,
          mod.readmeSummary ?? null,
          mod.architectureNotes ?? null,
          mod.starCount ?? null,
          JSON.stringify(mod.minecraftVersions ?? []),
          mod.priority
        );
        modId.set(mod.repo, res.lastInsertRowid as number);
        counts.mods++;
      }

      const tagId = new Map<string, number>();
      const ensureTag = (slug: string): number => {
        const existing = tagId.get(slug);
        if (existing !== undefined) return existing;
        const res = insertTag.run(slug);
        const id = res.lastInsertRowid as number;
        tagId.set(slug, id);
        counts.tags++;
        return id;
      };

      for (const rec of records) {
        const mid = modId.get(rec.modRepo);
        if (mid === undefined) {
          throw new Error(`ingest: example references unknown mod repo '${rec.modRepo}'`);
        }
        const slug = rec.categorySlug;
        const cid = slug ? (categoryId.get(slug) ?? null) : null;
        if (slug !== null && cid !== null) {
          counts.byCategory[slug] = (counts.byCategory[slug] ?? 0) + 1;
        } else {
          counts.uncategorized++;
        }
        const res = insertExample.run(
          mid,
          cid,
          rec.filePath,
          rec.fileUrl,
          rec.startLine,
          rec.endLine,
          rec.title,
          rec.code,
          rec.language,
          rec.caption,
          rec.explanation,
          rec.patternType,
          rec.complexity,
          JSON.stringify(rec.bestPractices),
          JSON.stringify(rec.potentialPitfalls),
          JSON.stringify(rec.useCases),
          JSON.stringify(rec.keywords),
          JSON.stringify(rec.minecraftConcepts),
          rec.qualityScore,
          rec.isFeatured ? 1 : 0
        );
        const exampleId = res.lastInsertRowid as number;
        counts.examples++;
        counts.byLoader[rec.loader] = (counts.byLoader[rec.loader] ?? 0) + 1;

        for (const imp of rec.imports) {
          insertImport.run(exampleId, imp.path, imp.type, imp.isCritical ? 1 : 0);
          counts.imports++;
        }
        for (const ref of rec.apiReferences) {
          insertApiRef.run(
            exampleId,
            ref.className,
            ref.methodName,
            ref.apiType,
            ref.srgName,
            ref.resolvedName,
            ref.apiFqn,
            ref.apiKind
          );
          counts.apiReferences++;
          if (ref.resolvedName) counts.srgResolved++;
          if (ref.apiFqn) counts.apiResolved++;
        }
        for (const tag of rec.tags) {
          insertExampleTag.run(exampleId, ensureTag(tag));
        }
      }

      insertMetadata.run('analysis_version', meta.analysisVersion);
      insertMetadata.run('prompt_version', meta.promptVersion);
      insertMetadata.run('llm_model', meta.llmModel);
      insertMetadata.run('roster_pins', JSON.stringify(meta.rosterPins));
      insertMetadata.run('license_review', JSON.stringify(meta.licenseReview));
      insertMetadata.run('indexed_at', new Date().toISOString());
      insertMetadata.run('counts', JSON.stringify(counts));
      // Additive Revision 1 provenance (real builds only; absent in golden).
      if (meta.llmBaseHost !== undefined) insertMetadata.run('llm_base_host', meta.llmBaseHost);
      if (meta.llmCost !== undefined) insertMetadata.run('llm_cost', meta.llmCost);

      return counts;
    });

    return run();
  } finally {
    db.close();
  }
}

/**
 * Ingest into `${dbPath}.tmp` then atomically rename into place, cleaning up
 * tmp/-wal/-shm on error so no partial DB ever lands at the runtime path.
 */
export function runIngest(opts: {
  dbPath: string;
  records: ExampleRecord[];
  mods: ModMeta[];
  meta: IngestMeta;
}): IngestCounts {
  const tmp = `${opts.dbPath}.tmp`;
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${tmp}${suffix}`, { force: true });
  }
  try {
    const counts = ingest(tmp, opts.records, opts.mods, opts.meta);
    for (const suffix of ['-wal', '-shm']) {
      fs.rmSync(`${opts.dbPath}${suffix}`, { force: true });
    }
    try {
      fs.renameSync(tmp, opts.dbPath);
    } catch {
      fs.rmSync(opts.dbPath, { force: true });
      fs.renameSync(tmp, opts.dbPath);
    }
    return counts;
  } catch (error) {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${tmp}${suffix}`, { force: true });
    }
    throw error;
  }
}
