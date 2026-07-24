/**
 * Cleanroom API Tools - Search the Cleanroom/Forge framework API surface.
 * Backed by cleanroom-api.db: symbols extracted from the published Cleanroom
 * sources jar, with first-class events and annotations catalogs.
 */

import {
  CleanroomApiService,
  type ApiClassDetails,
  type ApiSearchKind,
} from '../services/cleanroom-api-service.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS (for registration)
// ═══════════════════════════════════════════════════════════════════════════════

/** Valid `kind` values; the inputSchema and the runtime guard share this list. */
const KIND_VALUES = [
  'class',
  'interface',
  'enum',
  'annotation',
  'record',
  'event',
  'method',
  'field',
  'constructor',
  'all',
] as const;

export const CLEANROOM_API_TOOLS = [
  {
    name: 'search_cleanroom_api',
    description:
      'Search the Cleanroom/Forge framework API (com.cleanroommc.*, zone.rong.mixinbooter.*, net.minecraftforge.*): classes, interfaces, enums, annotations (@Mod, @SubscribeEvent, @ObjectHolder, ...), the events catalog (subclasses of the Forge event bus Event, with cancelable/result flags), methods and fields — with signatures, deprecation status, and Javadoc from the pinned Cleanroom sources. Vanilla net.minecraft.* symbols live in the mappings tools (search_mappings, resolve_symbol) instead. Use kind:"event" for the events catalog, kind:"annotation" for the annotations catalog; an empty query with package_filter and/or kind browses.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Symbol name or words (e.g., "RegistryEvent", "right click block", "SubscribeEvent", "EnumHackery"). May be empty when package_filter or kind is set (browse mode).',
        },
        package_filter: {
          type: 'string',
          description:
            'Package prefix filter (e.g., "net.minecraftforge.event", "zone.rong.mixinbooter", "com.cleanroommc.hackery")',
        },
        kind: {
          type: 'string',
          enum: [...KIND_VALUES],
          description:
            'Filter by symbol kind. "event" searches the events catalog; "annotation" the annotations catalog. Default: all',
          default: 'all',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (1-50). Default: 15',
          minimum: 1,
          maximum: 50,
          default: 15,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_api_class',
    description:
      'Get full details for one Cleanroom/Forge framework type: declaration, Javadoc, deprecation, members with signatures (long member lists are truncated with an overflow note), nested types, superclass chain, and known subclasses (capped, with the total). For events it shows cancelable/result status. Companion to search_cleanroom_api; for vanilla net.minecraft.* classes use get_class_details instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description:
            'Fully qualified or simple type name (e.g., "net.minecraftforge.fml.common.Mod", "PlayerInteractEvent.RightClickBlock", "EnumHackery")',
        },
        include_members: {
          type: 'boolean',
          description: 'Include the member listing. Default: true',
          default: true,
        },
      },
      required: ['name'],
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

const NOT_INSTALLED_MESSAGE =
  'The Cleanroom API database is not installed. This optional database indexes the Cleanroom/Forge framework API surface (com.cleanroommc.*, zone.rong.mixinbooter.*, net.minecraftforge.*) — classes, events, annotations, signatures, and Javadoc.\n\n' +
  'To install it, run: `npx cleanroom-modding-mcp manage`.\n\n' +
  'The standard documentation tools (search_docs, get_example) are still available for modding guidance.';

const OUTDATED_SCHEMA_MESSAGE =
  'The installed Cleanroom API database uses an outdated schema and has been disabled.\n\n' +
  'It is replaced automatically on startup once a release carries the updated database; you can also reinstall it with `npx cleanroom-modding-mcp manage`.';

function notAvailableResult(): CallToolResult {
  const text = CleanroomApiService.isSchemaOutdated()
    ? OUTDATED_SCHEMA_MESSAGE
    : NOT_INSTALLED_MESSAGE;
  return { content: [{ type: 'text', text }] };
}

/** Badge line shared by search hits and details: kind, event flags, loader, deprecation. */
function formatBadges(result: {
  kind: string;
  loader: string;
  isEvent: boolean;
  isCancelable: boolean;
  hasResult: boolean;
  isDeprecated: boolean;
  deprecationNote: string | null;
  since: string | null;
}): string {
  let output = '';
  const badges: string[] = [];
  if (result.isEvent) {
    badges.push('**Event**');
    if (result.isCancelable) {
      badges.push('Cancelable');
    }
    if (result.hasResult) {
      badges.push('HasResult');
    }
  }
  badges.push(`[${result.loader}]`);
  if (result.since) {
    badges.push(`since ${result.since}`);
  }
  output += `${badges.join(' · ')}\n`;
  if (result.isDeprecated) {
    output += `**DEPRECATED**${result.deprecationNote ? ` — ${result.deprecationNote}` : ''}\n`;
  }
  return output;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Runtime guard mirroring the inputSchema enum (the CallTool dispatch casts). */
const VALID_KINDS: ReadonlySet<string> = new Set(KIND_VALUES);

export interface SearchCleanroomApiParams {
  query: string;
  package_filter?: string;
  kind?: ApiSearchKind;
  limit?: number;
}

export function handleSearchCleanroomApi(params: SearchCleanroomApiParams): CallToolResult {
  try {
    if (!CleanroomApiService.isAvailable()) {
      return notAvailableResult();
    }

    // LIKE-wildcard-only input ('%', '_') counts as an empty query (browse
    // mode), matching the service's normalization — otherwise it would bypass
    // the empty-query gate below.
    const rawQuery = (params.query || '').trim();
    const query = rawQuery.replace(/[%_]/g, '').trim() === '' ? '' : rawQuery;
    const kind = params.kind || 'all';
    if (!VALID_KINDS.has(kind)) {
      return {
        content: [
          {
            type: 'text',
            text: `Unknown kind "${String(kind)}". Valid kinds: ${[...VALID_KINDS].join(', ')}.`,
          },
        ],
      };
    }
    if (!query && !params.package_filter && kind === 'all') {
      return {
        content: [
          {
            type: 'text',
            text: 'Provide a query, or browse by setting package_filter and/or kind (e.g., kind:"event" lists the events catalog).',
          },
        ],
      };
    }

    const service = new CleanroomApiService();
    try {
      const limit = Math.min(Math.max(params.limit || 15, 1), 50);
      const results = service.search({
        query,
        packageFilter: params.package_filter,
        kind,
        limit,
      });

      if (results.length === 0) {
        let output = 'No framework API symbols found';
        if (query) {
          output += ` for "${query}"`;
        }
        if (params.package_filter) {
          output += ` in package ${params.package_filter}`;
        }
        if (kind !== 'all') {
          output += ` (kind: ${kind})`;
        }
        output += '.\n\n**Suggestions:**\n';
        output += '- Try a broader or camel-split term (e.g., "registry event")\n';
        output += '- Drop the package_filter or kind filter\n';
        output +=
          '- Vanilla net.minecraft.* symbols live in the mappings tools (`search_mappings`)\n';
        return { content: [{ type: 'text', text: output }] };
      }

      let output = `Found ${results.length} framework API symbol${results.length > 1 ? 's' : ''}`;
      output += query ? ` for "${query}":\n\n` : ' (browse):\n\n';
      if (results.length === limit) {
        output += query
          ? `_Showing the first ${limit} by relevance — refine the query or raise \`limit\` for more._\n\n`
          : `_Showing the first ${limit} alphabetically — add a query to rank by relevance, or raise \`limit\` for more._\n\n`;
      }

      for (const result of results) {
        if (result.resultKind === 'type') {
          output += `### ${capitalize(result.kind)}: \`${result.fqn}\`\n`;
          output += formatBadges(result);
          output += `\`\`\`java\n${result.signature}\n\`\`\`\n`;
          if (result.usageCount != null && result.kind === 'annotation') {
            output += `**Usage in corpus:** ${result.usageCount} declaration${result.usageCount === 1 ? '' : 's'}\n`;
          }
          if (result.javadocSummary) {
            output += `${result.javadocSummary}\n`;
          }
        } else {
          output += `### ${capitalize(result.memberKind)}: \`${result.declaringFqn}#${result.name}\`\n`;
          if (result.isDeprecated) {
            output += `**DEPRECATED**${result.deprecationNote ? ` — ${result.deprecationNote}` : ''}\n`;
          }
          if (result.since) {
            output += `since ${result.since}\n`;
          }
          output += `\`\`\`java\n${result.signature}\n\`\`\`\n`;
          if (result.javadocSummary) {
            output += `${result.javadocSummary}\n`;
          }
        }
        output += '\n---\n\n';
      }

      output += '_Use `get_api_class` for full member listings and hierarchy._';
      return { content: [{ type: 'text', text: output.trim() }] };
    } finally {
      service.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error searching Cleanroom API: ${message}` }],
      isError: true,
    };
  }
}

export interface GetApiClassParams {
  name: string;
  include_members?: boolean;
}

function formatDetails(details: ApiClassDetails, includeMembers: boolean): string {
  let output = `# ${capitalize(details.kind)}: \`${details.fqn}\`\n\n`;
  output += formatBadges(details);
  output += `\`\`\`java\n${details.signature}\n\`\`\`\n`;
  output += `**Package:** \`${details.packageName}\` · **Source:** \`${details.sourceFile}\`\n\n`;

  if (details.javadoc) {
    output += `${details.javadoc}\n\n`;
  }

  if (details.ancestors.length > 0) {
    const chain = [
      `\`${details.simpleName}\``,
      ...details.ancestors.map((a) => (a.external ? `\`${a.fqn}\` _(external)_` : `\`${a.fqn}\``)),
    ];
    output += `**Hierarchy:** ${chain.join(' → ')}\n`;
  }
  if (details.implementsRaw.length > 0) {
    output += `**${details.kind === 'interface' ? 'Extends' : 'Implements'}:** ${details.implementsRaw
      .map((i) => `\`${i}\``)
      .join(', ')}\n`;
  }
  output += '\n';

  if (includeMembers && details.members.length > 0) {
    const groups = new Map<string, typeof details.members>();
    for (const member of details.members) {
      const list = groups.get(member.kind) ?? [];
      list.push(member);
      groups.set(member.kind, list);
    }
    const groupTitles: Record<string, string> = {
      constructor: 'Constructors',
      annotation_element: 'Annotation elements',
      enum_constant: 'Enum constants',
      method: 'Methods',
      field: 'Fields',
    };
    for (const [kind, members] of groups) {
      output += `## ${groupTitles[kind] ?? capitalize(kind)}\n`;
      for (const member of members) {
        output += `- \`${member.signature}\``;
        if (member.isDeprecated) {
          output += ` **DEPRECATED**${member.deprecationNote ? ` — ${member.deprecationNote}` : ''}`;
        }
        if (member.javadocSummary) {
          output += ` — ${member.javadocSummary}`;
        }
        output += '\n';
      }
      output += '\n';
    }
    if (details.memberCount > details.members.length) {
      output += `_${details.memberCount - details.members.length} more member${
        details.memberCount - details.members.length === 1 ? '' : 's'
      } not shown — narrow with \`search_cleanroom_api\`._\n\n`;
    }
  }

  if (details.nestedTypes.length > 0) {
    output += `**Nested types:** ${details.nestedTypes.map((n) => `\`${n}\``).join(', ')}\n\n`;
  }
  if (details.knownSubclasses.length > 0) {
    output += `**Known subclasses:** ${details.knownSubclasses.map((s) => `\`${s}\``).join(', ')}\n`;
    if (details.subclassCount > details.knownSubclasses.length) {
      output += `_…and ${details.subclassCount - details.knownSubclasses.length} more — find them with \`search_cleanroom_api\`._\n`;
    }
  }

  return output.trim();
}

export function handleGetApiClass(params: GetApiClassParams): CallToolResult {
  try {
    if (!CleanroomApiService.isAvailable()) {
      return notAvailableResult();
    }
    if (!params.name || !params.name.trim()) {
      return {
        content: [{ type: 'text', text: 'Provide a type name (FQN or simple name).' }],
      };
    }

    const service = new CleanroomApiService();
    try {
      const includeMembers = params.include_members !== false;
      const lookup = service.getTypeByName(params.name, includeMembers ? 40 : 0);

      if (!lookup.match) {
        if (lookup.candidates.length > 0) {
          let output = `Multiple framework types match "${params.name}" — use the full name:\n\n`;
          for (const candidate of lookup.candidates) {
            output += `- \`${candidate}\`\n`;
          }
          return { content: [{ type: 'text', text: output }] };
        }
        let output = `No framework type named "${params.name}" found.\n\n`;
        output += '**Suggestions:**\n';
        output += '- Search first: `search_cleanroom_api` with a partial name\n';
        output +=
          '- Vanilla net.minecraft.* classes live in the mappings tools (`get_class_details`)\n';
        return { content: [{ type: 'text', text: output }] };
      }

      return {
        content: [{ type: 'text', text: formatDetails(lookup.match, includeMembers) }],
      };
    } finally {
      service.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error getting API class details: ${message}` }],
      isError: true,
    };
  }
}
