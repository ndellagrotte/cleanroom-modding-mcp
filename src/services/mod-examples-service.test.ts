/**
 * Tests for ModExamplesService.searchExamples ranking.
 *
 * Regression guard: a text query must rank by FTS relevance (bm25), not by
 * quality_score alone. Ordering by quality alone let a passing mention inside a
 * high-scoring example outrank an exact match in a lower-scoring one — e.g.
 * "desync" returned MinecraftByExample tile-entity snippets while every
 * UniversalTweaks desync mixin was pushed off the result set.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getDefaultDbPath } from '../data-dir.js';
import { DBS } from '../dbs.js';
import { ModExamplesService } from './mod-examples-service.js';

// Collect-time gate: these are integration tests against the built examples DB.
// The shared data dir (getDefaultDbPath) is where an installed server reads from,
// but a dev checkout keeps its DB in the repo's data/ — CLEANROOM_MCP_DATA_DIR is
// only set when the server is launched, not under vitest. Try both, then skip
// cleanly when neither is present or the schema version differs.
const REPO_DB_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data',
  DBS.examples.fileName
);
const DB_PATH = [getDefaultDbPath(DBS.examples.fileName), REPO_DB_PATH].find((p) =>
  ModExamplesService.isAvailable(p)
);
const describeDb = DB_PATH ? describe : describe.skip;

describeDb('ModExamplesService.searchExamples ranking', () => {
  it('ranks exact topic matches above merely-high-quality unrelated examples', () => {
    const service = new ModExamplesService(DB_PATH);
    // min_quality 0 so ranking alone decides the order, not the quality filter.
    const results = service.searchExamples({ query: 'desync', minQualityScore: 0, limit: 5 });

    expect(results.length).toBeGreaterThan(0);

    // Titles and mod attribution both shift when the corpus is rebuilt — the
    // snippets are re-analyzed and re-titled by an LLM, so "desync" may come
    // back as "...sync block break state" under a different mod. Assert the
    // ordering property itself, which is what actually regressed: with a text
    // query the result set must NOT be in quality-score order (the mirror of
    // the no-query branch asserted below).
    const scores = results.map((r) => r.qualityScore);
    expect(scores).not.toEqual([...scores].sort((a, b) => b - a));

    // Concretely: the top hit is outranked on quality by something below it.
    expect(results.some((r) => r.qualityScore > results[0].qualityScore)).toBe(true);
  });

  it('still finds a distinctive single-token query', () => {
    const service = new ModExamplesService(DB_PATH);
    const results = service.searchExamples({ query: 'LivingHurtEvent', limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain('LivingHurtEvent');
  });

  it('orders by quality when no text query is given (no-MATCH branch)', () => {
    const service = new ModExamplesService(DB_PATH);
    // bm25() is only legal alongside a MATCH — this guards the branch that must
    // NOT reference it, and would throw "unable to use function bm25" if it did.
    const results = service.searchExamples({ minQualityScore: 0.7, limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    const scores = results.map((r) => r.qualityScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('applies filters alongside a text query', () => {
    const service = new ModExamplesService(DB_PATH);
    const results = service.searchExamples({
      query: 'mixin redirect',
      modName: 'UniversalTweaks',
      minQualityScore: 0,
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.modName === 'UniversalTweaks')).toBe(true);
  });
});
