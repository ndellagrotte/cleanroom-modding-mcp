/**
 * Central identity + database registry for cleanroom-modding-mcp.
 *
 * This module is one of the two single-source-of-truth registries in the
 * codebase (the other is src/loaders.ts): nothing outside this file may
 * hardcode the repo slug, a database filename, or a manifest filename.
 *
 * Distribution convention: every database asset and its manifest are attached
 * to the main `v{version}` GitHub release of this repository. There are no
 * per-database release tags.
 */

import fs from 'fs';
import { getDefaultDbPath } from './data-dir.js';

export const PACKAGE_NAME = 'cleanroom-modding-mcp';
export const REPO_SLUG = 'ndellagrotte/cleanroom-modding-mcp';
export const REPO_URL = `https://github.com/${REPO_SLUG}`;
export const USER_AGENT = PACKAGE_NAME;

/**
 * GitHub API base for this repository. `GITHUB_REPO_URL` overrides the default
 * (kept from the pre-fork behavior; points at the API `repos/<owner>/<name>` root).
 */
export function getApiBase(): string {
  return process.env.GITHUB_REPO_URL || `https://api.github.com/repos/${REPO_SLUG}`;
}

export type DbId = 'docs' | 'mappings' | 'examples' | 'cleanroom-api';

export interface DbSpec {
  id: DbId;
  name: string;
  fileName: string;
  manifestName: string;
  /** Required DBs are installed by postinstall and always auto-updated; optional DBs only once installed via `manage`. */
  required: boolean;
  /** Runtime schema gate: services treat a DB with a different schema_version as not installed. */
  schemaVersion: number;
  description: string;
  icon: string;
}

export const DBS: Record<DbId, DbSpec> = {
  docs: {
    id: 'docs',
    name: 'Documentation Database',
    fileName: 'docs.db',
    manifestName: 'docs-manifest.json',
    required: true,
    schemaVersion: 1,
    description: 'Cleanroom/Forge 1.12.2 docs plus Fabric & NeoForge porting reference',
    icon: '📚',
  },
  mappings: {
    id: 'mappings',
    name: 'Mappings Database',
    fileName: 'mappings.db',
    manifestName: 'mappings-manifest.json',
    required: false,
    schemaVersion: 1,
    description: 'Minecraft class/method/field mappings (1.12.2 MCP/SRG + modern Parchment/Mojang)',
    icon: '🗺️',
  },
  examples: {
    id: 'examples',
    name: 'Mod Examples Database',
    fileName: 'examples.db',
    manifestName: 'examples-manifest.json',
    required: false,
    schemaVersion: 1,
    description: 'Curated code examples from canonical open-source 1.12.2 mods',
    icon: '🧩',
  },
  'cleanroom-api': {
    id: 'cleanroom-api',
    name: 'Cleanroom API Database',
    fileName: 'cleanroom-api.db',
    manifestName: 'cleanroom-api-manifest.json',
    required: false,
    schemaVersion: 1,
    description: 'Cleanroom/Forge framework API symbols: classes, events, annotations',
    icon: '🧬',
  },
};

export const DB_IDS = Object.keys(DBS) as DbId[];

/** Default on-disk path for a database (inside the shared data directory). */
export function dbPath(id: DbId): string {
  return getDefaultDbPath(DBS[id].fileName);
}

export function isInstalled(id: DbId): boolean {
  return fs.existsSync(dbPath(id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared GitHub-release selection
// ─────────────────────────────────────────────────────────────────────────────

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface GitHubRelease {
  id: number;
  tag_name: string;
  published_at: string;
  assets: ReleaseAsset[];
}

export interface SelectedRelease {
  release: GitHubRelease;
  dbAsset: ReleaseAsset;
  manifestAsset: ReleaseAsset | null;
}

/**
 * Pick the newest release (GitHub API order) that follows the `v{version}` tag
 * convention and carries this DB's file asset. Releases whose upload failed
 * (asset missing) are skipped. By default the manifest asset is optional —
 * callers that need it (hash verification, remote version info) either handle
 * null or pass `requireManifest: true` to keep scanning past partial uploads.
 */
export function selectRelease(
  releases: GitHubRelease[],
  spec: DbSpec,
  opts: { requireManifest?: boolean } = {}
): SelectedRelease | null {
  for (const release of releases) {
    if (!release.tag_name.startsWith('v')) {
      continue;
    }
    const dbAsset = release.assets.find((a) => a.name === spec.fileName);
    if (!dbAsset) {
      continue;
    }
    const manifestAsset = release.assets.find((a) => a.name === spec.manifestName) ?? null;
    if (opts.requireManifest && !manifestAsset) {
      continue;
    }
    return { release, dbAsset, manifestAsset };
  }
  return null;
}
