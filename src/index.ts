#!/usr/bin/env node
import { createRequire } from 'module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { handleGetExample } from './tools/getExample.js';
import { handleListTargets } from './tools/listTargets.js';
import { handleSearchDocs } from './tools/searchDocs.js';
import { handleExplainConcept } from './tools/explainConcept.js';
import { autoUpdateAll } from './db-versioning.js';
import { PACKAGE_NAME } from './dbs.js';
import { LOADER_IDS } from './loaders.js';
import { DOC_CATEGORY_ENUM, DOC_CATEGORIES } from './categories.js';
import { ModExamplesService } from './services/mod-examples-service.js';
import { MappingsService } from './services/mappings-service.js';
import {
  MOD_EXAMPLES_TOOLS,
  handleSearchModExamples,
  handleGetModExample,
  handleListCanonicalMods,
  handleListModCategories,
  handleGetModPatterns,
} from './tools/modExamples.js';
import {
  MAPPINGS_TOOLS,
  handleSearchMappings,
  handleGetClassDetails,
  handleResolveSymbol,
  handleGetMethodSignature,
  handleListMappingVersions,
  handleBrowsePackage,
} from './tools/mappings.js';
import { CleanroomApiService } from './services/cleanroom-api-service.js';
import {
  CLEANROOM_API_TOOLS,
  handleSearchCleanroomApi,
  handleGetApiClass,
  type SearchCleanroomApiParams,
} from './tools/cleanroomApi.js';
import {
  FIND_EQUIVALENT_TOOLS,
  handleFindEquivalent,
  type FindEquivalentParams,
} from './tools/findEquivalent.js';
import {
  GET_PROJECT_TEMPLATE_TOOLS,
  handleGetProjectTemplate,
} from './tools/getProjectTemplate.js';
import { GET_PORTING_GUIDE_TOOLS, handleGetPortingGuide } from './tools/getPortingGuide.js';
import { listCleanroomResources, readCleanroomResource } from './resources.js';
import { PROMPT_DEFS, getPromptResult } from './prompts.js';

// Check for CLI commands
if (process.argv.includes('manage')) {
  if (process.argv.includes('--build-mappings')) {
    // Headless on-device build of the 1.12.2 mappings database
    const { runHeadlessMappingsBuild } = await import('./cli/manage.js');
    process.exit(await runHeadlessMappingsBuild());
  }
  const { runInstaller } = await import('./cli/manage.js');
  await runInstaller();
  process.exit(0);
}

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../package.json') as { version: string };

const server = new Server(
  {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  }
);

// Base tools always available
const BASE_TOOLS = [
  {
    name: 'search_docs',
    description:
      'Search Minecraft modding documentation. Defaults to the TARGET scope: Cleanroom + Forge 1.12.2 — the loaders this server helps you build for. Use scope "reference" for Fabric/NeoForge porting material, "all" for comparative work.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            "Search query (e.g., 'how to register items', 'mixin setup', 'capabilities'). Be specific for best results.",
        },
        scope: {
          type: 'string',
          enum: ['target', 'reference', 'all'],
          description:
            'Loader family to search: "target" = Cleanroom/Forge 1.12.2 (default), "reference" = Fabric/NeoForge porting material, "all" = everything',
          default: 'target',
        },
        loader: {
          type: 'string',
          enum: LOADER_IDS,
          description: 'Filter to one specific loader (overrides scope)',
        },
        category: {
          type: 'string',
          enum: DOC_CATEGORY_ENUM,
          description: 'Documentation category to search within (default: all)',
          default: 'all',
        },
        minecraft_version: {
          type: 'string',
          description:
            "Minecraft version filter (e.g., '1.12.2', '1.21.4'). 'latest' resolves per scope: 1.12.2 for target, newest indexed for reference.",
        },
        include_code: {
          type: 'boolean',
          description: 'Include code snippets in results (default: true)',
          default: true,
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (1-20)',
          default: 10,
          minimum: 1,
          maximum: 20,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_doc_snippet',
    description:
      'Get code snippets out of the scraped modding documentation corpus (docs.db): code ' +
      'blocks lifted from tutorials and wikis, returned with their surrounding section text, ' +
      'source URL, loader, and Minecraft version. Defaults to the target scope ' +
      '(Cleanroom/Forge 1.12.2). This tool only ever returns what the documentation shows — ' +
      'for idiomatic, production-tested implementations taken from real 1.12.2 mods, prefer ' +
      '`search_mod_examples` (curated mod-examples corpus; listed only when the optional ' +
      'examples database is installed — run `cleanroom-modding-mcp manage` to add it). ' +
      'See also `search_docs` for prose documentation rather than code.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description:
            "Topic or pattern to get examples for (e.g., 'register item', 'tile entity', 'mixin', 'networking', 'custom armor'). Can be free-form text.",
        },
        language: {
          type: 'string',
          description: "Programming language (e.g., 'java', 'json', 'groovy')",
          default: 'java',
        },
        scope: {
          type: 'string',
          enum: ['target', 'reference', 'all'],
          description:
            'Loader family: "target" = Cleanroom/Forge 1.12.2 (default), "reference" = Fabric/NeoForge, "all" = everything',
          default: 'target',
        },
        loader: {
          type: 'string',
          enum: LOADER_IDS,
          description: 'Filter to one specific loader (overrides scope)',
        },
        minecraft_version: {
          type: 'string',
          description:
            "Minecraft version filter (e.g., '1.12.2', '1.21.4'). 'latest' resolves per scope.",
        },
        category: {
          type: 'string',
          enum: DOC_CATEGORIES,
          description: 'Documentation category to filter by',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of examples to return (1-10)',
          default: 5,
          minimum: 1,
          maximum: 10,
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'explain_concept',
    description:
      'Get a detailed explanation of a Minecraft modding concept, from the perspective of a specific loader (default: Cleanroom). Use this to understand fundamental concepts, terminology, or architectural patterns — e.g. capabilities, SRG names, mixins, mcmod.info.',
    inputSchema: {
      type: 'object',
      properties: {
        concept: {
          type: 'string',
          description:
            "Concept to explain (e.g., 'capabilities', 'srg names', 'mixins', 'oredictionary', 'mcmod.info', 'events'). Max 100 characters.",
        },
        loader: {
          type: 'string',
          enum: LOADER_IDS,
          description: "Loader perspective for the explanation (default: 'cleanroom')",
          default: 'cleanroom',
        },
      },
      required: ['concept'],
    },
  },
  {
    name: 'list_targets',
    description:
      'Orientation call: shows which loaders are development targets (Cleanroom/Forge 1.12.2) vs porting reference (Fabric/NeoForge), the indexed documentation versions, and which optional databases are installed. Call this first in a new session.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// List available tools (conditionally include mod examples if database exists)
server.setRequestHandler(ListToolsRequestSchema, () => {
  // Phase 4 porting tools are always listed: find_equivalent is backed by the required
  // docs.db (it degrades gracefully if the corpus isn't present yet); the template/guide
  // tools are backed by package-shipped content and need no DB.
  const tools: any[] = [
    ...BASE_TOOLS,
    ...FIND_EQUIVALENT_TOOLS,
    ...GET_PROJECT_TEMPLATE_TOOLS,
    ...GET_PORTING_GUIDE_TOOLS,
  ];

  // Add mod examples tools if database is available
  if (ModExamplesService.isAvailable()) {
    tools.push(...MOD_EXAMPLES_TOOLS);
    console.error('[MCP] Mod examples database available - additional tools registered');
  }

  // Add mappings tools if database is available
  if (MappingsService.isAvailable()) {
    tools.push(...MAPPINGS_TOOLS);
    console.error('[MCP] Mappings database available - additional tools registered');
  }

  // Add Cleanroom API tools if database is available
  if (CleanroomApiService.isAvailable()) {
    tools.push(...CLEANROOM_API_TOOLS);
    console.error('[MCP] Cleanroom API database available - additional tools registered');
  }

  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'find_equivalent': {
      return handleFindEquivalent({
        query: (args?.query as string) || '',
        from: args?.from as FindEquivalentParams['from'],
        topic: args?.topic as string | undefined,
        limit: args?.limit as number | undefined,
      });
    }

    case 'get_project_template': {
      return handleGetProjectTemplate({
        component: (args?.component as string) || '',
      });
    }

    case 'get_porting_guide': {
      return handleGetPortingGuide({
        name: (args?.name as string) || '',
      });
    }

    case 'search_docs': {
      return handleSearchDocs({
        query: (args?.query as string) || '',
        scope: args?.scope as string | undefined,
        category: args?.category as string | undefined,
        loader: args?.loader as string | undefined,
        minecraftVersion: args?.minecraft_version as string | undefined,
        includeCode: args?.include_code as boolean | undefined,
        limit: args?.limit as number | undefined,
      });
    }

    // `get_example` is the pre-2.2.0 name, kept as an UNLISTED dispatch alias so hardcoded
    // prompts and configs don't hard-fail on the `default:` throw below. Only `get_doc_snippet`
    // is returned by ListTools. Remove the alias in 3.0.0.
    case 'get_example':
    case 'get_doc_snippet': {
      return await handleGetExample({
        topic: (args?.topic as string) || '',
        language: args?.language as string | undefined,
        scope: args?.scope as string | undefined,
        loader: args?.loader as string | undefined,
        minecraftVersion: args?.minecraft_version as string | undefined,
        category: args?.category as string | undefined,
        limit: args?.limit as number | undefined,
        invokedAs: name,
      });
    }

    case 'explain_concept': {
      return await handleExplainConcept({
        concept: (args?.concept as string) || '',
        loader: args?.loader as string | undefined,
      });
    }

    case 'list_targets': {
      return handleListTargets();
    }

    // Mod examples tools (only work if database is available)
    case 'search_mod_examples': {
      return handleSearchModExamples({
        query: args?.query as string | undefined,
        mod: args?.mod as string | undefined,
        loader: args?.loader as string | undefined,
        category: args?.category as string | undefined,
        pattern_type: args?.pattern_type as string | undefined,
        complexity: args?.complexity as string | undefined,
        min_quality: args?.min_quality as number | undefined,
        featured_only: args?.featured_only as boolean | undefined,
        limit: args?.limit as number | undefined,
      });
    }

    case 'get_mod_example': {
      // Pass the raw id through; the handler validates its presence and type so a
      // missing id is a validation error, not a silent id=0 "not found".
      return handleGetModExample({
        id: args?.id as number,
        include_related: args?.include_related as boolean | undefined,
      });
    }

    case 'list_canonical_mods': {
      return handleListCanonicalMods({
        include_stats: args?.include_stats as boolean | undefined,
      });
    }

    case 'list_mod_categories': {
      return handleListModCategories();
    }

    case 'get_mod_patterns': {
      return handleGetModPatterns();
    }

    // Mappings tools (only work if database is available)
    case 'search_mappings': {
      return handleSearchMappings({
        query: (args?.query as string) || '',
        type: args?.type as 'class' | 'method' | 'field' | 'all' | undefined,
        minecraft_version: args?.minecraft_version as string | undefined,
        package_filter: args?.package_filter as string | undefined,
        include_javadoc: args?.include_javadoc as boolean | undefined,
        limit: args?.limit as number | undefined,
      });
    }

    case 'get_class_details': {
      return handleGetClassDetails({
        class_name: (args?.class_name as string) || '',
        minecraft_version: args?.minecraft_version as string | undefined,
        include_methods: args?.include_methods as boolean | undefined,
        include_fields: args?.include_fields as boolean | undefined,
      });
    }

    case 'resolve_symbol': {
      return handleResolveSymbol({
        symbol: (args?.symbol as string) || '',
        minecraft_version: args?.minecraft_version as string | undefined,
      });
    }

    case 'get_method_signature': {
      return handleGetMethodSignature({
        class_name: (args?.class_name as string) || '',
        method_name: (args?.method_name as string) || '',
        minecraft_version: args?.minecraft_version as string | undefined,
      });
    }

    case 'list_mapping_versions': {
      return handleListMappingVersions({
        include_stats: args?.include_stats as boolean | undefined,
      });
    }

    case 'browse_package': {
      return handleBrowsePackage({
        package_name: (args?.package_name as string) || '',
        minecraft_version: args?.minecraft_version as string | undefined,
      });
    }

    // Cleanroom API tools (only work if database is available)
    case 'search_cleanroom_api': {
      return handleSearchCleanroomApi({
        query: (args?.query as string) || '',
        package_filter: args?.package_filter as string | undefined,
        kind: args?.kind as SearchCleanroomApiParams['kind'],
        limit: args?.limit as number | undefined,
      });
    }

    case 'get_api_class': {
      return handleGetApiClass({
        name: (args?.name as string) || '',
        include_members: args?.include_members as boolean | undefined,
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// List available resources — every cleanroom:// URI is enumerated concretely.
server.setRequestHandler(ListResourcesRequestSchema, () => {
  return { resources: listCleanroomResources() };
});

// No RFC-6570 resource templates are surfaced (no surveyed client uses them); registered
// for spec-completeness so clients that probe it get an empty list rather than an error.
server.setRequestHandler(ListResourceTemplatesRequestSchema, () => {
  return { resourceTemplates: [] };
});

// Read resource — resolve template/guide bodies; unknown URI → spec code -32002.
server.setRequestHandler(ReadResourceRequestSchema, (request) => {
  const { uri } = request.params;
  const body = readCleanroomResource(uri);
  if (!body) {
    throw new McpError(-32002, `Resource not found: ${uri}`);
  }
  return {
    contents: [{ uri, mimeType: body.mimeType, text: body.text }],
  };
});

// List prompts (declared via the `prompts` capability above).
server.setRequestHandler(ListPromptsRequestSchema, () => {
  return {
    prompts: PROMPT_DEFS.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  };
});

// Get a prompt — embeds the relevant resource + a tool plan. Bad name / missing arg → -32602.
server.setRequestHandler(GetPromptRequestSchema, (request) => {
  const { name, arguments: args } = request.params;
  return getPromptResult(name, args);
});

// Start the server
async function main() {
  // Check for database updates on startup (skip if CLEANROOM_MCP_SKIP_AUTO_UPDATE is set)
  if (process.env.CLEANROOM_MCP_SKIP_AUTO_UPDATE) {
    console.error('[DbVersioning] Auto-update skipped (CLEANROOM_MCP_SKIP_AUTO_UPDATE is set)');
  } else {
    try {
      console.error('[DbVersioning] Checking for database updates...');
      const result = await autoUpdateAll();
      console.error('[DbVersioning] Update check complete');
      if (result.updated.length > 0) {
        console.error('[DbVersioning] Database(s) updated. Restart recommended for best results.');
      }
      if (result.failed.length > 0) {
        console.error(
          `[DbVersioning] Database update failed for: ${result.failed.join(', ')}. ` +
            'Data-backed tools may be unavailable; see the preceding errors and ' +
            'https://github.com/ndellagrotte/cleanroom-modding-mcp/releases'
        );
      } else if (result.updated.length === 0) {
        console.error('[DbVersioning] Installed databases are up to date');
      }
    } catch (error) {
      console.error('[DbVersioning] Error checking for updates:', error);
      // Continue startup even if update fails
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Cleanroom Modding MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
