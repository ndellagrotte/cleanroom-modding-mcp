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
import Database from 'better-sqlite3';
// Fixtures are built from the registry rather than hardcoded filenames (see
// src/dbs.ts); the values are static data, so importing it outside `load()` is safe.
import { DBS, DB_IDS, type DbId } from './dbs.js';

// Built on disk in WAL mode, like every shipped database: opening a WAL DB —
// even read-only, as the schema check does — makes SQLite create -shm/-wal
// sidecars, which is what the temp-file cleanup has to deal with.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanroom-mcp-fixture-'));
const fixturePath = path.join(fixtureDir, 'fixture.db');
const fixtureDb = new Database(fixturePath);
fixtureDb.pragma('journal_mode = WAL');
fixtureDb.exec(
  `CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   INSERT INTO metadata VALUES ('schema_version', '2');`
);
fixtureDb.close();
const DB_CONTENT = fs.readFileSync(fixturePath);
fs.rmSync(fixtureDir, { recursive: true, force: true });
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

  /** A single v-tag release carrying the DB + manifest pair of every listed id. */
  function releasesFixture(ids: readonly DbId[] = DB_IDS) {
    return [
      {
        id: 2,
        tag_name: 'v0.5.0',
        published_at: '2026-01-02T00:00:00Z',
        assets: ids.flatMap((id) => [
          {
            name: DBS[id].fileName,
            browser_download_url: `https://cdn.test/v0.5.0/${DBS[id].fileName}`,
            size: DB_CONTENT.length,
          },
          {
            name: DBS[id].manifestName,
            browser_download_url: `https://cdn.test/v0.5.0/${DBS[id].manifestName}`,
            size: 500,
          },
        ]),
      },
    ];
  }

  function manifestFixture(overrides: Partial<Record<string, unknown>> = {}, id: DbId = 'docs') {
    return {
      version: '1.2.0',
      schemaVersion: 2,
      timestamp: '2026-01-02T00:00:00Z',
      type: 'full',
      hash: DB_HASH,
      size: DB_CONTENT.length,
      // Deliberately stale URL: the release asset URL must win.
      downloadUrl: `https://cdn.test/stale/${DBS[id].fileName}`,
      changelog: 'test',
      ...overrides,
    };
  }

  /** Manifest + database asset routes for each listed id. */
  function dbAssetRoutes(ids: readonly DbId[] = DB_IDS): MockRoute[] {
    const exact = (name: string) => new RegExp(`/${name.replace(/\./g, '\\.')}$`);
    return ids.flatMap((id) => [
      { url: exact(DBS[id].manifestName), body: manifestFixture({}, id) },
      { url: exact(DBS[id].fileName), body: {}, binary: DB_CONTENT },
    ]);
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

  it('rejects a release manifest whose schema is missing or incompatible', async () => {
    for (const schemaVersion of [undefined, 1]) {
      const manifest = manifestFixture({ schemaVersion });
      vi.stubGlobal(
        'fetch',
        mockFetch([
          { url: /\/releases$/, body: releasesFixture() },
          { url: /docs-manifest\.json$/, body: manifest },
        ])
      );

      const { DbVersioning } = await load();
      expect(await new DbVersioning().getRemoteManifest()).toBeNull();
      vi.resetModules();
    }
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

  it('creates manifests only for schema-compatible databases', async () => {
    const { DbVersioning, DBS } = await load();
    const Database = (await import('better-sqlite3')).default;
    const dbFile = path.join(tempDir, 'built-docs.db');
    const db = new Database(dbFile);
    db.exec(
      `CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
       INSERT INTO metadata VALUES ('schema_version', '2');`
    );
    db.close();

    const manifest = await new DbVersioning(DBS.docs, dbFile).createManifest(
      '2.1.6',
      'full',
      'test',
      'v2.1.6'
    );
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.downloadUrl).toContain('/v2.1.6/docs.db');

    const stale = new Database(dbFile);
    stale.prepare("UPDATE metadata SET value='1' WHERE key='schema_version'").run();
    stale.close();
    await expect(
      new DbVersioning(DBS.docs, dbFile).createManifest('2.1.6', 'full', 'test', 'v2.1.6')
    ).rejects.toThrow('database schema v1 does not match required v2');
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

  it('rejects an unreadable database even when its manifest hash matches', async () => {
    const unreadable = Buffer.from('not sqlite');
    const manifest = manifestFixture({
      hash: crypto.createHash('sha256').update(unreadable).digest('hex'),
      size: unreadable.length,
      downloadUrl: 'https://cdn.test/v0.5.0/docs.db',
    });
    vi.stubGlobal('fetch', mockFetch([{ url: /docs\.db$/, body: {}, binary: unreadable }]));

    const { DbVersioning, dbPath } = await load();
    expect(await new DbVersioning().downloadDatabase(manifest as never)).toBe(false);
    expect(fs.existsSync(dbPath('docs'))).toBe(false);
  });

  it('leaves no temp sidecars behind (the schema check opens the .tmp file)', async () => {
    const manifest = manifestFixture({ downloadUrl: 'https://cdn.test/v0.5.0/docs.db' });
    vi.stubGlobal('fetch', mockFetch([{ url: /docs\.db$/, body: {}, binary: DB_CONTENT }]));

    const { DbVersioning, dbPath } = await load();
    expect(await new DbVersioning().downloadDatabase(manifest as never)).toBe(true);

    // -shm/-wal are named after the .tmp path, so the rename would strand them.
    const strays = fs.readdirSync(tempDir).filter((name) => name.includes('.tmp'));
    expect(strays).toEqual([]);
    expect(fs.existsSync(dbPath('docs'))).toBe(true);
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
            schemaVersion: 2,
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

  it('autoUpdateAll installs every database, optional ones included', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([{ url: /\/releases$/, body: releasesFixture() }, ...dbAssetRoutes()])
    );

    const { autoUpdateAll, dbPath } = await load();
    const result = await autoUpdateAll();

    expect(result).toEqual({ updated: [...DB_IDS], failed: [] });
    for (const id of DB_IDS) {
      expect(fs.existsSync(dbPath(id))).toBe(true);
    }
  });

  it('reports a database the release cannot supply as failed, and installs the rest', async () => {
    const carried = DB_IDS.filter((id) => id !== 'examples');
    vi.stubGlobal(
      'fetch',
      mockFetch([{ url: /\/releases$/, body: releasesFixture(carried) }, ...dbAssetRoutes(carried)])
    );

    const { autoUpdateAll, dbPath } = await load();
    const result = await autoUpdateAll();

    expect(result).toEqual({ updated: carried, failed: ['examples'] });
    expect(fs.existsSync(dbPath('examples'))).toBe(false);
  });

  it('reports a missing database as failed when no release can supply it', async () => {
    vi.stubGlobal('fetch', mockFetch([{ url: /\/releases$/, body: [] }]));

    const { autoUpdateAll } = await load();
    expect(await autoUpdateAll()).toEqual({ updated: [], failed: [...DB_IDS] });
  });

  it('leaves a locally built database alone now that every DB auto-installs', async () => {
    const fetchMock = mockFetch([
      { url: /\/releases$/, body: releasesFixture() },
      ...dbAssetRoutes(),
    ]);
    vi.stubGlobal('fetch', fetchMock);

    const { autoUpdateAll, dbPath } = await load();
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(dbPath('mappings'), DB_CONTENT);
    fs.writeFileSync(
      path.join(tempDir, DBS.mappings.manifestName),
      JSON.stringify({ version: '0.0.0-local', source: 'local-build' })
    );

    const result = await autoUpdateAll();

    expect(result.updated).not.toContain('mappings');
    expect(result.failed).not.toContain('mappings');
    // The prebuilt asset must never be fetched over an on-device build.
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((u) => /\/mappings\.db$/.test(u))).toBe(false);
    // …while the other three still install.
    expect(result.updated).toEqual(DB_IDS.filter((id) => id !== 'mappings'));
  });
});
