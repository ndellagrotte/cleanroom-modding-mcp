/**
 * list_targets — the agent's orientation call.
 * Reports the loader/version matrix (which loaders are development targets vs
 * porting reference), the indexed documentation versions, and which optional
 * databases are installed. Replaces the old get_minecraft_version tool.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { LOADERS, LOADER_IDS, TARGET_VERSION, type Scope } from '../loaders.js';
import type { DocCoverage } from '../services/corpus-coverage.js';
import { DBS, DB_IDS, dbPath, isInstalled } from '../dbs.js';
import { readDbSchemaVersion } from '../mappings/schema.js';
import { CleanroomApiService } from '../services/cleanroom-api-service.js';
import { ExampleService } from '../services/example-service.js';
import { MappingsService } from '../services/mappings-service.js';
import { ModExamplesService } from '../services/mod-examples-service.js';
import { EquivalenceService } from '../services/equivalence-service.js';
import { TEMPLATE_COMPONENTS } from '../templates/index.js';
import { GUIDE_NAMES } from '../guides/index.js';
import { PROMPT_DEFS } from '../prompts.js';

export function handleListTargets(): CallToolResult {
  try {
    let output = '## Development Targets\n\n';
    output += `This server helps you build **Cleanroom / Forge mods for Minecraft ${TARGET_VERSION}**. `;
    output += 'Fabric and NeoForge corpora are retained as porting reference.\n\n';

    // Document counts per scope, so the corpus asymmetry is visible before the
    // first search rather than inferred from thin results afterwards.
    // Best effort — orientation output must never fail on a missing DB.
    let scopes: Partial<Record<Scope, DocCoverage>>;
    try {
      const exampleService = new ExampleService();
      scopes = {
        target: exampleService.getCoverage({ scope: 'target' }),
        reference: exampleService.getCoverage({ scope: 'reference' }),
        all: exampleService.getCoverage({ scope: 'all' }),
      };
      exampleService.close();
    } catch {
      scopes = {};
    }

    const docsFor = (id: string): string => {
      const row = scopes.all?.loaders.find((l) => l.loader === id);
      return row ? String(row.count) : '—';
    };

    output += '| Loader | Role | Default version | Indexed docs |\n|---|---|---|---|\n';
    for (const id of LOADER_IDS) {
      const info = LOADERS[id];
      const version = info.defaultVersion ?? 'latest indexed';
      output += `| ${info.displayName} (\`${id}\`) | ${info.role} | ${version} | ${docsFor(id)} |\n`;
    }

    const reach = (scope: Scope): string =>
      scopes[scope] ? ` — **${scopes[scope].inScope} documents**` : '';

    output += '\n**Scopes** (accepted by `search_docs` / `get_doc_snippet`):\n';
    output += `- \`target\` (default) — Cleanroom + Forge + loader-agnostic content at ${TARGET_VERSION}${reach('target')}\n`;
    output += `- \`reference\` — Fabric + NeoForge porting material${reach('reference')}\n`;
    output += `- \`all\` — everything, for comparative work${reach('all')}\n`;

    const target = scopes.target;
    if (target) {
      output += `\n⚠️ The ${TARGET_VERSION} documentation corpus is small: ${target.inScope} scraped pages `;
      output += `against ${target.corpusDocuments} indexed overall. Treat \`search_mod_examples\` as the `;
      output += `primary source for ${TARGET_VERSION} implementation patterns and \`search_docs\` / `;
      output += '`get_doc_snippet` as the supplement for prose and concepts.\n';

      const populated = target.categories
        .filter((c) => c.inEnum && c.count > 0)
        .sort((a, b) => b.count - a.count);
      if (populated.length > 0) {
        output += `\n**${TARGET_VERSION} documentation by category:** `;
        output += populated.map((c) => `${c.category} ${c.count}`).join(', ') + '.\n';
      }
      if (target.emptyCategories.length > 0) {
        // Offered as `category` values but backed by nothing at this scope, so
        // filtering by one can never match — say so before an agent tries.
        output += `**No ${TARGET_VERSION} documents:** ${target.emptyCategories.join(', ')} `;
        output += '— accepted by the `category` filter but unable to return results here.\n';
      }
      if (target.versions.length > 0) {
        output += `\n**Indexed documentation versions:** \`target\` ${target.versions.join(', ')}`;
        const referenceVersions = scopes.reference?.versions ?? [];
        if (referenceVersions.length > 0) {
          output += ` · \`reference\` ${referenceVersions.slice(0, 6).join(', ')}`;
          output += referenceVersions.length > 6 ? ', …' : '';
        }
        output += '\n';
      }
    } else {
      output += '\n**Indexed documentation versions:** docs database not installed yet\n';
    }

    // Best effort — orientation output must never fail on a service hiccup
    let mappingsOutdated = false;
    try {
      mappingsOutdated = MappingsService.isSchemaOutdated();
    } catch {
      mappingsOutdated = false;
    }
    const docsOutdated =
      isInstalled('docs') && readDbSchemaVersion(dbPath('docs')) !== DBS.docs.schemaVersion;
    let cleanroomApiOutdated = false;
    try {
      cleanroomApiOutdated = CleanroomApiService.isSchemaOutdated();
    } catch {
      cleanroomApiOutdated = false;
    }
    let examplesOutdated = false;
    try {
      examplesOutdated = ModExamplesService.isSchemaOutdated();
    } catch {
      examplesOutdated = false;
    }

    output += '\n## Installed Databases\n\n';
    for (const id of DB_IDS) {
      const spec = DBS[id];
      let status: string;
      if (id === 'docs' && docsOutdated) {
        status =
          '⚠️ installed but schema-outdated (documentation tools may be unavailable; updates on next startup)';
      } else if (id === 'mappings' && mappingsOutdated) {
        // File exists but the schema gate disabled it — "installed" would lie.
        status =
          '⚠️ installed but schema-outdated (mappings tools disabled; updates on next startup, or run `cleanroom-modding-mcp manage`)';
      } else if (id === 'cleanroom-api' && cleanroomApiOutdated) {
        status =
          '⚠️ installed but schema-outdated (Cleanroom API tools disabled; updates on next startup, or run `cleanroom-modding-mcp manage`)';
      } else if (id === 'examples' && examplesOutdated) {
        status =
          '⚠️ installed but schema-outdated (mod examples tools disabled; updates on next startup, or run `cleanroom-modding-mcp manage`)';
      } else if (isInstalled(id)) {
        status = '✅ installed';
      } else {
        status = '⬜ not installed (downloads automatically on startup)';
      }
      output += `- ${spec.icon} **${spec.name}** — ${status}\n`;
    }

    // Phase 4 porting/scaffolding surfaces (prompts, resources, templates, equivalence).
    let corpusPresent = false;
    try {
      const eq = new EquivalenceService();
      corpusPresent = eq.isCorpusPresent();
      eq.close();
    } catch {
      corpusPresent = false;
    }

    output += '\n## Porting & Scaffolding\n\n';
    output += '**Prompts** (workflow openers): ';
    output += PROMPT_DEFS.map((p) => `\`${p.name}\``).join(', ') + '\n\n';

    output += '**Resources** (whole-file artifacts, each with a tool twin):\n';
    output += `- \`cleanroom://template/{${TEMPLATE_COMPONENTS.join(', ')}}\` — mirrored by \`get_project_template\`\n`;
    output += `- \`cleanroom://guide/{${GUIDE_NAMES.join(', ')}}\` — mirrored by \`get_porting_guide\`\n\n`;

    output += `**Templates:** ${TEMPLATE_COMPONENTS.length} scaffolding files via \`get_project_template(component)\`.\n\n`;

    output += '**Equivalence corpus:** ';
    output += corpusPresent
      ? '✅ present — query with `find_equivalent(query, from)`.\n'
      : '⬜ not present in this docs.db yet (updates on startup; `find_equivalent` degrades gracefully).\n';
    output += 'find_equivalent from-vocabulary: `fabric`, `neoforge`, `modern-minecraft` ';
    output += '(a source vocabulary for translation — not a build target).\n';

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
