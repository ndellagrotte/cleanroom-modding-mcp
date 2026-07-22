/**
 * Cleanroom wiki ingestion (DESIGN.md §6.1).
 *
 * Primary path: read the wiki's markdown straight from the site's source repo
 * (CleanroomMC/Website) — raw fidelity, clear provenance, no HTML round-trip.
 * Fallback path: derive the live wiki routes from VitePress's emitted
 * hashmap.json manifest and let the existing DocumentCrawler fetch them (its
 * selector table already strips VitePress chrome).
 */

import fetch from 'node-fetch';
import { LOADERS, TARGET_VERSION } from '../loaders.js';
import { categorizeDocPath } from '../categories.js';
import { USER_AGENT } from '../dbs.js';
import { parseMarkdownPage } from './markdown.js';
import type { DocumentPage } from './types.js';

/** Public site origin the wiki routes live under. */
const SITE_ORIGIN = 'https://cleanroommc.com';

interface GitTreeEntry {
  path: string;
  type: string;
}

interface GitTreeResponse {
  tree?: GitTreeEntry[];
  truncated?: boolean;
}

/** Standard headers for GitHub requests; GITHUB_TOKEN raises the rate limit. */
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

/** owner/repo parsed from the registry's repo-markdown source URL. */
function wikiRepoSlug(): string {
  const source = LOADERS.cleanroom.sources.find((s) => s.kind === 'repo-markdown');
  if (!source) {
    throw new Error('No repo-markdown source registered for cleanroom');
  }
  const match = new URL(source.url).pathname.match(/^\/([^/]+\/[^/]+)/);
  if (!match?.[1]) {
    throw new Error(`Cannot parse owner/repo from ${source.url}`);
  }
  return match[1];
}

/**
 * Map a repo path to its published route:
 * docs/wiki/forge-mod-development/event.md → https://cleanroommc.com/wiki/forge-mod-development/event
 * docs/wiki/index.md → https://cleanroommc.com/wiki
 */
export function wikiPathToRoute(path: string): string {
  const route = path
    .replace(/^docs\//, '')
    .replace(/\.md$/, '')
    .replace(/\/?index$/, '');
  return `${SITE_ORIGIN}/${route}`.replace(/\/+$/, '');
}

/**
 * Map a VitePress hashmap key to a live route:
 * wiki_forge-mod-development_event.md → https://cleanroommc.com/wiki/forge-mod-development/event
 * Known limitation, fine for a fallback: '_' inside real filenames (e.g.
 * modularui/json/theme_ref.md) is indistinguishable from a path separator, so
 * a rare derived URL 404s; the crawler tolerates per-URL failures.
 */
export function hashmapKeyToRoute(key: string): string {
  const route = key.replace(/\.md$/, '').replace(/_/g, '/');
  return `${SITE_ORIGIN}/${route}`;
}

/**
 * Fetch the Cleanroom wiki as parsed DocumentPages from the source repo.
 * Throws when discovery fails outright — callers fall back to
 * getCleanroomWikiFallbackUrls(). Individual file failures are skipped.
 *
 * `includeTrees` is the slot where future target-scope corpora (GroovyScript,
 * renderbook — DESIGN.md §6.1 ecosystem rows) plug in; docs/zh/** stays out.
 */
export async function getCleanroomWikiPages(
  options: { includeTrees?: string[] } = {}
): Promise<DocumentPage[]> {
  const includeTrees = options.includeTrees ?? ['docs/wiki/'];
  const slug = wikiRepoSlug();

  const treeResponse = await fetch(
    `https://api.github.com/repos/${slug}/git/trees/main?recursive=1`,
    { headers: githubHeaders() }
  );
  if (!treeResponse.ok) {
    throw new Error(`GitHub tree API returned ${treeResponse.status} for ${slug}`);
  }
  const tree = (await treeResponse.json()) as GitTreeResponse;
  if (tree.truncated) {
    throw new Error(`GitHub tree listing for ${slug} is truncated`);
  }

  const paths = (tree.tree ?? [])
    .filter(
      (entry) =>
        entry.type === 'blob' &&
        entry.path.endsWith('.md') &&
        includeTrees.some((prefix) => entry.path.startsWith(prefix))
    )
    .map((entry) => entry.path)
    .sort();

  if (paths.length === 0) {
    throw new Error(`No wiki markdown found under ${includeTrees.join(', ')} in ${slug}`);
  }
  console.error(`[cleanroom-wiki] Fetching ${paths.length} markdown files from ${slug}`);

  const pages: DocumentPage[] = [];
  for (const path of paths) {
    const rawUrl = `https://raw.githubusercontent.com/${slug}/main/${path}`;
    let markdown: string | null = null;
    for (let attempt = 1; attempt <= 3 && markdown === null; attempt++) {
      try {
        const response = await fetch(rawUrl, { headers: { 'User-Agent': USER_AGENT } });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        markdown = await response.text();
      } catch (error) {
        if (attempt === 3) {
          console.error(`[cleanroom-wiki] Skipping ${path} after 3 attempts:`, error);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
      }
    }
    if (markdown === null) continue;

    const url = wikiPathToRoute(path);
    const segments = new URL(url).pathname.split('/').filter((s) => s && s !== 'wiki');
    pages.push(
      parseMarkdownPage({
        url,
        markdown,
        loader: 'cleanroom',
        category: categorizeDocPath(segments),
      })
    );
  }

  console.error(
    `[cleanroom-wiki] Parsed ${pages.length}/${paths.length} pages (Minecraft ${TARGET_VERSION})`
  );
  return pages;
}

/**
 * Fallback URL discovery for the live-site crawl: VitePress route manifest.
 * Returns [] on failure (matching the sitemap fetchers' contract).
 */
export async function getCleanroomWikiFallbackUrls(): Promise<string[]> {
  try {
    const response = await fetch(`${SITE_ORIGIN}/hashmap.json`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const hashmap = (await response.json()) as Record<string, string>;
    return Object.keys(hashmap)
      .filter((key) => /^wiki(_|\.md$)/.test(key))
      .map(hashmapKeyToRoute)
      .sort();
  } catch (error) {
    console.error('[cleanroom-wiki] hashmap.json fallback failed:', error);
    return [];
  }
}
