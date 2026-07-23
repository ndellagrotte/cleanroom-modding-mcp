/**
 * Mappings Service - Query Minecraft class/method/field mappings.
 *
 * Two eras share one database (schema v2, see src/mappings/schema.ts):
 * - 1.12.2 MCP/SRG (the Cleanroom target; the default version)
 * - modern Parchment/Mojang versions (backport reference)
 *
 * Features:
 * - Semantic search with CamelCase tokenization
 * - Fuzzy matching with Levenshtein distance
 * - Direct SRG lookups (func_/field_/p_ names short-circuit the fuzzy engine)
 * - resolve_symbol: readable ⇄ SRG ⇄ notch resolution for crash logs
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import { getDefaultDbPath } from '../data-dir.js';
import { DBS } from '../dbs.js';
import { TARGET_VERSION } from '../loaders.js';
import { compareVersions } from '../version-utils.js';
import { readDbSchemaVersion } from '../mappings/schema.js';
import { detectSymbolKind, extractSrgId, type SymbolKind } from '../mappings/symbol-kind.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Common abbreviations used in Minecraft modding
 * Maps abbreviations to their full forms for expansion
 */
const ABBREVIATION_MAP: Record<string, string[]> = {
  // Common abbreviations
  msg: ['message'],
  btn: ['button'],
  inv: ['inventory'],
  pos: ['position'],
  vel: ['velocity'],
  dir: ['direction'],
  cfg: ['config', 'configuration'],
  pkt: ['packet'],
  tex: ['texture'],
  gui: ['gui', 'screen', 'interface'],
  nbt: ['nbt', 'tag', 'compound'],
  mc: ['minecraft'],
  bb: ['bounding', 'boundingbox'],
  aabb: ['aabb', 'boundingbox'],
  ai: ['ai', 'artificial'],
  dmg: ['damage'],
  hp: ['health'],
  xp: ['experience'],
  lvl: ['level'],
  idx: ['index'],
  len: ['length'],
  cnt: ['count'],
  num: ['number'],
  str: ['string'],
  obj: ['object'],
  arr: ['array'],
  vec: ['vector'],
  mat: ['matrix', 'material'],
  col: ['color', 'column', 'collision'],
  rot: ['rotation'],
  trans: ['translation', 'transform'],
  ent: ['entity'],
  blk: ['block'],
  itm: ['item'],
  ply: ['player'],
  srv: ['server'],
  cli: ['client'],
  net: ['network'],
  reg: ['register', 'registry'],
  evt: ['event'],
  cb: ['callback'],
  fn: ['function'],
  ctx: ['context'],
  req: ['request'],
  res: ['response', 'result'],
  err: ['error'],
  def: ['default', 'definition'],
  init: ['initialize', 'initial'],
  desc: ['descriptor', 'description'],
  info: ['information'],
  src: ['source'],
  dst: ['destination'],
  tmp: ['temporary'],
  max: ['maximum'],
  min: ['minimum'],
  avg: ['average'],
  rnd: ['random', 'render'],
  gen: ['generate', 'generator'],
  sync: ['synchronized', 'synchronize'],
  async: ['asynchronous'],
};

/**
 * Internal method prefixes that should be deprioritized
 * These are typically GLFW/OpenGL internals or lambda functions
 */
const INTERNAL_PREFIXES = ['_', 'lambda$', 'access$', '$'];

/**
 * Check if a name appears to be an internal/generated method
 */
function isInternalName(name: string): boolean {
  if (!name) return false;
  for (const prefix of INTERNAL_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  // Also check for $ in the middle (lambda methods)
  if (name.includes('$') && !name.endsWith('$')) return true;
  return false;
}

/**
 * Expand abbreviations in a query to include full forms
 */
function expandAbbreviations(tokens: string[]): string[] {
  const expanded: string[] = [];
  for (const token of tokens) {
    expanded.push(token);
    const expansions = ABBREVIATION_MAP[token.toLowerCase()];
    if (expansions) {
      for (const exp of expansions) {
        if (!expanded.includes(exp)) {
          expanded.push(exp);
        }
      }
    }
  }
  return expanded;
}

/**
 * Split a CamelCase or snake_case identifier into tokens
 * Examples:
 *   sendMessage → ["send", "message"]
 *   send_message → ["send", "message"]
 *   XMLParser → ["xml", "parser"]
 *   getHTTPResponse → ["get", "http", "response"]
 */
function tokenizeIdentifier(identifier: string): string[] {
  // Handle empty/null
  if (!identifier) return [];

  // Replace underscores and hyphens with spaces for splitting
  let normalized = identifier.replace(/[_-]/g, ' ');

  // Insert space before uppercase letters that follow lowercase (camelCase)
  // But handle consecutive capitals (acronyms) carefully
  normalized = normalized.replace(/([a-z])([A-Z])/g, '$1 $2');

  // Handle acronyms followed by lowercase (XMLParser → XML Parser)
  normalized = normalized.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  // Split on whitespace and filter
  return normalized
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Compute Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Create 2D matrix with proper initialization
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = new Array<number>(a.length + 1).fill(0);
  }

  // Initialize first column
  for (let i = 0; i <= b.length; i++) {
    matrix[i]![0] = i;
  }
  // Initialize first row
  for (let j = 0; j <= a.length; j++) {
    matrix[0]![j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1, // substitution
          matrix[i]![j - 1]! + 1, // insertion
          matrix[i - 1]![j]! + 1 // deletion
        );
      }
    }
  }

  return matrix[b.length]![a.length]!;
}

/**
 * Calculate similarity score between two strings (0-1)
 * Uses Levenshtein distance normalized by length
 */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  const maxLength = Math.max(a.length, b.length);

  return 1 - distance / maxLength;
}

/**
 * Check if a string contains a substring (case-insensitive)
 */
function containsCI(str: string, substr: string): boolean {
  return str.toLowerCase().includes(substr.toLowerCase());
}

/**
 * Tokenize a search query into normalized tokens
 * Handles natural language queries like "send message" or "get player health"
 * Also expands common abbreviations for better matching
 */
function tokenizeQuery(query: string): string[] {
  // First, split on whitespace, underscores, hyphens
  const parts = query.toLowerCase().split(/[\s_-]+/);

  // Expand CamelCase if present
  const tokens: string[] = [];
  for (const part of parts) {
    tokens.push(...tokenizeIdentifier(part));
  }

  // Remove duplicates and very short tokens
  const uniqueTokens = [...new Set(tokens)].filter((t) => t.length >= 2);

  // Expand abbreviations
  return expandAbbreviations(uniqueTokens);
}

/**
 * Calculate semantic match score between query tokens and an identifier
 *
 * Scoring strategy (0-100):
 * - Exact match: 100 points
 * - Starts with query: 85-95 points
 * - All query tokens found exactly: 75-90 points
 * - All query tokens found (partial): 60-75 points
 * - Most tokens matched: 40-60 points
 * - Fuzzy matches: 20-40 points
 *
 * Penalties:
 * - Internal/lambda methods: -20 points
 * - Very long identifiers: -5 points
 *
 * Bonuses:
 * - Shorter identifiers: +5 points
 * - Tokens in order: +5 points
 * - Name starts with first query token: +10 points
 */
function calculateSemanticScore(
  identifier: string,
  queryTokens: string[],
  originalQuery: string
): number {
  if (!identifier || queryTokens.length === 0) return 0;

  const identifierLower = identifier.toLowerCase();
  const originalLower = originalQuery.toLowerCase().replace(/[\s_-]+/g, '');

  // Penalty for internal/generated methods
  const internalPenalty = isInternalName(identifier) ? 25 : 0;

  // Check for exact match (highest priority)
  if (identifierLower === originalLower) {
    return 100 - internalPenalty;
  }

  // Check if identifier starts with the query (joined)
  if (identifierLower.startsWith(originalLower)) {
    const lengthBonus = Math.max(0, 10 - (identifier.length - originalQuery.length));
    return Math.min(95, 85 + lengthBonus) - internalPenalty;
  }

  // Check whole-string fuzzy match for typos (e.g., "setHelth" → "setHealth")
  // This catches cases where the query is a single misspelled token
  const wholeStringSimilarity = stringSimilarity(originalLower, identifierLower);
  if (wholeStringSimilarity >= 0.75) {
    // High similarity to the whole identifier - this is likely a typo
    const fuzzyScore = 50 + wholeStringSimilarity * 40;
    return Math.min(Math.round(fuzzyScore), 90) - internalPenalty;
  }

  // Tokenize the identifier
  const identifierTokens = tokenizeIdentifier(identifier);

  // Track matching quality for each query token
  // Use only the base tokens (not expanded abbreviations) for primary matching
  // but keep abbreviation expansions for secondary matching
  const baseQueryTokens = originalQuery
    .toLowerCase()
    .split(/[\s_-]+/)
    .flatMap((p) => tokenizeIdentifier(p))
    .filter((t) => t.length >= 2);
  const baseTokenSet = new Set(baseQueryTokens);

  let exactMatches = 0;
  let prefixMatches = 0;
  let containsMatches = 0;
  let fuzzyMatches = 0;
  let totalMatchScore = 0;

  // Score each query token
  for (const queryToken of queryTokens) {
    let bestMatch = 0;
    const isBaseToken = baseTokenSet.has(queryToken);
    const tokenWeight = isBaseToken ? 1.0 : 0.6; // Expanded tokens matter less

    for (const idToken of identifierTokens) {
      // Exact token match
      if (idToken === queryToken) {
        bestMatch = Math.max(bestMatch, 1.0);
        break; // Can't do better than exact
      }

      // Token starts with query token (e.g., "msg" matches "message")
      if (idToken.startsWith(queryToken)) {
        const prefixScore = 0.9 - (idToken.length - queryToken.length) * 0.02;
        bestMatch = Math.max(bestMatch, Math.max(0.75, prefixScore));
        continue;
      }

      // Query token starts with id token (e.g., "message" matches "msg")
      if (queryToken.startsWith(idToken) && idToken.length >= 3) {
        const prefixScore = 0.8 - (queryToken.length - idToken.length) * 0.03;
        bestMatch = Math.max(bestMatch, Math.max(0.65, prefixScore));
        continue;
      }

      // Contains match (but not just single letters)
      if (queryToken.length >= 3 && idToken.includes(queryToken)) {
        bestMatch = Math.max(bestMatch, 0.7);
        continue;
      }
      if (idToken.length >= 3 && queryToken.includes(idToken)) {
        bestMatch = Math.max(bestMatch, 0.6);
        continue;
      }

      // Fuzzy match (for typos) - IMPROVED THRESHOLD
      // Allow more lenient matching for longer tokens
      const minLen = Math.min(idToken.length, queryToken.length);
      const fuzzyThreshold = minLen >= 6 ? 0.65 : minLen >= 4 ? 0.7 : 0.75;

      const similarity = stringSimilarity(idToken, queryToken);
      if (similarity >= fuzzyThreshold) {
        // Higher multiplier for fuzzy matches
        const fuzzyScore = similarity * 0.7;
        bestMatch = Math.max(bestMatch, fuzzyScore);
      }
    }

    // Categorize the match
    if (bestMatch >= 0.95) {
      exactMatches++;
    } else if (bestMatch >= 0.75) {
      prefixMatches++;
    } else if (bestMatch >= 0.55) {
      containsMatches++;
    } else if (bestMatch > 0.3) {
      fuzzyMatches++;
    }

    totalMatchScore += bestMatch * tokenWeight;
  }

  // Calculate final score based on match distribution
  let score = 0;
  const totalBaseTokens = baseQueryTokens.length || 1;
  const matchedBase =
    exactMatches + prefixMatches >= totalBaseTokens * 0.8 ? totalBaseTokens : exactMatches;

  // All base tokens matched exactly
  if (matchedBase === totalBaseTokens) {
    score = 75 + (totalMatchScore / queryTokens.length) * 15;

    // Bonus if tokens appear in the correct order
    const joinedQuery = baseQueryTokens.join('');
    if (identifierLower.includes(joinedQuery)) {
      score += 5;
    }

    // Bonus if identifier starts with first query token
    if (identifierTokens[0] === baseQueryTokens[0]) {
      score += 10;
    }
  }
  // Most tokens matched (prefix or exact)
  else if (exactMatches + prefixMatches >= totalBaseTokens * 0.7) {
    score = 55 + (totalMatchScore / queryTokens.length) * 20;
  }
  // Some good matches
  else if (exactMatches + prefixMatches + containsMatches >= totalBaseTokens * 0.5) {
    score = 40 + (totalMatchScore / queryTokens.length) * 20;
  }
  // Fuzzy matches only
  else if (fuzzyMatches > 0 || totalMatchScore > 0.3) {
    score = 20 + (totalMatchScore / queryTokens.length) * 30;
  }

  // Length-based adjustments
  if (identifier.length < 15) {
    score += 5; // Bonus for concise names
  } else if (identifier.length > 40) {
    score -= 5; // Penalty for very long names
  }

  // Also check raw contains (for cases like searching "Player" finding "ServerPlayer")
  if (containsCI(identifier, originalLower) && originalLower.length >= 3) {
    const containsScore = 55 + (originalLower.length / identifier.length) * 20;
    score = Math.max(score, containsScore);
  }

  // Apply internal penalty
  score -= internalPenalty;

  return Math.min(Math.max(Math.round(score), 0), 100);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

export interface MappingClass {
  id: number;
  name: string;
  notchName: string | null;
  javadoc: string | null;
  packageName: string;
  minecraftVersion: string;
  mappingSet: string;
  methodCount: number;
  fieldCount: number;
}

export interface MappingMethod {
  id: number;
  classId: number;
  className: string;
  name: string;
  srgName: string | null;
  notchName: string | null;
  descriptor: string;
  javadoc: string | null;
  minecraftVersion: string;
  parameters: MappingParameter[];
}

export interface MappingField {
  id: number;
  classId: number;
  className: string;
  name: string;
  srgName: string | null;
  notchName: string | null;
  descriptor: string | null;
  javadoc: string | null;
  minecraftVersion: string;
}

export interface MappingParameter {
  id: number;
  methodId: number;
  index: number;
  srgToken: string | null;
  name: string;
  javadoc: string | null;
}

export interface MappingSearchOptions {
  query: string;
  type?: 'class' | 'method' | 'field' | 'all';
  minecraftVersion?: string;
  packageFilter?: string;
  includeJavadoc?: boolean;
  limit?: number;
}

export interface MappingSearchResult {
  type: 'class' | 'method' | 'field' | 'parameter';
  name: string;
  fullName: string;
  srgName: string | null;
  notchName: string | null;
  descriptor: string | null;
  javadoc: string | null;
  className: string | null;
  packageName: string | null;
  minecraftVersion: string;
  parameters?: MappingParameter[];
  score: number;
}

/** Per-version summary for list_mapping_versions. */
export interface MappingVersionInfo {
  minecraftVersion: string;
  mappingSet: string;
  classCount: number;
}

/** Result of resolve_symbol: what the symbol is and what it resolved to. */
export interface ResolvedSymbol {
  kind: SymbolKind;
  /**
   * exact — direct hit; parent-method — a p_ token whose slot is unnamed but
   * whose owning method was found; none — nothing resolved.
   */
  resolution: 'exact' | 'parent-method' | 'none';
  result: MappingSearchResult | null;
  /** Honest context: unnamed slots, multiple owners, unindexed name kinds. */
  message?: string;
}

export interface MappingsStats {
  totalClasses: number;
  totalMethods: number;
  totalFields: number;
  totalParameters: number;
  minecraftVersions: string[];
  topPackages: Array<{ packageName: string; count: number }>;
  documentedMethods: number;
  documentedFields: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class MappingsService {
  private db: Database.Database;
  private static dbPath = getDefaultDbPath(DBS.mappings.fileName);
  /** Schema-gate result cached by file identity so isAvailable() stays cheap per call. */
  private static availabilityCache: { mtimeMs: number; size: number; ok: boolean } | null = null;
  private defaultVersionCache: string | null | undefined;

  constructor(dbPath?: string) {
    const finalPath = dbPath || MappingsService.dbPath;
    console.error(`[MappingsService] Using database at: ${finalPath}`);
    this.db = new Database(finalPath, { readonly: true });
  }

  /**
   * Check if the mappings database is available AND matches the schema version
   * this build expects (DBS.mappings.schemaVersion). A stale-schema DB is
   * treated as not installed; startup auto-update replaces it.
   */
  static isAvailable(): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(MappingsService.dbPath);
    } catch {
      MappingsService.availabilityCache = null;
      return false;
    }
    const cache = MappingsService.availabilityCache;
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      return cache.ok;
    }
    const ok = readDbSchemaVersion(MappingsService.dbPath) === DBS.mappings.schemaVersion;
    MappingsService.availabilityCache = { mtimeMs: stat.mtimeMs, size: stat.size, ok };
    return ok;
  }

  /** True when a DB file exists but its schema_version doesn't match this build. */
  static isSchemaOutdated(): boolean {
    return fs.existsSync(MappingsService.dbPath) && !MappingsService.isAvailable();
  }

  /**
   * Get database path
   */
  static getDbPath(): string {
    return MappingsService.dbPath;
  }

  /**
   * Get database statistics
   */
  getStats(): MappingsStats {
    const counts = this.db
      .prepare(
        `
        SELECT
          (SELECT COUNT(*) FROM classes) as totalClasses,
          (SELECT COUNT(*) FROM methods) as totalMethods,
          (SELECT COUNT(*) FROM fields) as totalFields,
          (SELECT COUNT(*) FROM parameters) as totalParameters,
          (SELECT COUNT(*) FROM methods WHERE javadoc IS NOT NULL AND javadoc != '') as documentedMethods,
          (SELECT COUNT(*) FROM fields WHERE javadoc IS NOT NULL AND javadoc != '') as documentedFields
      `
      )
      .get() as {
      totalClasses: number;
      totalMethods: number;
      totalFields: number;
      totalParameters: number;
      documentedMethods: number;
      documentedFields: number;
    };

    const versions = this.db
      .prepare(`SELECT DISTINCT minecraft_version FROM classes ORDER BY minecraft_version DESC`)
      .all() as Array<{ minecraft_version: string }>;

    const topPackages = this.db
      .prepare(
        `
        SELECT package_name as packageName, COUNT(*) as count
        FROM classes
        GROUP BY package_name
        ORDER BY count DESC
        LIMIT 10
      `
      )
      .all() as Array<{ packageName: string; count: number }>;

    return {
      ...counts,
      minecraftVersions: versions.map((v) => v.minecraft_version),
      topPackages,
    };
  }

  /**
   * Get all available Minecraft versions, newest first (semantic sort — a
   * lexicographic ORDER BY would misplace e.g. 1.9 above 1.21).
   */
  getMinecraftVersions(): string[] {
    const versions = this.db
      .prepare(`SELECT DISTINCT minecraft_version FROM classes`)
      .all() as Array<{ minecraft_version: string }>;
    return versions.map((v) => v.minecraft_version).sort((a, b) => compareVersions(b, a));
  }

  /**
   * Get the newest Minecraft version in the database (used for the modern
   * reference era; tools default to getDefaultVersion instead).
   */
  getLatestVersion(): string | null {
    return this.getMinecraftVersions()[0] ?? null;
  }

  /**
   * The version tools default to: 1.12.2 (the Cleanroom target) when present,
   * otherwise the newest indexed version.
   */
  getDefaultVersion(): string | null {
    if (this.defaultVersionCache !== undefined) {
      return this.defaultVersionCache;
    }
    const hasTarget = this.db
      .prepare(`SELECT 1 FROM classes WHERE minecraft_version = ? LIMIT 1`)
      .get(TARGET_VERSION);
    this.defaultVersionCache = hasTarget ? TARGET_VERSION : this.getLatestVersion();
    return this.defaultVersionCache;
  }

  /** Newest modern (non-1.12.2) version, or null. */
  getLatestModernVersion(): string | null {
    return this.getMinecraftVersions().find((v) => v !== TARGET_VERSION) ?? null;
  }

  /** The mapping set ('mcp' | 'parchment') a version belongs to, or null. */
  getMappingSet(minecraftVersion: string): string | null {
    const row = this.db
      .prepare(`SELECT mapping_set FROM classes WHERE minecraft_version = ? LIMIT 1`)
      .get(minecraftVersion) as { mapping_set: string } | undefined;
    return row?.mapping_set ?? null;
  }

  /** Per-version summary (version, mapping set, class count), newest first. */
  getVersionInfo(): MappingVersionInfo[] {
    const rows = this.db
      .prepare(
        `SELECT minecraft_version as minecraftVersion, mapping_set as mappingSet, COUNT(*) as classCount
         FROM classes GROUP BY minecraft_version, mapping_set`
      )
      .all() as MappingVersionInfo[];
    return rows.sort((a, b) => compareVersions(b.minecraftVersion, a.minecraftVersion));
  }

  /**
   * Search for mappings across classes, methods, and fields
   * Uses semantic search with CamelCase tokenization and fuzzy matching
   */
  search(options: MappingSearchOptions): MappingSearchResult[] {
    const {
      query,
      type = 'all',
      minecraftVersion,
      packageFilter,
      includeJavadoc = true,
      limit = 20,
    } = options;

    const results: MappingSearchResult[] = [];

    // Determine which version to use
    const version = minecraftVersion || this.getDefaultVersion();
    if (!version) {
      return [];
    }

    // SRG names/tokens short-circuit the fuzzy engine (tokenization would
    // shred them): direct prefix lookups against srg_name / srg_token.
    // p_i… covers constructor-parameter tokens.
    if (/^(func_\d+|field_\d+|p_i?\d+)/.test(query.trim())) {
      return this.searchSrg(query.trim(), version, { type, packageFilter, includeJavadoc, limit });
    }

    // Tokenize query for semantic matching
    const queryTokens = tokenizeQuery(query);
    console.error(
      `[MappingsService] Search query: "${query}" → tokens: [${queryTokens.join(', ')}]`
    );

    // Generate SQL patterns for database search
    // We fetch MORE results than needed, then re-rank with semantic scoring
    const sqlPatterns = this.generateSqlPatterns(query, queryTokens);

    // Search classes
    if (type === 'all' || type === 'class') {
      const classResults = this.searchClassesSemantic(
        sqlPatterns,
        queryTokens,
        query,
        version,
        packageFilter,
        limit * 3 // Fetch more for re-ranking
      );
      for (const cls of classResults) {
        results.push({
          type: 'class',
          name: cls.name,
          fullName: `${cls.packageName}.${cls.name}`,
          srgName: null,
          notchName: cls.notchName,
          descriptor: null,
          javadoc: includeJavadoc ? cls.javadoc : null,
          className: null,
          packageName: cls.packageName,
          minecraftVersion: cls.minecraftVersion,
          score: cls.score,
        });
      }
    }

    // Search methods
    if (type === 'all' || type === 'method') {
      const methodResults = this.searchMethodsSemantic(
        sqlPatterns,
        queryTokens,
        query,
        version,
        packageFilter,
        limit * 3
      );
      for (const method of methodResults) {
        results.push({
          type: 'method',
          name: method.name,
          fullName: `${method.className}.${method.name}`,
          srgName: method.srgName,
          notchName: method.notchName,
          descriptor: method.descriptor,
          javadoc: includeJavadoc ? method.javadoc : null,
          className: method.className,
          packageName: method.packageName,
          minecraftVersion: method.minecraftVersion,
          parameters: method.parameters,
          score: method.score,
        });
      }
    }

    // Search fields
    if (type === 'all' || type === 'field') {
      const fieldResults = this.searchFieldsSemantic(
        sqlPatterns,
        queryTokens,
        query,
        version,
        packageFilter,
        limit * 3
      );
      for (const field of fieldResults) {
        results.push({
          type: 'field',
          name: field.name,
          fullName: `${field.className}.${field.name}`,
          srgName: field.srgName,
          notchName: field.notchName,
          descriptor: field.descriptor,
          javadoc: includeJavadoc ? field.javadoc : null,
          className: field.className,
          packageName: field.packageName,
          minecraftVersion: field.minecraftVersion,
          score: field.score,
        });
      }
    }

    // Sort by score and limit
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Direct SRG prefix search: func_/field_ prefixes against srg_name, p_/p_i
   * tokens against parameters.srg_token (mapped to their owning methods).
   * Underscores are escaped — they are LIKE wildcards. Honors the caller's
   * type / packageFilter / includeJavadoc options: SRG kinds are self-typing,
   * so a contradictory type filter yields no results rather than wrong ones.
   */
  private searchSrg(
    query: string,
    version: string,
    opts: {
      type: 'class' | 'method' | 'field' | 'all';
      packageFilter?: string;
      includeJavadoc: boolean;
      limit: number;
    }
  ): MappingSearchResult[] {
    const { type, packageFilter, includeJavadoc, limit } = opts;
    const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
    const pattern = `${escaped}%`;
    const results: MappingSearchResult[] = [];

    if (query.startsWith('p_')) {
      // Parameter tokens belong to methods
      if (type !== 'all' && type !== 'method') {
        return [];
      }
      let sql = `SELECT m.id, m.name, m.srg_name as srgName, m.notch_name as notchName, m.descriptor,
                  m.javadoc, c.name as className, c.package_name as packageName,
                  c.minecraft_version as minecraftVersion
           FROM parameters p
           JOIN methods m ON p.method_id = m.id
           JOIN classes c ON m.class_id = c.id
           WHERE c.minecraft_version = ? AND p.srg_token LIKE ? ESCAPE '\\'`;
      const params: (string | number)[] = [version, pattern];
      if (packageFilter) {
        sql += ` AND c.package_name LIKE ?`;
        params.push(`%${packageFilter}%`);
      }
      sql += ` GROUP BY m.id LIMIT ?`;
      params.push(limit);
      const rows = this.db.prepare(sql).all(...params) as Array<{
        id: number;
        name: string;
        srgName: string | null;
        notchName: string | null;
        descriptor: string;
        javadoc: string | null;
        className: string;
        packageName: string;
        minecraftVersion: string;
      }>;
      for (const row of rows) {
        results.push({
          type: 'method',
          name: row.name,
          fullName: `${row.className}.${row.name}`,
          srgName: row.srgName,
          notchName: row.notchName,
          descriptor: row.descriptor,
          javadoc: includeJavadoc ? row.javadoc : null,
          className: row.className,
          packageName: row.packageName,
          minecraftVersion: row.minecraftVersion,
          parameters: this.getParameters(row.id),
          score: 100,
        });
      }
      return results;
    }

    const table = query.startsWith('field_') ? 'fields' : 'methods';
    const resultType = table === 'fields' ? 'field' : 'method';
    if (type !== 'all' && type !== resultType) {
      return [];
    }
    let sql = `SELECT x.id, x.name, x.srg_name as srgName, x.notch_name as notchName, x.descriptor,
                x.javadoc, c.name as className, c.package_name as packageName,
                c.minecraft_version as minecraftVersion
         FROM ${table} x
         JOIN classes c ON x.class_id = c.id
         WHERE c.minecraft_version = ? AND x.srg_name LIKE ? ESCAPE '\\'`;
    const params: (string | number)[] = [version, pattern];
    if (packageFilter) {
      sql += ` AND c.package_name LIKE ?`;
      params.push(`%${packageFilter}%`);
    }
    sql += ` ORDER BY x.srg_name LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      name: string;
      srgName: string | null;
      notchName: string | null;
      descriptor: string | null;
      javadoc: string | null;
      className: string;
      packageName: string;
      minecraftVersion: string;
    }>;
    for (const row of rows) {
      results.push({
        type: resultType,
        name: row.name,
        fullName: `${row.className}.${row.name}`,
        srgName: row.srgName,
        notchName: row.notchName,
        descriptor: row.descriptor,
        javadoc: includeJavadoc ? row.javadoc : null,
        className: row.className,
        packageName: row.packageName,
        minecraftVersion: row.minecraftVersion,
        parameters: table === 'methods' ? this.getParameters(row.id) : undefined,
        score: 100,
      });
    }
    return results;
  }

  /** Fetch a method's parameters, ordered by logical index. */
  private getParameters(methodId: number): MappingParameter[] {
    return this.db
      .prepare(
        `SELECT id, method_id as methodId, param_index as "index", srg_token as srgToken, name, javadoc
         FROM parameters WHERE method_id = ? ORDER BY param_index`
      )
      .all(methodId) as MappingParameter[];
  }

  /**
   * Generate SQL LIKE patterns for initial database search
   * Creates multiple patterns to cast a wide net, then re-rank semantically
   *
   * Strategy:
   * 1. Exact patterns for original query
   * 2. Individual tokens
   * 3. Token pairs
   * 4. Fuzzy patterns (remove single chars, handle common typos)
   * 5. Prefix patterns for short queries
   */
  private generateSqlPatterns(query: string, tokens: string[]): string[] {
    const patterns: string[] = [];
    const queryLower = query.toLowerCase();

    // Original query as-is
    patterns.push(`%${query}%`);

    // Query with spaces removed (for CamelCase matching)
    const joinedQuery = query.replace(/\s+/g, '');
    patterns.push(`%${joinedQuery}%`);

    // Each token individually
    for (const token of tokens) {
      if (token.length >= 2) {
        patterns.push(`%${token}%`);

        // Generate fuzzy variants for longer tokens (typo tolerance)
        if (token.length >= 4) {
          // Single character deletion variants (for typos like "helth" → find "health")
          for (let i = 0; i < token.length; i++) {
            const variant = token.slice(0, i) + token.slice(i + 1);
            if (variant.length >= 3) {
              patterns.push(`%${variant}%`);
            }
          }

          // Single character insertion wildcards (for missing chars)
          // e.g., "helth" → "he%lth" to match "health"
          for (let i = 1; i < token.length; i++) {
            const variant = token.slice(0, i) + '%' + token.slice(i);
            patterns.push(`%${variant}%`);
          }
        }

        // For tokens >= 3 chars, also add prefix pattern
        if (token.length >= 3) {
          patterns.push(`${token}%`); // Starts with token
        }
      }
    }

    // Adjacent token pairs (for multi-word matches)
    for (let i = 0; i < tokens.length - 1; i++) {
      const pair = `%${tokens[i]}%${tokens[i + 1]}%`;
      patterns.push(pair);

      // Also try direct concatenation
      patterns.push(`%${tokens[i]}${tokens[i + 1]}%`);
    }

    // For short queries (likely prefixes), add some common suffixes
    if (queryLower.length <= 4 && tokens.length === 1) {
      const common = ['er', 'ing', 'ed', 'tion', 'ment', 'able', 'ible'];
      for (const suffix of common) {
        patterns.push(`%${tokens[0]}${suffix}%`);
      }
    }

    // Deduplicate
    return [...new Set(patterns)];
  }

  /**
   * Search classes with semantic scoring
   */
  private searchClassesSemantic(
    patterns: string[],
    queryTokens: string[],
    originalQuery: string,
    version: string,
    packageFilter?: string,
    limit: number = 60
  ): Array<{
    id: number;
    name: string;
    notchName: string | null;
    javadoc: string | null;
    packageName: string;
    minecraftVersion: string;
    score: number;
  }> {
    // Build OR conditions for all patterns
    const patternConditions = patterns.map(() => 'name LIKE ?').join(' OR ');

    // Retrieve more candidates for fuzzy matching, then score and limit
    const retrievalLimit = Math.max(limit * 3, 200);

    let sql = `
      SELECT id, name, notch_name as notchName, javadoc, package_name as packageName, minecraft_version as minecraftVersion
      FROM classes
      WHERE minecraft_version = ?
        AND (${patternConditions})
    `;
    const params: (string | number)[] = [version, ...patterns];

    if (packageFilter) {
      sql += ` AND package_name LIKE ?`;
      params.push(`%${packageFilter}%`);
    }

    sql += ` LIMIT ?`;
    params.push(retrievalLimit);

    const rawResults = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      name: string;
      notchName: string | null;
      javadoc: string | null;
      packageName: string;
      minecraftVersion: string;
    }>;

    // Apply semantic scoring and return top results
    return rawResults
      .map((cls) => ({
        ...cls,
        score: calculateSemanticScore(cls.name, queryTokens, originalQuery),
      }))
      .filter((cls) => cls.score > 10)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Search methods with semantic scoring
   */
  private searchMethodsSemantic(
    patterns: string[],
    queryTokens: string[],
    originalQuery: string,
    version: string,
    packageFilter?: string,
    limit: number = 60
  ): Array<{
    id: number;
    name: string;
    srgName: string | null;
    notchName: string | null;
    descriptor: string;
    javadoc: string | null;
    className: string;
    packageName: string;
    minecraftVersion: string;
    parameters: MappingParameter[];
    score: number;
  }> {
    const patternConditions = patterns.map(() => 'm.name LIKE ?').join(' OR ');

    // Retrieve more candidates for fuzzy matching
    const retrievalLimit = Math.max(limit * 3, 200);

    let sql = `
      SELECT
        m.id,
        m.name,
        m.srg_name as srgName,
        m.notch_name as notchName,
        m.descriptor,
        m.javadoc,
        c.name as className,
        c.package_name as packageName,
        c.minecraft_version as minecraftVersion
      FROM methods m
      JOIN classes c ON m.class_id = c.id
      WHERE c.minecraft_version = ?
        AND (${patternConditions})
    `;
    const params: (string | number)[] = [version, ...patterns];

    if (packageFilter) {
      sql += ` AND c.package_name LIKE ?`;
      params.push(`%${packageFilter}%`);
    }

    sql += ` LIMIT ?`;
    params.push(retrievalLimit);

    const rawResults = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      name: string;
      srgName: string | null;
      notchName: string | null;
      descriptor: string;
      javadoc: string | null;
      className: string;
      packageName: string;
      minecraftVersion: string;
    }>;

    // Apply semantic scoring and return top results
    return rawResults
      .map((method) => ({
        ...method,
        parameters: this.getParameters(method.id),
        score: calculateSemanticScore(method.name, queryTokens, originalQuery),
      }))
      .filter((method) => method.score > 10)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Search fields with semantic scoring
   */
  private searchFieldsSemantic(
    patterns: string[],
    queryTokens: string[],
    originalQuery: string,
    version: string,
    packageFilter?: string,
    limit: number = 60
  ): Array<{
    id: number;
    name: string;
    srgName: string | null;
    notchName: string | null;
    descriptor: string | null;
    javadoc: string | null;
    className: string;
    packageName: string;
    minecraftVersion: string;
    score: number;
  }> {
    const patternConditions = patterns.map(() => 'f.name LIKE ?').join(' OR ');

    // Retrieve more candidates for fuzzy matching
    const retrievalLimit = Math.max(limit * 3, 200);

    let sql = `
      SELECT
        f.id,
        f.name,
        f.srg_name as srgName,
        f.notch_name as notchName,
        f.descriptor,
        f.javadoc,
        c.name as className,
        c.package_name as packageName,
        c.minecraft_version as minecraftVersion
      FROM fields f
      JOIN classes c ON f.class_id = c.id
      WHERE c.minecraft_version = ?
        AND (${patternConditions})
    `;
    const params: (string | number)[] = [version, ...patterns];

    if (packageFilter) {
      sql += ` AND c.package_name LIKE ?`;
      params.push(`%${packageFilter}%`);
    }

    sql += ` LIMIT ?`;
    params.push(retrievalLimit);

    const rawResults = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      name: string;
      srgName: string | null;
      notchName: string | null;
      descriptor: string | null;
      javadoc: string | null;
      className: string;
      packageName: string;
      minecraftVersion: string;
    }>;

    // Apply semantic scoring and return top results
    return rawResults
      .map((field) => ({
        ...field,
        score: calculateSemanticScore(field.name, queryTokens, originalQuery),
      }))
      .filter((field) => field.score > 10)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Get a class by full name (package.ClassName)
   */
  getClass(fullName: string, minecraftVersion?: string): MappingClass | null {
    const version = minecraftVersion || this.getDefaultVersion();
    if (!version) return null;

    const parts = fullName.split('.');
    const className = parts.pop() || fullName;
    const packageName = parts.join('.');

    let sql = `
      SELECT
        c.id,
        c.name,
        c.notch_name as notchName,
        c.javadoc,
        c.package_name as packageName,
        c.minecraft_version as minecraftVersion,
        c.mapping_set as mappingSet,
        (SELECT COUNT(*) FROM methods WHERE class_id = c.id) as methodCount,
        (SELECT COUNT(*) FROM fields WHERE class_id = c.id) as fieldCount
      FROM classes c
      WHERE c.minecraft_version = ?
        AND c.name = ?
    `;
    const params: string[] = [version, className];

    if (packageName) {
      sql += ` AND c.package_name = ?`;
      params.push(packageName);
    }

    return (this.db.prepare(sql).get(...params) as MappingClass | undefined) ?? null;
  }

  /**
   * Get all methods for a class
   */
  getClassMethods(classId: number): MappingMethod[] {
    const methods = this.db
      .prepare(
        `
        SELECT
          m.id,
          m.class_id as classId,
          c.name as className,
          m.name,
          m.srg_name as srgName,
          m.notch_name as notchName,
          m.descriptor,
          m.javadoc,
          c.minecraft_version as minecraftVersion
        FROM methods m
        JOIN classes c ON m.class_id = c.id
        WHERE m.class_id = ?
        ORDER BY m.name
      `
      )
      .all(classId) as Array<Omit<MappingMethod, 'parameters'>>;

    return methods.map((method) => ({
      ...method,
      parameters: this.getParameters(method.id),
    }));
  }

  /**
   * Get all fields for a class
   */
  getClassFields(classId: number): MappingField[] {
    return this.db
      .prepare(
        `
        SELECT
          f.id,
          f.class_id as classId,
          c.name as className,
          f.name,
          f.srg_name as srgName,
          f.notch_name as notchName,
          f.descriptor,
          f.javadoc,
          c.minecraft_version as minecraftVersion
        FROM fields f
        JOIN classes c ON f.class_id = c.id
        WHERE f.class_id = ?
        ORDER BY f.name
      `
      )
      .all(classId) as MappingField[];
  }

  /**
   * Get all overloads of a method by class name and method name.
   * Every matching row is returned — overloads are distinct rows (per-era
   * guarantees differ: structural for MCP, descriptor-matched for modern).
   */
  getMethods(className: string, methodName: string, minecraftVersion?: string): MappingMethod[] {
    const version = minecraftVersion || this.getDefaultVersion();
    if (!version) return [];

    const methods = this.db
      .prepare(
        `
        SELECT
          m.id,
          m.class_id as classId,
          c.name as className,
          m.name,
          m.srg_name as srgName,
          m.notch_name as notchName,
          m.descriptor,
          m.javadoc,
          c.minecraft_version as minecraftVersion
        FROM methods m
        JOIN classes c ON m.class_id = c.id
        WHERE c.minecraft_version = ?
          AND (c.name = ? OR (c.package_name || '.' || c.name) = ?)
          AND m.name = ?
        ORDER BY m.id
      `
      )
      .all(version, className, className, methodName) as Array<Omit<MappingMethod, 'parameters'>>;

    return methods.map((method) => ({
      ...method,
      parameters: this.getParameters(method.id),
    }));
  }

  /**
   * Resolve a symbol from a crash log, decompiled code, or user input.
   * Auto-detects the name kind (SRG / notch / readable) and returns every
   * mapping layer. SRG-shaped symbols force version 1.12.2 — they exist in no
   * other indexed era.
   */
  resolveSymbol(symbol: string, minecraftVersion?: string): ResolvedSymbol {
    const trimmed = symbol.trim();
    const kind = detectSymbolKind(trimmed);

    if (kind === 'modern-intermediary') {
      return {
        kind,
        resolution: 'none',
        result: null,
        message:
          `\`${trimmed}\` is a modern official-mappings intermediary name (1.14+), not a 1.12.2 SRG name. ` +
          `These are not indexed. For modern symbols, search the readable name with search_mappings ` +
          `and an explicit minecraft_version.`,
      };
    }

    const isSrgKind =
      kind === 'srg-method' ||
      kind === 'srg-field' ||
      kind === 'srg-param' ||
      kind === 'srg-ctor-param';

    // SRG names only exist in the MCP era; notch/readable use the default
    // version, falling back to the newest modern version.
    let versions: string[];
    if (minecraftVersion) {
      versions = [minecraftVersion];
    } else if (isSrgKind) {
      versions = [TARGET_VERSION];
    } else {
      const candidates = [this.getDefaultVersion(), this.getLatestModernVersion()];
      versions = [...new Set(candidates.filter((v): v is string => v !== null))];
    }

    for (const version of versions) {
      const resolved = this.resolveSymbolInVersion(trimmed, kind, version);
      if (resolved) {
        return resolved;
      }
    }

    return {
      kind,
      resolution: 'none',
      result: null,
      message:
        `No match for \`${trimmed}\` in ${versions.join(', ') || 'the database'}. ` +
        `Try search_mappings for fuzzy name search.`,
    };
  }

  /**
   * Batch form of {@link resolveSymbol}: resolve many symbols under this one held
   * connection instead of opening/closing per name. Input is de-duplicated;
   * the returned map is keyed by the original (untrimmed) symbol string.
   *
   * Used by the examples pipeline's index-time SRG cross-linking (Phase 5 §8.1);
   * 1.12.2 rows carry minecraft_version='1.12.2', mapping_set='mcp'.
   */
  resolveSymbols(symbols: string[], minecraftVersion?: string): Map<string, ResolvedSymbol> {
    const out = new Map<string, ResolvedSymbol>();
    for (const symbol of symbols) {
      if (out.has(symbol)) {
        continue;
      }
      out.set(symbol, this.resolveSymbol(symbol, minecraftVersion));
    }
    return out;
  }

  private resolveSymbolInVersion(
    symbol: string,
    kind: SymbolKind,
    version: string
  ): ResolvedSymbol | null {
    switch (kind) {
      case 'srg-method': {
        const methods = this.findBySrgName('methods', symbol, version);
        const first = methods[0];
        if (!first) return null;
        return {
          kind,
          resolution: 'exact',
          result: first,
          message:
            methods.length > 1
              ? `This SRG id is carried by ${methods.length} method rows (overrides in subclasses); showing ${first.className}.`
              : undefined,
        };
      }
      case 'srg-field': {
        const fields = this.findBySrgName('fields', symbol, version);
        const first = fields[0];
        if (!first) return null;
        return {
          kind,
          resolution: 'exact',
          result: first,
          message:
            fields.length > 1
              ? `This SRG id is carried by ${fields.length} field rows (overrides in subclasses); showing ${first.className}.`
              : undefined,
        };
      }
      case 'srg-param':
      case 'srg-ctor-param': {
        const param = this.findBySrgToken(symbol, version);
        if (param) {
          return {
            kind,
            resolution: 'exact',
            result: param.result,
            message:
              param.ownerCount > 1
                ? `This parameter token appears on ${param.ownerCount} method rows ` +
                  `(SRG ids are shared by overrides in subclasses); showing ${param.result.className}.`
                : undefined,
          };
        }
        // Unnamed slot: recover the owning method from the id in the token
        if (kind === 'srg-param') {
          const srgId = extractSrgId(symbol);
          const slot = symbol.match(/^p_\d+_(\d+)_$/)?.[1];
          if (srgId !== null) {
            const owners = this.findBySrgPrefix('methods', `func_${srgId}_`, version);
            const owner = owners[0];
            if (owner) {
              return {
                kind,
                resolution: 'parent-method',
                result: owner,
                message:
                  `\`${symbol}\` is the parameter at LVT slot ${slot} of this method; ` +
                  `it has no readable name in MCP stable_39.`,
              };
            }
          }
        }
        return null;
      }
      case 'notch': {
        return (
          this.classByNotch(symbol, version) ??
          this.memberByNotch('methods', symbol, version) ??
          this.memberByNotch('fields', symbol, version)
        );
      }
      case 'readable':
        return this.resolveReadable(symbol, version);
      default:
        return null;
    }
  }

  /** Exact srg_name match returning full search results (with params for methods). */
  private findBySrgName(
    table: 'methods' | 'fields',
    srgName: string,
    version: string
  ): MappingSearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT x.id, x.name, x.srg_name as srgName, x.notch_name as notchName, x.descriptor,
                x.javadoc, c.name as className, c.package_name as packageName,
                c.minecraft_version as minecraftVersion
         FROM ${table} x JOIN classes c ON x.class_id = c.id
         WHERE c.minecraft_version = ? AND x.srg_name = ?
         ORDER BY x.id`
      )
      .all(version, srgName) as Array<{
      id: number;
      name: string;
      srgName: string | null;
      notchName: string | null;
      descriptor: string | null;
      javadoc: string | null;
      className: string;
      packageName: string;
      minecraftVersion: string;
    }>;
    return rows.map((row) => ({
      type: table === 'methods' ? ('method' as const) : ('field' as const),
      name: row.name,
      fullName: `${row.className}.${row.name}`,
      srgName: row.srgName,
      notchName: row.notchName,
      descriptor: row.descriptor,
      javadoc: row.javadoc,
      className: row.className,
      packageName: row.packageName,
      minecraftVersion: row.minecraftVersion,
      parameters: table === 'methods' ? this.getParameters(row.id) : undefined,
      score: 100,
    }));
  }

  /** srg_name prefix match (used to find a p_ token's owning method by id). */
  private findBySrgPrefix(
    table: 'methods',
    prefix: string,
    version: string
  ): MappingSearchResult[] {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    const row = this.db
      .prepare(
        `SELECT x.srg_name as srgName FROM ${table} x
         JOIN classes c ON x.class_id = c.id
         WHERE c.minecraft_version = ? AND x.srg_name LIKE ? ESCAPE '\\'
         LIMIT 1`
      )
      .get(version, `${escaped}%`) as { srgName: string } | undefined;
    return row ? this.findBySrgName(table, row.srgName, version) : [];
  }

  /**
   * Exact srg_token match: a parameter result with its method as context.
   * ownerCount reports how many method rows carry the token (overrides in
   * subclasses share SRG ids) so callers can disclose the ambiguity.
   */
  private findBySrgToken(
    token: string,
    version: string
  ): { result: MappingSearchResult; ownerCount: number } | null {
    const row = this.db
      .prepare(
        `SELECT p.name as paramName, p.srg_token as srgToken, m.id as methodId, m.name as methodName,
                m.srg_name as methodSrg, m.notch_name as methodNotch, m.descriptor,
                c.name as className, c.package_name as packageName,
                c.minecraft_version as minecraftVersion,
                (SELECT COUNT(*) FROM parameters p2
                 JOIN methods m2 ON p2.method_id = m2.id
                 JOIN classes c2 ON m2.class_id = c2.id
                 WHERE c2.minecraft_version = c.minecraft_version AND p2.srg_token = p.srg_token
                ) as ownerCount
         FROM parameters p
         JOIN methods m ON p.method_id = m.id
         JOIN classes c ON m.class_id = c.id
         WHERE c.minecraft_version = ? AND p.srg_token = ?
         ORDER BY p.id LIMIT 1`
      )
      .get(version, token) as
      | {
          paramName: string;
          srgToken: string;
          methodId: number;
          methodName: string;
          methodSrg: string | null;
          methodNotch: string | null;
          descriptor: string;
          className: string;
          packageName: string;
          minecraftVersion: string;
          ownerCount: number;
        }
      | undefined;
    if (!row) return null;
    return {
      result: {
        type: 'parameter',
        name: row.paramName,
        fullName: `${row.className}.${row.methodName}(${row.paramName})`,
        srgName: row.srgToken,
        notchName: null,
        descriptor: row.descriptor,
        javadoc: null,
        className: row.className,
        packageName: row.packageName,
        minecraftVersion: row.minecraftVersion,
        parameters: this.getParameters(row.methodId),
        score: 100,
      },
      ownerCount: row.ownerCount,
    };
  }

  private classByNotch(notchName: string, version: string): ResolvedSymbol | null {
    const cls = this.db
      .prepare(
        `SELECT id, name, notch_name as notchName, javadoc, package_name as packageName,
                minecraft_version as minecraftVersion
         FROM classes WHERE minecraft_version = ? AND notch_name = ? LIMIT 1`
      )
      .get(version, notchName) as
      | {
          id: number;
          name: string;
          notchName: string;
          javadoc: string | null;
          packageName: string;
          minecraftVersion: string;
        }
      | undefined;
    if (!cls) return null;
    return {
      kind: 'notch',
      resolution: 'exact',
      result: {
        type: 'class',
        name: cls.name,
        fullName: `${cls.packageName}.${cls.name}`,
        srgName: null,
        notchName: cls.notchName,
        descriptor: null,
        javadoc: cls.javadoc,
        className: null,
        packageName: cls.packageName,
        minecraftVersion: cls.minecraftVersion,
        score: 100,
      },
    };
  }

  private memberByNotch(
    table: 'methods' | 'fields',
    notchName: string,
    version: string
  ): ResolvedSymbol | null {
    const row = this.db
      .prepare(
        `SELECT x.id, x.name, x.srg_name as srgName, x.notch_name as notchName, x.descriptor,
                x.javadoc, c.name as className, c.package_name as packageName,
                c.minecraft_version as minecraftVersion
         FROM ${table} x JOIN classes c ON x.class_id = c.id
         WHERE c.minecraft_version = ? AND x.notch_name = ? LIMIT 1`
      )
      .get(version, notchName) as
      | {
          id: number;
          name: string;
          srgName: string | null;
          notchName: string | null;
          descriptor: string | null;
          javadoc: string | null;
          className: string;
          packageName: string;
          minecraftVersion: string;
        }
      | undefined;
    if (!row) return null;
    return {
      kind: 'notch',
      resolution: 'exact',
      result: {
        type: table === 'methods' ? 'method' : 'field',
        name: row.name,
        fullName: `${row.className}.${row.name}`,
        srgName: row.srgName,
        notchName: row.notchName,
        descriptor: row.descriptor,
        javadoc: row.javadoc,
        className: row.className,
        packageName: row.packageName,
        minecraftVersion: row.minecraftVersion,
        parameters: table === 'methods' ? this.getParameters(row.id) : undefined,
        score: 100,
      },
      message:
        `Note: short tokens are ambiguous — this matched the obfuscated (notch) ` +
        `${table === 'methods' ? 'method' : 'field'} name in ${version}.`,
    };
  }

  /** Resolve a readable name: `pkg.Class`, `Class`, `Class.member`, `Class#member`, or bare member. */
  private resolveReadable(symbol: string, version: string): ResolvedSymbol | null {
    const hashSplit = symbol.split('#');
    let classPart: string | null = null;
    let memberPart: string | null = null;

    if (hashSplit.length === 2 && hashSplit[0] && hashSplit[1]) {
      classPart = hashSplit[0];
      memberPart = hashSplit[1];
    } else if (symbol.includes('.')) {
      // Could be pkg.Class or Class.member or pkg.Class.member.
      // Try the whole thing as a class first, then split off a member.
      const asClass = this.getClass(symbol, version);
      if (asClass) {
        return this.classResult(asClass);
      }
      const lastDot = symbol.lastIndexOf('.');
      classPart = symbol.substring(0, lastDot);
      memberPart = symbol.substring(lastDot + 1);
    } else {
      // Bare name: class first, then method, then field
      const asClass = this.getClass(symbol, version);
      if (asClass) {
        return this.classResult(asClass);
      }
      const asMethod = this.memberByName('methods', null, symbol, version);
      if (asMethod) return asMethod;
      return this.memberByName('fields', null, symbol, version);
    }

    if (classPart && memberPart) {
      const asMethod = this.memberByName('methods', classPart, memberPart, version);
      if (asMethod) return asMethod;
      return this.memberByName('fields', classPart, memberPart, version);
    }
    return null;
  }

  private classResult(cls: MappingClass): ResolvedSymbol {
    return {
      kind: 'readable',
      resolution: 'exact',
      result: {
        type: 'class',
        name: cls.name,
        fullName: cls.packageName ? `${cls.packageName}.${cls.name}` : cls.name,
        srgName: null,
        notchName: cls.notchName,
        descriptor: null,
        javadoc: cls.javadoc,
        className: null,
        packageName: cls.packageName,
        minecraftVersion: cls.minecraftVersion,
        score: 100,
      },
    };
  }

  private memberByName(
    table: 'methods' | 'fields',
    className: string | null,
    memberName: string,
    version: string
  ): ResolvedSymbol | null {
    // Also match srg_name so qualified crash-log symbols like
    // `Minecraft.func_71410_x` / `Entity#field_70170_p` resolve.
    let sql = `
      SELECT x.id, x.name, x.srg_name as srgName, x.notch_name as notchName, x.descriptor,
             x.javadoc, c.name as className, c.package_name as packageName,
             c.minecraft_version as minecraftVersion
      FROM ${table} x JOIN classes c ON x.class_id = c.id
      WHERE c.minecraft_version = ? AND (x.name = ? OR x.srg_name = ?)`;
    const params: string[] = [version, memberName, memberName];
    if (className) {
      sql += ` AND (c.name = ? OR (c.package_name || '.' || c.name) = ?)`;
      params.push(className, className);
    }
    sql += ` ORDER BY x.id LIMIT 1`;

    const row = this.db.prepare(sql).get(...params) as
      | {
          id: number;
          name: string;
          srgName: string | null;
          notchName: string | null;
          descriptor: string | null;
          javadoc: string | null;
          className: string;
          packageName: string;
          minecraftVersion: string;
        }
      | undefined;
    if (!row) return null;
    return {
      kind: 'readable',
      resolution: 'exact',
      result: {
        type: table === 'methods' ? 'method' : 'field',
        name: row.name,
        fullName: `${row.className}.${row.name}`,
        srgName: row.srgName,
        notchName: row.notchName,
        descriptor: row.descriptor,
        javadoc: row.javadoc,
        className: row.className,
        packageName: row.packageName,
        minecraftVersion: row.minecraftVersion,
        parameters: table === 'methods' ? this.getParameters(row.id) : undefined,
        score: 100,
      },
    };
  }

  /**
   * Get top-level packages
   */
  getPackages(minecraftVersion?: string): string[] {
    const version = minecraftVersion || this.getDefaultVersion();
    if (!version) return [];

    const packages = this.db
      .prepare(
        `
        SELECT DISTINCT
          CASE
            WHEN INSTR(package_name, '.') > 0
            THEN SUBSTR(package_name, 1, INSTR(package_name, '.') - 1)
            ELSE package_name
          END as topPackage
        FROM classes
        WHERE minecraft_version = ?
        ORDER BY topPackage
      `
      )
      .all(version) as Array<{ topPackage: string }>;

    return packages.map((p) => p.topPackage);
  }

  /**
   * Browse classes in a package
   */
  getClassesInPackage(packageName: string, minecraftVersion?: string): MappingClass[] {
    const version = minecraftVersion || this.getDefaultVersion();
    if (!version) return [];

    return this.db
      .prepare(
        `
        SELECT
          c.id,
          c.name,
          c.notch_name as notchName,
          c.javadoc,
          c.package_name as packageName,
          c.minecraft_version as minecraftVersion,
          c.mapping_set as mappingSet,
          (SELECT COUNT(*) FROM methods WHERE class_id = c.id) as methodCount,
          (SELECT COUNT(*) FROM fields WHERE class_id = c.id) as fieldCount
        FROM classes c
        WHERE c.minecraft_version = ?
          AND c.package_name LIKE ?
        ORDER BY c.name
      `
      )
      .all(version, `${packageName}%`) as MappingClass[];
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}
