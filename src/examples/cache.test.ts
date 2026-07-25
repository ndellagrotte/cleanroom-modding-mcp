import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { hashSnippet, openAnalysisCache } from './cache.js';
import { parseAnalysis } from './analyze.js';
import type { CompletionUsage, Snippet } from './model.js';

const snippet: Snippet = {
  repo: 'o/r',
  modName: 'r',
  loader: 'forge',
  license: 'MIT',
  filePath: 'X.java',
  fileUrl: 'https://github.com/o/r/blob/sha1/X.java#L1-L2',
  startLine: 1,
  endLine: 2,
  code: 'class X {}',
  language: 'java',
  imports: [],
};

const ANALYSIS = parseAnalysis(JSON.stringify({ title: 'T', quality_score: 0.7 }), snippet);
const USAGE: CompletionUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

let dir: string;
let cachePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-cache-test-'));
  cachePath = path.join(dir, 'cache.db');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('hashSnippet', () => {
  it('is stable over the prompt-visible payload', () => {
    expect(hashSnippet(snippet)).toBe(hashSnippet({ ...snippet }));
    expect(hashSnippet(snippet)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores provenance outside the prompt (a pin bump with unchanged files still hits)', () => {
    const bumped = {
      ...snippet,
      fileUrl: 'https://github.com/o/r/blob/sha2/X.java#L1-L2', // roster SHA moved
      imports: ['different.Imports'], // not part of the prompt payload
      license: 'Apache-2.0',
    };
    expect(hashSnippet(bumped)).toBe(hashSnippet(snippet));
  });

  it('changes when any prompt-visible field changes', () => {
    expect(hashSnippet({ ...snippet, code: 'class Y {}' })).not.toBe(hashSnippet(snippet));
    expect(hashSnippet({ ...snippet, startLine: 2 })).not.toBe(hashSnippet(snippet));
    expect(hashSnippet({ ...snippet, filePath: 'Y.java' })).not.toBe(hashSnippet(snippet));
    expect(hashSnippet({ ...snippet, modName: 'other' })).not.toBe(hashSnippet(snippet));
    expect(hashSnippet({ ...snippet, repo: 'o/other' })).not.toBe(hashSnippet(snippet));
  });
});

describe('openAnalysisCache', () => {
  it('round-trips an analysis + usage (write-through then hit)', () => {
    const cache = openAnalysisCache(cachePath);
    const hash = hashSnippet(snippet);
    expect(cache.getCached(hash, 'av1-x')).toBeNull(); // cold miss
    cache.putCached(hash, 'av1-x', ANALYSIS, USAGE);
    const hit = cache.getCached(hash, 'av1-x');
    expect(hit).not.toBeNull();
    expect(hit!.analysis).toEqual(ANALYSIS);
    expect(hit!.usage).toEqual(USAGE);
    cache.close();
  });

  it('misses when analysis_version differs (prompt/model/PIPELINE_REV invalidation)', () => {
    const cache = openAnalysisCache(cachePath);
    const hash = hashSnippet(snippet);
    cache.putCached(hash, 'av1-old', ANALYSIS, USAGE);
    expect(cache.getCached(hash, 'av1-new')).toBeNull(); // version gate
    expect(cache.getCached(hash, 'av1-old')).not.toBeNull();
    cache.close();
  });

  it('misses unknown hashes and round-trips null usage', () => {
    const cache = openAnalysisCache(cachePath);
    expect(cache.getCached('nope', 'av1')).toBeNull();
    cache.putCached(hashSnippet(snippet), 'av1', ANALYSIS, null);
    expect(cache.getCached(hashSnippet(snippet), 'av1')!.usage).toBeNull();
    cache.close();
  });

  it('persists across opens (a re-run pays only the delta)', () => {
    const hash = hashSnippet(snippet);
    const first = openAnalysisCache(cachePath);
    first.putCached(hash, 'av1', ANALYSIS, USAGE);
    first.close();
    const second = openAnalysisCache(cachePath);
    expect(second.getCached(hash, 'av1')!.analysis).toEqual(ANALYSIS);
    second.close();
  });

  it('readonly mode serves hits without mutating the file (--estimate)', () => {
    const hash = hashSnippet(snippet);
    const writer = openAnalysisCache(cachePath);
    writer.putCached(hash, 'av1', ANALYSIS, USAGE);
    writer.close();

    const before = fs.readFileSync(cachePath);
    const reader = openAnalysisCache(cachePath, { readonly: true });
    expect(reader.getCached(hash, 'av1')!.analysis.title).toBe('T');
    expect(() => reader.putCached('x', 'av1', ANALYSIS, USAGE)).toThrow();
    reader.close();
    expect(fs.readFileSync(cachePath)).toEqual(before);
  });

  it('stores exactly the Revision 1 §4.5 columns', () => {
    const cache = openAnalysisCache(cachePath);
    cache.putCached(hashSnippet(snippet), 'av1', ANALYSIS, USAGE);
    cache.close();
    const db = new Database(cachePath, { readonly: true });
    const cols = db.prepare(`PRAGMA table_info(analysis_cache)`).all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual([
      'snippet_hash',
      'analysis_version',
      'analysis_json',
      'usage_json',
      'created_at',
    ]);
    db.close();
  });
});
