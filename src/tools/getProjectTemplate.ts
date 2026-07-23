/**
 * get_project_template — serve a vendored, annotated CleanroomModTemplate snapshot.
 *
 * The tool-shaped twin of the `cleanroom://template/*` resources (DESIGN §7.2). It returns
 * the EXACT template module string (byte-identical to the resource body — a test enforces
 * this). Always available: content ships in the npm package, no DB required.
 */

import { TEMPLATE_COMPONENTS, getTemplate } from '../templates/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const GET_PROJECT_TEMPLATE_TOOLS = [
  {
    name: 'get_project_template',
    description:
      'Get a file from the official CleanroomModTemplate for scaffolding a Cleanroom (1.12.2, Java 25+) mod. Returns the raw upstream snapshot verbatim with blossom {{ }} tokens intact (your Unimined + blossom build expands them) plus an annotation explaining the tokens. Components: build.gradle, gradle.properties, settings.gradle, mcmod.info, ExampleMod.java, mixins.json, modid_at.cfg, README, checklist. Mirrors the cleanroom://template/* resources.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        component: {
          type: 'string',
          enum: [...TEMPLATE_COMPONENTS],
          description: 'Which template file to return.',
        },
      },
      required: ['component'],
    },
  },
];

export interface GetProjectTemplateParams {
  component: string;
}

export function handleGetProjectTemplate(params: GetProjectTemplateParams): CallToolResult {
  const content = getTemplate(params.component);
  if (content === undefined) {
    return {
      content: [
        {
          type: 'text',
          text: `Unknown template component "${params.component}". Available: ${TEMPLATE_COMPONENTS.join(', ')}.`,
        },
      ],
      isError: true,
    };
  }
  return { content: [{ type: 'text', text: content }] };
}
