/**
 * list_targets — the agent's orientation call.
 * Reports the loader/version matrix (which loaders are development targets vs
 * porting reference), the indexed documentation versions, and which optional
 * databases are installed. Replaces the old get_minecraft_version tool.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { LOADERS, LOADER_IDS, TARGET_VERSION } from '../loaders.js';
import { DBS, DB_IDS, isInstalled } from '../dbs.js';
import { CleanroomApiService } from '../services/cleanroom-api-service.js';
import { ExampleService } from '../services/example-service.js';
import { MappingsService } from '../services/mappings-service.js';

export function handleListTargets(): CallToolResult {
  try {
    let output = '## Development Targets\n\n';
    output += `This server helps you build **Cleanroom / Forge mods for Minecraft ${TARGET_VERSION}**. `;
    output += 'Fabric and NeoForge corpora are retained as porting reference.\n\n';

    output += '| Loader | Role | Default version |\n|---|---|---|\n';
    for (const id of LOADER_IDS) {
      const info = LOADERS[id];
      const version = info.defaultVersion ?? 'latest indexed';
      output += `| ${info.displayName} (\`${id}\`) | ${info.role} | ${version} |\n`;
    }

    output += '\n**Scopes** (accepted by `search_docs` / `get_example`):\n';
    output += `- \`target\` (default) — Cleanroom + Forge + loader-agnostic content at ${TARGET_VERSION}\n`;
    output += '- `reference` — Fabric + NeoForge porting material\n';
    output += '- `all` — everything, for comparative work\n';

    // Indexed documentation versions (best effort — docs DB may be absent)
    try {
      const exampleService = new ExampleService();
      const topics = exampleService.getAvailableTopics();
      exampleService.close();
      if (topics.versions.length > 0) {
        output += `\n**Indexed documentation versions:** ${topics.versions.join(', ')}\n`;
      }
    } catch {
      output += '\n**Indexed documentation versions:** docs database not installed yet\n';
    }

    // Best effort — orientation output must never fail on a service hiccup
    let mappingsOutdated = false;
    try {
      mappingsOutdated = MappingsService.isSchemaOutdated();
    } catch {
      mappingsOutdated = false;
    }
    let cleanroomApiOutdated = false;
    try {
      cleanroomApiOutdated = CleanroomApiService.isSchemaOutdated();
    } catch {
      cleanroomApiOutdated = false;
    }

    output += '\n## Installed Databases\n\n';
    for (const id of DB_IDS) {
      const spec = DBS[id];
      let status: string;
      if (id === 'mappings' && mappingsOutdated) {
        // File exists but the schema gate disabled it — "installed" would lie.
        status =
          '⚠️ installed but schema-outdated (mappings tools disabled; updates on next startup, or run `npx cleanroom-modding-mcp manage`)';
      } else if (id === 'cleanroom-api' && cleanroomApiOutdated) {
        status =
          '⚠️ installed but schema-outdated (Cleanroom API tools disabled; updates on next startup, or run `npx cleanroom-modding-mcp manage`)';
      } else if (isInstalled(id)) {
        status = '✅ installed';
      } else {
        status = spec.required
          ? '⬜ not installed (downloads automatically on startup)'
          : '⬜ not installed (`npx cleanroom-modding-mcp manage` to add)';
      }
      output += `- ${spec.icon} **${spec.name}** — ${status}\n`;
    }

    return {
      content: [{ type: 'text', text: output }],
    };
  } catch (error) {
    console.error('[list_targets] Error:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error listing targets: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
      ],
      isError: true,
    };
  }
}
