/**
 * Mod Examples Tools — query curated examples from canonical open-source 1.12.2
 * mods. The corpus is the eight-repo roster in data/examples-roster.json (Forge
 * and Cleanroom-native), analyzed at build time with per-example source +
 * license attribution and index-time SRG / framework-API cross-links.
 */

import { ModExamplesService } from '../services/mod-examples-service.js';
import { EXAMPLE_CATEGORIES } from '../categories.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Availability guidance (aligned with the NOT_INSTALLED convention, Phase 3)
// ═══════════════════════════════════════════════════════════════════════════════

const NOT_INSTALLED_MESSAGE =
  'The mod examples database is not installed. This optional database holds curated, ' +
  'AI-analyzed code examples from canonical open-source 1.12.2 mods (Forge and Cleanroom-native), ' +
  'with per-example source + license attribution and SRG cross-links.\n\n' +
  'To install it, run: `cleanroom-modding-mcp manage`.\n\n' +
  'The standard documentation tools (search_docs, get_example) are still available.';

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
    'Search curated, AI-analyzed code examples from canonical open-source Minecraft 1.12.2 ' +
    'mods (Forge and Cleanroom-native). These are real-world, idiomatic implementations with ' +
    'explanations, best practices, and SRG cross-links. Use this when you need a proven 1.12.2 ' +
    'pattern (blocks, tile entities, capabilities, networking, mixins, GUIs, …).',
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
      'Get all available pattern types with counts. Useful for discovering specific implementation patterns.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

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
        output = 'No mod examples found matching your criteria.\n\n';
        output += '**Suggestions:**\n';
        output += '- Try broader search terms\n';
        output += '- Remove category, loader, or complexity filters\n';
        output += '- Use `list_canonical_mods` to see available mods\n';
        output += '- Use `list_mod_categories` to see available categories\n';
      } else {
        output = `Found ${examples.length} canonical mod example${examples.length > 1 ? 's' : ''}:\n\n`;
        examples.forEach((ex, i) => {
          output += `### ${i + 1}. ${ex.title}\n`;
          output += `**ID:** ${ex.id} | **Mod:** ${ex.modName} (${ex.license}) | **Quality:** ${(ex.qualityScore * 100).toFixed(0)}%`;
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
        output += `| Avg Quality Score | ${(stats.avgQualityScore * 100).toFixed(0)}% |\n\n`;
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
      const categories = service.listCategories();
      let output = '# Pattern Categories\n\n';
      output += 'Available categories for filtering mod examples:\n\n';
      output += '| Category | Name | Examples | Description |\n';
      output += '|----------|------|----------|-------------|\n';
      categories.forEach((cat) => {
        output += `| ${cat.icon} \`${cat.slug}\` | ${cat.name} | ${cat.exampleCount} | ${cat.description} |\n`;
      });
      // Reconcile to the corpus total: a category-filtered search can never
      // reach these, so a table that silently omitted them read as complete
      // when it wasn't.
      const uncategorized = service.countUncategorized();
      const categorized = categories.reduce((sum, cat) => sum + cat.exampleCount, 0);
      output += `\n${categorized + uncategorized} examples total`;
      if (uncategorized > 0) {
        output += `, of which ${uncategorized} are uncategorized (reachable by search, not by the \`category\` filter)`;
      }
      output += '.\n';
      output += '\n**Usage:** `search_mod_examples` with `category` parameter\n';
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

export function handleGetModPatterns(): CallToolResult {
  try {
    if (!ModExamplesService.isAvailable()) {
      return notAvailableResult();
    }

    const service = new ModExamplesService();
    try {
      const patterns = service.getPatternTypes();
      let output = '# Pattern Types\n\n';
      output += 'Specific implementation patterns found in indexed mods:\n\n';
      output += '| Pattern Type | Example Count |\n|--------------|---------------|\n';
      patterns.forEach((p) => (output += `| \`${p.type}\` | ${p.count} |\n`));
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
