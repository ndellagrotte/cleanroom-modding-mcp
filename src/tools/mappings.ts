/**
 * Mappings Tools - Query Minecraft class/method/field mappings.
 * Two eras in one database: 1.12.2 MCP/SRG (the Cleanroom target, default) and
 * modern Parchment/Mojang versions (backport reference).
 */

import { MappingsService, type MappingSearchResult } from '../services/mappings-service.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS (for registration)
// ═══════════════════════════════════════════════════════════════════════════════

export const MAPPINGS_TOOLS = [
  {
    name: 'search_mappings',
    description:
      'Search Minecraft class, method, and field mappings. Returns readable names, SRG names (1.12.2), obfuscated names, parameter names, and Javadoc. Defaults to Minecraft 1.12.2 (the Cleanroom/Forge target); modern versions are available as backport reference. SRG queries (func_/field_/p_ prefixes) are matched directly.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Search query - class name, method name, field name, or SRG name (e.g., "Block", "getStateFromMeta", "func_71410", "player")',
        },
        type: {
          type: 'string',
          enum: ['class', 'method', 'field', 'all'],
          description: 'Filter by mapping type. Default: all',
          default: 'all',
        },
        minecraft_version: {
          type: 'string',
          description:
            'Target Minecraft version. Defaults to 1.12.2 when indexed; modern versions (e.g., "1.21.4") remain queryable as backport reference.',
        },
        package_filter: {
          type: 'string',
          description:
            'Filter by package name (e.g., "net.minecraft.block", "net.minecraft.world")',
        },
        include_javadoc: {
          type: 'boolean',
          description: 'Include Javadoc documentation in results. Default: true',
          default: true,
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
    name: 'get_class_details',
    description:
      'Get detailed information about a specific Minecraft class including all its methods and fields with their parameter names and Javadocs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        class_name: {
          type: 'string',
          description: 'Full class name (e.g., "net.minecraft.block.Block" or just "Block")',
        },
        minecraft_version: {
          type: 'string',
          description: 'Target Minecraft version. Defaults to 1.12.2 when indexed.',
        },
        include_methods: {
          type: 'boolean',
          description: 'Include method details. Default: true',
          default: true,
        },
        include_fields: {
          type: 'boolean',
          description: 'Include field details. Default: true',
          default: true,
        },
      },
      required: ['class_name'],
    },
  },
  {
    name: 'resolve_symbol',
    description:
      'Resolve any Minecraft symbol from crash logs, decompiled code, or mixin targets to all its mapping layers (readable ⇄ SRG ⇄ obfuscated). Auto-detects the name kind: SRG names ("func_71410_x", "field_78443_a"), SRG parameter tokens ("p_70080_1_", "p_i46742_2_"), obfuscated notch tokens ("aab", "bhy$a"), or readable names ("Block", "net.minecraft.block.Block", "Block#getStateFromMeta"). The crash-log workhorse for 1.12.2 Cleanroom/Forge development.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        symbol: {
          type: 'string',
          description:
            'The symbol to resolve (e.g., "func_71410_x", "field_70170_p", "p_180495_1_", "aab", "Block#getStateFromMeta")',
        },
        minecraft_version: {
          type: 'string',
          description:
            'Target Minecraft version. SRG names imply 1.12.2; other kinds default to 1.12.2 then the newest modern version.',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_method_signature',
    description:
      'Get the full signature of a specific method including parameter names, types, and Javadoc. Useful when you need to understand how to call or override a Minecraft method.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        class_name: {
          type: 'string',
          description: 'The class containing the method',
        },
        method_name: {
          type: 'string',
          description: 'The method name to look up',
        },
        minecraft_version: {
          type: 'string',
          description: 'Target Minecraft version. Defaults to 1.12.2 when indexed.',
        },
      },
      required: ['class_name', 'method_name'],
    },
  },
  {
    name: 'list_mapping_versions',
    description:
      'List all Minecraft versions in the mappings database, labeled by mapping era: 1.12.2 MCP/SRG (the Cleanroom target and default) vs modern Parchment/Mojang (backport reference).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        include_stats: {
          type: 'boolean',
          description: 'Include detailed statistics. Default: false',
          default: false,
        },
      },
    },
  },
  {
    name: 'browse_package',
    description:
      'Browse classes in a specific Minecraft package. Useful for discovering available classes in a package.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        package_name: {
          type: 'string',
          description:
            'Package name to browse (e.g., "net.minecraft.block", "net.minecraftforge.event")',
        },
        minecraft_version: {
          type: 'string',
          description: 'Target Minecraft version. Defaults to 1.12.2 when indexed.',
        },
      },
      required: ['package_name'],
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

const NOT_INSTALLED_MESSAGE =
  'The mappings database is not installed. This optional database provides Minecraft class/method/field mappings — 1.12.2 MCP/SRG names (the Cleanroom target) plus modern Parchment/Mojang reference versions.\n\n' +
  'To install it, run: `cleanroom-modding-mcp manage` (download prebuilt, or build the 1.12.2 data locally with `cleanroom-modding-mcp manage --build-mappings`).\n\n' +
  'The standard documentation tools (search_docs, get_doc_snippet) are still available for modding guidance.';

const OUTDATED_SCHEMA_MESSAGE =
  'The installed mappings database uses an outdated schema and has been disabled.\n\n' +
  'It will be updated automatically on the next server startup, or update it now with: `cleanroom-modding-mcp manage`.';

function notAvailableResult(): CallToolResult {
  const text = MappingsService.isSchemaOutdated() ? OUTDATED_SCHEMA_MESSAGE : NOT_INSTALLED_MESSAGE;
  return { content: [{ type: 'text', text }] };
}

/** Render the readable/SRG/notch layers shared by several outputs. */
function formatNameLayers(result: MappingSearchResult): string {
  let output = '';
  if (result.srgName) {
    output += `**SRG:** \`${result.srgName}\`\n`;
  }
  if (result.notchName) {
    output += `**Obfuscated (notch):** \`${result.notchName}\`\n`;
  }
  return output;
}

export interface SearchMappingsParams {
  query: string;
  type?: 'class' | 'method' | 'field' | 'all';
  minecraft_version?: string;
  package_filter?: string;
  include_javadoc?: boolean;
  limit?: number;
}

export function handleSearchMappings(params: SearchMappingsParams): CallToolResult {
  try {
    if (!MappingsService.isAvailable()) {
      return notAvailableResult();
    }

    const service = new MappingsService();

    try {
      const results = service.search({
        query: params.query,
        type: params.type || 'all',
        minecraftVersion: params.minecraft_version,
        packageFilter: params.package_filter,
        includeJavadoc: params.include_javadoc !== false,
        limit: Math.min(Math.max(params.limit || 15, 1), 50),
      });

      if (results.length === 0) {
        const version = params.minecraft_version || service.getDefaultVersion() || 'unknown';
        let output = `No mappings found for "${params.query}" in Minecraft ${version}.\n\n`;
        output += '**Suggestions:**\n';
        output += '- Try a broader search term\n';
        output += '- Check the spelling of the class/method name\n';
        output += '- Try without the package filter\n';
        output += '- Use `list_mapping_versions` to see available versions\n';

        return { content: [{ type: 'text', text: output }] };
      }

      let output = `Found ${results.length} mapping${results.length > 1 ? 's' : ''} for "${params.query}":\n\n`;

      for (const result of results) {
        output += `### ${result.type.charAt(0).toUpperCase() + result.type.slice(1)}: \`${result.fullName}\`\n`;

        output += formatNameLayers(result);

        if (result.descriptor) {
          output += `**Descriptor:** \`${result.descriptor}\`\n`;
        }

        if (result.type === 'method' && result.parameters && result.parameters.length > 0) {
          output += `**Parameters:**\n`;
          for (const param of result.parameters) {
            output += `  - \`${param.name}\``;
            if (param.javadoc) {
              output += ` — ${param.javadoc}`;
            }
            output += '\n';
          }
        }

        if (result.javadoc) {
          output += `**Javadoc:** ${result.javadoc}\n`;
        }

        output += `**Version:** ${result.minecraftVersion}\n`;
        output += '\n---\n\n';
      }

      return { content: [{ type: 'text', text: output.trim() }] };
    } finally {
      service.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error searching mappings: ${message}` }],
      isError: true,
    };
  }
}

export interface GetClassDetailsParams {
  class_name: string;
  minecraft_version?: string;
  include_methods?: boolean;
  include_fields?: boolean;
}

export function handleGetClassDetails(params: GetClassDetailsParams): CallToolResult {
  try {
    if (!MappingsService.isAvailable()) {
      return notAvailableResult();
    }

    const service = new MappingsService();

    try {
      const cls = service.getClass(params.class_name, params.minecraft_version);

      if (!cls) {
        const version = params.minecraft_version || service.getDefaultVersion() || 'unknown';
        return {
          content: [
            {
              type: 'text',
              text: `Class "${params.class_name}" not found in Minecraft ${version} mappings.\n\nTry using \`search_mappings\` to find the correct class name.`,
            },
          ],
        };
      }

      let output = `# Class: \`${cls.packageName}.${cls.name}\`\n\n`;

      if (cls.notchName) {
        output += `**Obfuscated (notch):** \`${cls.notchName}\`\n`;
      }
      output += `**Package:** \`${cls.packageName}\`\n`;
      output += `**Version:** ${cls.minecraftVersion} (${cls.mappingSet === 'mcp' ? 'MCP/SRG' : 'Parchment/Mojang'})\n`;

      if (cls.javadoc) {
        output += `\n**Javadoc:**\n${cls.javadoc}\n`;
      }

      // Methods
      if (params.include_methods !== false) {
        const methods = service.getClassMethods(cls.id);
        output += `\n## Methods (${methods.length})\n\n`;

        if (methods.length === 0) {
          output += '_No methods with mappings found._\n';
        } else {
          for (const method of methods.slice(0, 30)) {
            // Limit to avoid huge outputs
            output += `### \`${method.name}\`\n`;
            output += `**Descriptor:** \`${method.descriptor}\`\n`;

            if (method.srgName) {
              output += `**SRG:** \`${method.srgName}\`\n`;
            }
            if (method.notchName) {
              output += `**Obfuscated (notch):** \`${method.notchName}\`\n`;
            }

            if (method.parameters.length > 0) {
              output += `**Parameters:**\n`;
              for (const param of method.parameters) {
                output += `  - \`${param.name}\``;
                if (param.javadoc) {
                  output += ` — ${param.javadoc}`;
                }
                output += '\n';
              }
            }

            if (method.javadoc) {
              output += `**Javadoc:** ${method.javadoc}\n`;
            }

            output += '\n';
          }

          if (methods.length > 30) {
            output += `\n_...and ${methods.length - 30} more methods. Use \`search_mappings\` with the class name to find specific methods._\n`;
          }
        }
      }

      // Fields
      if (params.include_fields !== false) {
        const fields = service.getClassFields(cls.id);
        output += `\n## Fields (${fields.length})\n\n`;

        if (fields.length === 0) {
          output += '_No fields with mappings found._\n';
        } else {
          for (const field of fields) {
            output += `- **\`${field.name}\`**`;
            if (field.descriptor) {
              output += ` (\`${field.descriptor}\`)`;
            }
            if (field.srgName) {
              output += ` — SRG: \`${field.srgName}\``;
            }
            if (field.notchName) {
              output += ` — notch: \`${field.notchName}\``;
            }
            if (field.javadoc) {
              output += `\n  ${field.javadoc}`;
            }
            output += '\n';
          }
        }
      }

      return { content: [{ type: 'text', text: output.trim() }] };
    } finally {
      service.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error getting class details: ${message}` }],
      isError: true,
    };
  }
}

export interface ResolveSymbolParams {
  symbol: string;
  minecraft_version?: string;
}

export function handleResolveSymbol(params: ResolveSymbolParams): CallToolResult {
  try {
    if (!MappingsService.isAvailable()) {
      return notAvailableResult();
    }

    const service = new MappingsService();

    try {
      const resolved = service.resolveSymbol(params.symbol, params.minecraft_version);

      if (!resolved.result) {
        let output = `# Symbol: \`${params.symbol}\`\n\n`;
        output += `**Detected kind:** ${resolved.kind}\n\n`;
        output += resolved.message ?? 'No match found.';
        return { content: [{ type: 'text', text: output.trim() }] };
      }

      const result = resolved.result;
      const mappingSet = service.getMappingSet(result.minecraftVersion);
      const eraLabel = mappingSet === 'mcp' ? 'MCP stable_39 / SRG' : 'Parchment/Mojang';

      let output = `# Symbol: \`${params.symbol}\`\n\n`;
      output += `**Type:** ${result.type}\n`;
      output += `**Readable:** \`${result.fullName}\`\n`;
      output += formatNameLayers(result);
      output += `**Version:** ${result.minecraftVersion} (${eraLabel})\n`;

      if (result.descriptor) {
        output += `**Descriptor:** \`${result.descriptor}\`\n`;
      }

      if (resolved.message) {
        output += `\n_${resolved.message}_\n`;
      }

      if (result.parameters && result.parameters.length > 0) {
        output += `\n**Parameters${result.type === 'parameter' ? ' (of the owning method)' : ''}:**\n`;
        for (const param of result.parameters) {
          output += `  - \`${param.name}\``;
          if (param.srgToken && param.srgToken !== param.name) {
            output += ` (\`${param.srgToken}\`)`;
          }
          if (param.javadoc) {
            output += ` — ${param.javadoc}`;
          }
          output += '\n';
        }
      }

      if (result.javadoc) {
        output += `\n**Javadoc:**\n${result.javadoc}\n`;
      }

      return { content: [{ type: 'text', text: output.trim() }] };
    } finally {
      service.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error resolving symbol: ${message}` }],
      isError: true,
    };
  }
}

export interface GetMethodSignatureParams {
  class_name: string;
  method_name: string;
  minecraft_version?: string;
}

export function handleGetMethodSignature(params: GetMethodSignatureParams): CallToolResult {
  try {
    if (!MappingsService.isAvailable()) {
      return notAvailableResult();
    }

    const service = new MappingsService();

    try {
      const methods = service.getMethods(
        params.class_name,
        params.method_name,
        params.minecraft_version
      );

      if (methods.length === 0) {
        const version = params.minecraft_version || service.getDefaultVersion() || 'unknown';
        return {
          content: [
            {
              type: 'text',
              text: `Method "${params.method_name}" not found in class "${params.class_name}" for Minecraft ${version}.\n\nTry using \`search_mappings\` to find the correct method name.`,
            },
          ],
        };
      }

      const first = methods[0]!;
      // A simple class name can match same-named classes in different
      // packages — label each entry with its class when that happens.
      const classCount = new Set(methods.map((m) => `${m.className}#${m.classId}`)).size;
      let output = `# Method: \`${first.className}.${first.name}\`\n\n`;
      if (methods.length > 1) {
        output += `_${methods.length} matching method${methods.length > 1 ? 's' : ''}`;
        if (classCount > 1) {
          output += ` across ${classCount} classes named "${params.class_name}"`;
        }
        output += `${methods.length > 10 ? '; showing the first 10' : ''}._\n\n`;
      }

      for (const method of methods.slice(0, 10)) {
        if (methods.length > 1) {
          output +=
            classCount > 1
              ? `## \`${method.className}.${method.name}\` — \`${method.descriptor}\`\n\n`
              : `## Overload \`${method.descriptor}\`\n\n`;
        }
        output += `**Descriptor:** \`${method.descriptor}\`\n`;

        if (method.srgName) {
          output += `**SRG:** \`${method.srgName}\`\n`;
        }
        if (method.notchName) {
          output += `**Obfuscated (notch):** \`${method.notchName}\`\n`;
        }

        output += `**Version:** ${method.minecraftVersion}\n`;

        if (method.parameters.length > 0) {
          output += `\n**Parameters:**\n`;
          for (const param of method.parameters) {
            output += `- **\`${param.name}\`** (index ${param.index})`;
            if (param.srgToken && param.srgToken !== param.name) {
              output += ` — \`${param.srgToken}\``;
            }
            if (param.javadoc) {
              output += `\n  ${param.javadoc}`;
            }
            output += '\n';
          }
        } else {
          output += '\n_No parameter names available for this overload._\n';
        }

        if (method.javadoc) {
          output += `\n**Javadoc:**\n${method.javadoc}\n`;
        }
        output += '\n';
      }

      if (methods.length > 10) {
        output += `_...and ${methods.length - 10} more overloads._\n`;
      }

      return { content: [{ type: 'text', text: output.trim() }] };
    } finally {
      service.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error getting method signature: ${message}` }],
      isError: true,
    };
  }
}

export interface ListMappingVersionsParams {
  include_stats?: boolean;
}

export function handleListMappingVersions(params: ListMappingVersionsParams): CallToolResult {
  try {
    if (!MappingsService.isAvailable()) {
      return notAvailableResult();
    }

    const service = new MappingsService();

    try {
      const versionInfo = service.getVersionInfo();

      if (versionInfo.length === 0) {
        return {
          content: [
            { type: 'text', text: 'No Minecraft versions found in the mappings database.' },
          ],
        };
      }

      const defaultVersion = service.getDefaultVersion();
      let output = `# Available Minecraft Versions\n\n`;
      output += `Found ${versionInfo.length} version${versionInfo.length > 1 ? 's' : ''}:\n\n`;

      for (const info of versionInfo) {
        const era =
          info.mappingSet === 'mcp'
            ? 'MCP/SRG — Cleanroom/Forge target'
            : 'Parchment/Mojang — backport reference';
        output += `- **${info.minecraftVersion}** — ${era} (${info.classCount.toLocaleString()} classes)`;
        if (info.minecraftVersion === defaultVersion) {
          output += ' _(default)_';
        }
        output += '\n';
      }

      if (params.include_stats) {
        const stats = service.getStats();
        output += `\n## Database Statistics\n\n`;
        output += `- **Total Classes:** ${stats.totalClasses.toLocaleString()}\n`;
        output += `- **Total Methods:** ${stats.totalMethods.toLocaleString()}\n`;
        output += `- **Total Fields:** ${stats.totalFields.toLocaleString()}\n`;
        output += `- **Total Parameters:** ${stats.totalParameters.toLocaleString()}\n`;
        output += `- **Documented Methods:** ${stats.documentedMethods.toLocaleString()}\n`;
        output += `- **Documented Fields:** ${stats.documentedFields.toLocaleString()}\n`;

        if (stats.topPackages.length > 0) {
          output += `\n### Top Packages\n\n`;
          for (const pkg of stats.topPackages) {
            output += `- \`${pkg.packageName}\` (${pkg.count} classes)\n`;
          }
        }
      }

      return { content: [{ type: 'text', text: output.trim() }] };
    } finally {
      service.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error listing mapping versions: ${message}` }],
      isError: true,
    };
  }
}

export interface BrowsePackageParams {
  package_name: string;
  minecraft_version?: string;
}

export function handleBrowsePackage(params: BrowsePackageParams): CallToolResult {
  try {
    if (!MappingsService.isAvailable()) {
      return notAvailableResult();
    }

    const service = new MappingsService();

    try {
      const classes = service.getClassesInPackage(params.package_name, params.minecraft_version);
      const version = params.minecraft_version || service.getDefaultVersion() || 'unknown';

      if (classes.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No classes found in package "${params.package_name}" for Minecraft ${version}.\n\nTry a broader package name or check the spelling.`,
            },
          ],
        };
      }

      let output = `# Package: \`${params.package_name}\`\n\n`;
      output += `Found ${classes.length} class${classes.length > 1 ? 'es' : ''} in Minecraft ${version}:\n\n`;

      // Group by sub-package
      const bySubPackage = new Map<string, typeof classes>();
      for (const cls of classes) {
        const subPkg = cls.packageName;
        if (!bySubPackage.has(subPkg)) {
          bySubPackage.set(subPkg, []);
        }
        bySubPackage.get(subPkg)!.push(cls);
      }

      for (const [pkg, pkgClasses] of Array.from(bySubPackage.entries()).sort()) {
        if (bySubPackage.size > 1) {
          output += `## \`${pkg}\`\n\n`;
        }

        for (const cls of pkgClasses.slice(0, 50)) {
          output += `- **\`${cls.name}\`**`;
          output += ` — ${cls.methodCount} methods, ${cls.fieldCount} fields`;
          if (cls.javadoc) {
            const shortDoc =
              cls.javadoc.length > 100 ? cls.javadoc.substring(0, 100) + '...' : cls.javadoc;
            output += `\n  _${shortDoc}_`;
          }
          output += '\n';
        }

        if (pkgClasses.length > 50) {
          output += `\n_...and ${pkgClasses.length - 50} more classes._\n`;
        }

        output += '\n';
      }

      output += `\nUse \`get_class_details\` to see the full details of a specific class.`;

      return { content: [{ type: 'text', text: output.trim() }] };
    } finally {
      service.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error browsing package: ${message}` }],
      isError: true,
    };
  }
}
