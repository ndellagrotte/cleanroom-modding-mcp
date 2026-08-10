/**
 * Sitemap parser for automatic URL discovery
 * Parses XML sitemaps to discover all documentation URLs
 * Supports both plain XML and gzipped sitemaps (.xml.gz)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import fetch from 'node-fetch';
import { load } from 'cheerio';
import { gunzipSync } from 'zlib';
import { defaultVersionFor, isMinecraftVersion, LOADERS, type Loader } from '../loaders.js';

export interface SitemapEntry {
  url: string;
  lastModified?: Date;
  changeFreq?: string;
  priority?: number;
}

export interface SitemapFilter {
  includeLocales?: string[]; // e.g., ['en'] or empty for English only
  includePatterns?: RegExp[]; // URL patterns to include
  excludePatterns?: RegExp[]; // URL patterns to exclude
}

export class SitemapParser {
  private sitemapUrl: string;
  private filter: SitemapFilter;

  constructor(sitemapUrl: string, filter: SitemapFilter = {}) {
    this.sitemapUrl = sitemapUrl;
    this.filter = {
      includeLocales: filter.includeLocales || [], // Empty = English only
      includePatterns: filter.includePatterns || [],
      excludePatterns: filter.excludePatterns || [],
    };
  }

  /**
   * Fetch and parse the sitemap
   * Automatically handles gzipped sitemaps based on content-type or URL
   */
  async parse(): Promise<SitemapEntry[]> {
    console.error(`Fetching sitemap from: ${this.sitemapUrl}`);

    const response = await fetch(this.sitemapUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch sitemap: ${response.statusText}`);
    }

    // Check if response is gzipped
    const contentType = response.headers.get('content-type') || '';
    const contentEncoding = response.headers.get('content-encoding') || '';
    const isGzipped =
      contentType.includes('gzip') ||
      contentType.includes('application/x-gzip') ||
      contentEncoding.includes('gzip') ||
      this.sitemapUrl.endsWith('.gz') ||
      this.sitemapUrl.includes('do=sitemap'); // Fabric Wiki returns gzip for this

    let xml: string;

    if (isGzipped) {
      console.error('Detected gzipped sitemap, decompressing...');
      const buffer = await response.arrayBuffer();
      try {
        const decompressed = gunzipSync(Buffer.from(buffer));
        xml = decompressed.toString('utf-8');
      } catch {
        // Maybe it's not actually gzipped, try as plain text
        console.error('Gzip decompression failed, trying as plain text...');
        xml = Buffer.from(buffer).toString('utf-8');
      }
    } else {
      xml = await response.text();
    }

    const entries = this.parseSitemapXML(xml);

    console.error(`Found ${entries.length} entries in sitemap`);

    // Apply filters
    const filtered = this.applyFilters(entries);

    console.error(`Filtered to ${filtered.length} entries`);

    return filtered;
  }

  /**
   * Parse sitemap XML content
   */
  private parseSitemapXML(xml: string): SitemapEntry[] {
    const $ = load(xml, { xmlMode: true });
    const entries: SitemapEntry[] = [];

    // Handle sitemap index (contains links to other sitemaps)
    $('sitemap').each((_: number, elem: unknown) => {
      const loc = $(elem as any)
        .find('loc')
        .text()
        .trim();
      if (loc) {
        // This is a sitemap index, we'll need to fetch sub-sitemaps
        console.error(`Found sitemap index entry: ${loc}`);
      }
    });

    // Handle URL entries
    $('url').each((_: number, elem: unknown) => {
      const $url = $(elem as any);
      const loc = $url.find('loc').text().trim();

      if (!loc) return;

      const lastmod = $url.find('lastmod').text().trim();
      const changefreq = $url.find('changefreq').text().trim();
      const priority = $url.find('priority').text().trim();

      entries.push({
        url: loc,
        lastModified: lastmod ? new Date(lastmod) : undefined,
        changeFreq: changefreq || undefined,
        priority: priority ? parseFloat(priority) : undefined,
      });
    });

    return entries;
  }

  /**
   * Apply filters to sitemap entries
   */
  private applyFilters(entries: SitemapEntry[]): SitemapEntry[] {
    return entries.filter((entry) => {
      const url = entry.url;

      // Filter by locale
      if (this.filter.includeLocales && this.filter.includeLocales.length > 0) {
        // If specific locales are requested
        const hasLocale = this.filter.includeLocales.some((locale) => url.includes(`/${locale}_`));
        if (!hasLocale && !this.isEnglishUrl(url)) {
          return false;
        }
      } else {
        // Default: English only (no locale prefix)
        if (!this.isEnglishUrl(url)) {
          return false;
        }
      }

      // Apply include patterns
      if (this.filter.includePatterns && this.filter.includePatterns.length > 0) {
        const matches = this.filter.includePatterns.some((pattern) => pattern.test(url));
        if (!matches) {
          return false;
        }
      }

      // Apply exclude patterns
      if (this.filter.excludePatterns && this.filter.excludePatterns.length > 0) {
        const excluded = this.filter.excludePatterns.some((pattern) => pattern.test(url));
        if (excluded) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Check if URL is English (no locale prefix)
   */
  private isEnglishUrl(url: string): boolean {
    // English URLs don't have locale prefixes like /de_de/, /es_es/, etc.
    const localePattern = /\/[a-z]{2}_[a-z]{2}\//;
    return !localePattern.test(url);
  }

  /**
   * Parse raw sitemap text (for SITEMAP.txt format)
   */
  static parseRawSitemap(content: string): SitemapEntry[] {
    const entries: SitemapEntry[] = [];
    const urlPattern = /(https?:\/\/[^\s]+?)(\d{4}-\d{2}-\d{2}T[\d:]+\.\d{3}Z)/g;

    let match;
    while ((match = urlPattern.exec(content)) !== null) {
      const url = match[1];
      const date = match[2];

      if (url && date) {
        entries.push({
          url: url,
          lastModified: new Date(date),
        });
      }
    }

    return entries;
  }
}

/**
 * Get Fabric documentation URLs from sitemap
 */
export async function getFabricUrlsFromSitemap(): Promise<string[]> {
  const parser = new SitemapParser('https://docs.fabricmc.net/sitemap.xml', {
    includeLocales: [], // English only
    includePatterns: [/\/develop\//], // Only /develop/ pages
    excludePatterns: [
      /\/contributing/,
      /\/#/, // Skip anchor links
    ],
  });

  try {
    const entries = await parser.parse();
    return entries.map((e) => e.url).sort();
  } catch (error) {
    console.error('Failed to fetch sitemap, falling back to static list:', error);
    // Fallback to static list if sitemap fails
    return [];
  }
}

/**
 * Get Forge 1.12.x documentation URLs from the RTD sitemap.
 * The sitemap's <loc> entries live on the ReadTheDocs internal host
 * (mcforge.readthedocs.io); they are rewritten to the canonical public host,
 * which serves the same routes.
 */
export async function getForgeUrlsFromSitemap(): Promise<string[]> {
  const source = LOADERS.forge.sources.find((s) => s.kind === 'sitemap');
  if (!source) {
    console.error('No sitemap source registered for forge');
    return [];
  }

  const parser = new SitemapParser(source.url, {
    includeLocales: [], // English only
    includePatterns: [/\/en\/1\.12\.x\//],
    excludePatterns: [
      /\/styleguide\//, // contribute-to-Forge content, not modding docs
      /\/forgedev\//,
      /\/#/, // Skip anchor links
    ],
  });

  try {
    const entries = await parser.parse();
    return entries
      .map((e) =>
        e.url.replace('https://mcforge.readthedocs.io/', 'https://docs.minecraftforge.net/')
      )
      .sort();
  } catch (error) {
    console.error('Failed to fetch Forge sitemap:', error);
    return [];
  }
}

/**
 * Get Fabric documentation URLs from sitemap
 */
export async function getNeoforgeUrlsFromSitemap(): Promise<string[]> {
  const parser = new SitemapParser('https://docs.neoforged.net/sitemap.xml', {
    includeLocales: [], // English only
    includePatterns: [/\/docs\//], // Only /docs/ pages
    excludePatterns: [
      /\/contributing/,
      /\/#/, // Skip anchor links
    ],
  });

  try {
    const entries = await parser.parse();
    return entries.map((e) => e.url).sort();
  } catch (error) {
    console.error('Failed to fetch sitemap, falling back to static list:', error);
    // Fallback to static list if sitemap fails
    return [];
  }
}

/**
 * Get Fabric wiki documentation URLs from sitemap
 * The wiki sitemap is served as a gzipped XML file
 */
export async function getFabricWikiUrlsFromSitemap(): Promise<string[]> {
  const sitemapUrl = 'https://wiki.fabricmc.net/start?do=sitemap'; // Returns sitemap.xml.gz

  const parser = new SitemapParser(sitemapUrl, {
    includeLocales: [], // English only
    includePatterns: [], // Include all wiki pages
    excludePatterns: [
      /\?do=/, // Skip action URLs (edit, revisions, etc.)
      /\?rev=/, // Skip revision URLs
      /\?idx=/, // Skip index URLs
      /\/playground/, // Skip playground
      /\/wiki\/wiki/, // Skip wiki meta pages
      /\/start$/, // Skip start page redirects
      /\/de:/, // Skip non-English locales
      /\/es:/,
      /\/fr:/,
      /\/ja:/,
      /\/ru:/,
      /\/zh_cn:/,
      /\/it:/,
      /\/ko_kr:/,
      /\/pt_br:/,
      /\/archive\//, // Skip archive pages
      /\/drafts:/, // Skip draft pages
    ],
  });

  try {
    const entries = await parser.parse();
    const urls = entries.map((e) => e.url).sort();
    console.error(`Found ${urls.length} Fabric Wiki URLs`);
    return urls;
  } catch (error) {
    console.error('Failed to fetch Fabric wiki sitemap:', error);
    // Fallback to static list if sitemap fails
    return getFabricWikiStaticUrls();
  }
}

/**
 * Static fallback URLs for Fabric Wiki if sitemap fetch fails
 */
function getFabricWikiStaticUrls(): string[] {
  const baseUrl = 'https://wiki.fabricmc.net';
  return [
    `${baseUrl}/tutorial/setup`,
    `${baseUrl}/tutorial/items`,
    `${baseUrl}/tutorial/blocks`,
    `${baseUrl}/tutorial/blockentity`,
    `${baseUrl}/tutorial/entity`,
    `${baseUrl}/tutorial/mixin`,
    `${baseUrl}/tutorial/networking`,
    `${baseUrl}/tutorial/recipes`,
    `${baseUrl}/tutorial/commands`,
    `${baseUrl}/tutorial/events`,
    `${baseUrl}/tutorial/keybinds`,
    `${baseUrl}/tutorial/sounds`,
    `${baseUrl}/tutorial/screen`,
    `${baseUrl}/tutorial/enchantments`,
    `${baseUrl}/documentation/fabric_mod_json`,
    `${baseUrl}/documentation/entrypoint`,
  ];
}

/** Versions a document can be tagged with. Either half may be absent. */
export interface DetectedVersions {
  /** A real Minecraft version, or undefined when none can be established. */
  minecraftVersion?: string;
  /**
   * The docs-site or loader version the page was published under — Fabric
   * serves versioned snapshots at `docs.fabricmc.net/26.1.2/…`. Real metadata,
   * but not a Minecraft version, and storing it in `minecraft_version` made 115
   * documents unfilterable and put `26.1.2` in agent-facing version lists.
   */
  loaderVersion?: string;
}

/**
 * Detect the versions a document belongs to, from its URL and content.
 *
 * Target-family loaders (cleanroom/forge) have a FIXED version — their entire
 * corpus is 1.12.2, so content sniffing (which can match Forge's own version
 * numbers like "14.23.5") is skipped entirely.
 *
 * For reference loaders, every candidate is checked against
 * `MC_VERSION_PATTERN` before it is accepted as a Minecraft version. A URL
 * segment that is version-shaped but not Minecraft-shaped becomes the
 * `loaderVersion` instead of being silently mislabeled; a content match that
 * fails the shape is discarded outright, because prose is far too weak a signal
 * to justify inventing a version from it.
 *
 * Nothing is fabricated. A document with no establishable Minecraft version
 * keeps `undefined` — 359 pages in the corpus (`archive:changelog`, most wiki
 * tutorials) genuinely have none, and guessing would be worse than disclosing.
 */
export function detectVersions(url: string, content: string, loader?: Loader): DetectedVersions {
  const fixedVersion = loader ? defaultVersionFor(loader) : null;
  if (fixedVersion) {
    return { minecraftVersion: fixedVersion };
  }

  const result: DetectedVersions = {};

  // A version segment in the URL is the strongest signal available — but it is
  // only a *Minecraft* version if it is shaped like one.
  const urlVersion = url.match(/\/(\d+\.\d+(?:\.\d+)?)\//)?.[1];
  if (urlVersion) {
    if (isMinecraftVersion(urlVersion)) {
      result.minecraftVersion = urlVersion;
    } else {
      result.loaderVersion = urlVersion;
    }
  }

  if (result.minecraftVersion) {
    return result;
  }

  // Fall back to prose. Ordered most- to least-specific; the loose trailing
  // patterns are why '21.9' and '0.6.6' reached the column, so a match that is
  // not Minecraft-shaped is dropped rather than demoted to loaderVersion.
  const contentPatterns = [
    /Minecraft\s+(?:version\s+)?(\d+\.\d+(?:\.\d+)?)/i,
    /MC\s+(\d+\.\d+(?:\.\d+)?)/i,
    /version\s+(\d+\.\d+(?:\.\d+)?)/i,
    /for\s+(\d+\.\d+(?:\.\d+)?)/i,
  ];

  for (const pattern of contentPatterns) {
    const match = content.match(pattern)?.[1];
    if (match && isMinecraftVersion(match)) {
      result.minecraftVersion = match;
      break;
    }
  }

  return result;
}

/**
 * Minecraft version only.
 *
 * @deprecated Prefer `detectVersions`, which also reports the docs-site version
 * instead of discarding it.
 */
export function detectMinecraftVersion(
  url: string,
  content: string,
  loader?: Loader
): string | undefined {
  return detectVersions(url, content, loader).minecraftVersion;
}

/**
 * Get version-specific documentation
 */
export interface VersionInfo {
  version: string;
  releaseDate?: Date;
  isLatest: boolean;
  isLTS?: boolean;
}

export function parseVersionFromUrl(url: string): string | undefined {
  // Extract version from URLs like /1.20.1/ or /1.21/
  const match = url.match(/\/(\d+\.\d+(?:\.\d+)?)\//);
  return match ? match[1] : undefined;
}

/**
 * Compare semantic versions
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;

    if (part1 > part2) return 1;
    if (part1 < part2) return -1;
  }

  return 0;
}

/**
 * Get latest version from a list
 */
export function getLatestVersion(versions: string[]): string | undefined {
  if (versions.length === 0) return undefined;

  return versions.sort((a, b) => compareVersions(b, a))[0];
}
