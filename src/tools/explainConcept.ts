/**
 * Explain Minecraft modding concepts (Cleanroom/Forge 1.12.2 by default)
 * Provides comprehensive explanations using hybrid search (FTS + semantic)
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ConceptService, type ConceptExplanation } from '../services/concept-service.js';
import { isLoader, type Loader } from '../loaders.js';
import { REPO_URL } from '../dbs.js';

export interface ExplainConceptParams {
  concept: string;
  loader?: string;
}

// Singleton instance for reuse
let conceptServiceInstance: ConceptService | null = null;

function getConceptService(): ConceptService {
  if (!conceptServiceInstance) {
    conceptServiceInstance = new ConceptService();
  }
  return conceptServiceInstance;
}

/**
 * Handle the explain_fabric_concept tool call
 * Uses hybrid search (FTS + semantic embeddings) for comprehensive explanations
 */
export async function handleExplainConcept(params: ExplainConceptParams): Promise<CallToolResult> {
  const { concept } = params;

  // Default perspective is the target loader; unknown values are ignored.
  const loader: Loader | undefined =
    params.loader && isLoader(params.loader) ? params.loader : undefined;

  // Validate input
  if (!concept || typeof concept !== 'string' || concept.trim().length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: Concept parameter is required and cannot be empty.',
        },
      ],
      isError: true,
    };
  }

  const trimmedConcept = concept.trim();

  // Check for very long input
  if (trimmedConcept.length > 100) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: Concept should be a concise term or phrase (max 100 characters). Examples: "mixins", "registry", "sided logic".',
        },
      ],
      isError: true,
    };
  }

  try {
    const service = getConceptService();

    // Get comprehensive explanation
    const explanation = await service.explainConcept(trimmedConcept, loader);

    // Format for AI
    const formattedOutput = service.formatForAI(explanation);

    // Add suggestions if few results
    let suggestions = '';
    if (explanation.metadata.sourcesUsed < 2) {
      suggestions = '\n\n**Note:** Limited information found for this concept. ';
      suggestions += 'Try:\n';
      suggestions += '- Using a more common term (e.g., "mixin" instead of "bytecode injection")\n';
      suggestions += '- Checking spelling\n';
      suggestions += '- Using `search_docs` for broader search\n';
    }

    return {
      content: [
        {
          type: 'text',
          text: formattedOutput + suggestions,
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[explainConcept] Error: ${errorMessage}`);

    return {
      content: [
        {
          type: 'text',
          text:
            `Error explaining concept: documentation database unavailable — automatic installation ` +
            `did not complete. Ensure CLEANROOM_MCP_SKIP_AUTO_UPDATE is unset and restart the server. ` +
            `Release assets and status: ${REPO_URL}/releases\n\nOriginal error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Get suggested concepts for exploration
 */
export function getSuggestedConcepts(): string[] {
  return [
    // Target-family (Cleanroom / Forge 1.12.2) concepts
    'capabilities',
    'srg names',
    'coremods',
    'mcmod.info',
    'creativetabs',
    'oredictionary',
    'mixinbooter',
    'gameregistry',
    'access transformers',
    'tileentity',
    // Cross-loader fundamentals
    'mixin',
    'registry',
    'entrypoint',
    'fabric.mod.json',
    'sided logic',
    'networking',
    'blockentity',
    'item',
    'block',
    'event',
    'recipe',
    'datagen',
    'render',
    'screen',
    'command',
    'tag',
    'loot',
    'sound',
    'keybind',
    'entity',
  ];
}

// Re-export types
export type { ConceptExplanation };
