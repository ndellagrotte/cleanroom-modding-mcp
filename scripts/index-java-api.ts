#!/usr/bin/env npx tsx
/* eslint-disable no-console */
/**
 * Cleanroom API Indexer — builds cleanroom-api.db (schema v1).
 *
 * Downloads the published `com.cleanroommc:cleanroom:<version>:sources` jar
 * from repo.cleanroommc.com (the maven explicitly published for mod
 * development), parses the framework namespaces (com.cleanroommc.*,
 * zone.rong.*, net.minecraftforge.*) with tree-sitter-java (wasm), resolves
 * the type graph, and writes the symbols + events/annotations catalogs.
 *
 * The gitignored cleanroom-src/ checkout is NEVER read (DESIGN.md §6.3);
 * offline runs pass --sources-jar with a previously downloaded jar.
 *
 * This orchestration script is NOT included in the npm package — for
 * local/maintainer/CI use only. There is no on-device build path for this DB.
 *
 * Usage:
 *   npx tsx scripts/index-java-api.ts [options]
 *
 * Options:
 *   --cleanroom-version <v>  Index this Cleanroom version (default: maven latest)
 *   --sources-jar <path>     Use a local sources jar instead of downloading
 *   --db-path <path>         Output path (default: data/cleanroom-api.db)
 *   --force                  Rebuild even when the DB is already up to date
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import AdmZip from 'adm-zip';
import { createRequire } from 'module';
import { DBS, USER_AGENT } from '../src/dbs.js';
import { LOCAL_BUILD_SOURCE } from '../src/db-versioning.js';
import {
  CLEANROOM_API_SCHEMA_VERSION,
  readDbMetadata,
  readDbSchemaVersion,
} from '../src/cleanroom-api/schema.js';
import { createJavaParser } from '../src/cleanroom-api/java-parser.js';
import { extractFile } from '../src/cleanroom-api/extract.js';
import { resolveAll } from '../src/cleanroom-api/resolve.js';
import { ingest } from '../src/cleanroom-api/ingest.js';
import type { ExtractedFile } from '../src/cleanroom-api/model.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CLEANROOM_MAVEN_BASE = 'https://repo.cleanroommc.com/releases';
const CLEANROOM_GROUP_PATH = 'com/cleanroommc/cleanroom';

const CONFIG = {
  metadataUrl: `${CLEANROOM_MAVEN_BASE}/${CLEANROOM_GROUP_PATH}/maven-metadata.xml`,
  dbPath: path.join(process.cwd(), 'data', DBS['cleanroom-api'].fileName),
  /** Jar entries to index; vanilla net.minecraft.* deliberately excluded. */
  entryPattern: /^(com\/cleanroommc|zone\/rong|net\/minecraftforge)\/.*\.java$/,
  /** Fail loud when the jar looks corrupt or mispackaged. */
  minExpectedFiles: 400,
  downloadTimeoutMs: 120_000,
};

function sourcesJarUrl(version: string): string {
  return `${CLEANROOM_MAVEN_BASE}/${CLEANROOM_GROUP_PATH}/${version}/cleanroom-${version}-sources.jar`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function log(level: 'info' | 'warn' | 'error' | 'success' | 'debug', message: string): void {
  const icons = { info: 'ℹ️', warn: '⚠️', error: '❌', success: '✅', debug: '🔍' };
  const colorMap = {
    info: colors.cyan,
    warn: colors.yellow,
    error: colors.red,
    success: colors.green,
    debug: colors.dim,
  };
  console.log(`${colorMap[level]}${icons[level]} ${message}${colors.reset}`);
}

function banner(title: string): void {
  console.log(`\n${colors.bright}${colors.cyan}${'═'.repeat(60)}${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}  ${title}${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}${'═'.repeat(60)}${colors.reset}\n`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// NETWORK
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.text();
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(CONFIG.downloadTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Latest tagged Cleanroom release per the maven metadata (e.g. '0.6.3-alpha'). */
async function fetchLatestCleanroomVersion(): Promise<string> {
  const xml = await fetchText(CONFIG.metadataUrl);
  const match = xml.match(/<latest>([^<]+)<\/latest>/) ?? xml.match(/<release>([^<]+)<\/release>/);
  if (!match) {
    throw new Error(`No <latest> version found in ${CONFIG.metadataUrl}`);
  }
  return match[1].trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

interface CliOptions {
  cleanroomVersion: string | null;
  sourcesJar: string | null;
  dbPath: string;
  force: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const valueOf = (flag: string): string | null => {
    const idx = argv.indexOf(flag);
    const next = idx !== -1 ? argv[idx + 1] : undefined;
    return next && !next.startsWith('--') ? next : null;
  };
  return {
    cleanroomVersion: valueOf('--cleanroom-version'),
    sourcesJar: valueOf('--sources-jar'),
    dbPath: valueOf('--db-path') ?? CONFIG.dbPath,
    force: argv.includes('--force') || argv.includes('-f'),
  };
}

function parserInfo(): string {
  const require = createRequire(import.meta.url);
  // web-tree-sitter's exports map hides ./package.json; resolve the entry
  // point and walk up to the nearest package.json instead.
  const readVersion = (pkg: string): string => {
    let dir = path.dirname(require.resolve(pkg));
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        return (JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { version: string }).version;
      }
      dir = path.dirname(dir);
    }
    return 'unknown';
  };
  return `web-tree-sitter@${readVersion('web-tree-sitter')} + tree-sitter-java@${readVersion('tree-sitter-java')}`;
}

async function main(): Promise<void> {
  banner('Cleanroom API Indexer');

  const opts = parseArgs(process.argv.slice(2));
  log('info', `Database path: ${opts.dbPath}`);
  if (opts.sourcesJar) {
    log('info', `Local sources jar: ${opts.sourcesJar}`);
  }

  // ── Resolve the target Cleanroom version ────────────────────────────────────
  let version = opts.cleanroomVersion;
  if (!version) {
    if (opts.sourcesJar) {
      version = 'local';
      log('warn', `No --cleanroom-version given for the local jar — recording version as 'local'`);
    } else {
      log('info', `Fetching latest Cleanroom version from ${CONFIG.metadataUrl}`);
      version = await fetchLatestCleanroomVersion();
      log('success', `Latest Cleanroom release: ${version}`);
    }
  }

  // ── Up-to-date check (drives the weekly job's no-op skip) ───────────────────
  // With --sources-jar the jar hash joins the check: version 'local' must not
  // let a different jar skip the rebuild.
  let localJarSha256: string | null = null;
  if (opts.sourcesJar) {
    localJarSha256 = crypto
      .createHash('sha256')
      .update(fs.readFileSync(opts.sourcesJar))
      .digest('hex');
  }
  if (!opts.force && fs.existsSync(opts.dbPath)) {
    const existingVersion = readDbMetadata(opts.dbPath, 'cleanroom_version');
    const existingSchema = readDbSchemaVersion(opts.dbPath);
    const existingJarSha = opts.sourcesJar
      ? readDbMetadata(opts.dbPath, 'sources_jar_sha256')
      : null;
    if (
      existingVersion === version &&
      existingSchema === CLEANROOM_API_SCHEMA_VERSION &&
      (!opts.sourcesJar || existingJarSha === localJarSha256)
    ) {
      log(
        'success',
        `Database already indexes Cleanroom ${version} (schema v${existingSchema}) — nothing to do.`
      );
      log('info', 'Use --force to rebuild anyway.');
      return;
    }
    if (existingVersion) {
      log(
        'info',
        `Existing DB indexes Cleanroom ${existingVersion} (schema v${existingSchema ?? '?'}) — rebuilding for ${version}.`
      );
    }
  }

  fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });

  const tmpDbPath = `${opts.dbPath}.tmp`;
  try {
    // ── Obtain the sources jar ────────────────────────────────────────────────
    let jarBuffer: Buffer;
    let jarUrl: string | null = null;
    if (opts.sourcesJar) {
      jarBuffer = fs.readFileSync(opts.sourcesJar);
    } else {
      jarUrl = sourcesJarUrl(version);
      log('info', `Downloading ${jarUrl}`);
      jarBuffer = await fetchBuffer(jarUrl);
      log('success', `Downloaded sources jar (${(jarBuffer.length / 1024 / 1024).toFixed(1)} MB)`);
    }
    const jarSha256 = crypto.createHash('sha256').update(jarBuffer).digest('hex');
    log('debug', `sha256: ${jarSha256}`);

    // ── Select entries ────────────────────────────────────────────────────────
    const zip = new AdmZip(jarBuffer);
    const entries = zip
      .getEntries()
      .filter(
        (e) =>
          !e.isDirectory &&
          CONFIG.entryPattern.test(e.entryName) &&
          !e.entryName.endsWith('package-info.java')
      );
    log('info', `Matched ${entries.length} framework source files in the jar`);
    if (entries.length < CONFIG.minExpectedFiles) {
      throw new Error(
        `Only ${entries.length} framework .java entries matched (expected >= ${CONFIG.minExpectedFiles}) — corrupt or mispackaged jar?`
      );
    }

    // ── Pass 1: extraction ────────────────────────────────────────────────────
    banner('Pass 1 — Extraction (tree-sitter-java)');
    const parser = await createJavaParser();
    const files: ExtractedFile[] = [];
    let parseErrorFiles = 0;
    let skippedFiles = 0;
    for (const entry of entries) {
      const source = entry.getData().toString('utf-8');
      const extracted = extractFile(parser, source, entry.entryName);
      if (!extracted) {
        skippedFiles++;
        log('warn', `Skipped (no package or unparseable): ${entry.entryName}`);
        continue;
      }
      if (extracted.parseErrors) {
        parseErrorFiles++;
        log('debug', `Syntax errors (partial extraction): ${entry.entryName}`);
      }
      files.push(extracted);
    }
    log(
      'success',
      `Extracted ${files.length} files (${parseErrorFiles} with partial parses, ${skippedFiles} skipped)`
    );

    // ── Pass 2: resolution + catalogs ─────────────────────────────────────────
    banner('Pass 2 — Resolution and catalogs');
    const resolved = resolveAll(files);
    log(
      'info',
      `Types: ${resolved.stats.totalTypes.toLocaleString()} | Members: ${resolved.stats.totalMembers.toLocaleString()}`
    );
    log(
      'info',
      `Events: ${resolved.stats.events.toLocaleString()} | Annotation types: ${resolved.stats.annotationTypes.toLocaleString()}`
    );
    log(
      'info',
      `Parents resolved: ${resolved.stats.resolvedParents.toLocaleString()} | external/unresolved: ${resolved.stats.unresolvedParents.toLocaleString()}`
    );

    // ── Ingest into a temp DB, then atomically move into place ────────────────
    banner('Ingest');
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${tmpDbPath}${suffix}`, { force: true });
    }
    const counts = ingest(tmpDbPath, resolved, {
      cleanroomVersion: version,
      sourcesJarUrl: jarUrl,
      sourcesJarSha256: jarSha256,
      parserInfo: parserInfo(),
    });
    // Close-out above checkpoints WAL. rename(2) atomically replaces the
    // destination on POSIX; on Windows the rename fails while the destination
    // exists, so fall back to remove+rename (a small crash window there).
    for (const suffix of ['-wal', '-shm']) {
      fs.rmSync(`${opts.dbPath}${suffix}`, { force: true });
    }
    try {
      fs.renameSync(tmpDbPath, opts.dbPath);
    } catch {
      fs.rmSync(opts.dbPath, { force: true });
      fs.renameSync(tmpDbPath, opts.dbPath);
    }

    // Mark the DB as locally built (next to it, same basename convention as
    // manage's local-build manifest) so startup auto-update never silently
    // replaces a maintainer-built DB with a release asset.
    const stat = fs.statSync(opts.dbPath);
    const localManifest = {
      version: '0.0.0-local',
      timestamp: new Date().toISOString(),
      type: 'full',
      hash: crypto.createHash('sha256').update(fs.readFileSync(opts.dbPath)).digest('hex'),
      size: stat.size,
      downloadUrl: '',
      changelog: `Built locally by index-java-api.ts from Cleanroom ${version} (sources jar sha256 ${jarSha256})`,
      source: LOCAL_BUILD_SOURCE,
    };
    fs.writeFileSync(
      path.join(path.dirname(opts.dbPath), DBS['cleanroom-api'].manifestName),
      JSON.stringify(localManifest, null, 2)
    );

    // ── Summary ───────────────────────────────────────────────────────────────
    banner('Summary');
    log('success', `Indexed Cleanroom ${version} into ${opts.dbPath}`);
    log('info', `  Types:            ${counts.types.toLocaleString()}`);
    log('info', `  Members:          ${counts.members.toLocaleString()}`);
    log('info', `  Events:           ${counts.events.toLocaleString()}`);
    log('info', `  Annotation types: ${counts.annotationTypes.toLocaleString()}`);
    log('info', `  Deprecated types: ${counts.deprecatedTypes.toLocaleString()}`);
    for (const [ns, count] of Object.entries(counts.byNamespace)) {
      log('info', `  ${ns.padEnd(20)} ${count.toLocaleString()} types`);
    }
    const sizeMb = fs.statSync(opts.dbPath).size / 1024 / 1024;
    log('info', `  Database size:    ${sizeMb.toFixed(1)} MB`);
  } catch (error) {
    // No partial DB may ever land at the real path.
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${tmpDbPath}${suffix}`, { force: true });
    }
    throw error;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  log('error', `Indexing failed: ${message}`);
  process.exit(1);
});
