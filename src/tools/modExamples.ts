/**
 * Mod Examples Tools — query curated examples from canonical open-source 1.12.2
 * mods. The corpus is the eight-repo roster in data/examples-roster.json (Forge
 * and Cleanroom-native), analyzed at build time with per-example source +
 * license attribution and index-time SRG / framework-API cross-links.
 */

import { ModExamplesService } from '../services/mod-examples-service.js';
import type { CategoryInfo } from '../services/mod-examples-service.js';
import {
  EXAMPLE_CATEGORIES,
  THIN_CATEGORY_THRESHOLD,
  auditCategoryCoverage,
} from '../categories.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { formatQualityScore } from '../services/search-utils.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Availability guidance (aligned with the NOT_INSTALLED convention, Phase 3)
// ═══════════════════════════════════════════════════════════════════════════════

const NOT_INSTALLED_MESSAGE =
  'The mod examples database is not installed. This optional database holds curated, ' +
  'AI-analyzed code examples from canonical open-source 1.12.2 mods (Forge and Cleanroom-native), ' +
  'with per-example source + license attribution and SRG cross-links.\n\n' +
  'It downloads automatically on server startup — restart the server to retry, or install it ' +
  'now with `cleanroom-modding-mcp manage`.\n\n' +
  'The standard documentation tools (search_docs, get_doc_snippet) are still available.';

const OUTDATED_SCHEMA_MESSAGE =
  'The installed mod examples database uses an outdated schema and has been disabled.\n\n' +
  'It is replaced automatically on startup once a release carries the updated database; ' +
  'you can also reinstall it with `cleanroom-modding-mcp manage`.';

function notAvailableResult(): CallToolResult {
  const text = ModExamplesService.isSchemaOutdated()
    ? OUTDATED_SCHEMA_MESSAGE
    : NOT_INSTALLED_MESSAGE;
  return { content: [{ type: 'text', text }] };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const searchModExamplesTool = {
  name: 'search_mod_examples',
  description:
    'PRIMARY source for Minecraft 1.12.2 implementation patterns: curated, AI-analyzed code ' +
    'examples from canonical open-source 1.12.2 mods (Forge and Cleanroom-native). These are ' +
    'real-world, idiomatic implementations with explanations, best practices, and SRG ' +
    'cross-links. Reach for this FIRST whenever you need working 1.12.2 code — blocks, tile ' +
    'entities, capabilities, networking, mixins, GUIs, registration, recipes. The scraped ' +
    'documentation tools are the supplement, not the starting point: their 1.12.2 corpus is ' +
    'thin, and `get_doc_snippet` only quotes code blocks out of tutorials and wikis while ' +
    '`search_docs` returns prose and concepts.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description:
          'Search query (e.g. "tile entity", "capability provider", "network packet", "mixin"). Free-form text.',
      },
      mod: {
        type: 'string',
        description: 'Filter by a specific indexed mod name (see `list_canonical_mods`).',
      },
      loader: {
        type: 'string',
        enum: ['forge', 'cleanroom'],
        description: 'Filter by target loader family: `forge` (classic 1.12.2) or `cleanroom`.',
      },
      category: {
        type: 'string',
        enum: [...EXAMPLE_CATEGORIES],
        description: 'Filter by pattern category',
      },
      pattern_type: {
        type: 'string',
        description:
          'Filter by pattern type (e.g. "block-registration", "event-handler", "packet-handler").',
      },
      complexity: {
        type: 'string',
        enum: ['beginner', 'intermediate', 'advanced', 'expert'],
        description: 'Filter by complexity level',
      },
      min_quality: {
        type: 'number',
        description: 'Minimum quality score (0.0-1.0). Higher = more curated. Default: 0.5',
        minimum: 0,
        maximum: 1,
      },
      featured_only: {
        type: 'boolean',
        description: 'Only return featured (highest quality) examples',
      },
      limit: {
        type: 'number',
        description: 'Maximum results (1-20). Default: 5',
        minimum: 1,
        maximum: 20,
      },
    },
  },
};

export const MOD_EXAMPLES_TOOLS = [
  searchModExamplesTool,
  {
    name: 'get_mod_example',
    description:
      'Get full detail for a specific mod example by ID: code, source + license attribution, ' +
      'explanation, best practices, pitfalls, imports, SRG cross-links, and related examples. ' +
      'Use after searching to get complete details.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'number', description: 'Example ID (from search results)' },
        include_related: {
          type: 'boolean',
          description: 'Include related examples (similar patterns, dependencies). Default: true',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_canonical_mods',
    description:
      'List the indexed canonical mods with their loader, license, and example counts. Use this ' +
      'to discover what source mods the examples come from.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        include_stats: {
          type: 'boolean',
          description: 'Include database statistics. Default: false',
        },
      },
    },
  },
  {
    name: 'list_mod_categories',
    description:
      'List available pattern categories with example counts. Use this to discover what kinds of ' +
      'examples are available.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_mod_patterns',
    description:
      'Get the most common implementation pattern types with counts. Output is bounded and reports how many pattern types were suppressed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum pattern types to return (1-200). Default: 40',
          minimum: 1,
          maximum: 200,
          default: 40,
        },
        min_count: {
          type: 'number',
          description: 'Minimum examples required for a pattern type. Default: 2',
          minimum: 1,
          default: 2,
        },
      },
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// COVERAGE DISCLOSURE (beta report N2)
//
// Every EXAMPLE_CATEGORIES slug is a filter value the schema offers, but the
// corpus does not back all of them: `capabilities` holds 0 examples because the
// snippet selector truncates each repo at maxSnippetsPerRepo in tree order and
// never reaches TinkersConstruct's library/capability/**. Until that is fixed
// corpus-side, both surfaces below say so out loud — an agent that filters,
// gets nothing, and concludes the corpus has no capability examples has been
// misled, which is worse than an empty result.
//
// The schema enum stays sourced from EXAMPLE_CATEGORIES: it is a compile-time
// registry constant (the SSOT rule in CLAUDE.md), and making it DB-dependent
// would trade a disclosed gap for a hidden one.
// ═══════════════════════════════════════════════════════════════════════════════

/** Slug→count map over the DB's category rows, for auditCategoryCoverage. */
function countsBySlug(categories: CategoryInfo[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const cat of categories) {
    counts[cat.slug] = cat.exampleCount;
  }
  return counts;
}

/** `icon \`slug\`` when the icon is known, bare slug otherwise. */
function labelFor(categories: CategoryInfo[], slug: string): string {
  const icon = categories.find((c) => c.slug === slug)?.icon;
  return icon ? `${icon} \`${slug}\`` : `\`${slug}\``;
}

/** The `list_mod_categories` body: the table, the reconciliation, the caveats. */
export function formatCategoryTable(categories: CategoryInfo[], uncategorized: number): string {
  let output = '# Pattern Categories\n\n';
  output += 'Available categories for filtering mod examples:\n\n';
  output += '| Category | Name | Examples | Description |\n';
  output += '|----------|------|----------|-------------|\n';
  categories.forEach((cat) => {
    output += `| ${cat.icon} \`${cat.slug}\` | ${cat.name} | ${cat.exampleCount} | ${cat.description} |\n`;
  });

  // Reconcile to the corpus total: a category-filtered search can never reach
  // these, so a table that silently omitted them read as complete when it wasn't.
  const categorized = categories.reduce((sum, cat) => sum + cat.exampleCount, 0);
  output += `\n${categorized + uncategorized} examples total`;
  if (uncategorized > 0) {
    output += `, of which ${uncategorized} are uncategorized (reachable by search, not by the \`category\` filter)`;
  }
  output += '.\n';

  const { empty, thin } = auditCategoryCoverage(countsBySlug(categories));
  if (empty.length > 0) {
    output += `\n⚠️ **Empty ${empty.length === 1 ? 'category' : 'categories'}** — accepted by the \`category\` filter but backed by 0 examples, `;
    output += `so filtering by ${empty.length === 1 ? 'it' : 'them'} can never return results: `;
    output += `${empty.map((slug) => labelFor(categories, slug)).join(', ')}.\n`;
  }
  if (thin.length > 0) {
    const listed = [...thin]
      .sort((a, b) => a.count - b.count)
      .map((t) => `\`${t.slug}\` (${t.count})`)
      .join(', ');
    output += `\nThin categories (under ${THIN_CATEGORY_THRESHOLD} examples — a filter on these narrows hard): ${listed}.\n`;
  }

  output += '\n**Usage:** `search_mod_examples` with `category` parameter\n';
  return output;
}

/**
 * The `search_mod_examples` zero-result body. A category filter is the one
 * argument that can make the result set empty no matter what else the agent
 * does, so when one is set the message reports that category's true corpus
 * count instead of the generic "try broader search terms".
 */
export function formatEmptyModExampleSearch(
  params: SearchModExamplesParams,
  categories: CategoryInfo[],
  uncategorized: number
): string {
  let output = 'No mod examples found matching your criteria.\n\n';

  const filtered = params.category ? categories.find((c) => c.slug === params.category) : undefined;
  const total = categories.reduce((sum, cat) => sum + cat.exampleCount, 0) + uncategorized;
  const minQuality = params.min_quality ?? 0.5;

  if (params.category && (filtered === undefined || filtered.exampleCount === 0)) {
    output += `⚠️ The \`${params.category}\` category holds **0 of the ${total} examples** in this corpus. `;
    output +=
      'Filtering by it can never return results, whatever the query — this is a gap in the ';
    output +=
      'corpus, not a failed search, so do not read it as "no such patterns exist in 1.12.2".\n\n';
    output += '**Suggestions:**\n';
    output += `- Re-run the same query without \`category\` — free-text search reaches the whole corpus, including the ${uncategorized} uncategorized examples\n`;
    const populated = categories
      .filter((c) => c.exampleCount > 0)
      .sort((a, b) => b.exampleCount - a.exampleCount)
      .slice(0, 5);
    if (populated.length > 0) {
      output += `- Best-populated categories: ${populated.map((c) => `\`${c.slug}\` (${c.exampleCount})`).join(', ')}\n`;
    }
    output += '- Use `list_mod_categories` to see every category with its true count\n';
    return output;
  }

  if (filtered !== undefined) {
    output += `The \`${filtered.slug}\` category holds ${filtered.exampleCount} examples, so another filter excluded them all `;
    output += `(active: \`min_quality\` ≥ ${minQuality}${params.featured_only ? ', `featured_only`' : ''}${params.mod ? `, mod \`${params.mod}\`` : ''}${params.loader ? `, loader \`${params.loader}\`` : ''}${params.complexity ? `, complexity \`${params.complexity}\`` : ''}${params.pattern_type ? `, pattern \`${params.pattern_type}\`` : ''}).\n\n`;
  }

  output += '**Suggestions:**\n';
  output += '- Try broader search terms\n';
  output += '- Remove category, loader, or complexity filters\n';
  output += `- Lower \`min_quality\` (currently ${minQuality}; the corpus mean is around 0.55)\n`;
  output += '- Use `list_canonical_mods` to see available mods\n';
  output += '- Use `list_mod_categories` to see available categories\n';
  return output;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

export interface SearchModExamplesParams {
  query?: string;
  mod?: string;
  loader?: string;
  category?: string;
  pattern_type?: string;
  complexity?: string;
  min_quality?: number;
  featured_only?: boolean;
  limit?: number;
}

export function handleSearchModExamples(params: SearchModExamplesParams): CallToolResult {
  try {
    if (!ModExamplesService.isAvailable()) {
      return notAvailableResult();
    }

    const service = new ModExamplesService();
    try {
      const examples = service.searchExamples({
        query: params.query,
        modName: params.mod,
        loader: params.loader,
        category: params.category,
        patternType: params.pattern_type,
        complexity: params.complexity,
        minQualityScore: params.min_quality ?? 0.5,
        featured: params.featured_only,
        limit: Math.min(Math.max(params.limit || 5, 1), 20),
      });

      let output = '';
      if (examples.length === 0) {
        // Only on the empty path — the category counts cost two extra queries
        // and exist to explain WHY it is empty (N2), not to decorate hits.
        output = formatEmptyModExampleSearch(
          params,
          service.listCategories(),
          service.countUncategorized()
        );
      } else {
        output = `Found ${examples.length} canonical mod example${examples.length > 1 ? 's' : ''}:\n\n`;
        examples.forEach((ex, i) => {
          output += `### ${i + 1}. ${ex.title}\n`;
          output += `**ID:** ${ex.id} | **Mod:** ${ex.modName} (${ex.license}) | **Quality:** ${formatQualityScore(ex.qualityScore)}`;
          if (ex.isFeatured) output += ' | ⭐ Featured';
          output += '\n';
          output += `**Loader:** ${ex.loader} | **Category:** ${ex.categoryName || ex.category || 'Uncategorized'} | **Pattern:** ${ex.patternType} | **Complexity:** ${ex.complexity}\n`;
          output += `\n${ex.caption}\n\n`;
          output += `\`\`\`${ex.language}\n${ex.code.slice(0, 500)}${ex.code.length > 500 ? '\n// ... (truncated, use get_mod_example for full code)' : ''}\n\`\`\`\n\n`;
          output += `→ Use \`get_mod_example\` with ID ${ex.id} for full details\n\n---\n\n`;
        });
      }
      return { content: [{ type: 'text', text: output }] };
    } finally {
      service.close();
    }
  } catch (error) {
    console.error('[search_mod_examples] Error:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error searching mod examples: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

export interface GetModExampleParams {
  id: number;
  include_related?: boolean;
}

export function handleGetModExample(params: GetModExampleParams): CallToolResult {
  try {
    // Validate id presence — a missing id must be a validation error, not a
    // silent id=0 "not found" (dispatch footgun fix, DESIGN §9).
    if (typeof params.id !== 'number' || !Number.isFinite(params.id)) {
      return {
        content: [
          {
            type: 'text',
            text: 'Invalid request: `id` is required and must be a number (from `search_mod_examples`).',
          },
        ],
        isError: true,
      };
    }

    if (!ModExamplesService.isAvailable()) {
      return notAvailableResult();
    }

    const service = new ModExamplesService();
    try {
      const example = service.getExample(params.id);
      if (!example) {
        return {
          content: [
            {
              type: 'text',
              text: `Example with ID ${params.id} not found. Use search_mod_examples to find valid example IDs.`,
            },
          ],
        };
      }

      let output = service.formatExampleForAI(example);

      if (params.include_related !== false) {
        const relations = service.getRelatedExamples(params.id);
        if (relations.length > 0) {
          output += '\n---\n\n## Related Examples\n\n';
          relations.forEach((rel) => {
            const relationLabel =
              {
                uses: '📦 Uses',
                extends: '🔄 Extends',
                similar_to: '🔗 Similar to',
                alternative_to: '↔️ Alternative to',
                requires: '⚠️ Requires',
                complements: '✨ Complements',
              }[rel.relationType] || rel.relationType;
            output += `**${relationLabel}** (ID: ${rel.targetId}, strength: ${(rel.strength * 100).toFixed(0)}%)\n`;
            output += `- ${rel.targetTitle}\n`;
            output += `- ${rel.description}\n\n`;
          });
        }
      }

      return { content: [{ type: 'text', text: output }] };
    } finally {
      service.close();
    }
  } catch (error) {
    console.error('[get_mod_example] Error:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error retrieving example: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

export interface ListCanonicalModsParams {
  include_stats?: boolean;
}

export function handleListCanonicalMods(params: ListCanonicalModsParams): CallToolResult {
  try {
    if (!ModExamplesService.isAvailable()) {
      return notAvailableResult();
    }

    const service = new ModExamplesService();
    try {
      const mods = service.listMods();
      let output = '# Indexed Canonical Mods\n\n';
      output += 'Curated, open-source 1.12.2 mods with AI-analyzed code examples:\n\n';

      if (params.include_stats) {
        const stats = service.getStats();
        output += '## Database Statistics\n\n';
        output += `| Metric | Value |\n|--------|-------|\n`;
        output += `| Total Mods | ${stats.mods} |\n`;
        output += `| Total Examples | ${stats.examples} |\n`;
        output += `| Relationships | ${stats.relations} |\n`;
        output += `| Featured Examples | ${stats.featuredExamples} |\n`;
        output += `| Avg Quality Score | ${formatQualityScore(stats.avgQualityScore)} |\n\n`;
      }

      output += '## Available Mods\n\n';
      output += '| Mod | Loader | License | Examples | Repository |\n';
      output += '|-----|--------|---------|----------|------------|\n';
      mods.forEach((mod) => {
        output += `| ${mod.name} | ${mod.loader} | ${mod.license} | ${mod.exampleCount} | [${mod.repo}](https://github.com/${mod.repo}) |\n`;
      });
      output += '\n';

      mods.forEach((mod) => {
        if (mod.description) {
          output += `### ${mod.name}\n${mod.description}\n\n`;
        }
      });

      return { content: [{ type: 'text', text: output }] };
    } finally {
      service.close();
    }
  } catch (error) {
    console.error('[list_canonical_mods] Error:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error listing mods: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

export function handleListModCategories(): CallToolResult {
  try {
    if (!ModExamplesService.isAvailable()) {
      return notAvailableResult();
    }

    const service = new ModExamplesService();
    try {
      const output = formatCategoryTable(service.listCategories(), service.countUncategorized());
      return { content: [{ type: 'text', text: output }] };
    } finally {
      service.close();
    }
  } catch (error) {
    console.error('[list_mod_categories] Error:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error listing categories: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
export interface GetModPatternsParams {
  limit?: number;
  min_count?: number;
}

export function handleGetModPatterns(params: GetModPatternsParams = {}): CallToolResult {
  try {
    if (!ModExamplesService.isAvailable()) {
      return notAvailableResult();
    }

    const limit = Math.min(Math.max(Math.floor(params.limit ?? 40), 1), 200);
    const minCount = Math.max(Math.floor(params.min_count ?? 2), 1);
    const service = new ModExamplesService();
    try {
      const page = service.getPatternTypes(limit, minCount);
      let output = '# Pattern Types\n\n';
      output += 'Specific implementation patterns found in indexed mods:\n\n';
      output += `Showing ${page.patterns.length} of ${page.totalTypes} pattern types; ${page.singletonTypes.toLocaleString('en-US')} have a single example.`;
      if (minCount > 1) {
        output += ` ${page.eligibleTypes.toLocaleString('en-US')} meet \`min_count\` ≥ ${minCount}.`;
      }
      output += '\n\n';
      output += '| Pattern Type | Example Count |\n|--------------|---------------|\n';
      page.patterns.forEach((p) => (output += `| \`${p.type}\` | ${p.count} |\n`));
      output += '\n**Usage:** `search_mod_examples` with `pattern_type` parameter\n';
      return { content: [{ type: 'text', text: output }] };
    } finally {
      service.close();
    }
  } catch (error) {
    console.error('[get_mod_patterns] Error:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error getting patterns: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
