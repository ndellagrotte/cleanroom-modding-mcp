/**
 * Cleanroom API Service — queries cleanroom-api.db, the framework symbol index
 * (com.cleanroommc.*, zone.rong.mixinbooter.*, net.minecraftforge.*) extracted
 * from the published Cleanroom sources jar.
 *
 * Backs the `search_cleanroom_api` and `get_api_class` tools. Vanilla
 * net.minecraft.* symbols live in the mappings database instead.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import { getDefaultDbPath } from '../data-dir.js';
import { DBS } from '../dbs.js';
import { readDbSchemaVersion } from '../cleanroom-api/schema.js';
import { splitCamel } from '../cleanroom-api/extract.js';

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

export type ApiSearchKind =
  | 'class'
  | 'interface'
  | 'enum'
  | 'annotation'
  | 'record'
  | 'event'
  | 'method'
  | 'field'
  | 'constructor'
  | 'all';

export interface ApiSearchOptions {
  query: string;
  packageFilter?: string;
  kind?: ApiSearchKind;
  limit?: number;
}

export interface ApiTypeResult {
  resultKind: 'type';
  fqn: string;
  simpleName: string;
  packageName: string;
  kind: string;
  loader: string;
  signature: string;
  javadocSummary: string | null;
  isDeprecated: boolean;
  deprecationNote: string | null;
  since: string | null;
  isEvent: boolean;
  isCancelable: boolean;
  hasResult: boolean;
  usageCount: number | null;
}

export interface ApiMemberResult {
  resultKind: 'member';
  memberKind: string;
  name: string;
  declaringFqn: string;
  signature: string;
  javadocSummary: string | null;
  isDeprecated: boolean;
  deprecationNote: string | null;
  since: string | null;
}

export type ApiSearchResult = ApiTypeResult | ApiMemberResult;

export interface ApiMember {
  kind: string;
  name: string;
  signature: string;
  javadocSummary: string | null;
  isDeprecated: boolean;
  deprecationNote: string | null;
  since: string | null;
}

export interface ApiClassDetails {
  fqn: string;
  simpleName: string;
  packageName: string;
  outerFqn: string | null;
  kind: string;
  loader: string;
  signature: string;
  javadoc: string | null;
  isDeprecated: boolean;
  deprecationNote: string | null;
  since: string | null;
  isEvent: boolean;
  isCancelable: boolean;
  hasResult: boolean;
  sourceFile: string;
  /** Corpus ancestor chain (parent first); the final entry may be external (raw name). */
  ancestors: Array<{ fqn: string; external: boolean }>;
  implementsRaw: string[];
  members: ApiMember[];
  memberCount: number;
  nestedTypes: string[];
  /** Direct known subclasses in the corpus (capped by the caller). */
  knownSubclasses: string[];
  /** Total direct subclasses in the corpus (knownSubclasses is capped). */
  subclassCount: number;
}

/** Result of a by-name lookup: a hit, or candidates when ambiguous. */
export interface ApiTypeLookup {
  match: ApiClassDetails | null;
  candidates: string[];
}

export interface ApiStats {
  totalTypes: number;
  totalMembers: number;
  events: number;
  annotationTypes: number;
  cleanroomVersion: string | null;
}

interface TypeRow {
  id: number;
  fqn: string;
  simple_name: string;
  package_name: string;
  outer_fqn: string | null;
  kind: string;
  loader: string;
  signature: string;
  extends_raw: string | null;
  extends_fqn: string | null;
  implements_raw: string | null;
  javadoc: string | null;
  javadoc_summary: string | null;
  is_deprecated: number;
  deprecation_note: string | null;
  since: string | null;
  is_event: number;
  is_cancelable: number;
  has_result: number;
  source_file: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

const TYPE_KINDS = new Set(['class', 'interface', 'enum', 'annotation', 'record']);
const MEMBER_KINDS = new Set(['method', 'field', 'constructor']);

export class CleanroomApiService {
  private db: Database.Database;
  private static dbPath = getDefaultDbPath(DBS['cleanroom-api'].fileName);
  /** Schema-gate result cached by file identity so isAvailable() stays cheap per call. */
  private static availabilityCache: { mtimeMs: number; size: number; ok: boolean } | null = null;

  constructor(dbPath?: string) {
    const finalPath = dbPath || CleanroomApiService.dbPath;
    console.error(`[CleanroomApiService] Using database at: ${finalPath}`);
    this.db = new Database(finalPath, { readonly: true });
  }

  /**
   * Check if the Cleanroom API database is available AND matches the schema
   * version this build expects. A stale-schema DB is treated as not installed;
   * startup auto-update replaces it.
   */
  static isAvailable(): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(CleanroomApiService.dbPath);
    } catch {
      CleanroomApiService.availabilityCache = null;
      return false;
    }
    const cache = CleanroomApiService.availabilityCache;
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      return cache.ok;
    }
    const ok =
      readDbSchemaVersion(CleanroomApiService.dbPath) === DBS['cleanroom-api'].schemaVersion;
    CleanroomApiService.availabilityCache = { mtimeMs: stat.mtimeMs, size: stat.size, ok };
    return ok;
  }

  /** True when a DB file exists but its schema_version doesn't match this build. */
  static isSchemaOutdated(): boolean {
    return fs.existsSync(CleanroomApiService.dbPath) && !CleanroomApiService.isAvailable();
  }

  static getDbPath(): string {
    return CleanroomApiService.dbPath;
  }

  close(): void {
    this.db.close();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Search
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Build the FTS5 prefix-token query: split on non-alphanumerics AND camel
   * boundaries, quote each token with a '*' suffix, AND them together
   * ('registry event' / 'RegistryEvent' both -> '"registry"* AND "event"*').
   */
  private buildFtsQuery(query: string): string | null {
    const tokens = new Set<string>();
    for (const word of query.split(/[^A-Za-z0-9]+/)) {
      if (!word) {
        continue;
      }
      const parts = splitCamel(word);
      if (parts.length > 1) {
        for (const part of parts) {
          tokens.add(part);
        }
      } else {
        tokens.add(word.toLowerCase());
      }
    }
    if (tokens.size === 0) {
      return null;
    }
    return [...tokens].map((t) => `"${t}"*`).join(' AND ');
  }

  search(options: ApiSearchOptions): ApiSearchResult[] {
    const kind = options.kind ?? 'all';
    const limit = Math.min(Math.max(options.limit ?? 15, 1), 50);
    // LIKE-wildcard-only input ('%', '_') behaves as an empty query (browse);
    // otherwise the LIKE fallback would degenerate into a match-all.
    const trimmed = options.query.trim();
    const query = trimmed.replace(/[%_]/g, '').trim() === '' ? '' : trimmed;

    const wantTypes = kind === 'all' || kind === 'event' || TYPE_KINDS.has(kind);
    const wantMembers = kind === 'all' || MEMBER_KINDS.has(kind);

    const typeHits = wantTypes ? this.searchTypes(query, kind, options.packageFilter, limit) : [];
    // Explicit member kinds browse with an empty query; kind 'all' browses
    // types only (a whole-corpus member dump would be noise). The '*' browse
    // wildcard counts as empty for this purpose.
    const memberHits =
      wantMembers && ((query && query !== '*') || MEMBER_KINDS.has(kind))
        ? this.searchMembers(query, kind, options.packageFilter, limit)
        : [];

    if (kind === 'all' && query) {
      // Split the budget so type hits can't crowd member hits out of the
      // limit entirely; unused budget flows to the other side.
      const typeQuota = Math.ceil((limit * 2) / 3);
      const memberQuota = limit - typeQuota;
      const types = typeHits.slice(0, typeQuota + Math.max(0, memberQuota - memberHits.length));
      const members = memberHits.slice(0, memberQuota + Math.max(0, typeQuota - typeHits.length));
      return [...types, ...members];
    }

    // Types before members at equal rank; both lists arrive pre-ranked.
    return [...typeHits, ...memberHits].slice(0, limit);
  }

  private typeFilterSql(
    kind: ApiSearchKind,
    packageFilter?: string
  ): { sql: string; params: unknown[] } {
    let sql = '';
    const params: unknown[] = [];
    if (kind === 'event') {
      sql += ' AND t.is_event = 1';
    } else if (TYPE_KINDS.has(kind)) {
      sql += ' AND t.kind = ?';
      params.push(kind);
    }
    if (packageFilter) {
      sql += ` AND (t.package_name = ? OR t.package_name LIKE ? || '.%' OR t.fqn = ? OR t.fqn LIKE ? || '.%')`;
      params.push(packageFilter, packageFilter, packageFilter, packageFilter);
    }
    return { sql, params };
  }

  private rowToTypeResult(row: TypeRow & { usage_count?: number | null }): ApiTypeResult {
    return {
      resultKind: 'type',
      fqn: row.fqn,
      simpleName: row.simple_name,
      packageName: row.package_name,
      kind: row.kind,
      loader: row.loader,
      signature: row.signature,
      javadocSummary: row.javadoc_summary,
      isDeprecated: row.is_deprecated === 1,
      deprecationNote: row.deprecation_note,
      since: row.since,
      isEvent: row.is_event === 1,
      isCancelable: row.is_cancelable === 1,
      hasResult: row.has_result === 1,
      usageCount: row.usage_count ?? null,
    };
  }

  private searchTypes(
    query: string,
    kind: ApiSearchKind,
    packageFilter: string | undefined,
    limit: number
  ): ApiTypeResult[] {
    const filter = this.typeFilterSql(kind, packageFilter);

    // Event browsing is an orientation surface: show Forge's public event
    // catalog before Cleanroom implementation internals, then alphabetize.
    if (!query || query === '*') {
      const browseOrder =
        kind === 'event' ? `CASE WHEN t.loader = 'forge' THEN 0 ELSE 1 END, t.fqn` : 't.fqn';
      const rows = this.db
        .prepare(
          `SELECT t.*, u.usage_count FROM types t
           LEFT JOIN annotation_usage u ON u.annotation_fqn = t.fqn
           WHERE 1=1${filter.sql}
           ORDER BY ${browseOrder} LIMIT ?`
        )
        .all(...filter.params, limit) as Array<TypeRow & { usage_count: number | null }>;
      return rows.map((row) => this.rowToTypeResult(row));
    }

    const rank = `CASE
        WHEN t.simple_name = ? COLLATE NOCASE THEN 0
        WHEN t.fqn LIKE '%.' || ? || '.%' COLLATE NOCASE THEN 1
        WHEN t.simple_name LIKE ? || '%' THEN 2
        ELSE 3 END`;
    const ftsQuery = this.buildFtsQuery(query);
    if (ftsQuery) {
      try {
        const rows = this.db
          .prepare(
            `SELECT t.*, u.usage_count, ${rank} AS name_rank
             FROM types_fts f
             JOIN types t ON t.id = f.rowid
             LEFT JOIN annotation_usage u ON u.annotation_fqn = t.fqn
             WHERE types_fts MATCH ?${filter.sql}
             ORDER BY name_rank,
                      (length(t.fqn) - length(replace(t.fqn, '.', ''))) ASC,
                      COALESCE(u.usage_count, 0) DESC,
                      bm25(types_fts)
             LIMIT ?`
          )
          .all(query, query, query, ftsQuery, ...filter.params, limit) as Array<
          TypeRow & { usage_count: number | null }
        >;
        return rows.map((row) => this.rowToTypeResult(row));
      } catch (error) {
        console.error(
          `[CleanroomApiService] FTS query failed, falling back to LIKE: ${String(error)}`
        );
      }
    }

    // LIKE fallback for FTS-hostile input.
    const like = `%${query.replace(/[%_]/g, '')}%`;
    const rows = this.db
      .prepare(
        `SELECT t.*, u.usage_count, ${rank} AS name_rank
         FROM types t
         LEFT JOIN annotation_usage u ON u.annotation_fqn = t.fqn
         WHERE (t.fqn LIKE ? OR t.search_text LIKE ?)${filter.sql}
         ORDER BY name_rank,
                  (length(t.fqn) - length(replace(t.fqn, '.', ''))) ASC,
                  COALESCE(u.usage_count, 0) DESC,
                  length(t.fqn)
         LIMIT ?`
      )
      .all(query, query, query, like, like.toLowerCase(), ...filter.params, limit) as Array<
      TypeRow & { usage_count: number | null }
    >;
    return rows.map((row) => this.rowToTypeResult(row));
  }

  private searchMembers(
    query: string,
    kind: ApiSearchKind,
    packageFilter: string | undefined,
    limit: number
  ): ApiMemberResult[] {
    let kindSql = '';
    const kindParams: unknown[] = [];
    if (MEMBER_KINDS.has(kind)) {
      kindSql = ' AND m.kind = ?';
      kindParams.push(kind);
    }
    let packageSql = '';
    const packageParams: unknown[] = [];
    if (packageFilter) {
      packageSql = ` AND (t.package_name = ? OR t.package_name LIKE ? || '.%' OR t.fqn = ? OR t.fqn LIKE ? || '.%')`;
      packageParams.push(packageFilter, packageFilter, packageFilter, packageFilter);
    }
    const rank = `CASE
        WHEN m.name = ? COLLATE NOCASE THEN 0
        WHEN m.name LIKE ? || '%' THEN 1
        ELSE 2 END`;

    const mapRow = (row: {
      kind: string;
      name: string;
      fqn: string;
      signature: string;
      javadoc_summary: string | null;
      is_deprecated: number;
      deprecation_note: string | null;
      since: string | null;
    }): ApiMemberResult => ({
      resultKind: 'member',
      memberKind: row.kind,
      name: row.name,
      declaringFqn: row.fqn,
      signature: row.signature,
      javadocSummary: row.javadoc_summary,
      isDeprecated: row.is_deprecated === 1,
      deprecationNote: row.deprecation_note,
      since: row.since,
    });

    // Browse mode: no query, list members by filter alone.
    if (!query || query === '*') {
      const rows = this.db
        .prepare(
          `SELECT m.kind, m.name, m.signature, m.javadoc_summary, m.is_deprecated, m.deprecation_note, m.since, t.fqn
           FROM members m
           JOIN types t ON t.id = m.type_id
           WHERE 1=1${kindSql}${packageSql}
           ORDER BY t.fqn, m.kind, m.name
           LIMIT ?`
        )
        .all(...kindParams, ...packageParams, limit) as Array<{
        kind: string;
        name: string;
        fqn: string;
        signature: string;
        javadoc_summary: string | null;
        is_deprecated: number;
        deprecation_note: string | null;
        since: string | null;
      }>;
      return rows.map(mapRow);
    }

    const ftsQuery = this.buildFtsQuery(query);
    if (ftsQuery) {
      try {
        const rows = this.db
          .prepare(
            `SELECT m.kind, m.name, m.signature, m.javadoc_summary, m.is_deprecated, m.deprecation_note, m.since, t.fqn,
                    ${rank} AS name_rank
             FROM members_fts f
             JOIN members m ON m.id = f.rowid
             JOIN types t ON t.id = m.type_id
             WHERE members_fts MATCH ?${kindSql}${packageSql}
             ORDER BY name_rank, bm25(members_fts)
             LIMIT ?`
          )
          .all(query, query, ftsQuery, ...kindParams, ...packageParams, limit) as Array<{
          kind: string;
          name: string;
          fqn: string;
          signature: string;
          javadoc_summary: string | null;
          is_deprecated: number;
          deprecation_note: string | null;
          since: string | null;
        }>;
        return rows.map(mapRow);
      } catch (error) {
        console.error(
          `[CleanroomApiService] members FTS failed, falling back to LIKE: ${String(error)}`
        );
      }
    }

    const like = `%${query.replace(/[%_]/g, '')}%`;
    const rows = this.db
      .prepare(
        `SELECT m.kind, m.name, m.signature, m.javadoc_summary, m.is_deprecated, m.deprecation_note, m.since, t.fqn,
                ${rank} AS name_rank
         FROM members m
         JOIN types t ON t.id = m.type_id
         WHERE (m.name LIKE ? OR m.search_text LIKE ?)${kindSql}${packageSql}
         ORDER BY name_rank, length(m.name)
         LIMIT ?`
      )
      .all(
        query,
        query,
        like,
        like.toLowerCase(),
        ...kindParams,
        ...packageParams,
        limit
      ) as Array<{
      kind: string;
      name: string;
      fqn: string;
      signature: string;
      javadoc_summary: string | null;
      is_deprecated: number;
      deprecation_note: string | null;
      since: string | null;
    }>;
    return rows.map(mapRow);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Details
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Look a type up by FQN, unique simple name (case-insensitive), or FQN
   * suffix ('PlayerInteractEvent.RightClickBlock'). Ambiguity returns
   * candidates instead of a match.
   */
  getTypeByName(name: string, memberLimit = 40): ApiTypeLookup {
    const clean = name.trim().replace(/\$/g, '.');

    const exact = this.db.prepare(`SELECT * FROM types WHERE fqn = ?`).get(clean) as
      | TypeRow
      | undefined;
    if (exact) {
      return { match: this.buildDetails(exact, memberLimit), candidates: [] };
    }

    // ORDER BY fqn for a stable, readable candidate list; LIMIT 25 comfortably
    // exceeds the corpus's worst real ambiguity (e.g. simple name 'Pre'/'Post'
    // → 17 types), so valid matches are not silently dropped from the "use the
    // full name" list. An unordered LIMIT 10 previously omitted 7 of 17.
    const bySimple = this.db
      .prepare(`SELECT * FROM types WHERE simple_name = ? COLLATE NOCASE ORDER BY fqn LIMIT 25`)
      .all(clean) as TypeRow[];
    const onlySimple = bySimple[0];
    if (bySimple.length === 1 && onlySimple) {
      return { match: this.buildDetails(onlySimple, memberLimit), candidates: [] };
    }
    if (bySimple.length > 1) {
      return { match: null, candidates: bySimple.map((r) => r.fqn) };
    }

    const bySuffix = this.db
      .prepare(`SELECT * FROM types WHERE fqn LIKE '%.' || ? ESCAPE '\\' ORDER BY fqn LIMIT 25`)
      .all(clean.replace(/[\\%_]/g, (m) => `\\${m}`)) as TypeRow[];
    const onlySuffix = bySuffix[0];
    if (bySuffix.length === 1 && onlySuffix) {
      return { match: this.buildDetails(onlySuffix, memberLimit), candidates: [] };
    }
    return { match: null, candidates: bySuffix.map((r) => r.fqn) };
  }

  private buildDetails(row: TypeRow, memberLimit: number): ApiClassDetails {
    // Corpus ancestor chain via recursive CTE over extends_fqn; the first
    // unresolved extends_raw is appended as an external terminator.
    const ancestorRows = this.db
      .prepare(
        `WITH RECURSIVE chain(fqn, extends_fqn, extends_raw, depth) AS (
           SELECT fqn, extends_fqn, extends_raw, 0 FROM types WHERE id = ?
           UNION ALL
           SELECT t.fqn, t.extends_fqn, t.extends_raw, chain.depth + 1
           FROM types t JOIN chain ON t.fqn = chain.extends_fqn
           WHERE chain.depth < 30
         )
         SELECT fqn, extends_fqn, extends_raw, depth FROM chain WHERE depth > 0 ORDER BY depth`
      )
      .all(row.id) as Array<{
      fqn: string;
      extends_fqn: string | null;
      extends_raw: string | null;
      depth: number;
    }>;

    const ancestors: Array<{ fqn: string; external: boolean }> = ancestorRows.map((a) => ({
      fqn: a.fqn,
      external: false,
    }));
    const last = ancestorRows[ancestorRows.length - 1];
    const tail = last ?? { extends_fqn: row.extends_fqn, extends_raw: row.extends_raw };
    if (!tail.extends_fqn && tail.extends_raw) {
      ancestors.push({ fqn: tail.extends_raw, external: true });
    }

    const memberCount = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM members WHERE type_id = ?`).get(row.id) as {
        c: number;
      }
    ).c;
    // Cap each member KIND at memberLimit rather than applying one global LIMIT:
    // a flat `ORDER BY kind-priority LIMIT 40` lets a type with 40+
    // constructors+methods starve its Fields section out entirely (e.g.
    // net.minecraftforge.common.config.Property renders with none of its 24
    // fields). The window keeps every kind represented; memberCount still drives
    // the "N more not shown" note.
    const members = this.db
      .prepare(
        `SELECT kind, name, signature, javadoc_summary, is_deprecated, deprecation_note, since
         FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY kind ORDER BY name) AS rn
           FROM members WHERE type_id = ?
         )
         WHERE rn <= ?
         ORDER BY CASE kind
             WHEN 'constructor' THEN 0
             WHEN 'annotation_element' THEN 1
             WHEN 'enum_constant' THEN 2
             WHEN 'method' THEN 3
             ELSE 4 END,
           name`
      )
      .all(row.id, memberLimit) as Array<{
      kind: string;
      name: string;
      signature: string;
      javadoc_summary: string | null;
      is_deprecated: number;
      deprecation_note: string | null;
      since: string | null;
    }>;

    const nestedTypes = (
      this.db
        .prepare(`SELECT fqn FROM types WHERE outer_fqn = ? ORDER BY fqn`)
        .all(row.fqn) as Array<{
        fqn: string;
      }>
    ).map((r) => r.fqn);

    const knownSubclasses = (
      this.db
        .prepare(`SELECT fqn FROM types WHERE extends_fqn = ? ORDER BY fqn LIMIT 20`)
        .all(row.fqn) as Array<{ fqn: string }>
    ).map((r) => r.fqn);
    const subclassCount = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM types WHERE extends_fqn = ?`).get(row.fqn) as {
        c: number;
      }
    ).c;

    return {
      fqn: row.fqn,
      simpleName: row.simple_name,
      packageName: row.package_name,
      outerFqn: row.outer_fqn,
      kind: row.kind,
      loader: row.loader,
      signature: row.signature,
      javadoc: row.javadoc,
      isDeprecated: row.is_deprecated === 1,
      deprecationNote: row.deprecation_note,
      since: row.since,
      isEvent: row.is_event === 1,
      isCancelable: row.is_cancelable === 1,
      hasResult: row.has_result === 1,
      sourceFile: row.source_file,
      ancestors,
      implementsRaw: row.implements_raw ? (JSON.parse(row.implements_raw) as string[]) : [],
      members: members.map((m) => ({
        kind: m.kind,
        name: m.name,
        signature: m.signature,
        javadocSummary: m.javadoc_summary,
        isDeprecated: m.is_deprecated === 1,
        deprecationNote: m.deprecation_note,
        since: m.since,
      })),
      memberCount,
      nestedTypes,
      knownSubclasses,
      subclassCount,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Stats
  // ─────────────────────────────────────────────────────────────────────────────

  getStats(): ApiStats {
    const counts = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM types) AS totalTypes,
           (SELECT COUNT(*) FROM members) AS totalMembers,
           (SELECT COUNT(*) FROM types WHERE is_event = 1) AS events,
           (SELECT COUNT(*) FROM types WHERE kind = 'annotation') AS annotationTypes`
      )
      .get() as {
      totalTypes: number;
      totalMembers: number;
      events: number;
      annotationTypes: number;
    };
    const versionRow = this.db
      .prepare(`SELECT value FROM metadata WHERE key = 'cleanroom_version'`)
      .get() as { value: string } | undefined;
    return { ...counts, cleanroomVersion: versionRow?.value ?? null };
  }
}
