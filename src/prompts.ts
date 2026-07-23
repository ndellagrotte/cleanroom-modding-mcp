/**
 * MCP prompts for the Phase 4 porting workflows (DESIGN §8).
 *
 * Three prompts, each returning a GetPromptResult whose messages embed the relevant
 * cleanroom:// resource (spec-blessed `type: 'resource'` embedded content) plus a text
 * message laying out the tool plan. Arguments are few, flat strings (the protocol only
 * allows Record<string,string>). Invalid name / missing required arg → ErrorCode.InvalidParams
 * (-32602).
 */

import { McpError, ErrorCode, type GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { TEMPLATE_URI_PREFIX, GUIDE_URI_PREFIX, readCleanroomResource } from './resources.js';

export interface PromptArgumentDef {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDef {
  name: string;
  description: string;
  arguments: PromptArgumentDef[];
}

export const PROMPT_DEFS: PromptDef[] = [
  {
    name: 'scaffold_cleanroom_mod',
    description:
      'Start a new Cleanroom (1.12.2, Java 25+) mod: loads the scaffolding checklist and a tool plan.',
    arguments: [
      { name: 'mod_id', description: 'The mod id (lowercase, e.g. "mymod").', required: true },
      { name: 'mod_name', description: 'Human-readable mod name.', required: false },
    ],
  },
  {
    name: 'port_mod_to_cleanroom',
    description:
      'Port a Fabric or NeoForge mod to Cleanroom: loads the matching porting guide and a topic-sweep plan.',
    arguments: [
      {
        name: 'source_loader',
        description: 'The source loader: "fabric" or "neoforge".',
        required: true,
      },
    ],
  },
  {
    name: 'backport_feature',
    description:
      'Backport a modern-Minecraft feature to Cleanroom 1.12.2: loads the backporting guide and plan.',
    arguments: [
      {
        name: 'source_version',
        description: 'The modern Minecraft version (e.g. "1.21").',
        required: true,
      },
    ],
  },
];

const PROMPT_NAMES = new Set(PROMPT_DEFS.map((p) => p.name));

/** Build an embedded-resource message from a cleanroom:// URI (must resolve). */
function embeddedResource(uri: string): GetPromptResult['messages'][number] {
  const body = readCleanroomResource(uri);
  if (!body) {
    // Should never happen for the fixed URIs below; guard defensively.
    throw new McpError(ErrorCode.InternalError, `Prompt resource missing: ${uri}`);
  }
  return {
    role: 'user',
    content: { type: 'resource', resource: { uri, mimeType: body.mimeType, text: body.text } },
  };
}

function textMessage(
  role: 'user' | 'assistant',
  text: string
): GetPromptResult['messages'][number] {
  return { role, content: { type: 'text', text } };
}

export function getPromptResult(
  name: string,
  args: Record<string, string> | undefined
): GetPromptResult {
  if (!PROMPT_NAMES.has(name)) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  }
  const a = args ?? {};

  if (name === 'scaffold_cleanroom_mod') {
    const modId = a.mod_id;
    if (!modId || !modId.trim()) {
      throw new McpError(ErrorCode.InvalidParams, 'scaffold_cleanroom_mod requires "mod_id".');
    }
    const modName = a.mod_name?.trim() || modId;
    return {
      description: `Scaffold Cleanroom mod "${modName}" (id: ${modId})`,
      messages: [
        embeddedResource(`${TEMPLATE_URI_PREFIX}checklist`),
        textMessage(
          'user',
          `Scaffold a new Cleanroom (Minecraft 1.12.2, Java 25+) mod with id "${modId}" (name "${modName}").\n\n` +
            `Follow the checklist above. Concretely:\n` +
            `1. get_project_template("build.gradle"), ("settings.gradle"), ("gradle.properties") — Unimined toolchain; set mod_id=${modId}.\n` +
            `2. get_project_template("mcmod.info") and ("ExampleMod.java") for metadata and the @Mod entry point.\n` +
            `3. Register content via RegistryEvent.Register + @ObjectHolder (search_cleanroom_api "RegistryEvent").\n` +
            `4. resolve_symbol for any SRG names; search_docs (target scope) for idioms.\n` +
            `5. For mixins, get_porting_guide("mixin-setup").`
        ),
      ],
    };
  }

  if (name === 'port_mod_to_cleanroom') {
    const loader = a.source_loader?.trim();
    if (loader !== 'fabric' && loader !== 'neoforge') {
      throw new McpError(
        ErrorCode.InvalidParams,
        'port_mod_to_cleanroom requires "source_loader" of "fabric" or "neoforge".'
      );
    }
    const guide = loader === 'fabric' ? 'porting-from-fabric' : 'porting-from-neoforge';
    return {
      description: `Port a ${loader} mod to Cleanroom 1.12.2`,
      messages: [
        embeddedResource(`${GUIDE_URI_PREFIX}${guide}`),
        textMessage(
          'user',
          `Port a ${loader} mod to Cleanroom (1.12.2). Work through the guide above topic by topic. ` +
            `For each construct, call find_equivalent(query=<source API>, from="${loader}", topic=<topic>) across:\n` +
            `registration, events, networking, item-block-settings, capabilities-attachments, ` +
            `mixins-access-transformers, resources-datagen (expect kind:missing for datagen).\n` +
            `Then build the target side as in the scaffold flow (get_project_template, search_cleanroom_api, resolve_symbol).`
        ),
      ],
    };
  }

  // backport_feature
  const version = a.source_version?.trim();
  if (!version) {
    throw new McpError(ErrorCode.InvalidParams, 'backport_feature requires "source_version".');
  }
  return {
    description: `Backport a feature from Minecraft ${version} to Cleanroom 1.12.2`,
    messages: [
      embeddedResource(`${GUIDE_URI_PREFIX}backporting`),
      textMessage(
        'user',
        `Backport a feature from modern Minecraft ${version} down to Cleanroom 1.12.2. Follow the ` +
          `guide above. Sweep with find_equivalent(query=<modern API>, from="modern-minecraft", topic=<topic>) across:\n` +
          `serialization-nbt-codecs, data-components, block-entity-renderer, text-components, registration, advancements.\n` +
          `Expect several kind:missing answers — treat each as "no 1:1 port; here is the 1.12.2 idiom." ` +
          `Resolve names with resolve_symbol and search_mappings(minecraft_version="${version}").`
      ),
    ],
  };
}
