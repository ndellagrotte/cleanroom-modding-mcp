/**
 * find_equivalent — the equivalence-corpus front door (DESIGN §4).
 *
 * Cross-loader / backport API translation lookup. `from` is a separate FROM-VOCABULARY
 * ('fabric' | 'neoforge' | 'modern-minecraft') — NOT a Loader value (Fixed Input 3).
 * Backed by the equivalence table inside docs.db (the required, always-updated DB); the
 * tool is ALWAYS listed and degrades gracefully when the corpus is not yet present.
 */

import { EquivalenceService } from '../services/equivalence-service.js';
import { FROM_VOCABS } from '../equivalence/types.js';
import { TOPIC_VALUES } from '../equivalence/topics.js';
import type { EquivalenceMatch } from '../equivalence/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

/** Shared between the inputSchema enum and the runtime guard. */
const FROM_VALUES = [...FROM_VOCABS] as const;
const TOPIC_VALUES_ARR = [...TOPIC_VALUES] as const;

export const FIND_EQUIVALENT_TOOLS = [
  {
    name: 'find_equivalent',
    description:
      'Translate a Fabric, NeoForge, or modern-Minecraft API/pattern to its Cleanroom/Forge-1.12.2 counterpart (or learn that none exists). This is the front door for cross-loader ports (from: fabric|neoforge) and backports (from: modern-minecraft). Paste the source-side API name or describe the pattern; results give the 1.12.2 target API, the change kind (direct/analog/pattern-change/missing), notes, code, and caveats. For "missing" topics (e.g. datagen) it honestly says there is no equivalent and gives the 1.12.2 idiom instead. Optionally narrow by topic.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Source-side API name or pattern words (e.g. "ServerPlayNetworking.registerGlobalReceiver", "DeferredRegister", "Codec", "capability"). May be empty when topic is set (browse mode).',
        },
        from: {
          type: 'string',
          enum: [...FROM_VALUES],
          description:
            'The source vocabulary: "fabric" or "neoforge" for cross-loader ports, "modern-minecraft" for backports. NOT a loader — it selects which side of the corpus to search.',
        },
        topic: {
          type: 'string',
          enum: [...TOPIC_VALUES_ARR],
          description:
            'Optional topic filter (e.g. "networking", "registration", "capabilities-attachments", "serialization-nbt-codecs").',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (1-50). Default: 15',
          minimum: 1,
          maximum: 50,
          default: 15,
        },
      },
      required: ['query', 'from'],
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

const NOT_PRESENT_MESSAGE =
  "The porting corpus isn't present in this `docs.db` build yet. The equivalence data ships " +
  'inside the documentation database and arrives with the next update.\n\n' +
  'Restart the server to auto-update, or run `cleanroom-modding-mcp manage` to refresh the ' +
  'databases. The standard tools (search_docs, explain_concept, search_cleanroom_api) still work ' +
  'for 1.12.2 guidance in the meantime.';

const FROM_SET: ReadonlySet<string> = new Set(FROM_VALUES);
const TOPIC_SET: ReadonlySet<string> = new Set(TOPIC_VALUES_ARR);

export interface FindEquivalentParams {
  query: string;
  from: (typeof FROM_VALUES)[number];
  topic?: string;
  limit?: number;
}

const KIND_BADGE: Record<string, string> = {
  direct: '🟢 direct',
  analog: '🟡 analog',
  'pattern-change': '🟠 pattern-change',
  missing: '🔴 missing',
};

function renderHit(m: EquivalenceMatch): string {
  let out = `### ${m.fromApi}\n`;
  out += `${KIND_BADGE[m.kind] ?? m.kind} · topic: ${m.topic} · from: ${m.fromVocab}`;
  if (m.fromEra) out += ` (${m.fromEra})`;
  out += '\n\n';

  out += `**Source:** \`${m.fromApi}\``;
  if (m.fromVersions) out += ` — ${m.fromVersions}`;
  out += '\n';
  if (m.fromApiAlt.length > 0) {
    out += `**Also written:** ${m.fromApiAlt.map((a) => `\`${a}\``).join(', ')}\n`;
  }

  if (m.kind === 'missing') {
    out += `**Target:** No 1.12.2 equivalent — use the idiom below instead.\n`;
  } else {
    out += `**Target (${m.toLoader}):** \`${m.toApi ?? ''}\`\n`;
  }

  if (m.notes) out += `\n${m.notes.trim()}\n`;

  if (m.codeBefore) {
    out += `\n**Before (${m.fromVocab}):**\n\`\`\`java\n${m.codeBefore.trimEnd()}\n\`\`\`\n`;
  }
  if (m.codeAfter) {
    out += `\n**After (1.12.2):**\n\`\`\`java\n${m.codeAfter.trimEnd()}\n\`\`\`\n`;
  }

  if (m.caveats.length > 0) {
    out += `\n**Caveats:**\n`;
    for (const c of m.caveats) out += `- ${c}\n`;
  }

  if (m.related.length > 0) {
    out += `\n**Related:** ${m.related.map((r) => `\`${r}\``).join(' · ')}\n`;
  }

  out += `\n*Citation: \`cleanroom://equivalence/${m.entryKey}\`*`;
  if (m.validatedAgainst) out += ` · validated against ${m.validatedAgainst}`;
  out += '\n';
  return out;
}

export function handleFindEquivalent(params: FindEquivalentParams): CallToolResult {
  const from = params.from;
  if (!FROM_SET.has(from)) {
    return {
      content: [
        {
          type: 'text',
          text: `Invalid "from" value. Use one of: ${[...FROM_VALUES].join(', ')}.`,
        },
      ],
      isError: true,
    };
  }
  if (params.topic !== undefined && !TOPIC_SET.has(params.topic)) {
    return {
      content: [
        {
          type: 'text',
          text: `Invalid "topic" value. Use one of: ${[...TOPIC_VALUES_ARR].join(', ')}.`,
        },
      ],
      isError: true,
    };
  }

  const limit = Math.min(Math.max(params.limit || 15, 1), 50);
  const service = new EquivalenceService();
  try {
    if (!service.isCorpusPresent()) {
      return { content: [{ type: 'text', text: NOT_PRESENT_MESSAGE }] };
    }

    const matches = service.search({
      query: params.query || '',
      fromVocab: from,
      topic: params.topic,
      limit,
    });

    if (matches.length === 0) {
      const scope = params.topic ? ` in topic "${params.topic}"` : '';
      let text = `Found 0 equivalents for "${params.query}" (from: ${from})${scope}.\n\n`;
      text += '**Suggestions:**\n';
      text += '- Paste the exact source API name (class or method), not a sentence.\n';
      text += '- Drop the `topic` filter to widen the search.\n';
      text += '- Try the porting guide: `get_porting_guide` / `cleanroom://guide/*`.\n';
      return { content: [{ type: 'text', text }] };
    }

    let text = `Found ${matches.length} equivalent${matches.length === 1 ? '' : 's'} for "${params.query}" (from: ${from})`;
    text += params.topic ? ` in topic "${params.topic}"` : '';
    text += ':\n\n';
    text += matches.map(renderHit).join('\n---\n\n');
    text += `\n\n*Next: scaffold with \`get_project_template\`, verify symbols with \`search_cleanroom_api\` / \`resolve_symbol\`.*`;

    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `find_equivalent failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  } finally {
    service.close();
  }
}
