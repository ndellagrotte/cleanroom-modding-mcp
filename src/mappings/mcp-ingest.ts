/**
 * MCP/SRG era ingestion for Minecraft 1.12.2.
 *
 * Downloads exactly what Cleanroom pins so the server's names match the agent's
 * dev environment (cleanroom-src/gradle.properties):
 *   - `de.oceanlabs.mcp:mcp_config:1.12.2-*` (joined.tsrg notch->SRG, constructors,
 *     static methods) — primary: Outlands maven (Cleanroom's rebuild); fallback:
 *     Forge maven's last 1.12.2 build (SRG ids are identical; packaging differs).
 *   - `de.oceanlabs.mcp:mcp_stable:39-1.12` (fields/methods/params CSVs,
 *     SRG->readable) — Forge maven ONLY (verified absent from Outlands).
 *
 * This module lives in src/ (not scripts/) deliberately: it ships in dist/ so
 * the `manage` CLI can build the 1.12.2 mappings database on-device — the
 * licensing-insurance path for the MCP CSVs (DESIGN.md §6.2, Open Question 2).
 * Total download is ~730 KB; a build takes well under a minute.
 */

import fs from 'fs';
import AdmZip from 'adm-zip';
import type Database from 'better-sqlite3';
import { USER_AGENT } from '../dbs.js';
import { initializeMappingsDb } from './schema.js';
import {
  parseTsrg,
  remapDescriptor,
  splitInternalName,
  paramSlots,
  slotToParamIndex,
} from './tsrg.js';
import {
  parseMcpNamesCsv,
  parseParamsCsv,
  parseConstructors,
  parseStaticMethods,
} from './mcp-csv.js';

export const MCP_MINECRAFT_VERSION = '1.12.2';
/** The mcp_config build Cleanroom pins (cleanroom-src/gradle.properties). */
export const MCP_CONFIG_VERSION = '1.12.2-20260220.202731';
/** Newest 1.12.2 mcp_config on the Forge maven — emergency fallback only. */
export const MCP_CONFIG_FALLBACK_VERSION = '1.12.2-20201025.185735';
export const MCP_STABLE_VERSION = '39-1.12';

export const OUTLANDS_MAVEN_BASE = 'https://maven.outlands.top/releases';
export const FORGE_MAVEN_BASE = 'https://maven.minecraftforge.net';

export function mcpConfigUrl(mavenBase: string, version: string): string {
  return `${mavenBase}/de/oceanlabs/mcp/mcp_config/${version}/mcp_config-${version}.zip`;
}

export function mcpStableUrl(): string {
  return `${FORGE_MAVEN_BASE}/de/oceanlabs/mcp/mcp_stable/${MCP_STABLE_VERSION}/mcp_stable-${MCP_STABLE_VERSION}.zip`;
}

export type McpSource = 'outlands' | 'forge-fallback';

export interface McpArtifacts {
  tsrgText: string;
  constructorsText: string;
  staticMethodsText: string;
  fieldsCsv: string;
  methodsCsv: string;
  paramsCsv: string;
  mcpConfigVersion: string;
  mcpSource: McpSource;
}

export interface McpIngestStats {
  classes: number;
  methods: number;
  fields: number;
  parameters: number;
  documentedMethods: number;
  documentedFields: number;
  /** params.csv tokens whose LVT slot did not map onto the descriptor. */
  skippedParams: number;
  /** constructors.txt rows whose owner class was not in the TSRG. */
  skippedConstructors: number;
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function readZipText(zip: AdmZip, entryPath: string): string {
  const entry = zip.getEntry(entryPath);
  if (!entry) {
    throw new Error(`Zip entry not found: ${entryPath}`);
  }
  return zip.readAsText(entry);
}

/** MCPConfig config.json — data paths may be strings or nested objects. */
function dataPath(configJson: unknown, key: string, fallback: string): string {
  if (typeof configJson === 'object' && configJson !== null) {
    const data = (configJson as { data?: Record<string, unknown> }).data;
    const value = data?.[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return fallback;
}

export interface DownloadMcpOptions {
  /** Override the mcp_config version (tried on both mavens; disables the version fallback). */
  mcpConfigVersion?: string;
  onProgress?: (message: string) => void;
}

export async function downloadMcpArtifacts(opts: DownloadMcpOptions = {}): Promise<McpArtifacts> {
  const progress = opts.onProgress ?? ((): void => undefined);

  const attempts: Array<{ url: string; version: string; source: McpSource }> = opts.mcpConfigVersion
    ? [
        {
          url: mcpConfigUrl(OUTLANDS_MAVEN_BASE, opts.mcpConfigVersion),
          version: opts.mcpConfigVersion,
          source: 'outlands',
        },
        {
          url: mcpConfigUrl(FORGE_MAVEN_BASE, opts.mcpConfigVersion),
          version: opts.mcpConfigVersion,
          source: 'forge-fallback',
        },
      ]
    : [
        {
          url: mcpConfigUrl(OUTLANDS_MAVEN_BASE, MCP_CONFIG_VERSION),
          version: MCP_CONFIG_VERSION,
          source: 'outlands',
        },
        {
          url: mcpConfigUrl(FORGE_MAVEN_BASE, MCP_CONFIG_FALLBACK_VERSION),
          version: MCP_CONFIG_FALLBACK_VERSION,
          source: 'forge-fallback',
        },
      ];

  let configZip: AdmZip | null = null;
  let configVersion = '';
  let configSource: McpSource = 'outlands';
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      progress(`Downloading mcp_config ${attempt.version} (${attempt.source})...`);
      configZip = new AdmZip(await fetchBuffer(attempt.url));
      configVersion = attempt.version;
      configSource = attempt.source;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${attempt.url}: ${message}`);
    }
  }
  if (!configZip) {
    throw new Error(`Failed to download mcp_config from all sources:\n  ${errors.join('\n  ')}`);
  }
  if (configSource === 'forge-fallback') {
    console.error(
      `[mcp-ingest] WARNING: Outlands maven unavailable — using Forge-maven mcp_config ` +
        `${configVersion} (SRG ids are identical to the Cleanroom rebuild; packaging differs).`
    );
  }

  let configJson: unknown = null;
  try {
    configJson = JSON.parse(readZipText(configZip, 'config.json'));
  } catch {
    // Fall back to conventional paths below.
  }
  const tsrgText = readZipText(configZip, dataPath(configJson, 'mappings', 'config/joined.tsrg'));
  const constructorsText = readZipText(
    configZip,
    dataPath(configJson, 'constructors', 'config/constructors.txt')
  );
  const staticMethodsText = readZipText(
    configZip,
    dataPath(configJson, 'statics', 'config/static_methods.txt')
  );

  progress(`Downloading mcp_stable ${MCP_STABLE_VERSION} (Forge maven)...`);
  // No fallback exists: mcp_stable is not mirrored on Outlands (verified 404).
  const stableZip = new AdmZip(await fetchBuffer(mcpStableUrl()));

  return {
    tsrgText,
    constructorsText,
    staticMethodsText,
    fieldsCsv: readZipText(stableZip, 'fields.csv'),
    methodsCsv: readZipText(stableZip, 'methods.csv'),
    paramsCsv: readZipText(stableZip, 'params.csv'),
    mcpConfigVersion: configVersion,
    mcpSource: configSource,
  };
}

const SRG_METHOD_NAME = /^func_(\d+)_/;
const SRG_FIELD_NAME = /^field_\d+_/;
const SRG_PARAM_TOKEN = /^p_(\d+)_(\d+)_$/;

/**
 * Ingest the 1.12.2 MCP era into an open mappings database (schema v2).
 * Refuses to run when 1.12.2 rows already exist — callers delete them first.
 */
export function ingestMcpEra(db: Database.Database, artifacts: McpArtifacts): McpIngestStats {
  const existing = db
    .prepare(`SELECT COUNT(*) as count FROM classes WHERE minecraft_version = ?`)
    .get(MCP_MINECRAFT_VERSION) as { count: number };
  if (existing.count > 0) {
    throw new Error(
      `${MCP_MINECRAFT_VERSION} is already indexed (${existing.count} classes); delete its rows before re-ingesting`
    );
  }

  const tsrg = parseTsrg(artifacts.tsrgText);
  const methodNames = parseMcpNamesCsv(artifacts.methodsCsv);
  const fieldNames = parseMcpNamesCsv(artifacts.fieldsCsv);
  const paramNames = parseParamsCsv(artifacts.paramsCsv);
  const staticMethods = parseStaticMethods(artifacts.staticMethodsText);
  const constructors = parseConstructors(artifacts.constructorsText);

  const classMap = new Map<string, string>();
  for (const cls of tsrg.classes) {
    classMap.set(cls.obfName, cls.name);
  }

  const stats: McpIngestStats = {
    classes: 0,
    methods: 0,
    fields: 0,
    parameters: 0,
    documentedMethods: 0,
    documentedFields: 0,
    skippedParams: 0,
    skippedConstructors: 0,
  };

  const insertClass = db.prepare(`
    INSERT INTO classes (name, package_name, notch_name, javadoc, minecraft_version, mapping_set)
    VALUES (?, ?, ?, ?, ?, 'mcp')
  `);
  const insertMethod = db.prepare(`
    INSERT INTO methods (class_id, name, srg_name, notch_name, descriptor, javadoc)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertField = db.prepare(`
    INSERT INTO fields (class_id, name, srg_name, notch_name, descriptor, javadoc)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertParameter = db.prepare(`
    INSERT INTO parameters (method_id, param_index, srg_token, name, javadoc)
    VALUES (?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    const classIdByInternalName = new Map<string, number>();
    /** SRG id -> every method row carrying it (overrides share SRG ids across classes). */
    const methodsBySrgId = new Map<
      number,
      Array<{ methodId: number; descriptor: string; isStatic: boolean }>
    >();
    /** Method rows whose parameters came from TSRG v2 sub-lines (skip the CSV pass). */
    const methodsWithParams = new Set<number>();

    for (const cls of tsrg.classes) {
      const { packageName, simpleName } = splitInternalName(cls.name);
      const classResult = insertClass.run(
        simpleName,
        packageName,
        cls.obfName,
        null,
        MCP_MINECRAFT_VERSION
      );
      const classId = classResult.lastInsertRowid as number;
      classIdByInternalName.set(cls.name, classId);
      stats.classes++;

      for (const field of cls.fields) {
        const isSrg = SRG_FIELD_NAME.test(field.srgName);
        const csv = isSrg ? fieldNames.get(field.srgName) : undefined;
        const descriptor = field.obfDescriptor
          ? remapDescriptor(field.obfDescriptor, classMap)
          : null;
        insertField.run(
          classId,
          csv?.name ?? field.srgName,
          isSrg ? field.srgName : null,
          field.obfName,
          descriptor,
          csv?.javadoc ?? null
        );
        stats.fields++;
        if (csv?.javadoc) {
          stats.documentedFields++;
        }
      }

      for (const method of cls.methods) {
        const srgMatch = method.srgName.match(SRG_METHOD_NAME);
        const csv = srgMatch ? methodNames.get(method.srgName) : undefined;
        const descriptor = remapDescriptor(method.obfDescriptor, classMap);
        const isStatic = method.isStatic || staticMethods.has(method.srgName);
        const methodResult = insertMethod.run(
          classId,
          csv?.name ?? method.srgName,
          srgMatch ? method.srgName : null,
          method.obfName,
          descriptor,
          csv?.javadoc ?? null
        );
        const methodId = methodResult.lastInsertRowid as number;
        stats.methods++;
        if (csv?.javadoc) {
          stats.documentedMethods++;
        }

        if (srgMatch) {
          const srgId = Number.parseInt(srgMatch[1] ?? '', 10);
          if (!Number.isNaN(srgId)) {
            const rows = methodsBySrgId.get(srgId) ?? [];
            rows.push({ methodId, descriptor, isStatic });
            methodsBySrgId.set(srgId, rows);
          }
        }

        // TSRG v2 carries parameters inline; prefer them over the CSV join.
        for (const param of method.params) {
          const index = slotToParamIndex(descriptor, param.slot, isStatic);
          if (index === null) {
            stats.skippedParams++;
            continue;
          }
          const isToken = SRG_PARAM_TOKEN.test(param.name);
          insertParameter.run(
            methodId,
            index,
            isToken ? param.name : null,
            (isToken ? paramNames.get(param.name) : undefined) ?? param.name,
            null
          );
          methodsWithParams.add(methodId);
          stats.parameters++;
        }
      }
    }

    // params.csv pass: p_<srgId>_<slot>_ -> every method row with that SRG id.
    for (const [token, name] of paramNames) {
      const match = token.match(SRG_PARAM_TOKEN);
      if (!match) {
        continue; // p_i tokens are handled by constructor synthesis below
      }
      const srgId = Number.parseInt(match[1] ?? '', 10);
      const slot = Number.parseInt(match[2] ?? '', 10);
      const rows = methodsBySrgId.get(srgId);
      if (!rows || Number.isNaN(slot)) {
        stats.skippedParams++;
        continue;
      }
      for (const row of rows) {
        if (methodsWithParams.has(row.methodId)) {
          continue;
        }
        const index = slotToParamIndex(row.descriptor, slot, row.isStatic);
        if (index === null) {
          stats.skippedParams++;
          continue;
        }
        insertParameter.run(row.methodId, index, token, name, null);
        stats.parameters++;
      }
    }

    // Constructor synthesis: insert <init> rows and ALL their p_i tokens so
    // resolve_symbol can answer p_i<id>_<slot>_ lookups (the ctor id is only
    // recoverable at query time if a row stores the token).
    for (const ctor of constructors) {
      const classId = classIdByInternalName.get(ctor.owner);
      if (classId === undefined) {
        stats.skippedConstructors++;
        continue;
      }
      const methodResult = insertMethod.run(
        classId,
        '<init>',
        null,
        '<init>',
        ctor.descriptor,
        null
      );
      const methodId = methodResult.lastInsertRowid as number;
      stats.methods++;
      for (const { index, slot } of paramSlots(ctor.descriptor, false)) {
        const token = `p_i${ctor.id}_${slot}_`;
        insertParameter.run(methodId, index, token, paramNames.get(token) ?? token, null);
        stats.parameters++;
      }
    }
  });

  transaction();

  const setMeta = db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`);
  setMeta.run('mcp_config_version', artifacts.mcpConfigVersion);
  setMeta.run('mcp_stable_version', MCP_STABLE_VERSION);
  setMeta.run('mcp_source', artifacts.mcpSource);

  return stats;
}

export interface BuildLocalMappingsOptions {
  dbPath: string;
  mcpConfigVersion?: string;
  onProgress?: (message: string) => void;
}

export interface BuildLocalMappingsResult {
  stats: McpIngestStats;
  mcpConfigVersion: string;
  mcpSource: McpSource;
}

/**
 * Build a fresh 1.12.2-only mappings database at `dbPath` (the on-device path
 * used by `manage`). Any existing file at that path is replaced.
 */
export async function buildLocalMappingsDb(
  opts: BuildLocalMappingsOptions
): Promise<BuildLocalMappingsResult> {
  const progress = opts.onProgress ?? ((): void => undefined);

  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(opts.dbPath + suffix, { force: true });
  }

  const artifacts = await downloadMcpArtifacts({
    mcpConfigVersion: opts.mcpConfigVersion,
    onProgress: progress,
  });

  progress('Building 1.12.2 mappings database...');
  const db = initializeMappingsDb(opts.dbPath);
  try {
    const stats = ingestMcpEra(db, artifacts);
    const setMeta = db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`);
    setMeta.run('indexed_at', new Date().toISOString());
    setMeta.run('versions_indexed', JSON.stringify([MCP_MINECRAFT_VERSION]));
    setMeta.run('has_obfuscated_mappings', 'true');
    progress(
      `Indexed ${stats.classes.toLocaleString()} classes, ${stats.methods.toLocaleString()} methods, ` +
        `${stats.fields.toLocaleString()} fields, ${stats.parameters.toLocaleString()} parameters`
    );
    return { stats, mcpConfigVersion: artifacts.mcpConfigVersion, mcpSource: artifacts.mcpSource };
  } finally {
    db.close();
  }
}
