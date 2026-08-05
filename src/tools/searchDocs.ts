/**
 * search_docs tool handler
 * Full implementation using intelligent multi-strategy search with query expansion and relevance scoring.
 * Defaults to the target scope (Cleanroom/Forge 1.12.2); reference scope serves porting material.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SearchService } from '../services/search-service.js';
import type { SearchResult, SearchOptions } from '../services/search-service.js';
import type { DocCoverage } from '../services/corpus-coverage.js';
import { pickLatestVersion } from '../services/corpus-coverage.js';
import { ModExamplesService } from '../services/mod-examples-service.js';
import {
  formatDocCoverage,
  formatDocSearchDiagnostics,
  type DocSearchRequest,
  type ExampleCounts,
} from './docCoverage.js';
import { isLoader, TARGET_VERSION, type Scope } from '../loaders.js';
import { DOC_CATEGORIES, isExampleCategory } from '../categories.js';
import { REPO_URL } from '../dbs.js';

export interface SearchDocsParams {
  query: string;
  category?: string;
  scope?: string;
  loader?: string;
  minecraftVersion?: string;
  includeCode?: boolean;
  limit?: number;
}

const SCOPES: Scope[] = ['target', 'reference', 'all'];

// Singleton instance for reuse (better performance)
let searchServiceInstance: SearchService | null = null;

function getSearchService(): SearchService {
  if (!searchServiceInstance) {
    searchServiceInstance = new SearchService();
  }
  return searchServiceInstance;
}

/**
 * Handle the search_fabric_docs tool call
 * Performs intelligent multi-strategy search with:
 * - FTS5 full-text search with fallback to LIKE patterns
 * - Query tokenization and synonym expansion
 * - Relevance scoring with weighted factors
 * - Result deduplication and ranking
 * - AI-friendly formatted output
 */
export async function handleSearchDocs(params: SearchDocsParams): Promise<CallToolResult> {
  const { query, category, loader, minecraftVersion, includeCode = true, limit = 10 } = params;

  // Scope defaults to 'target' — building Cleanroom mods is the mission;
  // reference material is opt-in.
  const scope: Scope = SCOPES.includes(params.scope as Scope) ? (params.scope as Scope) : 'target';

  // Validate required parameters
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: Query parameter is required and cannot be empty.',
        },
      ],
      isError: true,
    };
  }

  const trimmedQuery = query.trim();

  // Validate limit
  const effectiveLimit = Math.min(Math.max(1, limit), 20);

  try {
    const searchService = getSearchService();

    // Build search options
    const searchOptions: SearchOptions = {
      query: trimmedQuery,
      limit: effectiveLimit,
      includeCode,
      scope,
    };

    // Add optional filters
    if (category && category !== 'all') {
      searchOptions.category = category;
    }

    // An explicit loader overrides the scope (unknown values are ignored).
    if (loader && isLoader(loader)) {
      searchOptions.loader = loader;
    }

    if (minecraftVersion) {
      // 'latest' is family-scoped: fixed 1.12.2 within the target family,
      // newest indexed version otherwise.
      if (minecraftVersion.toLowerCase() === 'latest') {
        if (scope === 'target') {
          searchOptions.minecraftVersion = TARGET_VERSION;
        } else {
          // Scope-filtered, and Minecraft-shaped: the global version list also
          // holds loader versions ('26.2', '21.9'), and a naive numeric max
          // resolved 'latest' to one of those, matching almost nothing.
          const latest = pickLatestVersion(
            searchService.getCoverage({ query: trimmedQuery, scope }).versions
          );
          if (latest) {
            searchOptions.minecraftVersion = latest;
          }
        }
      } else {
        searchOptions.minecraftVersion = minecraftVersion;
      }
    }

    // Perform search
    const results = await searchService.search(searchOptions);

    // Format results for AI
    const formattedOutput = searchService.formatForAI(results, trimmedQuery);

    // Reference-scope output is porting material, not target guidance.
    const referenceBanner =
      scope === 'reference' && !searchOptions.loader
        ? '> ⚠️ **Porting reference** — these results describe Fabric/NeoForge/modern-Minecraft APIs. ' +
          'They are source material for a port, not Cleanroom/1.12.2 guidance. ' +
          'Verify the Cleanroom-side equivalent before writing code.\n\n'
        : '';

    // Best effort: a coverage hiccup must never sink an otherwise good search.
    let coverage: DocCoverage | undefined;
    try {
      coverage = searchService.getCoverage(searchOptions);
    } catch (error) {
      console.error('[searchDocs] coverage unavailable:', error);
    }

    let body = formattedOutput;
    if (coverage) {
      const req: DocSearchRequest = {
        query: trimmedQuery,
        scope,
        ...(searchOptions.loader ? { loader: searchOptions.loader } : {}),
        ...(searchOptions.category ? { category: searchOptions.category } : {}),
        ...(searchOptions.minecraftVersion
          ? { minecraftVersion: searchOptions.minecraftVersion }
          : {}),
        resultCount: results.length,
        limit: effectiveLimit,
      };

      const diagnostics = formatDocSearchDiagnostics(req, coverage, loadExampleCounts());
      // With no results there is nothing to bury the explanation under, so it
      // leads; with hits it follows them.
      body =
        results.length === 0
          ? diagnostics + formattedOutput
          : formattedOutput + '\n\n' + diagnostics;

      body += '\n\n' + formatDocCoverage(req, coverage);
    }

    return {
      content: [
        {
          type: 'text',
          text: referenceBanner + body,
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[searchDocs] Error: ${errorMessage}`);

    return {
      content: [
        {
          type: 'text',
          text:
            `Error searching documentation: database unavailable — automatic installation did not complete. ` +
            `Ensure CLEANROOM_MCP_SKIP_AUTO_UPDATE is unset and restart the server. ` +
            `Release assets and status: ${REPO_URL}/releases\n\nOriginal error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Live `search_mod_examples` counts, or undefined when examples.db is absent.
 *
 * A bare "try `search_mod_examples`" does not tell an agent whether the other
 * corpus is any better stocked than the one that just came back empty, and the
 * whole point of routing is that it usually is by an order of magnitude. The
 * dependency is one-way and optional: with no examples DB installed the
 * diagnostics still route, just without numbers.
 */
function loadExampleCounts(): ExampleCounts | undefined {
  if (!ModExamplesService.isAvailable()) {
    return undefined;
  }

  let service: ModExamplesService | undefined;
  try {
    service = new ModExamplesService();
    const byCategory: ExampleCounts['byCategory'] = {};
    let categorized = 0;
    for (const category of service.listCategories()) {
      if (isExampleCategory(category.slug)) {
        byCategory[category.slug] = category.exampleCount;
      }
      categorized += category.exampleCount;
    }
    return { byCategory, total: categorized + service.countUncategorized() };
  } catch (error) {
    console.error('[searchDocs] mod-examples counts unavailable:', error);
    return undefined;
  } finally {
    service?.close();
  }
}

/**
 * Search documentation (legacy function for compatibility)
 * @deprecated Use handleSearchDocs instead
 */
export async function searchDocs(params: SearchDocsParams): Promise<SearchResult[]> {
  const searchService = getSearchService();
  return await searchService.search({
    query: params.query,
    category: params.category,
    minecraftVersion: params.minecraftVersion,
    limit: 10,
  });
}

/**
 * Get available categories for filtering (from the central taxonomy)
 */
export function getAvailableCategories(): string[] {
  return [...DOC_CATEGORIES];
}
