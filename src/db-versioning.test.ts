/**
 * Distribution tests: download, verify, poison-pill marker, and auto-update
 * gating — the machinery every shipped database depends on.
 *
 * Uses a real temp directory (CLEANROOM_MCP_DATA_DIR) and a mocked global
 * fetch, so the full write/verify/rename path is exercised without network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const DB_CONTENT = Buffer.from('sqlite pretend content');
const DB_HASH = crypto.createHash('sha256').update(DB_CONTENT).digest('hex');

interface MockRoute {
  url: RegExp;
  body: unknown;
  binary?: Buffer;
  status?: number;
}

function mockFetch(routes: MockRoute[]) {
  return vi.fn((input: string | URL) => {
    const url = String(input);
    const route = routes.find((r) => r.url.test(url));
    if (!route) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
    }
    const status = route.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(route.body),
      arrayBuffer: () => {
        const buf = route.binary ?? Buffer.from(JSON.stringify(route.body));
        return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      },
    });
  });
}

describe('DbVersioning distribution flow', () => {
  let tempDir: string;
  let savedDataDirEnv: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanroom-mcp-test-'));
    savedDataDirEnv = process.env.CLEANROOM_MCP_DATA_DIR;
    process.env.CLEANROOM_MCP_DATA_DIR = tempDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (savedDataDirEnv === undefined) {
      delete process.env.CLEANROOM_MCP_DATA_DIR;
    } else {
      process.env.CLEANROOM_MCP_DATA_DIR = savedDataDirEnv;
    }
    vi.unstubAllGlobals();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function load() {
    const dbsModule = await import('./dbs.js');
    const versioningModule = await import('./db-versioning.js');
    return { ...dbsModule, ...versioningModule };
  }

  function releasesFixture() {
    return [
      {
        id: 2,
        tag_name: 'v0.5.0',
        published_at: '2026-01-02T00:00:00Z',
        assets: [
          {
            name: 'docs.db',
            browser_download_url: 'https://cdn.test/v0.5.0/docs.db',
            size: DB_CONTENT.length,
          },
          {
            name: 'docs-manifest.json',
            browser_download_url: 'https://cdn.test/v0.5.0/docs-manifest.json',
            size: 500,
          },
        ],
      },
    ];
  }

  function manifestFixture(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      version: '1.2.0',
      timestamp: '2026-01-02T00:00:00Z',
      type: 'full',
      hash: DB_HASH,
      size: DB_CONTENT.length,
      // Deliberately stale URL: the release asset URL must win.
      downloadUrl: 'https://cdn.test/stale/docs.db',
      changelog: 'test',
      ...overrides,
    };
  }

  it('getRemoteManifest prefers the release asset URL over the manifest URL', async () => {
    const manifest = manifestFixture();
    vi.stubGlobal(
      'fetch',
      mockFetch([
        { url: /\/releases$/, body: releasesFixture() },
        { url: /docs-manifest\.json$/, body: manifest },
      ])
    );

    const { DbVersioning } = await load();
    const remote = await new DbVersioning().getRemoteManifest();

    expect(remote?.version).toBe('1.2.0');
    expect(remote?.downloadUrl).toBe('https://cdn.test/v0.5.0/docs.db');
  });

  it('downloads, verifies, and installs a database', async () => {
    const manifest = manifestFixture({ downloadUrl: 'https://cdn.test/v0.5.0/docs.db' });
    vi.stubGlobal('fetch', mockFetch([{ url: /docs\.db$/, body: {}, binary: DB_CONTENT }]));

    const { DbVersioning, dbPath } = await load();
    const versioning = new DbVersioning();
    const ok = await versioning.downloadDatabase(manifest as never);

    expect(ok).toBe(true);
    expect(fs.readFileSync(dbPath('docs'))).toEqual(DB_CONTENT);
    expect(fs.existsSync(path.join(tempDir, 'docs-download-failed.json'))).toBe(false);
  });

  it('rejects a hash mismatch, writes the poison-pill marker, and skips that version thereafter', async () => {
    const badManifest = manifestFixture({
      hash: 'deadbeef'.repeat(8),
      downloadUrl: 'https://cdn.test/v0.5.0/docs.db',
    });
    vi.stubGlobal(
      'fetch',
      mockFetch([
        { url: /\/releases$/, body: releasesFixture() },
        { url: /docs-manifest\.json$/, body: badManifest },
        { url: /docs\.db$/, body: {}, binary: DB_CONTENT },
      ])
    );

    const { DbVersioning, dbPath } = await load();
    const versioning = new DbVersioning();

    const ok = await versioning.downloadDatabase(badManifest as never);
    expect(ok).toBe(false);
    expect(fs.existsSync(dbPath('docs'))).toBe(false);

    const markerPath = path.join(tempDir, 'docs-download-failed.json');
    expect(fs.existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as { version: string };
    expect(marker.version).toBe('1.2.0');

    // Poison pill: the same broken release must not be offered again.
    expect(await versioning.isUpdateAvailable()).toBe(false);
  });

  it('clears the poison-pill marker after a successful download', async () => {
    const markerPath = path.join(tempDir, 'docs-download-failed.json');
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ version: '1.1.0', hash: 'old' }));

    const manifest = manifestFixture({ downloadUrl: 'https://cdn.test/v0.5.0/docs.db' });
    vi.stubGlobal('fetch', mockFetch([{ url: /docs\.db$/, body: {}, binary: DB_CONTENT }]));

    const { DbVersioning } = await load();
    const ok = await new DbVersioning().downloadDatabase(manifest as never);

    expect(ok).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('forces an update when the installed DB schema does not match the build', async () => {
    const { DbVersioning, DBS, dbPath } = await load();
    fs.mkdirSync(tempDir, { recursive: true });

    // A v1-schema mappings DB on disk with a manifest version EQUAL to the
    // remote — the version comparison alone would report "up to date".
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath('mappings'));
    db.exec(
      `CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       INSERT INTO metadata VALUES ('schema_version','1');`
    );
    db.close();
    fs.writeFileSync(
      path.join(tempDir, DBS.mappings.manifestName),
      JSON.stringify({ version: '1.2.0' })
    );
    vi.stubGlobal(
      'fetch',
      mockFetch([
        {
          url: /\/releases$/,
          body: [
            {
              id: 9,
              tag_name: 'v9.9.9',
              published_at: '2026-01-01T00:00:00Z',
              assets: [
                {
                  name: 'mappings.db',
                  browser_download_url: 'https://cdn.test/mappings.db',
                  size: 1,
                },
                {
                  name: 'mappings-manifest.json',
                  browser_download_url: 'https://cdn.test/mappings-manifest.json',
                  size: 1,
                },
              ],
            },
          ],
        },
        {
          url: /mappings-manifest\.json$/,
          body: {
            version: '1.2.0',
            timestamp: '',
            type: 'full',
            hash: DB_HASH,
            size: DB_CONTENT.length,
            downloadUrl: 'https://cdn.test/mappings.db',
            changelog: '',
          },
        },
      ])
    );

    expect(await new DbVersioning(DBS.mappings).isUpdateAvailable()).toBe(true);
  });

  it('never auto-updates a locally built database', async () => {
    const { DbVersioning, DBS } = await load();
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, DBS.mappings.manifestName),
      JSON.stringify({ version: '0.0.0-local', source: 'local-build' })
    );
    const fetchSpy = mockFetch([{ url: /\/releases$/, body: releasesFixture() }]);
    vi.stubGlobal('fetch', fetchSpy);

    const versioning = new DbVersioning(DBS.mappings);
    expect(await versioning.isUpdateAvailable()).toBe(false);
    // The decision is local: no release lookup happens at all.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('backs up the existing database before replacing it', async () => {
    const manifest = manifestFixture({ downloadUrl: 'https://cdn.test/v0.5.0/docs.db' });
    vi.stubGlobal('fetch', mockFetch([{ url: /docs\.db$/, body: {}, binary: DB_CONTENT }]));

    const { DbVersioning, dbPath } = await load();
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(dbPath('docs'), 'old content');

    const ok = await new DbVersioning().downloadDatabase(manifest as never);

    expect(ok).toBe(true);
    expect(fs.readFileSync(`${dbPath('docs')}.backup`, 'utf-8')).toBe('old content');
  });

  it('autoUpdateAll updates required DBs and skips optional DBs that are not installed', async () => {
    const manifest = manifestFixture({ downloadUrl: 'https://cdn.test/v0.5.0/docs.db' });
    const fetchMock = mockFetch([
      { url: /\/releases$/, body: releasesFixture() },
      { url: /docs-manifest\.json$/, body: manifest },
      { url: /docs\.db$/, body: {}, binary: DB_CONTENT },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const { autoUpdateAll, dbPath } = await load();
    const updated = await autoUpdateAll();

    expect(updated).toBe(true);
    expect(fs.existsSync(dbPath('docs'))).toBe(true);
    // Optional DBs are absent locally, so no requests may target their assets.
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => /mappings|examples|cleanroom-api/.test(u))).toBe(false);
  });
});
