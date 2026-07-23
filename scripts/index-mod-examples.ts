#!/usr/bin/env npx tsx
/* eslint-disable no-console */
/**
 * Mod Examples Indexer — builds examples.db (schema v2).
 *
 * Fully in-repo, reproducible pipeline (DESIGN.md Phase 5): for each roster repo
 * it downloads a pinned-SHA zipball, selects method/class snippets under the
 * repo's caps, analyzes each with a pluggable OpenAI-compatible LLM endpoint
 * (committed prompt, temperature 0), cross-links SRG + framework symbols against
 * the build machine's mappings.db / cleanroom-api.db, and ingests into a temp DB
 * that is atomically renamed into place.
 *
 * A configured endpoint is REQUIRED — with none set this exits non-zero and
 * writes nothing. CI never runs this; it carries the previous examples.db
 * forward. This script is NOT shipped in the npm package (maintainer/CI only).
 *
 * Usage:
 *   npx tsx scripts/index-mod-examples.ts [options]
 *
 * Options:
 *   --db-path <path>          Output path (default: data/examples.db)
 *   --roster <path>           Roster manifest (default: data/examples-roster.json)
 *   --mappings-db <path>      Build-machine mappings.db for SRG resolution (default: data/mappings.db)
 *   --cleanroom-api-db <path> Build-machine cleanroom-api.db for framework resolution (default: data/cleanroom-api.db)
 *   --repo-zip <path>         Offline: use this local zip for every roster repo (testing)
 *   --force                   Rebuild even when the DB is already up to date
 *   --llm-base-url <url>      LLM endpoint base URL (or CLEANROOM_MCP_LLM_BASE_URL)
 *   --llm-api-key <key>       LLM API key         (or CLEANROOM_MCP_LLM_API_KEY)
 *   --llm-model <id>          LLM model id        (or CLEANROOM_MCP_LLM_MODEL)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { DBS } from '../src/dbs.js';
import { LOCAL_BUILD_SOURCE } from '../src/db-versioning.js';
import { getDefaultDbPath } from '../src/data-dir.js';
import { MappingsService } from '../src/services/mappings-service.js';
import { CleanroomApiService } from '../src/services/cleanroom-api-service.js';
import {
  EXAMPLES_SCHEMA_VERSION,
  readDbMetadata,
  readDbSchemaVersion,
} from '../src/examples/schema.js';
import { acquireRepo } from '../src/examples/acquire.js';
import { selectSnippets } from '../src/examples/select.js';
import {
  analyzeSnippet,
  computeAnalysisVersion,
  createOpenAiClient,
  resolveEndpointConfig,
  EndpointNotConfiguredError,
  PIPELINE_REV,
} from '../src/examples/analyze.js';
import { resolveApiReferences, toExampleRecord } from '../src/examples/srg-link.js';
import { runIngest, isUpToDate, type ModMeta } from '../src/examples/ingest.js';
import type {
  AnalyzedSnippet,
  ExampleRecord,
  IngestMeta,
  LicenseReview,
  Roster,
  RosterRepo,
} from '../src/examples/model.js';

const PROMPT_FILE = path.join(process.cwd(), 'src/examples/prompts/analyze-snippet.v1.md');
const PROMPT_VERSION = 'v1';

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

interface CliOptions {
  dbPath: string;
  rosterPath: string;
  mappingsDb: string;
  cleanroomApiDb: string;
  repoZip: string | null;
  force: boolean;
}

function valueOf(argv: string[], flag: string, fallback: string): string {
  const idx = argv.indexOf(flag);
  const next = idx !== -1 ? argv[idx + 1] : undefined;
  return next && !next.startsWith('--') ? next : fallback;
}

function parseArgs(argv: string[]): CliOptions {
  const zip = argv.indexOf('--repo-zip');
  return {
    dbPath: valueOf(argv, '--db-path', path.join(process.cwd(), 'data', DBS.examples.fileName)),
    rosterPath: valueOf(argv, '--roster', path.join(process.cwd(), 'data', 'examples-roster.json')),
    mappingsDb: valueOf(argv, '--mappings-db', getDefaultBuildDb('mappings')),
    cleanroomApiDb: valueOf(argv, '--cleanroom-api-db', getDefaultBuildDb('cleanroom-api')),
    repoZip: zip !== -1 && argv[zip + 1] && !argv[zip + 1].startsWith('--') ? argv[zip + 1] : null,
    force: argv.includes('--force') || argv.includes('-f'),
  };
}

/** Prefer a repo-local data/ DB (maintainer's fresh build) over the data-dir copy. */
function getDefaultBuildDb(id: 'mappings' | 'cleanroom-api'): string {
  const local = path.join(process.cwd(), 'data', DBS[id].fileName);
  return fs.existsSync(local) ? local : getDefaultDbPath(DBS[id].fileName);
}

function openService<T>(
  dbPath: string,
  expectedSchema: number,
  make: (p: string) => T,
  label: string
): T | null {
  if (!fs.existsSync(dbPath)) {
    log('warn', `${label} not found at ${dbPath} — that enrichment degrades to NULL.`);
    return null;
  }
  // Schema-gate up front: a present-but-wrong-schema DB opens fine but throws at
  // query time (outside per-snippet isolation), so treat it as absent instead.
  const schema = readDbSchemaVersion(dbPath);
  if (schema !== expectedSchema) {
    log(
      'warn',
      `${label} schema v${schema ?? '?'} != expected v${expectedSchema} — enrichment degrades to NULL.`
    );
    return null;
  }
  try {
    return make(dbPath);
  } catch (e) {
    log('warn', `${label} could not be opened (${(e as Error).message}) — enrichment skipped.`);
    return null;
  }
}

async function main(): Promise<void> {
  banner('Mod Examples Indexer');
  const opts = parseArgs(process.argv.slice(2));

  // ── Endpoint is REQUIRED and resolved FIRST — before touching any file. ─────
  const endpoint = resolveEndpointConfig(process.argv.slice(2));
  const client = createOpenAiClient(endpoint);
  log('info', `LLM endpoint: ${endpoint.baseUrl} (model ${endpoint.model})`);
  log('info', `Database path: ${opts.dbPath}`);

  const prompt = fs.readFileSync(PROMPT_FILE, 'utf-8');
  const analysisVersion = computeAnalysisVersion({
    promptVersion: PROMPT_VERSION,
    model: endpoint.model,
    pipelineRev: PIPELINE_REV,
  });

  const roster = JSON.parse(fs.readFileSync(opts.rosterPath, 'utf-8')) as Roster;
  const rosterPins: Record<string, string> = {};
  for (const r of roster.repos) rosterPins[r.repo] = r.sha;

  // ── Up-to-date skip (roster SHAs ∧ analysis_version ∧ schema_version). ──────
  if (!opts.force && fs.existsSync(opts.dbPath)) {
    const existing = {
      roster_pins: JSON.parse(readDbMetadata(opts.dbPath, 'roster_pins') ?? '{}') as Record<
        string,
        string
      >,
      analysis_version: readDbMetadata(opts.dbPath, 'analysis_version') ?? '',
      schema_version: readDbSchemaVersion(opts.dbPath) ?? -1,
    };
    const target = {
      roster_pins: rosterPins,
      analysis_version: analysisVersion,
      schema_version: EXAMPLES_SCHEMA_VERSION,
    };
    if (isUpToDate(existing, target)) {
      log('success', `Database already up to date (analysis ${analysisVersion}) — nothing to do.`);
      log('info', 'Use --force to rebuild anyway.');
      return;
    }
  }

  const mappings = openService(
    opts.mappingsDb,
    DBS.mappings.schemaVersion,
    (p) => new MappingsService(p),
    'mappings.db (SRG resolution)'
  );
  const api = openService(
    opts.cleanroomApiDb,
    DBS['cleanroom-api'].schemaVersion,
    (p) => new CleanroomApiService(p),
    'cleanroom-api.db (framework resolution)'
  );

  const githubToken = process.env.GITHUB_TOKEN;
  const records: ExampleRecord[] = [];
  const mods: ModMeta[] = [];
  const licenseReview: Record<string, LicenseReview & { license: string }> = {};

  try {
    for (let repoIdx = 0; repoIdx < roster.repos.length; repoIdx++) {
      const repo: RosterRepo = roster.repos[repoIdx];
      banner(`${repo.name} (${repo.repo})`);
      licenseReview[repo.repo] = { ...repo.licenseReview, license: repo.license };

      // Isolate each repo: an acquire/network failure on one repo must not
      // discard other repos' already-analyzed (already-paid-for) records.
      try {
        log('info', `Downloading ${repo.repo} @ ${repo.sha || repo.ref}`);
        const files = await acquireRepo(repo, {
          zipPath: opts.repoZip ?? undefined,
          githubToken,
        });
        log('info', `${files.length} .java files in the tree`);

        const snippets = selectSnippets(
          files,
          {
            repo: repo.repo,
            modName: repo.name,
            loader: repo.loader,
            license: repo.license,
            include: repo.include,
            exclude: repo.exclude,
            maxFileBytes: repo.maxFileBytes,
            maxSnippetsPerRepo: repo.maxSnippetsPerRepo,
            maxSnippetLines: roster.snippetLineCap,
            ref: repo.sha || repo.ref,
          },
          { log: (m) => log('debug', m) }
        );
        log('info', `Selected ${snippets.length} snippets — analyzing…`);

        let analyzedCount = 0;
        let failedCount = 0;
        for (const snippet of snippets) {
          // Isolate each snippet end-to-end (analyze + enrich + record-build): a
          // single bad completion OR an enrichment query error must not discard
          // the whole run. Retry the LLM call once, then log and skip.
          try {
            let analysis;
            try {
              analysis = await analyzeSnippet(snippet, client, prompt);
            } catch {
              analysis = await analyzeSnippet(snippet, client, prompt);
            }
            const analyzed: AnalyzedSnippet = { snippet, analysis };
            const apiRefs = resolveApiReferences(analyzed, {
              mappings,
              api,
              minecraftVersion: '1.12.2',
            });
            records.push(toExampleRecord(analyzed, apiRefs));
            analyzedCount++;
            if (analyzedCount % 10 === 0) {
              log('debug', `  ${analyzedCount}/${snippets.length} analyzed`);
            }
          } catch (err) {
            failedCount++;
            log(
              'warn',
              `  skip ${snippet.filePath}:${snippet.startLine} — ${(err as Error).message}`
            );
          }
        }
        if (failedCount > 0) {
          log('warn', `${repo.name}: ${failedCount} snippet(s) skipped after failure`);
        }

        mods.push({
          name: repo.name,
          repo: repo.repo,
          loader: repo.loader,
          license: repo.license,
          description: repo.description,
          minecraftVersions: repo.minecraftVersions ?? ['1.12.2'],
          starCount: repo.starCount,
          priority: roster.repos.length - repoIdx, // roster order → rank
        });
        log('success', `${repo.name}: ${analyzedCount} examples`);
      } catch (err) {
        log('error', `${repo.name}: repo failed, skipping — ${(err as Error).message}`);
      }
    }
  } finally {
    mappings?.close();
    api?.close();
  }

  // ── Ingest (atomic tmp + rename). ───────────────────────────────────────────
  banner('Ingest');
  const meta: IngestMeta = {
    analysisVersion,
    promptVersion: PROMPT_VERSION,
    llmModel: endpoint.model,
    rosterPins,
    licenseReview,
  };
  fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
  const counts = runIngest({ dbPath: opts.dbPath, records, mods, meta });

  // ── Local-build manifest (so startup auto-update never clobbers it). ────────
  const stat = fs.statSync(opts.dbPath);
  const localManifest = {
    version: '0.0.0-local',
    timestamp: new Date().toISOString(),
    type: 'full',
    hash: crypto.createHash('sha256').update(fs.readFileSync(opts.dbPath)).digest('hex'),
    size: stat.size,
    downloadUrl: '',
    changelog: `Built locally by index-mod-examples.ts (analysis ${analysisVersion})`,
    source: LOCAL_BUILD_SOURCE,
  };
  fs.writeFileSync(
    path.join(path.dirname(opts.dbPath), DBS.examples.manifestName),
    JSON.stringify(localManifest, null, 2)
  );

  banner('Summary');
  log(
    'success',
    `Indexed ${counts.examples} examples from ${counts.mods} mods into ${opts.dbPath}`
  );
  log('info', `  Categories used:  ${counts.categories}`);
  log('info', `  Tags:             ${counts.tags}`);
  log('info', `  Imports:          ${counts.imports}`);
  log('info', `  API references:   ${counts.apiReferences}`);
  log('info', `  SRG resolved:     ${counts.srgResolved}`);
  log('info', `  Framework linked: ${counts.apiResolved}`);
  for (const [loader, n] of Object.entries(counts.byLoader)) {
    log('info', `  ${loader.padEnd(16)} ${n} examples`);
  }
  const sizeMb = fs.statSync(opts.dbPath).size / 1024 / 1024;
  log('info', `  Database size:    ${sizeMb.toFixed(1)} MB`);
}

main().catch((error) => {
  if (error instanceof EndpointNotConfiguredError) {
    log('error', error.message);
    process.exit(1);
  }
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  log('error', `Indexing failed: ${message}`);
  process.exit(1);
});
