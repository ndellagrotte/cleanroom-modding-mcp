/**
 * Scope-aware projections of the documentation corpus.
 *
 * `search_docs` runs under a scope — `target` (Cleanroom/Forge 1.12.2) by
 * default — but reported the whole corpus in its footer regardless. On the
 * shipped index that meant advertising 1,432 documents to a query that could
 * only ever reach 88, so an agent that got two results read the search as weak
 * and retried forever against a corpus that had nothing more to give.
 *
 * The number that actually stops that loop is `inFilter`: how many documents
 * the *complete* active filter can reach. When the result count equals it, the
 * corpus is exhausted and rephrasing is provably useless.
 *
 * Everything here is pure — it folds the rows `DocumentStore.getCoverage()`
 * returns. No SQL, no I/O, the same shape as `auditCategoryCoverage` in
 * ../categories.ts, and testable without a database.
 */

import type { DocCoverageRow } from '../indexer/store.js';
import { DOC_CATEGORIES, auditCoverage, type DocCategory } from '../categories.js';
import { LOADERS, LOADER_IDS, scopeToLoaders, type Scope } from '../loaders.js';

/** Versions shaped like a Minecraft release. Loader versions ('26.2') are not. */
const MC_VERSION_PATTERN = /^1\.\d+(\.\d+)?$/;

export interface CoverageFilter {
  scope: Scope;
  /** Explicit loader argument; overrides the scope, mirroring SearchService.search. */
  loader?: string;
  /** Active category filter. 'all' and undefined both mean "no filter". */
  category?: string;
  /** Raw requested version, matched with the same rule the SQL uses. */
  minecraftVersion?: string;
}

export interface LoaderCount {
  loader: string;
  count: number;
}

export interface CategoryCount {
  category: string;
  count: number;
  /** False for values outside DOC_CATEGORIES — unreachable by the `category` filter. */
  inEnum: boolean;
}

export interface DocCoverage {
  scope: Scope;
  loader?: string;
  /**
   * Documents matching the COMPLETE active filter — scope ∩ category ∩ version.
   * The true ceiling on how many results any phrasing of the query could return.
   */
  inFilter: number;
  /** Documents matching the loader/scope filter alone, ignoring category and version. */
  inScope: number;
  /** In-scope per-loader counts in registry order. Zero-count loaders are kept. */
  loaders: LoaderCount[];
  /** In-scope per-category counts: DOC_CATEGORIES order first, then off-enum values. */
  categories: CategoryCount[];
  /** In-scope DOC_CATEGORIES slugs holding 0 documents — a filter on these cannot match. */
  emptyCategories: DocCategory[];
  /** In-scope DOC_CATEGORIES slugs under the thin threshold (never zero). */
  thinCategories: Array<{ slug: DocCategory; count: number }>;
  /** In-scope documents in categories outside DOC_CATEGORIES. */
  offTaxonomy: number;
  /** Distinct in-scope Minecraft-shaped versions, newest first. */
  versions: string[];
  /** In-scope documents with no version, an empty version, or a non-Minecraft one. */
  unversionedInScope: number;
  /** Whole-corpus document total. */
  corpusDocuments: number;
  /** corpusDocuments − inScope. */
  outOfScope: number;
  /** Loader ids actually present in the index, in registry order. */
  corpusLoaders: string[];
}

const DOC_CATEGORY_SET: ReadonlySet<string> = new Set(DOC_CATEGORIES);

/**
 * '1.21' → '1.21%' (prefix), '1.12.2' → exact.
 *
 * `SearchService.getVersionFilter` delegates here so the SQL filter and the
 * coverage arithmetic cannot drift into reporting a ceiling the query does not
 * actually have.
 */
export function expandVersionFilter(version: string): string {
  return version.split('.').length === 2 ? `${version}%` : version;
}

/** SQL LIKE semantics for the patterns this module builds ('%' and '_'). */
function likeMatches(value: string, pattern: string): boolean {
  const regex = pattern
    .split('')
    .map((ch) => {
      if (ch === '%') return '.*';
      if (ch === '_') return '.';
      return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${regex}$`).test(value);
}

/**
 * Mirror of the version clause every search query uses:
 * `minecraft_version = ? OR minecraft_version LIKE ?` with `${filter}.%`.
 */
function versionMatches(stored: string | null, expandedFilter: string): boolean {
  if (!stored) return false;
  return stored === expandedFilter || likeMatches(stored, `${expandedFilter}.%`);
}

/** Numeric-segment sort, newest first ('1.21.11' > '1.21.9' > '1.12.2'). */
function compareVersionsDesc(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA !== numB) return numB - numA;
  }
  return 0;
}

/**
 * Newest Minecraft-shaped version, falling back to the newest of whatever is
 * there. `minecraft_version` also holds loader versions ('26.2', '21.9' — beta
 * report S8), so a naive numeric max resolved `minecraft_version: 'latest'` to
 * '26.2', which matches almost nothing. Preferring the `1.x` family sidesteps
 * that without needing the corpus rebuilt.
 */
export function pickLatestVersion(versions: readonly string[]): string | undefined {
  const sorted = [...versions].sort(compareVersionsDesc);
  return sorted.find((v) => MC_VERSION_PATTERN.test(v)) ?? sorted[0];
}

/**
 * Fold coverage rows down to what one search could reach.
 *
 * Both the in-scope numbers and the corpus totals come from this single row
 * set, so they can never disagree — the original defect was precisely two
 * independently computed counts presented side by side.
 */
export function summarizeCoverage(
  rows: readonly DocCoverageRow[],
  filter: CoverageFilter
): DocCoverage {
  const scopeLoaders: string[] = filter.loader ? [filter.loader] : scopeToLoaders(filter.scope);
  const scopeSet: ReadonlySet<string> = new Set(scopeLoaders);

  const activeCategory = filter.category && filter.category !== 'all' ? filter.category : undefined;
  const activeVersion = filter.minecraftVersion
    ? expandVersionFilter(filter.minecraftVersion)
    : undefined;

  const loaderCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const enumCounts: Record<string, number> = {};
  const corpusLoaders = new Set<string>();
  const versions = new Set<string>();
  let inScope = 0;
  let inFilter = 0;
  let offTaxonomy = 0;
  let unversionedInScope = 0;
  let corpusDocuments = 0;

  for (const row of rows) {
    corpusDocuments += row.count;
    corpusLoaders.add(row.loader);

    if (!scopeSet.has(row.loader)) continue;

    inScope += row.count;
    loaderCounts.set(row.loader, (loaderCounts.get(row.loader) ?? 0) + row.count);
    categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + row.count);

    if (DOC_CATEGORY_SET.has(row.category)) {
      enumCounts[row.category] = (enumCounts[row.category] ?? 0) + row.count;
    } else {
      offTaxonomy += row.count;
    }

    // '' is stored for 359 reference documents, and loader versions ('26.2')
    // for ~110 more; neither is a Minecraft version an agent can filter by.
    if (row.minecraftVersion && MC_VERSION_PATTERN.test(row.minecraftVersion)) {
      versions.add(row.minecraftVersion);
    } else {
      unversionedInScope += row.count;
    }

    const categoryOk = !activeCategory || row.category === activeCategory;
    const versionOk = !activeVersion || versionMatches(row.minecraftVersion, activeVersion);
    if (categoryOk && versionOk) {
      inFilter += row.count;
    }
  }

  // Registry order, and zero-count loaders are retained rather than dropped:
  // `shared` holds 0 documents corpus-wide but is an offered `loader` value, so
  // printing "shared 0" is the disclosure. Silently omitting it is the bug.
  const loaders: LoaderCount[] = scopeLoaders.map((loader) => ({
    loader,
    count: loaderCounts.get(loader) ?? 0,
  }));

  // Taxonomy order first, then whatever else the corpus holds — descending, so
  // the reconciliation names the biggest unreachable buckets.
  const offEnum = [...categoryCounts.entries()]
    .filter(([category]) => !DOC_CATEGORY_SET.has(category))
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count, inEnum: false }));

  const categories: CategoryCount[] = [
    ...DOC_CATEGORIES.map((category) => ({
      category: category,
      count: enumCounts[category] ?? 0,
      inEnum: true,
    })),
    ...offEnum,
  ];

  const { empty, thin } = auditCoverage(DOC_CATEGORIES, enumCounts);

  return {
    scope: filter.scope,
    ...(filter.loader ? { loader: filter.loader } : {}),
    inFilter,
    inScope,
    loaders,
    categories,
    emptyCategories: empty,
    thinCategories: thin,
    offTaxonomy,
    versions: [...versions].sort(compareVersionsDesc),
    unversionedInScope,
    corpusDocuments,
    outOfScope: corpusDocuments - inScope,
    // Unknown loader ids are appended, never dropped — a corpus built by a
    // newer indexer must not silently vanish from the report.
    corpusLoaders: [
      ...LOADER_IDS.filter((id) => corpusLoaders.has(id)),
      ...[...corpusLoaders].filter((id) => !(LOADER_IDS as string[]).includes(id)).sort(),
    ],
  };
}

/** In-scope count for one category, or 0 when it holds nothing. */
export function categoryCount(coverage: DocCoverage, category: string): number {
  return coverage.categories.find((c) => c.category === category)?.count ?? 0;
}

/** Display label for a loader id, tolerating ids outside the registry. */
export function loaderLabel(id: string): string {
  return (LOADERS as Record<string, { displayName: string } | undefined>)[id]?.displayName ?? id;
}
