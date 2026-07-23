/**
 * get_porting_guide — serve an authored porting/mixin guide.
 *
 * The tool-shaped twin of the `cleanroom://guide/*` resources (DESIGN §7.2). Returns the
 * EXACT guide module string (byte-identical to the resource body — a test enforces this).
 * Always available: content ships in the npm package, no DB required.
 */

import { GUIDE_NAMES, getGuide } from '../guides/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const GET_PORTING_GUIDE_TOOLS = [
  {
    name: 'get_porting_guide',
    description:
      'Get an authored, topic-sequenced porting guide for Cleanroom (1.12.2). Guides: porting-from-fabric, porting-from-neoforge, backporting (from modern Minecraft), mixin-setup. Each sequences the topics to sweep with find_equivalent and the tools to use. Mirrors the cleanroom://guide/* resources.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          enum: [...GUIDE_NAMES],
          description: 'Which guide to return.',
        },
      },
      required: ['name'],
    },
  },
];

export interface GetPortingGuideParams {
  name: string;
}

export function handleGetPortingGuide(params: GetPortingGuideParams): CallToolResult {
  const content = getGuide(params.name);
  if (content === undefined) {
    return {
      content: [
        {
          type: 'text',
          text: `Unknown guide "${params.name}". Available: ${GUIDE_NAMES.join(', ')}.`,
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: 'text', text: content }] };
}
