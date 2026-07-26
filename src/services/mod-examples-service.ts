/**
 * Mod Examples Service — query curated code examples from canonical open-source
 * 1.12.2 mods (the eight-repo roster in data/examples-roster.json).
 *
 * The database is built by scripts/index-mod-examples.ts (schema v2,
 * src/examples/schema.ts) and only read here. SRG cross-links and framework-API
 * references are resolved at index time and stored, so the runtime service opens
 * no sibling database and degrades gracefully when the mappings/API corpora are
 * absent (DESIGN §8).
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import { getDefaultDbPath } from '../data-dir.js';
import { DBS } from '../dbs.js';
import { readDbSchemaVersion } from '../examples/schema.js';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ModInfo {
  id: number;
  name: string;
  repo: string;
  loader: string;
  license: string;
  description: string;
  readmeSummary: string;
  architectureNotes: string;
  starCount: number;
  minecraftVersions: string[];
  exampleCount: number;
}

export interface ApiReference {
  className: string;
  methodName?: string;
  apiType: string;
  /** SRG token when the reference is an SRG name (resolved at index time). */
  srgName?: string;
  /** Readable name resolved from the 1.12.2 mappings at index time. */
  resolvedName?: string;
  /** Framework FQN from the Cleanroom API corpus at index time. */
  apiFqn?: string;
  /** 'event' | 'annotation' | 'class' | … from the Cleanroom API corpus. */
  apiKind?: string;
}

export interface ModExample {
  id: number;
  modName: string;
  modRepo: string;
  loader: string;
  license: string;
  filePath: string;
  fileUrl: string;
  startLine: number;
  endLine: number;
  title: string;
  code: string;
  language: string;
  caption: string;
  explanation: string;
  patternType: string;
  complexity: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  category: string;
  categoryName: string;
  bestPractices: string[];
  potentialPitfalls: string[];
  useCases: string[];
  keywords: string[];
  minecraftConcepts: string[];
  qualityScore: number;
  isFeatured: boolean;
  tags: string[];
  imports: Array<{ path: string; type: string; isCritical: boolean }>;
  apiReferences: ApiReference[];
}

export interface ExampleRelation {
  sourceId: number;
  targetId: number;
  relationType: 'uses' | 'extends' | 'similar_to' | 'alternative_to' | 'requires' | 'complements';
  description: string;
  strength: number;
  targetTitle: string;
  targetCaption: string;
}

export interface ModExampleSearchOptions {
  query?: string;
  modName?: string;
  loader?: string;
  minecraftVersion?: string;
  category?: string;
  patternType?: string;
  complexity?: string;
  minQualityScore?: number;
  featured?: boolean;
  tags?: string[];
  limit?: number;
}

export interface CategoryInfo {
  slug: string;
  name: string;
  description: string;
  icon: string;
  exampleCount: number;
}

/** Raw example row as SELECTed by search/get (JSON columns still strings). */
interface RawExampleRow {
  id: number;
  modName: string;
  modRepo: string;
  loader: string;
  license: string;
  filePath: string;
  fileUrl: string;
  startLine: number;
  endLine: number;
  title: string;
  code: string;
  language: string;
  caption: string;
  explanation: string;
  patternType: string;
  complexity: ModExample['complexity'];
  category: string;
  categoryName: string;
  bestPractices: string;
  potentialPitfalls: string;
  useCases: string;
  keywords: string;
  minecraftConcepts: string;
  qualityScore: number;
  isFeatured: number;
}

const EXAMPLE_COLUMNS = `
  e.id,
  m.name as modName,
  m.repo as modRepo,
  m.loader as loader,
  m.license as license,
  e.file_path as filePath,
  e.file_url as fileUrl,
  e.start_line as startLine,
  e.end_line as endLine,
  e.title,
  e.code,
  e.language,
  e.caption,
  e.explanation,
  e.pattern_type as patternType,
  e.complexity,
  c.slug as category,
  c.name as categoryName,
  e.best_practices as bestPractices,
  e.potential_pitfalls as potentialPitfalls,
  e.use_cases as useCases,
  e.keywords,
  e.minecraft_concepts as minecraftConcepts,
  e.quality_score as qualityScore,
  e.is_featured as isFeatured
`;

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class ModExamplesService {
  private db: Database.Database;
  private static dbPath = getDefaultDbPath(DBS.examples.fileName);
  /** Schema-gate result cached by file identity so isAvailable() stays cheap. */
  private static availabilityCache: { mtimeMs: number; size: number; ok: boolean } | null = null;

  constructor(dbPath?: string, options?: { mappingsDb?: string | null }) {
    const finalPath = dbPath || ModExamplesService.dbPath;
    // `options` is accepted for API symmetry with SRG-aware callers; all SRG /
    // framework enrichment is pre-stored, so no sibling database is opened at
    // runtime and rendering degrades gracefully on its own.
    console.error(
      `[ModExamplesService] Using database at: ${finalPath}` +
        (options?.mappingsDb === null ? ' (enrichment is pre-stored; no sibling DB opened)' : '')
    );
    this.db = new Database(finalPath, { readonly: true });
  }

  /**
   * Available AND schema-matched (DBS.examples.schemaVersion). A legacy DB with
   * no metadata table (readDbSchemaVersion → null) reads as not installed, so
   * startup auto-update replaces it (DESIGN §5).
   */
  static isAvailable(dbPath: string = ModExamplesService.dbPath): boolean {
    const useCache = dbPath === ModExamplesService.dbPath;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dbPath);
    } catch {
      if (useCache) {
        ModExamplesService.availabilityCache = null;
      }
      return false;
    }
    if (useCache) {
      const cache = ModExamplesService.availabilityCache;
      if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
        return cache.ok;
      }
    }
    const ok = readDbSchemaVersion(dbPath) === DBS.examples.schemaVersion;
    if (useCache) {
      ModExamplesService.availabilityCache = { mtimeMs: stat.mtimeMs, size: stat.size, ok };
    }
    return ok;
  }

  /** True when a DB file exists but its schema_version doesn't match this build. */
  static isSchemaOutdated(dbPath: string = ModExamplesService.dbPath): boolean {
    return fs.existsSync(dbPath) && !ModExamplesService.isAvailable(dbPath);
  }

  static getDbPath(): string {
    return ModExamplesService.dbPath;
  }

  getStats(): {
    mods: number;
    examples: number;
    relations: number;
    categories: number;
    featuredExamples: number;
    avgQualityScore: number;
  } {
    const stats = this.db
      .prepare(
        `
      SELECT
        (SELECT COUNT(*) FROM mods) as mods,
        (SELECT COUNT(*) FROM examples) as examples,
        (SELECT COUNT(*) FROM example_relations) as relations,
        (SELECT COUNT(*) FROM categories) as categories,
        (SELECT COUNT(*) FROM examples WHERE is_featured = 1) as featuredExamples,
        (SELECT AVG(quality_score) FROM examples) as avgQualityScore
    `
      )
      .get() as {
      mods: number;
      examples: number;
      relations: number;
      categories: number;
      featuredExamples: number;
      avgQualityScore: number;
    };

    return {
      ...stats,
      avgQualityScore: Math.round((stats.avgQualityScore || 0) * 100) / 100,
    };
  }

  /** List all indexed canonical mods. */
  listMods(): ModInfo[] {
    const mods = this.db
      .prepare(
        `
      SELECT
        m.id,
        m.name,
        m.repo,
        m.loader,
        m.license,
        m.description,
        m.readme_summary as readmeSummary,
        m.architecture_notes as architectureNotes,
        m.star_count as starCount,
        m.minecraft_versions as minecraftVersions,
        COUNT(e.id) as exampleCount
      FROM mods m
      LEFT JOIN examples e ON e.mod_id = m.id
      GROUP BY m.id
      ORDER BY m.priority DESC, m.star_count DESC
    `
      )
      .all() as Array<ModInfo & { minecraftVersions: string }>;

    return mods.map((m) => ({
      ...m,
      starCount: m.starCount ?? 0,
      minecraftVersions: JSON.parse(m.minecraftVersions || '[]') as string[],
    }));
  }

  /**
   * List all categories with example counts, including empty ones. Empty
   * categories are deliberately kept: the slug list is also the
   * `search_mod_examples` schema enum, so hiding a zero-count category left a
   * client able to pick a filter value that silently always returned nothing.
   */
  listCategories(): CategoryInfo[] {
    return this.db
      .prepare(
        `
      SELECT
        c.slug,
        c.name,
        c.description,
        c.icon,
        COUNT(e.id) as exampleCount
      FROM categories c
      LEFT JOIN examples e ON e.category_id = c.id
      GROUP BY c.id
      ORDER BY c.sort_order ASC
    `
      )
      .all() as CategoryInfo[];
  }

  /** Examples with no category, so category counts can be reconciled to the total. */
  countUncategorized(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM examples WHERE category_id IS NULL`)
      .get() as { n: number };
    return row.n;
  }

  /** Search for mod examples. */
  searchExamples(options: ModExampleSearchOptions): ModExample[] {
    const {
      query,
      modName,
      loader,
      minecraftVersion,
      category,
      patternType,
      complexity,
      minQualityScore = 0,
      featured,
      tags,
      limit = 10,
    } = options;

    let sql = `
      SELECT DISTINCT
        ${EXAMPLE_COLUMNS}
      FROM examples e
      JOIN mods m ON e.mod_id = m.id
      LEFT JOIN categories c ON e.category_id = c.id
    `;

    const conditions: string[] = [];
    const params: unknown[] = [];

    // Drives both the FTS JOIN and the ORDER BY below — bm25() is only a legal
    // ordering term when the statement actually carries a MATCH.
    const searchTerm = query?.trim() ?? '';

    if (searchTerm) {
      sql += ` JOIN examples_fts fts ON fts.rowid = e.id`;
      conditions.push(`examples_fts MATCH ?`);
      // Strip `"` from tokens — it is FTS5's string delimiter, and an embedded
      // quote produces a malformed MATCH ("unterminated string").
      const ftsQuery = searchTerm
        .split(/\s+/)
        .map((t) => t.replace(/"/g, ''))
        .filter((t) => t.length > 1)
        .map((t) => `"${t}"*`)
        .join(' OR ');
      params.push(ftsQuery || `"${searchTerm.replace(/"/g, '')}"`);
    }

    if (modName) {
      conditions.push(`LOWER(m.name) = LOWER(?)`);
      params.push(modName);
    }

    if (loader) {
      conditions.push(`m.loader = ?`);
      params.push(loader);
    }

    if (minecraftVersion) {
      // minecraft_versions is a JSON array string, e.g. '["1.12.2"]'.
      conditions.push(`m.minecraft_versions LIKE ?`);
      params.push(`%"${minecraftVersion}"%`);
    }

    if (category) {
      conditions.push(`c.slug = ?`);
      params.push(category);
    }

    if (patternType) {
      conditions.push(`e.pattern_type = ?`);
      params.push(patternType);
    }

    if (complexity) {
      conditions.push(`e.complexity = ?`);
      params.push(complexity);
    }

    if (minQualityScore > 0) {
      conditions.push(`e.quality_score >= ?`);
      params.push(minQualityScore);
    }

    if (featured !== undefined) {
      conditions.push(`e.is_featured = ?`);
      params.push(featured ? 1 : 0);
    }

    if (tags && tags.length > 0) {
      sql += ` JOIN example_tags et ON et.example_id = e.id JOIN tags t ON t.id = et.tag_id`;
      conditions.push(`t.slug IN (${tags.map(() => '?').join(', ')})`);
      params.push(...tags);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    // With a text query, rank by FTS relevance first (bm25 is ascending — lower is
    // a better match) and use quality only to break relevance ties. Ordering by
    // quality alone lets a passing mention in a high-scoring example outrank an
    // exact match in a lower-scoring one.
    sql += searchTerm
      ? ` ORDER BY bm25(examples_fts), e.quality_score DESC, e.is_featured DESC LIMIT ?`
      : ` ORDER BY e.quality_score DESC, e.is_featured DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as RawExampleRow[];
    return this.enrichExamples(rows);
  }

  /** Get a specific example by ID with full details. */
  getExample(id: number): ModExample | null {
    const row = this.db
      .prepare(
        `
      SELECT
        ${EXAMPLE_COLUMNS}
      FROM examples e
      JOIN mods m ON e.mod_id = m.id
      LEFT JOIN categories c ON e.category_id = c.id
      WHERE e.id = ?
    `
      )
      .get(id) as RawExampleRow | undefined;

    if (!row) return null;
    return this.enrichExamples([row])[0] ?? null;
  }

  /** Get related examples for a given example. */
  getRelatedExamples(exampleId: number): ExampleRelation[] {
    return this.db
      .prepare(
        `
      SELECT
        r.source_id as sourceId,
        r.target_id as targetId,
        r.relation_type as relationType,
        r.description,
        r.strength,
        e.title as targetTitle,
        e.caption as targetCaption
      FROM example_relations r
      JOIN examples e ON e.id = r.target_id
      WHERE r.source_id = ?
      ORDER BY r.strength DESC
    `
      )
      .all(exampleId) as ExampleRelation[];
  }

  /** Get featured examples (high quality, curated). */
  getFeaturedExamples(limit = 10): ModExample[] {
    return this.searchExamples({ featured: true, minQualityScore: 0.7, limit });
  }

  /** Get available pattern types. */
  getPatternTypes(): Array<{ type: string; count: number }> {
    return this.db
      .prepare(
        `
      SELECT pattern_type as type, COUNT(*) as count
      FROM examples
      WHERE pattern_type IS NOT NULL
      GROUP BY pattern_type
      ORDER BY count DESC
    `
      )
      .all() as Array<{ type: string; count: number }>;
  }

  /**
   * Enrich a set of example rows with tags, imports, and API references using a
   * single batched query per child table (WHERE example_id IN (…)) — O(1) child
   * queries for the whole set rather than O(3N) (DESIGN §9, N+1 fix).
   */
  private enrichExamples(rows: RawExampleRow[]): ModExample[] {
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(', ');

    const tagRows = this.db
      .prepare(
        `SELECT et.example_id as exampleId, t.slug
         FROM tags t JOIN example_tags et ON et.tag_id = t.id
         WHERE et.example_id IN (${placeholders})`
      )
      .all(...ids) as Array<{ exampleId: number; slug: string }>;

    const importRows = this.db
      .prepare(
        `SELECT example_id as exampleId, import_path as path, import_type as type, is_critical as isCritical
         FROM example_imports WHERE example_id IN (${placeholders})`
      )
      .all(...ids) as Array<{
      exampleId: number;
      path: string;
      type: string;
      isCritical: number;
    }>;

    const apiRows = this.db
      .prepare(
        `SELECT example_id as exampleId, class_name as className, method_name as methodName,
                api_type as apiType, srg_name as srgName, resolved_name as resolvedName,
                api_fqn as apiFqn, api_kind as apiKind
         FROM api_references WHERE example_id IN (${placeholders})`
      )
      .all(...ids) as Array<{
      exampleId: number;
      className: string;
      methodName: string | null;
      apiType: string | null;
      srgName: string | null;
      resolvedName: string | null;
      apiFqn: string | null;
      apiKind: string | null;
    }>;

    const groupInto = <T>(map: Map<number, T[]>, key: number, value: T): void => {
      const list = map.get(key);
      if (list) {
        list.push(value);
      } else {
        map.set(key, [value]);
      }
    };

    const tagsByExample = new Map<number, string[]>();
    for (const t of tagRows) {
      groupInto(tagsByExample, t.exampleId, t.slug);
    }
    const importsByExample = new Map<number, ModExample['imports']>();
    for (const i of importRows) {
      groupInto(importsByExample, i.exampleId, {
        path: i.path,
        type: i.type,
        isCritical: Boolean(i.isCritical),
      });
    }
    const apiByExample = new Map<number, ApiReference[]>();
    for (const r of apiRows) {
      groupInto(apiByExample, r.exampleId, {
        className: r.className,
        methodName: r.methodName || undefined,
        apiType: r.apiType || 'unknown',
        srgName: r.srgName || undefined,
        resolvedName: r.resolvedName || undefined,
        apiFqn: r.apiFqn || undefined,
        apiKind: r.apiKind || undefined,
      });
    }

    return rows.map((row) => ({
      id: row.id,
      modName: row.modName,
      modRepo: row.modRepo,
      loader: row.loader,
      license: row.license,
      filePath: row.filePath,
      fileUrl: row.fileUrl,
      startLine: row.startLine,
      endLine: row.endLine,
      title: row.title,
      code: row.code,
      language: row.language,
      caption: row.caption,
      explanation: row.explanation,
      patternType: row.patternType,
      complexity: row.complexity,
      category: row.category,
      categoryName: row.categoryName,
      bestPractices: JSON.parse(row.bestPractices || '[]') as string[],
      potentialPitfalls: JSON.parse(row.potentialPitfalls || '[]') as string[],
      useCases: JSON.parse(row.useCases || '[]') as string[],
      keywords: JSON.parse(row.keywords || '[]') as string[],
      minecraftConcepts: JSON.parse(row.minecraftConcepts || '[]') as string[],
      qualityScore: row.qualityScore,
      isFeatured: Boolean(row.isFeatured),
      tags: tagsByExample.get(row.id) ?? [],
      imports: importsByExample.get(row.id) ?? [],
      apiReferences: apiByExample.get(row.id) ?? [],
    }));
  }

  /** Format an example as AI-friendly Markdown with attribution + cross-links. */
  formatExampleForAI(example: ModExample): string {
    let output = '';

    output += `## ${example.title}\n\n`;
    // Attribution: mod, repo, license, and the upstream deep-link (DESIGN §4).
    output += `**Source:** ${example.modName} (${example.modRepo}, ${example.license}) — `;
    output += `[${example.filePath}](${example.fileUrl}) lines ${example.startLine}–${example.endLine}\n`;
    output += `**Loader:** ${example.loader}\n`;
    output += `**Category:** ${example.categoryName || example.category || 'Uncategorized'}\n`;
    output += `**Pattern:** ${example.patternType}\n`;
    output += `**Complexity:** ${example.complexity}\n`;
    output += `**Quality Score:** ${(example.qualityScore * 100).toFixed(0)}%\n`;

    if (example.isFeatured) {
      output += `**Featured:** Yes (curated high-quality example)\n`;
    }
    if (example.tags.length > 0) {
      output += `**Tags:** ${example.tags.join(', ')}\n`;
    }

    output += `\n### Description\n${example.caption}\n`;

    if (example.explanation) {
      output += `\n### Detailed Explanation\n${example.explanation}\n`;
    }

    output += `\n### Code\n\`\`\`${example.language}\n${example.code}\n\`\`\`\n`;

    if (example.bestPractices.length > 0) {
      output += `\n### Best Practices\n`;
      example.bestPractices.forEach((bp) => (output += `- ${bp}\n`));
    }
    if (example.potentialPitfalls.length > 0) {
      output += `\n### Potential Pitfalls\n`;
      example.potentialPitfalls.forEach((pp) => (output += `- ⚠️ ${pp}\n`));
    }
    if (example.useCases.length > 0) {
      output += `\n### When to Use\n`;
      example.useCases.forEach((uc) => (output += `- ${uc}\n`));
    }
    if (example.minecraftConcepts.length > 0) {
      output += `\n### Minecraft Concepts Used\n`;
      output += example.minecraftConcepts.join(', ') + '\n';
    }

    // SRG cross-links: render the readable name and point at resolve_symbol. The
    // names are stored (resolved at index time) so this works with or without the
    // 1.12.2 mappings corpus present at runtime.
    const srgRefs = example.apiReferences.filter((r) => r.srgName);
    if (srgRefs.length > 0) {
      output += `\n### SRG Cross-References\n`;
      for (const r of srgRefs) {
        const readable = r.resolvedName ?? '(unresolved)';
        output += `- ${r.srgName} → ${readable} (resolve with \`resolve_symbol\`)\n`;
      }
    }

    // Framework symbols resolved against the Cleanroom API corpus at index time.
    const apiRefs = example.apiReferences.filter((r) => r.apiFqn);
    if (apiRefs.length > 0) {
      output += `\n### Framework API\n`;
      for (const r of apiRefs) {
        output += `- ${r.apiFqn}${r.apiKind ? ` (${r.apiKind})` : ''} — see \`get_api_class\`\n`;
      }
    }

    if (example.imports.length > 0) {
      const criticalImports = example.imports.filter((i) => i.isCritical);
      if (criticalImports.length > 0) {
        output += `\n### Required Imports\n\`\`\`java\n`;
        criticalImports.forEach((i) => (output += `import ${i.path};\n`));
        output += `\`\`\`\n`;
      }
    }

    return output;
  }

  close(): void {
    this.db.close();
  }
}
