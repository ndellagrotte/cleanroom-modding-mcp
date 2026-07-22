/**
 * search_docs tool handler
 * Full implementation using intelligent multi-strategy search with query expansion and relevance scoring.
 * Defaults to the target scope (Cleanroom/Forge 1.12.2); reference scope serves porting material.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SearchService } from '../services/search-service.js';
import type { SearchResult, SearchOptions } from '../services/search-service.js';
import { isLoader, TARGET_VERSION, type Scope } from '../loaders.js';
import { DOC_CATEGORIES } from '../categories.js';

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
          const stats = searchService.getStats();
          const versions = stats.versions.sort((a, b) => {
            const partsA = a.split('.').map(Number);
            const partsB = b.split('.').map(Number);
            for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
              const numA = partsA[i] || 0;
              const numB = partsB[i] || 0;
              if (numA !== numB) return numB - numA;
            }
            return 0;
          });
          if (versions[0]) {
            searchOptions.minecraftVersion = versions[0];
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

    // Add metadata for AI to use
    const metadata = buildMetadata(results, searchOptions, searchService);

    return {
      content: [
        {
          type: 'text',
          text: referenceBanner + formattedOutput + '\n\n' + metadata,
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
          text: `Error searching documentation: ${errorMessage}\n\nPlease ensure the documentation database has been indexed. Run 'npm run index' to build the database.`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Build metadata section for AI context
 */
function buildMetadata(
  results: SearchResult[],
  options: SearchOptions,
  service: SearchService
): string {
  const stats = service.getStats();

  let metadata = '---\n**Search Metadata:**\n';
  metadata += `- Query: "${options.query}"\n`;
  metadata += `- Results found: ${results.length}\n`;

  if (options.category) {
    metadata += `- Category filter: ${options.category}\n`;
  }

  if (options.loader) {
    metadata += `- Loader filter: ${options.loader}\n`;
  } else if (options.scope) {
    metadata += `- Scope: ${options.scope}\n`;
  }

  if (options.minecraftVersion) {
    metadata += `- Minecraft version filter: ${options.minecraftVersion}\n`;
  }

  metadata += `\n**Database Stats:**\n`;
  metadata += `- Total documents indexed: ${stats.totalDocuments}\n`;
  metadata += `- Total sections: ${stats.totalSections}\n`;
  metadata += `- Available loaders: ${stats.loaders.join(', ')}\n`;
  metadata += `- Available versions: ${stats.versions.slice(0, 5).join(', ')}${stats.versions.length > 5 ? '...' : ''}\n`;

  // Add suggestions based on results
  if (results.length === 0) {
    metadata += '\n**Suggestions:**\n';
    metadata += '- Try broader search terms\n';
    metadata += '- Remove category/loader filters\n';
    metadata += '- Use synonyms (e.g., "register" instead of "create")\n';
  } else if (results.length < 3) {
    metadata += '\n**Note:** Few results found. Consider:\n';
    metadata += '- Using `get_example` for specific code examples\n';
    metadata += '- Trying related terms or concepts\n';
  }

  return metadata;
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
