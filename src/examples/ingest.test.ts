import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { isUpToDate, runIngest, type ModMeta, type SkipState } from './ingest.js';
import type { ExampleRecord, IngestMeta } from './model.js';

const META: IngestMeta = {
  analysisVersion: 'av1-test',
  promptVersion: 'v1',
  llmModel: 'test',
  rosterPins: { 'o/r': 'sha1' },
  licenseReview: {},
};

function record(overrides: Partial<ExampleRecord> = {}): ExampleRecord {
  return {
    modName: 'R',
    modRepo: 'o/r',
    loader: 'forge',
    license: 'MIT',
    filePath: 'X.java',
    fileUrl: 'https://github.com/o/r/blob/sha/X.java#L1-L2',
    startLine: 1,
    endLine: 2,
    title: 'T',
    code: 'class X {}',
    language: 'java',
    caption: 'c',
    explanation: 'e',
    patternType: 'p',
    complexity: 'beginner',
    categorySlug: 'blocks',
    bestPractices: [],
    potentialPitfalls: [],
    useCases: [],
    keywords: ['x'],
    minecraftConcepts: [],
    qualityScore: 0.5,
    isFeatured: false,
    tags: ['t'],
    imports: [{ path: 'a.B', type: 'library', isCritical: false }],
    apiReferences: [],
    ...overrides,
  };
}

const MOD: ModMeta = {
  name: 'R',
  repo: 'o/r',
  loader: 'forge',
  license: 'MIT',
  minecraftVersions: ['1.12.2'],
  priority: 1,
};

describe('isUpToDate', () => {
  const base: SkipState = {
    roster_pins: { a: 'sha1' },
    analysis_version: 'av1',
    schema_version: 2,
  };
  it('no-ops only when all three keys match', () => {
    expect(isUpToDate(base, base)).toBe(true);
    expect(isUpToDate(base, { ...base, roster_pins: { a: 'sha2' } })).toBe(false);
    expect(isUpToDate(base, { ...base, analysis_version: 'av2' })).toBe(false);
    expect(isUpToDate(base, { ...base, schema_version: 1 })).toBe(false);
  });
  it('--force overrides a match', () => {
    expect(isUpToDate(base, base, true)).toBe(false);
  });
});

describe('runIngest', () => {
  it('writes a populated DB and is atomic on success', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-ok-'));
    const dbPath = path.join(dir, 'examples.db');
    const counts = runIngest({ dbPath, records: [record()], mods: [MOD], meta: META });
    expect(counts.examples).toBe(1);
    expect(fs.existsSync(`${dbPath}.tmp`)).toBe(false);

    const db = new Database(dbPath, { readonly: true });
    expect((db.prepare('SELECT COUNT(*) c FROM examples').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM example_relations').get() as { c: number }).c).toBe(
      0
    );
    expect(db.prepare("SELECT value FROM metadata WHERE key='analysis_version'").get()).toEqual({
      value: 'av1-test',
    });
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves no partial DB when the build throws mid-transaction', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-fail-'));
    const dbPath = path.join(dir, 'examples.db');
    // A record whose mod repo is absent from `mods` throws inside the transaction.
    expect(() =>
      runIngest({ dbPath, records: [record({ modRepo: 'missing/repo' })], mods: [MOD], meta: META })
    ).toThrow();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}.tmp`]) {
      expect(fs.existsSync(p)).toBe(false);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
