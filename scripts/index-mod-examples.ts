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
 * Phase 5 Revision 1 (maintainer-paid endpoint): spend is visible before it
 * happens (--estimate), bounded during it (--llm-max-cost-usd, exit 2 on a
 * budget-truncated corpus), never repeated (content-addressed analysis cache),
 * and recorded in the shipped DB's provenance metadata (llm_base_host/llm_cost).
 *
 * Coverage gate: a corpus that leaves an EXAMPLE_CATEGORIES slug at zero exits 3.
 * The taxonomy is also the `search_mod_examples` filter enum, so an empty
 * category is a filter value the shipped server offers and can never satisfy
 * (beta report N2). --allow-empty-categories is the deliberate override.
 *
 * Usage:
 *   npx tsx scripts/index-mod-examples.ts [options]
 *
 * Options:
 *   --db-path <path>            Output path (default: data/examples.db)
 *   --roster <path>             Roster manifest (default: data/examples-roster.json)
 *   --mappings-db <path>        Build-machine mappings.db for SRG resolution (default: data/mappings.db)
 *   --cleanroom-api-db <path>   Build-machine cleanroom-api.db for framework resolution (default: data/cleanroom-api.db)
 *   --repo-zip <path>           Offline: use this local zip for every roster repo (testing)
 *   --force                     Rebuild even when the DB is already up to date
 *   --llm-base-url <url>        LLM endpoint base URL (or CLEANROOM_MCP_LLM_BASE_URL)
 *   --llm-api-key <key>         LLM API key         (or CLEANROOM_MCP_LLM_API_KEY)
 *   --llm-model <id>            LLM model id        (or CLEANROOM_MCP_LLM_MODEL)
 *   --llm-temperature <n>       Request temperature (or CLEANROOM_MCP_LLM_TEMPERATURE;
 *                               default 0 — some endpoints reject 0 with HTTP 400; the
 *                               config file may declare "temperature": null to omit the
 *                               field entirely, e.g. for Moonshot's kimi-k2.6)
 *   --estimate                  Dry run: project snippets/cache/tokens/cost, then exit 0.
 *                               Zero LLM calls, zero writes (no DB, no manifest, no cache mutation).
 *   --llm-max-cost-usd <n>      Hard budget cap (or CLEANROOM_MCP_LLM_MAX_COST_USD). Stops analysis
 *                               before any call that would start at/over the cap, ingests the
 *                               partial corpus, exits 2. Requires pricing in data/examples-llm.json.
 *   --llm-max-retries <n>       429/503 retries inside the client (default: 5)
 *   --llm-concurrency <n>       Concurrent analyses within a repo (default: 4; 1 = serial).
 *                               Example ids/DB content stay order-deterministic at any n.
 *   --llm-est-output-tokens <n> Fixed output-token allowance per snippet for --estimate (default: 350)
 *   --analysis-cache <path>     Analysis cache DB (default: data/examples-analysis-cache.db)
 *   --no-cache                  Bypass cache reads AND writes (a deliberate full re-spend)
 *   --allow-empty-categories    Ship a corpus that leaves an EXAMPLE_CATEGORIES slug at zero
 *                               examples. Without it such a build exits 3 (see below).
 *
 * Endpoint/pricing precedence (highest first): CLI flag → env var → committed
 * config file data/examples-llm.json (non-secret; the API key is never in it).
 * The config file is also the only carrier of provider-specific request-body
 * extensions ("extraBody", e.g. Moonshot's `"thinking": {"type": "disabled"}`)
 * so the pipeline code stays provider-agnostic. analysis_version covers the
 * effective request knobs (temperature + extraBody): changing them re-bills
 * the full corpus, exactly like a model change.
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
import { THIN_CATEGORY_THRESHOLD, auditCategoryCoverage } from '../src/categories.js';
import { selectSnippets } from '../src/examples/select.js';
import {
  analyzeSnippet,
  buildPrompt,
  computeAnalysisVersion,
  createOpenAiClient,
  estimateTokens,
  isTransientLlmError,
  renderPromptTemplate,
  resolveEndpointConfig,
  EndpointNotConfiguredError,
  PIPELINE_REV,
} from '../src/examples/analyze.js';
import { openAnalysisCache, hashSnippet, type AnalysisCache } from '../src/examples/cache.js';
import { resolveApiReferences, toExampleRecord } from '../src/examples/srg-link.js';
import { runIngest, isUpToDate, type ModMeta } from '../src/examples/ingest.js';
import type {
  Analysis,
  AnalyzedSnippet,
  AnalyzeOutcome,
  ExampleRecord,
  IngestMeta,
  LicenseReview,
  LlmPricing,
  RawFile,
  Roster,
  RosterRepo,
  Snippet,
} from '../src/examples/model.js';

const PROMPT_FILE = path.join(process.cwd(), 'src/examples/prompts/analyze-snippet.v2.md');
const PROMPT_VERSION = 'v2';
/** Uncategorized share above this (%) warns in the summary — a taxonomy smell. */
const UNCATEGORIZED_WARN_PCT = 10;
/** Committed, non-secret endpoint + pricing declaration (Revision 1 §4.1). */
const LLM_CONFIG_FILE = path.join(process.cwd(), 'data', 'examples-llm.json');

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
  estimate: boolean;
  llmMaxCostUsd: number | null;
  llmMaxRetries: number;
  llmConcurrency: number;
  llmEstOutputTokens: number;
  analysisCachePath: string;
  noCache: boolean;
  allowEmptyCategories: boolean;
}

function valueOf(argv: string[], flag: string, fallback: string): string {
  const idx = argv.indexOf(flag);
  const next = idx !== -1 ? argv[idx + 1] : undefined;
  return next && !next.startsWith('--') ? next : fallback;
}

function intOf(argv: string[], flag: string, fallback: number, min: number): number {
  const raw = valueOf(argv, flag, '');
  if (raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function parseArgs(argv: string[]): CliOptions {
  const capRaw =
    valueOf(argv, '--llm-max-cost-usd', '') || process.env.CLEANROOM_MCP_LLM_MAX_COST_USD || '';
  let llmMaxCostUsd: number | null = null;
  if (capRaw.trim() !== '') {
    const n = Number(capRaw);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(
        `Invalid --llm-max-cost-usd value '${capRaw}' (expected a non-negative number)`
      );
    }
    llmMaxCostUsd = n;
  }
  return {
    dbPath: valueOf(argv, '--db-path', path.join(process.cwd(), 'data', DBS.examples.fileName)),
    rosterPath: valueOf(argv, '--roster', path.join(process.cwd(), 'data', 'examples-roster.json')),
    mappingsDb: valueOf(argv, '--mappings-db', getDefaultBuildDb('mappings')),
    cleanroomApiDb: valueOf(argv, '--cleanroom-api-db', getDefaultBuildDb('cleanroom-api')),
    repoZip: valueOf(argv, '--repo-zip', '') || null,
    force: argv.includes('--force') || argv.includes('-f'),
    estimate: argv.includes('--estimate'),
    llmMaxCostUsd,
    llmMaxRetries: intOf(argv, '--llm-max-retries', 5, 0),
    llmConcurrency: intOf(argv, '--llm-concurrency', 4, 1),
    llmEstOutputTokens: intOf(argv, '--llm-est-output-tokens', 350, 1),
    analysisCachePath: valueOf(
      argv,
      '--analysis-cache',
      path.join(process.cwd(), 'data', 'examples-analysis-cache.db')
    ),
    noCache: argv.includes('--no-cache'),
    allowEmptyCategories: argv.includes('--allow-empty-categories'),
  };
}

/** Prefer a repo-local data/ DB (maintainer's fresh build) over the data-dir copy. */
function getDefaultBuildDb(id: 'mappings' | 'cleanroom-api'): string {
  const local = path.join(process.cwd(), 'data', DBS[id].fileName);
  return fs.existsSync(local) ? local : getDefaultDbPath(DBS[id].fileName);
}

// ─────────────────────────────────────────────────────────────────────────────
// Config file + pricing (Revision 1 §4.1) — non-secret; the API key never lives here
// ─────────────────────────────────────────────────────────────────────────────

interface LlmFileConfig {
  baseUrl?: string;
  model?: string;
  /** Number → send it; explicit null → omit the field; absent → frozen default 0. */
  temperature?: number | null;
  /** Provider-specific request-body extensions (see EndpointConfig.extraBody). */
  extraBody?: Record<string, unknown>;
  pricing?: LlmPricing;
}

function loadLlmFileConfig(configPath: string): LlmFileConfig {
  if (!fs.existsSync(configPath)) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Could not parse ${configPath}: ${(e as Error).message}`);
  }
  const out: LlmFileConfig = {};
  if (typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim() !== '') {
    out.baseUrl = parsed.baseUrl;
  }
  if (typeof parsed.model === 'string' && parsed.model.trim() !== '') {
    out.model = parsed.model;
  }
  if (typeof parsed.temperature === 'number' && Number.isFinite(parsed.temperature)) {
    out.temperature = parsed.temperature;
  } else if (parsed.temperature === null) {
    // Explicit null: omit the temperature field (the endpoint's default applies).
    out.temperature = null;
  }
  if (
    parsed.extraBody &&
    typeof parsed.extraBody === 'object' &&
    !Array.isArray(parsed.extraBody)
  ) {
    out.extraBody = parsed.extraBody as Record<string, unknown>;
  }
  const p = parsed.pricing as Record<string, unknown> | undefined;
  if (
    p &&
    typeof p === 'object' &&
    typeof p.inputPer1M === 'number' &&
    typeof p.outputPer1M === 'number'
  ) {
    out.pricing = {
      inputPer1M: p.inputPer1M,
      outputPer1M: p.outputPer1M,
      currency: typeof p.currency === 'string' ? p.currency : 'USD',
    };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run ledger (Revision 1 §4.2) — accumulated across the whole run
// ─────────────────────────────────────────────────────────────────────────────

interface RunLedger {
  promptTokens: number;
  completionTokens: number;
  calls: number;
  cacheHits: number;
  cacheWrites: number;
  tokensSaved: number;
}

function ledgerCostUsd(ledger: RunLedger, pricing: LlmPricing): number {
  return (
    (ledger.promptTokens * pricing.inputPer1M + ledger.completionTokens * pricing.outputPer1M) /
    1_000_000
  );
}

/** The llm_cost provenance row (Revision 1 §4.7). */
function ledgerJson(ledger: RunLedger, pricing: LlmPricing | null): string {
  return JSON.stringify({
    prompt_tokens: ledger.promptTokens,
    completion_tokens: ledger.completionTokens,
    calls: ledger.calls,
    cache_hits: ledger.cacheHits,
    cache_writes: ledger.cacheWrites,
    tokens_saved: ledger.tokensSaved,
    estimated_usd: pricing ? Number(ledgerCostUsd(ledger, pricing).toFixed(6)) : null,
    pricing,
  });
}

/**
 * Run `worker` over items with at most `concurrency` in flight. Workers write
 * into index-addressed slots, so downstream order never depends on completion
 * order (Revision 1 §4.6).
 */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  // Index-addressed entries: an exhausted queue reads as `undefined`, so the
  // lane needs no bounds assertion.
  const queue = items.map((item, index) => ({ item, index }));
  let next = 0;
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  const runLane = async (): Promise<void> => {
    let entry = queue[next++];
    while (entry !== undefined) {
      await worker(entry.item, entry.index);
      entry = queue[next++];
    }
  };
  await Promise.all(Array.from({ length: lanes }, runLane));
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

function selectForRepo(repo: RosterRepo, roster: Roster, files: RawFile[]): Snippet[] {
  return selectSnippets(
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Estimate mode (Revision 1 §4.3) — dry run: zero LLM calls, zero writes
// ─────────────────────────────────────────────────────────────────────────────

async function runEstimate(
  opts: CliOptions,
  roster: Roster,
  prompt: string,
  analysisVersion: string,
  pricing: LlmPricing | null
): Promise<void> {
  banner('Estimate (dry run — zero LLM calls, zero writes)');

  // Consult the cache read-only, and only when it already exists — opening a
  // missing path with better-sqlite3 would CREATE the file (a cache mutation).
  let cache: AnalysisCache | null = null;
  if (!opts.noCache && fs.existsSync(opts.analysisCachePath)) {
    try {
      cache = openAnalysisCache(opts.analysisCachePath, { readonly: true });
    } catch (e) {
      log('warn', `Analysis cache unreadable (${(e as Error).message}) — projecting all misses.`);
      cache = null;
    }
  }

  const githubToken = process.env.GITHUB_TOKEN;
  const rows: Array<{
    name: string;
    snippets: number;
    hits: number;
    misses: number;
    inTokens: number;
    outTokens: number;
    cost: number | null;
  }> = [];

  try {
    for (const repo of roster.repos) {
      try {
        log('info', `Scanning ${repo.repo} @ ${repo.sha || repo.ref}…`);
        const files = await acquireRepo(repo, {
          zipPath: opts.repoZip ?? undefined,
          githubToken,
        });
        const snippets = selectForRepo(repo, roster, files);

        let hits = 0;
        let inTokens = 0;
        for (const snippet of snippets) {
          if (cache?.getCached(hashSnippet(snippet), analysisVersion)) {
            hits++;
            continue;
          }
          // Input side is exact: the real prompt bodies buildPrompt would emit.
          inTokens += estimateTokens(buildPrompt(prompt, snippet));
        }
        const misses = snippets.length - hits;
        // Output side is the only soft term: a fixed per-snippet allowance.
        const outTokens = misses * opts.llmEstOutputTokens;
        const cost = pricing
          ? (inTokens * pricing.inputPer1M + outTokens * pricing.outputPer1M) / 1_000_000
          : null;
        rows.push({
          name: repo.name,
          snippets: snippets.length,
          hits,
          misses,
          inTokens,
          outTokens,
          cost,
        });
      } catch (err) {
        log(
          'error',
          `${repo.name}: scan failed, excluded from projection — ${(err as Error).message}`
        );
      }
    }
  } finally {
    cache?.close();
  }

  const fmtCost = (c: number | null): string => (c === null ? '—' : `$${c.toFixed(4)}`);
  const header = `  ${'Repo'.padEnd(26)}${'snips'.padStart(7)}${'hits'.padStart(7)}${'miss'.padStart(7)}${'in tok'.padStart(11)}${'out tok'.padStart(11)}${'est cost'.padStart(12)}`;
  console.log(header);
  console.log(`  ${'─'.repeat(78)}`);
  for (const r of rows) {
    console.log(
      `  ${r.name.padEnd(26)}${String(r.snippets).padStart(7)}${String(r.hits).padStart(7)}` +
        `${String(r.misses).padStart(7)}${String(r.inTokens).padStart(11)}` +
        `${String(r.outTokens).padStart(11)}${fmtCost(r.cost).padStart(12)}`
    );
  }
  const total = rows.reduce(
    (acc, r) => ({
      snippets: acc.snippets + r.snippets,
      hits: acc.hits + r.hits,
      misses: acc.misses + r.misses,
      inTokens: acc.inTokens + r.inTokens,
      outTokens: acc.outTokens + r.outTokens,
      cost: r.cost === null ? acc.cost : acc.cost === null ? null : acc.cost + r.cost,
    }),
    // The assertion is load-bearing, despite what no-unnecessary-type-assertion
    // thinks: this seed omits `name`, so reduce infers the accumulator from the
    // literal rather than from the row type. A bare `0` pins cost to `number`,
    // which the callback's `number | null` return then fails to satisfy.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    { snippets: 0, hits: 0, misses: 0, inTokens: 0, outTokens: 0, cost: 0 as number | null }
  );
  console.log(`  ${'─'.repeat(78)}`);
  console.log(
    `  ${'TOTAL'.padEnd(26)}${String(total.snippets).padStart(7)}${String(total.hits).padStart(7)}` +
      `${String(total.misses).padStart(7)}${String(total.inTokens).padStart(11)}` +
      `${String(total.outTokens).padStart(11)}${fmtCost(total.cost).padStart(12)}`
  );
  console.log('');
  log('info', `Target analysis_version: ${analysisVersion}`);
  log(
    'info',
    `Input tokens are measured over the real prompt bodies (chars/4); output tokens are a fixed ` +
      `${opts.llmEstOutputTokens}/snippet allowance — the only soft term.`
  );
  if (!pricing) {
    log(
      'warn',
      'No pricing configured — cost column omitted. Set pricing in data/examples-llm.json.'
    );
  }
  log('success', 'Estimate complete — zero LLM calls made, nothing written.');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

interface SlotResult {
  snippet: Snippet;
  outcome: 'ok' | 'failed' | 'budget';
  record?: ExampleRecord;
  error?: string;
}

async function main(): Promise<number> {
  banner('Mod Examples Indexer');
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  // ── Endpoint is REQUIRED and resolved FIRST — before touching any other file.
  // The committed config file is a layer of endpoint resolution itself, so it
  // is read here; with no endpoint anywhere this throws before any other I/O.
  const fileConfig = loadLlmFileConfig(LLM_CONFIG_FILE);
  const endpoint = resolveEndpointConfig(argv, process.env, fileConfig);
  const pricing = fileConfig.pricing ?? null;

  // ── A budget cap without resolvable pricing fails at startup, before any call.
  if (opts.llmMaxCostUsd !== null && !pricing) {
    log(
      'error',
      '--llm-max-cost-usd requires resolvable pricing, and none is configured.\n' +
        'Declare the maintainer list prices in data/examples-llm.json, e.g.\n' +
        '  "pricing": { "inputPer1M": 0.15, "outputPer1M": 0.60, "currency": "USD" }'
    );
    return 1;
  }

  const client = createOpenAiClient(endpoint, {
    maxRetries: opts.llmMaxRetries,
    onModelMismatch: (served, requested) =>
      log(
        'warn',
        `Endpoint served model '${served}' but '${requested}' is pinned — ` +
          'possible provider-side model aliasing. Provenance records the requested id.'
      ),
  });
  log(
    'info',
    `LLM endpoint: ${endpoint.baseUrl} (model ${endpoint.model}, temperature ${
      endpoint.temperature === null ? 'omitted (endpoint default)' : endpoint.temperature
    })`
  );
  if (pricing) {
    log(
      'info',
      `Pricing (declared): ${pricing.inputPer1M}/${pricing.outputPer1M} per 1M in/out (${pricing.currency})`
    );
  }
  log('info', `Database path: ${opts.dbPath}`);

  const prompt = fs.readFileSync(PROMPT_FILE, 'utf-8');
  // Hash the RENDERED template (placeholders substituted) into the version, so
  // editing the prompt text — or a category description that now gets rendered
  // into it — invalidates the cache. PROMPT_VERSION alone is a hand-maintained
  // literal: under v1 a prompt edit changed what the model saw while every
  // cache row still hit and isUpToDate reported a no-op.
  const promptFingerprint = crypto
    .createHash('sha256')
    .update(renderPromptTemplate(prompt))
    .digest('hex')
    .slice(0, 8);
  // The effective request knobs are part of the version: changing temperature
  // or extraBody (e.g. toggling a provider's thinking mode) re-bills the full
  // corpus exactly like a model change (DESIGN §6.4 invalidation semantics).
  const analysisVersion = computeAnalysisVersion({
    promptVersion: `${PROMPT_VERSION}:${promptFingerprint}`,
    model: endpoint.model,
    pipelineRev: PIPELINE_REV,
    requestKnobs: { temperature: endpoint.temperature, extraBody: endpoint.extraBody ?? null },
  });

  const roster = JSON.parse(fs.readFileSync(opts.rosterPath, 'utf-8')) as Roster;
  const rosterPins: Record<string, string> = {};
  for (const r of roster.repos) rosterPins[r.repo] = r.sha;

  // ── Estimate mode: project spend, then exit 0. Zero calls, zero writes. ────
  if (opts.estimate) {
    await runEstimate(opts, roster, prompt, analysisVersion, pricing);
    return 0;
  }

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
      return 0;
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

  // ── Analysis cache (Revision 1 §4.5): hits cost nothing; --no-cache bypasses
  // reads AND writes (a deliberate full re-spend). ─────────────────────────────
  let cache: AnalysisCache | null = null;
  if (!opts.noCache) {
    try {
      fs.mkdirSync(path.dirname(opts.analysisCachePath), { recursive: true });
      cache = openAnalysisCache(opts.analysisCachePath);
      log('info', `Analysis cache: ${opts.analysisCachePath}`);
    } catch (e) {
      log('warn', `Analysis cache unavailable (${(e as Error).message}) — running cache-disabled.`);
      cache = null;
    }
  } else {
    log('info', 'Analysis cache disabled (--no-cache) — a deliberate full re-spend.');
  }

  const githubToken = process.env.GITHUB_TOKEN;
  const records: ExampleRecord[] = [];
  const mods: ModMeta[] = [];
  const licenseReview: Record<string, LicenseReview & { license: string }> = {};
  /**
   * Category labels the model emitted that no EXAMPLE_CATEGORIES slug (or
   * alias) could absorb. Surfaced in the summary — under v1 these were coerced
   * to NULL in silence, which is how 36% of the corpus lost its category
   * without anything in the build output saying so.
   */
  const rejectedCategories = new Map<string, number>();
  const noteRejectedCategory = (raw: string): void => {
    rejectedCategories.set(raw, (rejectedCategories.get(raw) ?? 0) + 1);
  };
  const ledger: RunLedger = {
    promptTokens: 0,
    completionTokens: 0,
    calls: 0,
    cacheHits: 0,
    cacheWrites: 0,
    tokensSaved: 0,
  };
  let budgetTripped = false;

  // Budget enforcement uses ACTUAL usage only (never estimates): no LLM call
  // starts while the ledger is already at/over the cap.
  const overCap = (): boolean =>
    opts.llmMaxCostUsd !== null &&
    pricing !== null &&
    ledgerCostUsd(ledger, pricing) >= opts.llmMaxCostUsd;

  try {
    for (const [repoIdx, repo] of roster.repos.entries()) {
      if (budgetTripped) break;
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

        const snippets = selectForRepo(repo, roster, files);
        log(
          'info',
          `Selected ${snippets.length} snippets — analyzing (concurrency ${opts.llmConcurrency})…`
        );

        // Per-snippet isolation end-to-end (cache/analyze/enrich/record-build),
        // with results written into index-addressed slots so records append
        // strictly in selection order regardless of completion order.
        const slots: Array<SlotResult | undefined> = new Array<SlotResult | undefined>(
          snippets.length
        );
        let processed = 0;
        await runPool(snippets, opts.llmConcurrency, async (snippet, i) => {
          try {
            let analysis: Analysis | null = null;
            let hash: string | null = null;

            // Cache read (free — allowed even when the cap is already tripped).
            if (cache) {
              hash = hashSnippet(snippet);
              const hit = cache.getCached(hash, analysisVersion);
              if (hit) {
                ledger.cacheHits++;
                if (hit.usage) {
                  ledger.tokensSaved += hit.usage.promptTokens + hit.usage.completionTokens;
                }
                analysis = hit.analysis;
              }
            }

            if (!analysis) {
              // Budget gate: no LLM call starts at/over the cap.
              if (budgetTripped || overCap()) {
                budgetTripped = true;
                slots[i] = { snippet, outcome: 'budget' };
                return;
              }
              const callOnce = async (): Promise<AnalyzeOutcome> => {
                ledger.calls++;
                return analyzeSnippet(snippet, client, prompt, noteRejectedCategory);
              };
              let outcome: AnalyzeOutcome;
              try {
                outcome = await callOnce();
              } catch (err) {
                // No double-pay: permanent failures (other 4xx, unparsable
                // completions) skip immediately; only transient ones (network,
                // 429, 5xx) earn the single second attempt.
                if (!isTransientLlmError(err)) throw err;
                outcome = await callOnce();
              }
              ledger.promptTokens += outcome.usage?.promptTokens ?? 0;
              ledger.completionTokens += outcome.usage?.completionTokens ?? 0;
              if (cache && hash) {
                cache.putCached(hash, analysisVersion, outcome.analysis, outcome.usage);
                ledger.cacheWrites++;
              }
              analysis = outcome.analysis;
            }

            const analyzed: AnalyzedSnippet = { snippet, analysis };
            const apiRefs = resolveApiReferences(analyzed, {
              mappings,
              api,
              minecraftVersion: '1.12.2',
            });
            slots[i] = { snippet, outcome: 'ok', record: toExampleRecord(analyzed, apiRefs) };
          } catch (err) {
            slots[i] = { snippet, outcome: 'failed', error: (err as Error).message };
          } finally {
            processed++;
            if (processed % 10 === 0) {
              log('debug', `  ${processed}/${snippets.length} processed`);
            }
          }
        });

        let analyzedCount = 0;
        let failedCount = 0;
        let budgetSkipped = 0;
        for (const slot of slots) {
          if (!slot) continue;
          if (slot.outcome === 'ok' && slot.record) {
            records.push(slot.record);
            analyzedCount++;
          } else if (slot.outcome === 'budget') {
            budgetSkipped++;
          } else {
            failedCount++;
            log(
              'warn',
              `  skip ${slot.snippet.filePath}:${slot.snippet.startLine} — ${slot.error}`
            );
          }
        }
        if (budgetSkipped > 0) {
          log(
            'warn',
            `${repo.name}: ${budgetSkipped} snippet(s) not analyzed — budget cap reached`
          );
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
    cache?.close();
  }

  // ── Ingest (atomic tmp + rename). Already-completed records are kept even
  // when the budget cap truncated the run — the validated partial-corpus path.
  banner('Ingest');
  let llmBaseHost = '';
  try {
    llmBaseHost = new URL(endpoint.baseUrl).host;
  } catch {
    llmBaseHost = ''; // provenance without topology; '' on parse failure
  }
  const meta: IngestMeta = {
    analysisVersion,
    promptVersion: `${PROMPT_VERSION}:${promptFingerprint}`,
    llmModel: endpoint.model,
    rosterPins,
    licenseReview,
    llmBaseHost,
    llmCost: ledgerJson(ledger, pricing),
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
  // Categorization coverage, not the seeded-category count the v1 summary
  // printed under this label (it read a constant 21 while 36% of the corpus
  // was landing with a NULL category).
  const categorized = counts.examples - counts.uncategorized;
  const uncatPct = counts.examples > 0 ? (counts.uncategorized / counts.examples) * 100 : 0;
  log(
    'info',
    `  Categorized:      ${categorized}/${counts.examples} in ${Object.keys(counts.byCategory).length}/${counts.categories} categories`
  );
  const uncatLine = `  Uncategorized:    ${counts.uncategorized} (${uncatPct.toFixed(1)}%)`;
  log(uncatPct > UNCATEGORIZED_WARN_PCT ? 'warn' : 'info', uncatLine);
  if (uncatPct > UNCATEGORIZED_WARN_PCT) {
    log(
      'warn',
      `  Over the ${UNCATEGORIZED_WARN_PCT}% threshold — check the prompt's category guidance before shipping this corpus.`
    );
  }
  const coverage = auditCategoryCoverage(counts.byCategory);
  if (coverage.empty.length > 0) {
    log('warn', `  Categories with no examples: ${coverage.empty.join(', ')}`);
  }
  if (coverage.thin.length > 0) {
    const thin = [...coverage.thin]
      .sort((a, b) => a.count - b.count)
      .map((t) => `${t.slug} (${t.count})`)
      .join(', ');
    log('warn', `  Thin categories (<${THIN_CATEGORY_THRESHOLD}): ${thin}`);
  }
  for (const [slug, n] of Object.entries(counts.byCategory).sort((a, b) => b[1] - a[1])) {
    log('info', `    ${slug.padEnd(18)} ${n}`);
  }
  if (rejectedCategories.size > 0) {
    const total = [...rejectedCategories.values()].reduce((a, b) => a + b, 0);
    log('warn', `  Rejected category labels: ${total} across ${rejectedCategories.size} distinct`);
    for (const [label, n] of [...rejectedCategories].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      log('warn', `    ${JSON.stringify(label)} ×${n}`);
    }
  }
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

  // ── Cost ledger summary (Revision 1 §4.4) — always printed; loud on truncation.
  log('info', `  LLM calls:        ${ledger.calls}`);
  log(
    'info',
    `  Cache:            ${ledger.cacheHits} hits, ${ledger.cacheWrites} writes, ${ledger.tokensSaved} tokens saved`
  );
  log(
    'info',
    `  Tokens billed:    ${ledger.promptTokens} prompt + ${ledger.completionTokens} completion`
  );
  if (pricing) {
    log(
      'info',
      `  Estimated cost:   $${ledgerCostUsd(ledger, pricing).toFixed(4)} ${pricing.currency} (declared list price)`
    );
  } else {
    log('info', '  Estimated cost:   n/a — no pricing configured');
  }

  if (budgetTripped) {
    log(
      'error',
      `BUDGET CAP REACHED (--llm-max-cost-usd ${opts.llmMaxCostUsd}) — the corpus above is ` +
        `TRUNCATED (${counts.examples} examples ingested). Release automation must refuse to ship it.`
    );
    return 2;
  }

  // Coverage gate (beta report N2). EXAMPLE_CATEGORIES is the `search_mod_examples`
  // filter enum, so a category with zero examples is a filter value the shipped
  // server accepts and can never satisfy — the agent reads the empty result as
  // "the corpus has no such patterns" rather than "this slice was never indexed".
  // A warn was already printed for this before the corpus shipped anyway; it is
  // a gate now.
  if (coverage.empty.length > 0 && !opts.allowEmptyCategories) {
    log(
      'error',
      `EMPTY CATEGORIES (${coverage.empty.length}): ${coverage.empty.join(', ')} — the corpus above ` +
        `offers these as \`category\` filter values with nothing behind them. Release automation ` +
        `must refuse to ship it.`
    );
    log(
      'error',
      '  Usual cause: selectSnippets truncates each repo at maxSnippetsPerRepo in tree order ' +
        '(src/examples/select.ts), so late-sorting packages never reach the corpus — DESIGN §6.2 ' +
        'asks selection to prefer category-bearing units instead. Widen the roster include globs, ' +
        'raise the cap, or spread the selection.'
    );
    log('error', '  Pass --allow-empty-categories to ship a knowingly-incomplete corpus anyway.');
    return 3;
  }
  return 0;
}

main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((error) => {
    if (error instanceof EndpointNotConfiguredError) {
      log('error', error.message);
      process.exit(1);
    }
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    log('error', `Indexing failed: ${message}`);
    process.exit(1);
  });
