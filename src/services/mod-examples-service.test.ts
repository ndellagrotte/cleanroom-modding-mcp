import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DBS } from '../dbs.js';
import { exampleRecord, writeExampleFixture } from '../examples/test-fixture.js';
import type { ExampleRecord } from '../examples/model.js';
import { ModExamplesService } from './mod-examples-service.js';

let dir: string;
let service: ModExamplesService | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'example-search-'));
});

afterEach(() => {
  service?.close();
  service = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

function openFixture(records: ExampleRecord[]): ModExamplesService {
  const dbPath = path.join(dir, DBS.examples.fileName);
  writeExampleFixture(dbPath, records);
  service = new ModExamplesService(dbPath);
  return service;
}

describe('ModExamplesService.searchExamples', () => {
  it('ranks a relevant lower-quality match above a passing high-quality mention', () => {
    const db = openFixture([
      exampleRecord('Desync correction', {
        caption: 'Desync prevention and desync recovery',
        qualityScore: 0.6,
      }),
      exampleRecord('Inventory tutorial', {
        explanation: `${'Inventory slots store items. '.repeat(100)}Avoid desync.`,
        qualityScore: 0.99,
      }),
      // Keep the query distinctive: BM25 assigns near-zero IDF when most rows match.
      ...Array.from({ length: 10 }, (_, i) => exampleRecord(`Unrelated recipe ${i}`)),
    ]);

    expect(
      db.searchExamples({ query: 'desync', minQualityScore: 0, limit: 2 }).map((row) => row.title)
    ).toEqual(['Desync correction', 'Inventory tutorial']);
  });

  it('matches identifiers in code or keywords, not incidental prose mentions', () => {
    const db = openFixture([
      exampleRecord('Damage listener', { code: 'void onHurt(LivingHurtEvent event) {}' }),
      exampleRecord('Damage keywords', { keywords: ['LivingHurtEvent'], qualityScore: 0.7 }),
      exampleRecord('LivingHurtEvent overview', { qualityScore: 0.99 }),
    ]);

    expect(db.searchExamples({ query: 'LivingHurtEvent' }).map((row) => row.title)).toEqual([
      'Damage listener',
      'Damage keywords',
    ]);
  });

  it('orders by quality without a text query and applies the quality threshold', () => {
    const db = openFixture([
      exampleRecord('Lower', { qualityScore: 0.3 }),
      exampleRecord('Middle', { qualityScore: 0.7 }),
      exampleRecord('Higher', { qualityScore: 0.95 }),
    ]);

    expect(db.searchExamples({ minQualityScore: 0.5 }).map((row) => row.title)).toEqual([
      'Higher',
      'Middle',
    ]);
  });

  it('combines text, mod, loader, category and quality filters without admitting distractors', () => {
    const db = openFixture([
      exampleRecord('Redirect target', { patternType: 'mixin-redirect', qualityScore: 0.8 }),
      exampleRecord('Redirect other mod', {
        modName: 'Fixture Cleanroom',
        modRepo: 'fixture/cleanroom',
        loader: 'cleanroom',
      }),
      exampleRecord('Redirect other category', { categorySlug: 'items' }),
      exampleRecord('Redirect low quality', { qualityScore: 0.2 }),
      exampleRecord('Unrelated recipe'),
    ]);

    const options = {
      query: 'redirect',
      modName: 'fixture forge',
      loader: 'forge',
      category: 'blocks',
      minQualityScore: 0.5,
    };
    expect(db.searchExamples(options).map((row) => row.title)).toEqual(['Redirect target']);
    // A contradictory loader must reject the otherwise matching mod.
    expect(db.searchExamples({ ...options, loader: 'cleanroom' })).toEqual([]);
  });
});
