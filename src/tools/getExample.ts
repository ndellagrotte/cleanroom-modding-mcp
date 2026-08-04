/**
 * get_doc_snippet tool - Retrieves code snippets from the indexed documentation corpus
 * (docs.db). Optimized for AI consumption with rich context and metadata.
 *
 * Renamed from `get_example` in 2.2.0 because agents confused it with `search_mod_examples`
 * (see src/tools/modExamples.ts), which searches the curated real-mod corpus and is the better
 * source for idiomatic implementations. The file and its `handleGetExample` export keep the old
 * name to limit the rename's blast radius; only the MCP-visible tool name changed.
 */

import { ExampleService } from '../services/example-service.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isLoader, type Scope } from '../loaders.js';
import { REPO_URL } from '../dbs.js';

export interface GetExampleParams {
  topic: string;
  language?: string;
  scope?: string;
  loader?: string;
  minecraftVersion?: string;
  category?: string;
  limit?: number;
  /** Tool name the request arrived under; drives the deprecation notice on the old alias. */
  invokedAs?: string;
}

const SCOPES: Scope[] = ['target', 'reference', 'all'];

/** Prepended to the output when the caller used the pre-2.2.0 `get_example` name. */
const DEPRECATION_NOTICE =
  '> **Note:** `get_example` was renamed to `get_doc_snippet` — it searches the scraped ' +
  'documentation corpus. For implementations taken from real 1.12.2 mods, use ' +
  '`search_mod_examples`. The old name still works but will be removed.\n\n';

/**
 * Handle get_doc_snippet tool request (also reachable under the deprecated `get_example` name)
 * Returns formatted code snippets with full context for AI
 */
export async function handleGetExample(params: GetExampleParams): Promise<CallToolResult> {
  try {
    const { topic, language = 'java', loader, category, limit = 5, invokedAs } = params;
    const deprecationNotice = invokedAs === 'get_example' ? DEPRECATION_NOTICE : '';
    let { minecraftVersion } = params;

    // Scope defaults to 'target' (Cleanroom/Forge 1.12.2)
    const scope: Scope = SCOPES.includes(params.scope as Scope)
      ? (params.scope as Scope)
      : 'target';

    // Validate topic
    if (!topic || !topic.trim()) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: Topic parameter is required. Please specify what you want examples for (e.g., "register item", "block entity", "networking").',
          },
        ],
        isError: true,
      };
    }

    const exampleService = new ExampleService();

    if (minecraftVersion === 'latest') {
      // Family-scoped: 1.12.2 within the target family, newest indexed otherwise.
      minecraftVersion = exampleService.getLatestMinecraftVersion(scope);
    }

    // Validate and clamp limit
    const finalLimit = Math.min(Math.max(limit, 1), 10);

    console.error(
      `[get_doc_snippet] Searching for: "${topic}" (${language}, limit: ${finalLimit})`
    );

    // Get examples (synchronous - uses SQLite)
    const examples = await exampleService.getExamples({
      topic,
      language,
      scope,
      loader: loader && isLoader(loader) ? loader : undefined,
      minecraftVersion,
      category,
      limit: finalLimit,
    });

    // Handle no results
    if (examples.length === 0) {
      exampleService.close();

      let message = `No code examples found for "${topic}"`;

      if (language !== 'java') {
        message += ` in ${language}`;
      }

      if (loader) {
        message += ` for ${loader}`;
      }

      if (minecraftVersion) {
        message += ` (version ${minecraftVersion})`;
      }

      message += '.\n\n**Suggestions:**\n';
      message +=
        '- Try using more general search terms (e.g., "item" instead of "custom item registration")\n';
      message += '- Remove version or loader filters\n';
      message += "- Try `scope: 'all'` to include the Fabric/NeoForge reference corpus\n";
      message += '- Try searching with the `search_docs` tool first\n';
      message +=
        "- Try `language: 'json'` or `'groovy'` — this tool defaults to `java` and the docs " +
        'corpus tags resource files separately\n';
      message +=
        '- For a real-mod implementation of this pattern, try `search_mod_examples` (curated ' +
        'mod-examples corpus; run `cleanroom-modding-mcp manage` if that tool is not listed)\n';

      console.error(`[get_doc_snippet] No results found for "${topic}"`);

      return {
        content: [
          {
            type: 'text',
            text: deprecationNotice + message,
          },
        ],
      };
    }

    // Format results for AI
    const formattedOutput = exampleService.formatForAI(examples);

    // Close after formatting
    exampleService.close();

    console.error(`[get_doc_snippet] Returning ${examples.length} example(s) for "${topic}"`);

    return {
      content: [
        {
          type: 'text',
          text: deprecationNotice + formattedOutput,
        },
      ],
    };
  } catch (error) {
    console.error('[get_doc_snippet] Error:', error);

    return {
      content: [
        {
          type: 'text',
          text:
            `Documentation database unavailable — automatic installation did not complete. ` +
            `Ensure CLEANROOM_MCP_SKIP_AUTO_UPDATE is unset and restart the server. ` +
            `Release assets and status: ${REPO_URL}/releases\n\n` +
            `Original error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Get available example metadata (for debugging/info)
 */
export function getAvailableTopics(): {
  categories: string[];
  languages: Array<{ language: string; count: number }>;
  loaders: string[];
  versions: string[];
} {
  const exampleService = new ExampleService();
  const topics = exampleService.getAvailableTopics();
  exampleService.close();
  return topics;
}
