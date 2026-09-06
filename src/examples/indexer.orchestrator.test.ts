/**
 * Orchestrator-level tests for scripts/index-mod-examples.ts (Phase 5
 * Revision 1, §8): the script is spawned end-to-end against a local fake
 * OpenAI-compatible endpoint and a fixture repo zip, in a throwaway cwd (so
 * the committed data/examples-llm.json never leaks into these runs).
 *
 * Covered: endpoint/pricing startup gates, --estimate (zero calls/writes),
 * budget cap (exit 2 without publication), analysis cache (hits, version
 * invalidation, --no-cache), no-double-pay retry classification, and
 * concurrency order-determinism.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import AdmZip from 'adm-zip';
import Database from 'better-sqlite3';
import { DBS } from '../dbs.js';

const execFileP = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'index-mod-examples.ts');
const PROMPT_FILENAME = 'analyze-snippet.v2.md';
const PROMPT_SRC = path.join(REPO_ROOT, 'src', 'examples', 'prompts', PROMPT_FILENAME);

const tmpDirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise((r) => s.close(r));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SNIPPET_COUNT = 6;

/** One class with SNIPPET_COUNT member methods → exactly one region each. */
function fixtureJava(): string {
  const methods = [];
  for (let i = 0; i < SNIPPET_COUNT; i++) {
    methods.push(`    public int m${i}(int x) {\n        return x + ${i};\n    }`);
  }
  return `package test;\n\npublic class Fixture {\n${methods.join('\n\n')}\n}\n`;
}

interface Workspace {
  dir: string;
  dataDir: string;
  zipPath: string;
  dbPath: string;
  manifestPath: string;
  cachePath: string;
  baseArgs: string[];
}

function makeWorkspace(
  opts: { serverUrl?: string; pricing?: boolean; temperature?: number } = {}
): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexer-orch-'));
  tmpDirs.push(dir);

  // The script resolves the committed prompt relative to cwd.
  const promptDir = path.join(dir, 'src', 'examples', 'prompts');
  fs.mkdirSync(promptDir, { recursive: true });
  fs.copyFileSync(PROMPT_SRC, path.join(promptDir, PROMPT_FILENAME));

  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const roster = {
    schema: 1,
    snippetLineCap: 60,
    repos: [
      {
        name: 'Fixture',
        repo: 'o/r',
        ref: 'main',
        sha: 'deadbeefcafe',
        loader: 'forge',
        license: 'MIT',
        licenseReview: { verdict: 'approved', by: 'test', date: '2026-07-24' },
        include: [],
        exclude: [],
        maxSnippetsPerRepo: null,
        maxFileBytes: 100000,
        minecraftVersions: ['1.12.2'],
      },
    ],
  };
  fs.writeFileSync(path.join(dataDir, 'examples-roster.json'), JSON.stringify(roster));

  const zip = new AdmZip();
  zip.addFile('fixture-deadbeef/src/main/java/test/Fixture.java', Buffer.from(fixtureJava()));
  const zipPath = path.join(dir, 'repo.zip');
  fs.writeFileSync(zipPath, zip.toBuffer());

  if (opts.serverUrl) {
    const cfg: Record<string, unknown> = {
      schema: 1,
      baseUrl: opts.serverUrl,
      model: 'fixture-model',
    };
    if (opts.temperature !== undefined) {
      cfg.temperature = opts.temperature;
    }
    if (opts.pricing) {
      cfg.pricing = { inputPer1M: 0.15, outputPer1M: 0.6, currency: 'USD' };
    }
    fs.writeFileSync(path.join(dataDir, 'examples-llm.json'), JSON.stringify(cfg));
  }

  const dbPath = path.join(dataDir, 'examples.db');
  return {
    dir,
    dataDir,
    zipPath,
    dbPath,
    manifestPath: path.join(dataDir, 'examples-manifest.json'),
    cachePath: path.join(dataDir, 'examples-analysis-cache.db'),
    baseArgs: [
      '--repo-zip',
      zipPath,
      '--db-path',
      dbPath,
      '--mappings-db',
      path.join(dir, 'absent-mappings.db'),
      '--cleanroom-api-db',
      path.join(dir, 'absent-cleanroom.db'),
      // This fixture is one 6-method class analyzed by a fake endpoint that
      // answers with a single category — it can never cover all 21, so the
      // coverage gate would mask every exit code these tests assert on. The
      // gate itself is exercised by its own describe block below.
      '--allow-empty-categories',
    ],
  };
}

interface RunResult {
  code: number;
  out: string;
}

async function runIndexer(
  cwd: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLEANROOM_MCP_LLM_') || k === 'GITHUB_TOKEN') delete env[k];
  }
  Object.assign(env, extraEnv);
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [TSX_CLI, SCRIPT, ...args], {
      cwd,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      out: (err.stdout ?? '') + (err.stderr ?? ''),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake OpenAI-compatible endpoint
// ─────────────────────────────────────────────────────────────────────────────

interface FakeLlm {
  url: string;
  requests: Map<string, number>; // snippet id ('m3') → request count
  temperatures: number[]; // `temperature` seen in each request body
  total: () => number;
}

interface MockDecision {
  status: number;
  headers?: Record<string, string>;
  delayMs?: number;
}

function startFakeLlm(
  decide?: (id: string, nthRequestForId: number) => MockDecision | Promise<MockDecision>
): Promise<FakeLlm> {
  const requests = new Map<string, number>();
  const temperatures: number[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      void (async () => {
        let id = 'unknown';
        try {
          const parsed = JSON.parse(body) as {
            messages?: Array<{ content?: string }>;
            temperature?: number;
          };
          if (typeof parsed.temperature === 'number') temperatures.push(parsed.temperature);
          const prompt = parsed.messages?.[1]?.content ?? '';
          const m = /m(\d+)\(int x\)/.exec(prompt);
          if (m) id = `m${m[1]}`;
        } catch {
          /* keep id */
        }
        const nth = (requests.get(id) ?? 0) + 1;
        requests.set(id, nth);
        const decision = (await decide?.(id, nth)) ?? { status: 200 };
        if (decision.delayMs) {
          await new Promise((r) => setTimeout(r, decision.delayMs));
        }
        if (decision.status === 200) {
          const analysis = {
            title: `Analysis ${id}`,
            caption: 'c',
            category: 'blocks',
            complexity: 'beginner',
            quality_score: 0.9,
            keywords: [id],
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(analysis) } }],
              usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            })
          );
        } else {
          res.writeHead(decision.status, decision.headers ?? {});
          res.end('error');
        }
      })();
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        temperatures,
        total: () => [...requests.values()].reduce((a, b) => a + b, 0),
      });
    });
  });
}

function readExamples(dbPath: string): Array<Record<string, unknown>> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare('SELECT id, file_path, start_line, end_line, title, code FROM examples ORDER BY id')
      .all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function readMetadata(dbPath: string, key: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup gates (BLIND_SPEC §6 addendum)
// ─────────────────────────────────────────────────────────────────────────────

describe('startup gates', () => {
  it('exits non-zero writing nothing with no endpoint (also under --estimate)', async () => {
    const ws = makeWorkspace(); // no examples-llm.json, no endpoint flags
    const plain = await runIndexer(ws.dir, ws.baseArgs);
    expect(plain.code).not.toBe(0);
    expect(plain.out).toContain('configured LLM endpoint is required');

    const estimate = await runIndexer(ws.dir, [...ws.baseArgs, '--estimate']);
    expect(estimate.code).not.toBe(0);

    for (const p of [ws.dbPath, ws.manifestPath, ws.cachePath]) {
      expect(fs.existsSync(p), p).toBe(false);
    }
  });

  it('exits non-zero before any call when a cap is set but pricing is unresolvable', async () => {
    const llm = await startFakeLlm();
    const ws = makeWorkspace(); // endpoint via flags, but no pricing anywhere
    const res = await runIndexer(ws.dir, [
      ...ws.baseArgs,
      '--llm-base-url',
      llm.url,
      '--llm-model',
      'fixture-model',
      '--llm-max-cost-usd',
      '1',
    ]);
    expect(res.code).toBe(1);
    expect(res.out).toContain('requires resolvable pricing');
    expect(llm.total()).toBe(0); // failed at startup, before any call
    expect(fs.existsSync(ws.dbPath)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Estimate mode (Revision 1 §4.3)
// ─────────────────────────────────────────────────────────────────────────────

describe('--estimate', () => {
  it('performs zero LLM calls and writes nothing', async () => {
    const llm = await startFakeLlm();
    const ws = makeWorkspace({ serverUrl: llm.url, pricing: true });
    const res = await runIndexer(ws.dir, [...ws.baseArgs, '--estimate']);
    expect(res.code).toBe(0);
    expect(res.out).toContain('Estimate');
    expect(res.out).toContain('zero LLM calls');
    expect(res.out).toContain('analysis_version');
    expect(res.out).toContain('TOTAL');
    expect(llm.total()).toBe(0);
    for (const p of [ws.dbPath, ws.manifestPath, ws.cachePath]) {
      expect(fs.existsSync(p), p).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Real run + analysis cache (Revision 1 §4.5)
// ─────────────────────────────────────────────────────────────────────────────

describe('analysis cache', () => {
  it('bills only cache misses: identical re-run performs zero LLM calls', async () => {
    const llm = await startFakeLlm();
    const ws = makeWorkspace({ serverUrl: llm.url, pricing: true });

    const first = await runIndexer(ws.dir, ws.baseArgs);
    expect(first.code).toBe(0);
    expect(llm.total()).toBe(SNIPPET_COUNT);
    expect(readExamples(ws.dbPath)).toHaveLength(SNIPPET_COUNT);

    // Provenance: llm_base_host + llm_cost are written on real builds.
    expect(readMetadata(ws.dbPath, 'llm_base_host')).toBe(new URL(llm.url).host);
    const cost = JSON.parse(readMetadata(ws.dbPath, 'llm_cost')!) as Record<string, unknown>;
    expect(cost.calls).toBe(SNIPPET_COUNT);
    expect(cost.prompt_tokens).toBe(SNIPPET_COUNT * 100);
    expect(cost.completion_tokens).toBe(SNIPPET_COUNT * 50);
    expect(cost.cache_hits).toBe(0);
    expect(cost.cache_writes).toBe(SNIPPET_COUNT);
    expect(cost.tokens_saved).toBe(0);
    expect(cost.estimated_usd).toBeCloseTo(0.00027, 6);
    expect(cost.pricing).toEqual({ inputPer1M: 0.15, outputPer1M: 0.6, currency: 'USD' });

    // Identical re-run (--force to bypass the up-to-date skip): all cache hits.
    const second = await runIndexer(ws.dir, [...ws.baseArgs, '--force']);
    expect(second.code).toBe(0);
    expect(llm.total()).toBe(SNIPPET_COUNT); // no new calls
    expect(readExamples(ws.dbPath)).toHaveLength(SNIPPET_COUNT);
    const cost2 = JSON.parse(readMetadata(ws.dbPath, 'llm_cost')!) as Record<string, unknown>;
    expect(cost2.calls).toBe(0);
    expect(cost2.cache_hits).toBe(SNIPPET_COUNT);
    expect(cost2.tokens_saved).toBe(SNIPPET_COUNT * 150);
  });

  it('no-ops an up-to-date DB without --force (the skip sits above the cache)', async () => {
    const llm = await startFakeLlm();
    const ws = makeWorkspace({ serverUrl: llm.url, pricing: true });

    expect((await runIndexer(ws.dir, ws.baseArgs)).code).toBe(0);
    expect(llm.total()).toBe(SNIPPET_COUNT);
    const dbBefore = fs.readFileSync(ws.dbPath);
    const manifestBefore = fs.readFileSync(ws.manifestPath);
    const second = await runIndexer(ws.dir, ws.baseArgs); // no --force
    expect(second.code).toBe(0);
    expect(fs.readFileSync(ws.dbPath)).toEqual(dbBefore);
    expect(fs.readFileSync(ws.manifestPath)).toEqual(manifestBefore);
    expect(llm.total()).toBe(SNIPPET_COUNT); // no new calls, no rebuild
  });

  it('rebuilds an empty current-schema DB from cache instead of accepting its metadata', async () => {
    const llm = await startFakeLlm();
    const ws = makeWorkspace({ serverUrl: llm.url, pricing: true });
    expect((await runIndexer(ws.dir, ws.baseArgs)).code).toBe(0);
    const expected = readExamples(ws.dbPath);
    const db = new Database(ws.dbPath);
    try {
      db.prepare('DELETE FROM examples').run();
    } finally {
      db.close();
    }

    const resumed = await runIndexer(ws.dir, [...ws.baseArgs, '--llm-max-cost-usd', '0']);
    expect(resumed.code).toBe(0);
    expect(llm.total()).toBe(SNIPPET_COUNT);
    expect(readExamples(ws.dbPath)).toEqual(expected);
    const cost = JSON.parse(readMetadata(ws.dbPath, 'llm_cost')!) as Record<string, unknown>;
    expect(cost.calls).toBe(0);
    expect(cost.cache_hits).toBe(SNIPPET_COUNT);
  });

  it('refuses to upgrade an empty legacy corpus without changing its database or manifest', async () => {
    const llm = await startFakeLlm();
    const ws = makeWorkspace({ serverUrl: llm.url, pricing: true });
    expect((await runIndexer(ws.dir, ws.baseArgs)).code).toBe(0);
    const db = new Database(ws.dbPath);
    try {
      db.prepare('DELETE FROM examples').run();
      db.prepare("UPDATE metadata SET value = ? WHERE key = 'schema_version'").run(
        String(DBS.examples.schemaVersion - 1)
      );
    } finally {
      db.close();
    }
    const dbBefore = fs.readFileSync(ws.dbPath);
    const manifestBefore = fs.readFileSync(ws.manifestPath);

    const result = await runIndexer(ws.dir, [...ws.baseArgs, '--force']);
    expect(result.code).toBe(3);
    expect(llm.total()).toBe(SNIPPET_COUNT);
    expect(fs.readFileSync(ws.dbPath)).toEqual(dbBefore);
    expect(fs.readFileSync(ws.manifestPath)).toEqual(manifestBefore);
  });

  it('misses every entry after a model change (analysis_version invalidation)', async () => {
    const llm = await startFakeLlm();
    const ws = makeWorkspace({ serverUrl: llm.url, pricing: true });

    expect((await runIndexer(ws.dir, ws.baseArgs)).code).toBe(0);
    expect(llm.total()).toBe(SNIPPET_COUNT);

    // Model flag beats the config file → new analysis_version → full re-bill,
    // even without --force (the up-to-date skip sees the version change).
    const third = await runIndexer(ws.dir, [...ws.baseArgs, '--llm-model', 'other-model']);
    expect(third.code).toBe(0);
    expect(llm.total()).toBe(SNIPPET_COUNT * 2);
    expect(readMetadata(ws.dbPath, 'llm_model')).toBe('other-model');
  });

  it('--no-cache neither reads nor writes the cache', async () => {
    const llm = await startFakeLlm();
    const ws = makeWorkspace({ serverUrl: llm.url, pricing: true });

    expect((await runIndexer(ws.dir, ws.baseArgs)).code).toBe(0);
    expect(llm.total()).toBe(SNIPPET_COUNT);
    const countRows = (): number => {
      const db = new Database(ws.cachePath, { readonly: true });
      try {
        return (db.prepare('SELECT COUNT(*) c FROM analysis_cache').get() as { c: number }).c;
      } finally {
        db.close();
      }
    };
    const rowsBefore = countRows();

    const res = await runIndexer(ws.dir, [...ws.baseArgs, '--force', '--no-cache']);
    expect(res.code).toBe(0);
    expect(llm.total()).toBe(SNIPPET_COUNT * 2); // reads bypassed → full re-spend
    expect(countRows()).toBe(rowsBefore); // writes bypassed
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint temperature (configurable; endpoints that reject temperature 0)
// ─────────────────────────────────────────────────────────────────────────────

describe('temperature configuration', () => {
  it('sends the config-file temperature on every request (default would be 0)', async () => {
    const llm = await startFakeLlm();
    const ws = makeWorkspace({ serverUrl: llm.url, pricing: true, temperature: 1 });
    const res = await runIndexer(ws.dir, ws.baseArgs);
    expect(res.code).toBe(0);
    expect(llm.temperatures).toHaveLength(SNIPPET_COUNT);
    expect(llm.temperatures.every((t) => t === 1)).toBe(true);
  });

  it('sends temperature 0 when nothing configures it (frozen default)', async () => {
    const llm = await startFakeLlm();
    const ws = makeWorkspace({ serverUrl: llm.url, pricing: true });
    const res = await runIndexer(ws.dir, ws.baseArgs);
    expect(res.code).toBe(0);
    expect(llm.temperatures).toHaveLength(SNIPPET_COUNT);
    expect(llm.temperatures.every((t) => t === 0)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Budget cap (Revision 1 §4.4)
// ─────────────────────────────────────────────────────────────────────────────

describe('budget cap', () => {
  it.each([false, true])(
    'rejects truncation and resumes cached work (installed=%s)',
    async (installed) => {
      const llm = await startFakeLlm();
      const ws = makeWorkspace({ serverUrl: llm.url, pricing: true });
      if (installed) expect((await runIndexer(ws.dir, ws.baseArgs)).code).toBe(0);
      const dbBefore = installed ? fs.readFileSync(ws.dbPath) : null;
      const manifestBefore = installed ? fs.readFileSync(ws.manifestPath) : null;
      const callsBefore = llm.total();
      const args = [...ws.baseArgs, '--llm-model', 'budget-model'];
      // Each call costs $0.000045; serial cap $0.0001 permits three calls.
      const res = await runIndexer(ws.dir, [
        ...args,
        '--llm-max-cost-usd',
        '0.0001',
        '--llm-concurrency',
        '1',
      ]);
      expect(res.code).toBe(2);
      expect(llm.total() - callsBefore).toBe(3);
      expect(fs.existsSync(ws.dbPath)).toBe(installed);
      expect(fs.existsSync(ws.manifestPath)).toBe(installed);
      if (installed) {
        expect(fs.readFileSync(ws.dbPath)).toEqual(dbBefore);
        expect(fs.readFileSync(ws.manifestPath)).toEqual(manifestBefore);
      }

      expect((await runIndexer(ws.dir, args)).code).toBe(0);
      expect(llm.total() - callsBefore).toBe(SNIPPET_COUNT);
      expect(readExamples(ws.dbPath)).toHaveLength(SNIPPET_COUNT);
      const cost = JSON.parse(readMetadata(ws.dbPath, 'llm_cost')!) as Record<string, unknown>;
      expect(cost.calls).toBe(3);
      expect(cost.cache_hits).toBe(3);
      expect(cost.tokens_saved).toBe(450);
    }
  );

  it('an uncapped run never exits 2', async () => {
    const llm = await startFakeLlm();
    const ws = makeWorkspace({ serverUrl: llm.url, pricing: true });
    const res = await runIndexer(ws.dir, ws.baseArgs);
    expect(res.code).toBe(0);
    expect(llm.total()).toBe(SNIPPET_COUNT);
  });

  it('accepts the cap from CLEANROOM_MCP_LLM_MAX_COST_USD', async () => {
    const llm = await startFakeLlm();
    const ws = makeWorkspace({ serverUrl: llm.url, pricing: true });
    const res = await runIndexer(ws.dir, [...ws.baseArgs, '--llm-concurrency', '1'], {
      CLEANROOM_MCP_LLM_MAX_COST_USD: '0.0001',
    });
    expect(res.code).toBe(2);
    expect(llm.total()).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Category coverage gate (beta report N2)
// ─────────────────────────────────────────────────────────────────────────────

describe('category coverage gate', () => {
  /** baseArgs as a real release run would be invoked: without the override. */
  const withoutOverride = (args: string[]): string[] =>
    args.filter((a) => a !== '--allow-empty-categories');

  it.each([false, true])(
    'rejects missing coverage without publishing (installed=%s)',
    async (installed) => {
      const llm = await startFakeLlm(); // every analysis comes back category 'blocks'
      const ws = makeWorkspace({ serverUrl: llm.url, pricing: true });
      if (installed) expect((await runIndexer(ws.dir, ws.baseArgs)).code).toBe(0);
      const dbBefore = installed ? fs.readFileSync(ws.dbPath) : null;
      const manifestBefore = installed ? fs.readFileSync(ws.manifestPath) : null;
      // No --force: matching metadata must not bypass the stricter coverage gate.
      const res = await runIndexer(ws.dir, withoutOverride(ws.baseArgs));
      expect(res.code).toBe(3);
      expect(llm.total()).toBe(SNIPPET_COUNT);
      expect(fs.existsSync(ws.dbPath)).toBe(installed);
      expect(fs.existsSync(ws.manifestPath)).toBe(installed);
      if (installed) {
        expect(fs.readFileSync(ws.dbPath)).toEqual(dbBefore);
        expect(fs.readFileSync(ws.manifestPath)).toEqual(manifestBefore);
      }

      // Explicit override publishes the cached analyses without any new spend.
      const resumed = await runIndexer(ws.dir, [
        ...ws.baseArgs,
        '--force',
        '--llm-max-cost-usd',
        '0',
      ]);
      expect(resumed.code).toBe(0);
      expect(llm.total()).toBe(SNIPPET_COUNT);
      expect(readExamples(ws.dbPath)).toHaveLength(SNIPPET_COUNT);
      const cost = JSON.parse(readMetadata(ws.dbPath, 'llm_cost')!) as Record<string, unknown>;
      expect(cost.calls).toBe(0);
      expect(cost.cache_hits).toBe(SNIPPET_COUNT);
      expect(cost.estimated_usd).toBe(0);
      const manifest = JSON.parse(fs.readFileSync(ws.manifestPath, 'utf-8')) as { source: string };
      expect(manifest.source).toBe('local-build');
    }
  );

  it('--allow-empty-categories ships the same corpus with exit 0', async () => {
    const llm = await startFakeLlm();
    const ws = makeWorkspace({ serverUrl: llm.url, pricing: true });
    const res = await runIndexer(ws.dir, ws.baseArgs);

    expect(res.code).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(ws.manifestPath, 'utf-8')) as { source: string };
    expect(manifest.source).toBe('local-build');
    expect(readExamples(ws.dbPath)).toHaveLength(SNIPPET_COUNT);
  });

  it.each([false, true])(
    'rejects all failed analyses even with the override (installed=%s)',
    async (installed) => {
      let fail = false;
      const llm = await startFakeLlm(() => ({ status: fail ? 400 : 200 }));
      const ws = makeWorkspace({ serverUrl: llm.url, pricing: true });
      if (installed) expect((await runIndexer(ws.dir, ws.baseArgs)).code).toBe(0);
      const dbBefore = installed ? fs.readFileSync(ws.dbPath) : null;
      const manifestBefore = installed ? fs.readFileSync(ws.manifestPath) : null;
      const callsBefore = llm.total();
      fail = true;

      const res = await runIndexer(ws.dir, [...ws.baseArgs, '--force', '--no-cache']);
      expect(res.code).toBe(3);
      expect(llm.total() - callsBefore).toBe(SNIPPET_COUNT);
      expect(fs.existsSync(ws.dbPath)).toBe(installed);
      expect(fs.existsSync(ws.manifestPath)).toBe(installed);
      if (installed) {
        expect(fs.readFileSync(ws.dbPath)).toEqual(dbBefore);
        expect(fs.readFileSync(ws.manifestPath)).toEqual(manifestBefore);
      }
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// No double-pay (Revision 1 §4.6)
// ─────────────────────────────────────────────────────────────────────────────

describe('retry classification', () => {
  it('a 400 response incurs exactly one billable call (no double-pay)', async () => {
    const llm = await startFakeLlm((id) => {
      if (id === 'm2') return { status: 400 }; // permanent HTTP error
      return { status: 200 };
    });
    const ws = makeWorkspace({ serverUrl: llm.url, pricing: true });
    const res = await runIndexer(ws.dir, ws.baseArgs);
    expect(res.code).toBe(0);
    expect(llm.requests.get('m2')).toBe(1); // no second attempt on a 400
    expect(readExamples(ws.dbPath)).toHaveLength(SNIPPET_COUNT - 1);
  });

  it('an unparsable completion is permanent (exactly one call, snippet skipped)', async () => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
        const prompt = parsed.messages?.[1]?.content ?? '';
        const isM4 = /m4\(int x\)/.test(prompt);
        const counts = (server as unknown as { counts: Map<string, number> }).counts;
        const id = isM4 ? 'm4' : 'other';
        counts.set(id, (counts.get(id) ?? 0) + 1);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: isM4
                    ? 'I cannot analyze this snippet.' // no JSON object → permanent
                    : JSON.stringify({ title: 'T', quality_score: 0.9 }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          })
        );
      });
    });
    (server as unknown as { counts: Map<string, number> }).counts = new Map();
    servers.push(server);
    const url = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      });
    });
    const counts = (server as unknown as { counts: Map<string, number> }).counts;

    const ws = makeWorkspace({ serverUrl: url, pricing: true });
    const res = await runIndexer(ws.dir, ws.baseArgs);
    expect(res.code).toBe(0);
    expect(counts.get('m4')).toBe(1); // exactly one call — no double-pay
    expect(counts.get('other')).toBe(SNIPPET_COUNT - 1);
    expect(readExamples(ws.dbPath)).toHaveLength(SNIPPET_COUNT - 1);
  });

  it('a 429 honors the existing backoff semantics (client retry, then success)', async () => {
    const llm = await startFakeLlm((id, nth) => {
      if (id === 'm1' && nth === 1) return { status: 429, headers: { 'retry-after': '0' } };
      return { status: 200 };
    });
    const ws = makeWorkspace({ serverUrl: llm.url, pricing: true });
    const res = await runIndexer(ws.dir, ws.baseArgs);
    expect(res.code).toBe(0);
    expect(llm.requests.get('m1')).toBe(2); // one backoff retry inside the client
    expect(readExamples(ws.dbPath)).toHaveLength(SNIPPET_COUNT);
  }, 90_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency determinism (Revision 1 §4.6)
// ─────────────────────────────────────────────────────────────────────────────

describe('--llm-concurrency', () => {
  it('produces byte-identical example rows at concurrency 8 vs serial', async () => {
    // Reverse-order completion: later snippets respond faster, so under
    // concurrency the responses arrive out of selection order.
    const llm = await startFakeLlm((id) => ({
      status: 200,
      delayMs: (SNIPPET_COUNT - Number(id.slice(1))) * 30,
    }));

    const serial = makeWorkspace({ serverUrl: llm.url, pricing: true });
    const a = await runIndexer(serial.dir, [
      ...serial.baseArgs,
      '--llm-concurrency',
      '1',
      '--no-cache',
    ]);
    expect(a.code).toBe(0);

    const parallel = makeWorkspace({ serverUrl: llm.url, pricing: true });
    const b = await runIndexer(parallel.dir, [
      ...parallel.baseArgs,
      '--llm-concurrency',
      '8',
      '--no-cache',
    ]);
    expect(b.code).toBe(0);

    const stripVolatile = (rows: Array<Record<string, unknown>>) =>
      rows.map((r) => ({
        file_path: r.file_path,
        start_line: r.start_line,
        end_line: r.end_line,
        title: r.title,
        code: r.code,
      }));
    expect(stripVolatile(readExamples(parallel.dbPath))).toEqual(
      stripVolatile(readExamples(serial.dbPath))
    );
    expect(readExamples(parallel.dbPath)).toHaveLength(SNIPPET_COUNT);
  }, 90_000);
});
