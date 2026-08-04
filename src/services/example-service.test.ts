/**
 * Integration tests for ExampleService.getExamples against the real docs corpus.
 *
 * These encode the beta-test oracles for the documentation example path:
 *  - S2: distinct source documents come first; a page may only repeat once distinct pages are
 *    exhausted, and such repeats are labelled.
 *  - S4: an unmatchable query returns nothing, so the handler's empty-result block is reached.
 *  - the `language` filter is honoured by every strategy, including the semantic one.
 *
 * They SKIP when no populated docs.db is present (CI runners and the npm tarball carry none),
 * so the unit tests in search-utils.test.ts are the actual gate. Note the gate below checks the
 * document count, not just file existence: an installed server may hold an empty schema-stub
 * docs.db, against which every assertion here would pass vacuously.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { getDefaultDbPath } from '../data-dir.js';
import { DBS } from '../dbs.js';
import { ExampleService } from './example-service.js';
import { BACKFILL_REASON } from './search-utils.js';

const REPO_DB_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data',
  DBS.docs.fileName
);

function hasDocuments(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) return false;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS count FROM documents').get() as { count: number };
      return row.count > 0;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

const DB_PATH = [getDefaultDbPath(DBS.docs.fileName), REPO_DB_PATH].find(hasDocuments);
const describeDb = DB_PATH ? describe : describe.skip;

describeDb('ExampleService.getExamples', () => {
  it('prefers distinct source documents when enough of them qualify', async () => {
    const service = new ExampleService(DB_PATH);
    try {
      const examples = await service.getExamples({
        topic: 'tile entity',
        language: 'java',
        scope: 'target',
        limit: 5,
      });

      const urls = examples.map((e) => e.context.documentUrl);
      expect(urls.length).toBeGreaterThan(1);
      expect(new Set(urls).size).toBe(urls.length);
    } finally {
      service.close();
    }
  });

  it('labels any repeat of a page it has already listed', async () => {
    // "loot table" is the original defect case: Forge's items/loot_tables/ page holds six java
    // code blocks and used to fill the whole limit with them. Repeats are allowed only once
    // distinct pages run out, and must say so.
    const service = new ExampleService(DB_PATH);
    try {
      const examples = await service.getExamples({
        topic: 'loot table',
        language: 'java',
        scope: 'target',
        limit: 5,
      });

      const seen = new Set<string>();
      for (const example of examples) {
        const url = example.context.documentUrl;
        if (seen.has(url)) {
          expect(example.matchReasons).toContain(BACKFILL_REASON);
        }
        seen.add(url);
      }
    } finally {
      service.close();
    }
  });

  it('returns nothing for an unmatchable query rather than padding with near-misses', async () => {
    const service = new ExampleService(DB_PATH);
    try {
      const examples = await service.getExamples({ topic: 'xyzzy frobnicate', limit: 5 });
      expect(examples).toEqual([]);
    } finally {
      service.close();
    }
  });

  it('honours the language filter in every strategy, case-insensitively', async () => {
    const service = new ExampleService(DB_PATH);
    try {
      const examples = await service.getExamples({
        topic: 'block',
        language: 'java',
        scope: 'target',
        limit: 5,
      });

      for (const example of examples) {
        expect(example.language.toLowerCase()).toBe('java');
      }
    } finally {
      service.close();
    }
  });

  it('applies the relevance floor to everything it returns', async () => {
    const service = new ExampleService(DB_PATH);
    try {
      const examples = await service.getExamples({ topic: 'registry', limit: 5 });

      for (const example of examples) {
        expect(example.relevanceScore).toBeGreaterThanOrEqual(20);
      }
    } finally {
      service.close();
    }
  });
});
