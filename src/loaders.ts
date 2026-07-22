/**
 * Loader registry — the single source of truth for every mod-loader fact.
 *
 * This replaces the closed 'fabric' | 'neoforge' | 'shared' string union that
 * was previously duplicated across the indexer, services, and tool schemas.
 * Nothing outside this file may hardcode a loader id, a loader's doc host, or
 * a loader's default Minecraft version.
 *
 * Roles (the reorientation's core concept, DESIGN.md §5.2):
 *   - target:    what the server helps BUILD — Cleanroom and classic Forge,
 *                both at Minecraft 1.12.2
 *   - reference: retained corpora that serve porting/backporting — Fabric and
 *                NeoForge at modern Minecraft versions
 *   - neutral:   loader-agnostic content, always included in either scope
 */

export type Loader = 'cleanroom' | 'forge' | 'fabric' | 'neoforge' | 'shared';
export type Scope = 'target' | 'reference' | 'all';
export type LoaderRole = 'target' | 'reference' | 'neutral';

export interface LoaderSource {
  kind: 'sitemap' | 'repo-markdown' | 'bfs';
  url: string;
}

export interface LoaderInfo {
  id: Loader;
  role: LoaderRole;
  /** Fixed for the target family ('1.12.2'); null = derive from the DB (reference family). */
  defaultVersion: string | null;
  /** Hosts whose pages belong to this loader (exact match or subdomain). */
  docHosts: string[];
  /** URL-path fallbacks used when host detection is inconclusive. */
  urlPathHints: string[];
  displayName: string;
  /** Documentation sources the indexer ingests for this loader. */
  sources: LoaderSource[];
}

/** The one Minecraft version the target family develops against. */
export const TARGET_VERSION = '1.12.2';

export const LOADERS: Record<Loader, LoaderInfo> = {
  cleanroom: {
    id: 'cleanroom',
    role: 'target',
    defaultVersion: TARGET_VERSION,
    docHosts: ['cleanroommc.com'],
    urlPathHints: ['/cleanroom'],
    displayName: 'Cleanroom',
    sources: [
      { kind: 'repo-markdown', url: 'https://github.com/CleanroomMC/Website' },
      { kind: 'bfs', url: 'https://cleanroommc.com/wiki/' },
    ],
  },
  forge: {
    id: 'forge',
    role: 'target',
    defaultVersion: TARGET_VERSION,
    // The 1.12.x sitemap's <loc> URLs live on the ReadTheDocs internal host;
    // discovered URLs are rewritten to the canonical host, but both must label
    // as forge in case an un-rewritten URL ever reaches the crawler.
    docHosts: ['docs.minecraftforge.net', 'mcforge.readthedocs.io'],
    urlPathHints: ['/forge/'],
    displayName: 'Forge (1.12.2)',
    sources: [{ kind: 'sitemap', url: 'https://docs.minecraftforge.net/en/1.12.x/sitemap.xml' }],
  },
  fabric: {
    id: 'fabric',
    role: 'reference',
    defaultVersion: null,
    docHosts: ['fabricmc.net'],
    urlPathHints: ['/fabric/'],
    displayName: 'Fabric',
    sources: [
      { kind: 'sitemap', url: 'https://docs.fabricmc.net/sitemap.xml' },
      { kind: 'sitemap', url: 'https://wiki.fabricmc.net/start?do=sitemap' },
    ],
  },
  neoforge: {
    id: 'neoforge',
    role: 'reference',
    defaultVersion: null,
    docHosts: ['neoforged.net'],
    urlPathHints: ['/neoforge/'],
    displayName: 'NeoForge',
    sources: [{ kind: 'sitemap', url: 'https://docs.neoforged.net/sitemap.xml' }],
  },
  shared: {
    id: 'shared',
    role: 'neutral',
    defaultVersion: null,
    docHosts: [],
    urlPathHints: [],
    displayName: 'Loader-agnostic',
    sources: [],
  },
};

export const LOADER_IDS = Object.keys(LOADERS) as Loader[];

export const TARGET_FAMILY: Loader[] = LOADER_IDS.filter(
  (id) => LOADERS[id].role === 'target' || LOADERS[id].role === 'neutral'
);

export const REFERENCE_FAMILY: Loader[] = LOADER_IDS.filter(
  (id) => LOADERS[id].role === 'reference' || LOADERS[id].role === 'neutral'
);

export function isLoader(value: string): value is Loader {
  return (LOADER_IDS as string[]).includes(value);
}

/** Expand an agent-facing scope into the loader set it filters to. */
export function scopeToLoaders(scope: Scope): Loader[] {
  switch (scope) {
    case 'target':
      return TARGET_FAMILY;
    case 'reference':
      return REFERENCE_FAMILY;
    case 'all':
      return LOADER_IDS;
  }
}

/**
 * Default Minecraft version for a loader: fixed for the target family,
 * null for loaders whose "latest" is derived from indexed data.
 */
export function defaultVersionFor(loader: Loader): string | null {
  return LOADERS[loader].defaultVersion;
}

/**
 * Map a single-loader *perspective* (explain_concept's loader param) to the
 * corpus filter set used for concept synthesis.
 *
 * This intentionally differs from search's explicit-loader semantics (exactly
 * one loader): synthesis wants the widest corpus that cannot introduce
 * wrong-loader bias. Target-role loaders expand to the whole family — Cleanroom
 * IS Forge 1.12.2 plus a delta, and the cleanroom-only corpus (~34 wiki pages)
 * is too thin to explain concepts alone. Reference loaders keep their own
 * corpus plus neutral content ('shared' is loader-agnostic by definition), and
 * the neutral perspective applies no filter at all.
 */
export function perspectiveToLoaders(loader: Loader): Loader[] | undefined {
  switch (LOADERS[loader].role) {
    case 'target':
      return TARGET_FAMILY;
    case 'reference':
      return [loader, 'shared'];
    case 'neutral':
      return undefined;
  }
}

/**
 * Detect which loader a documentation URL belongs to.
 * Host matching first (exact or subdomain), then URL-path hints; 'shared' as
 * the fallback. Replaces DocumentCrawler.detectLoader's hardcoded host table.
 */
export function detectLoaderFromUrl(url: string): Loader {
  try {
    const host = new URL(url).host;
    for (const id of LOADER_IDS) {
      for (const docHost of LOADERS[id].docHosts) {
        if (host === docHost || host.endsWith(`.${docHost}`)) {
          return id;
        }
      }
    }
  } catch {
    // Relative or malformed URL — fall through to path hints.
  }
  for (const id of LOADER_IDS) {
    if (LOADERS[id].urlPathHints.some((hint) => url.includes(hint))) {
      return id;
    }
  }
  return 'shared';
}
