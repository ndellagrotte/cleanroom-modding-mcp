/**
 * Tests for the pure ranking helpers in search-utils.
 *
 * These cover three defects found by the beta test on the documentation example path:
 *  - S2: one documentation page with several code blocks consumed the caller's whole `limit`,
 *    because dedup compared code text only and had no per-document cap.
 *  - S4: there was no relevance floor, so a 36%-similarity near-miss was served as an answer
 *    and the handler's empty-result block was unreachable.
 *  - the dedup key for code-less results read a `url` field that code-block results never
 *    carry (they have `document_url`), collapsing them all to "::<heading>".
 *
 * No database is needed — these functions are pure, and they are the CI gate for the fixes.
 */

import { describe, it, expect } from 'vitest';
import {
  BACKFILL_REASON,
  canonicalSections,
  canonicalSummary,
  deduplicateAndRank,
  formatPublicScore,
  languageMatches,
  truncateAtBoundary,
  urlPathKey,
  type ScoredResult,
} from './search-utils.js';

interface TestItem {
  code?: string;
  url?: string;
  document_url?: string;
  document_id?: number;
  section_heading?: string | null;
}

function scored(score: number, item: TestItem): ScoredResult<TestItem> {
  return { item, score, matchReasons: [] };
}

/** A code block on a given page; `code` is unique per call unless overridden. */
function block(score: number, docUrl: string, code?: string): ScoredResult<TestItem> {
  return scored(score, {
    code: code ?? `snippet-${docUrl}-${score}`,
    document_url: docUrl,
    section_heading: 'Heading',
  });
}

describe('deduplicateAndRank — content dedup (existing behaviour)', () => {
  it('collapses identical code even when it comes from different documents', () => {
    const results = [
      block(50, 'https://docs.example/a', 'public void register() {}'),
      block(40, 'https://docs.example/b', 'public void register() {}'),
    ];

    expect(deduplicateAndRank(results, 5)).toHaveLength(1);
  });

  it('keeps the caller array unmutated', () => {
    const results = [block(10, 'https://docs.example/a'), block(90, 'https://docs.example/b')];
    const order = results.map((r) => r.score);

    deduplicateAndRank(results, 5);

    expect(results.map((r) => r.score)).toEqual(order);
  });

  it('distinguishes code-less results by document_url, not just heading', () => {
    // Regression: the key used to read `item.url`, which these never carry, so both
    // collapsed to "::Shared Heading" and one was silently dropped.
    const results = [
      scored(50, { document_url: 'https://docs.example/a', section_heading: 'Shared Heading' }),
      scored(40, { document_url: 'https://docs.example/b', section_heading: 'Shared Heading' }),
    ];

    expect(deduplicateAndRank(results, 5)).toHaveLength(2);
  });
});

describe('deduplicateAndRank — relevance floor (S4)', () => {
  it('drops results scoring below the floor', () => {
    // 8.297414696130966 is the literal score the beta test was served for three
    // loot-table snippets on a "creative tab" query (cosine 0.358).
    const results = [
      block(50, 'https://docs.example/a'),
      block(12, 'https://docs.example/b'),
      block(8.297414696130966, 'https://docs.example/c'),
    ];

    const ranked = deduplicateAndRank(results, 5, { minScore: 10 });

    expect(ranked).toHaveLength(2);
    expect(ranked.every((r) => r.score >= 10)).toBe(true);
  });

  it('returns nothing when every candidate is below the floor', () => {
    // This is what makes the handler's "no examples found" block reachable.
    const results = [block(9, 'https://docs.example/a'), block(2, 'https://docs.example/b')];

    expect(deduplicateAndRank(results, 5, { minScore: 10 })).toEqual([]);
  });

  it('keeps every result when no floor is given', () => {
    const results = [block(9, 'https://docs.example/a'), block(2, 'https://docs.example/b')];

    expect(deduplicateAndRank(results, 5)).toHaveLength(2);
  });
});

describe('deduplicateAndRank — per-document diversity cap (S2)', () => {
  it('returns one snippet per document when distinct documents can fill the limit', () => {
    // Models Forge's items/loot_tables/ page, which alone has 6 java code blocks.
    const results = [
      block(90, 'https://docs.example/a'),
      block(85, 'https://docs.example/a'),
      block(80, 'https://docs.example/a'),
      block(70, 'https://docs.example/b'),
      block(60, 'https://docs.example/b'),
      block(50, 'https://docs.example/c'),
    ];

    const ranked = deduplicateAndRank(results, 3, { maxPerDocument: 1 });
    const urls = ranked.map((r) => r.item.document_url);

    expect(ranked).toHaveLength(3);
    expect(new Set(urls).size).toBe(3);
  });

  it('backfills from the same document rather than under-filling the limit', () => {
    const results = [
      block(90, 'https://docs.example/a'),
      block(85, 'https://docs.example/a'),
      block(80, 'https://docs.example/a'),
      block(70, 'https://docs.example/a'),
    ];

    const ranked = deduplicateAndRank(results, 3, { maxPerDocument: 1 });

    expect(ranked).toHaveLength(3);
    expect(ranked.map((r) => r.score)).toEqual([90, 85, 80]);
  });

  it('labels backfilled results, and only those', () => {
    const results = [
      block(90, 'https://docs.example/a'),
      block(85, 'https://docs.example/a'),
      block(80, 'https://docs.example/b'),
    ];

    const ranked = deduplicateAndRank(results, 3, { maxPerDocument: 1 });

    expect(ranked.map((r) => r.matchReasons.includes(BACKFILL_REASON))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('does not mutate the match reasons of the caller results', () => {
    const results = [block(90, 'https://docs.example/a'), block(85, 'https://docs.example/a')];

    deduplicateAndRank(results, 2, { maxPerDocument: 1 });

    expect(results.every((r) => r.matchReasons.length === 0)).toBe(true);
  });

  it('orders distinct documents ahead of higher-scoring same-document extras', () => {
    const results = [
      block(50, 'https://docs.example/a'),
      block(45, 'https://docs.example/a'),
      block(40, 'https://docs.example/b'),
    ];

    const ranked = deduplicateAndRank(results, 3, { maxPerDocument: 1 });

    expect(ranked.map((r) => r.score)).toEqual([50, 40, 45]);
  });

  it('treats the same page indexed at two doc versions as one document', () => {
    const results = [
      block(50, 'https://docs.example/1.21.4/develop/blocks/first-block'),
      block(45, 'https://docs.example/1.21.5/develop/blocks/first-block'),
      block(40, 'https://docs.example/1.21.4/develop/items/first-item'),
    ];

    const ranked = deduplicateAndRank(results, 2, { maxPerDocument: 1 });

    expect(ranked.map((r) => r.score)).toEqual([50, 40]);
  });

  it('falls back to document_id when no URL is present', () => {
    const results = [
      scored(50, { code: 'one', document_id: 7 }),
      scored(45, { code: 'two', document_id: 7 }),
      scored(40, { code: 'three', document_id: 8 }),
    ];

    const ranked = deduplicateAndRank(results, 2, { maxPerDocument: 1 });

    expect(ranked.map((r) => r.item.document_id)).toEqual([7, 8]);
  });

  it('never caps results that have no document identity', () => {
    const results = [
      scored(50, { code: 'one' }),
      scored(45, { code: 'two' }),
      scored(40, { code: 'three' }),
    ];

    expect(deduplicateAndRank(results, 3, { maxPerDocument: 1 })).toHaveLength(3);
  });
});

describe('urlPathKey', () => {
  it('strips a version segment from the path', () => {
    expect(urlPathKey('https://docs.example/1.21.4/develop/blocks/first-block')).toBe(
      'https://docs.example/develop/blocks/first-block'
    );
  });

  it('handles two-component versions', () => {
    expect(urlPathKey('https://docs.example/1.12/items/loot_tables/')).toBe(
      'https://docs.example/items/loot_tables/'
    );
  });

  it('leaves an unversioned URL untouched', () => {
    expect(urlPathKey('https://docs.example/develop/blocks')).toBe(
      'https://docs.example/develop/blocks'
    );
  });
});

describe('languageMatches', () => {
  it('is case-insensitive — the corpus carries java, Java and JAVA', () => {
    expect(languageMatches('Java', 'java')).toBe(true);
    expect(languageMatches('JAVA', 'java')).toBe(true);
    expect(languageMatches('java', 'java')).toBe(true);
  });

  it('rejects a different language', () => {
    expect(languageMatches('json', 'java')).toBe(false);
  });

  it('matches everything when no language is requested', () => {
    expect(languageMatches('json', undefined)).toBe(true);
    expect(languageMatches(null, undefined)).toBe(true);
  });

  it('rejects a missing block language when one is requested', () => {
    expect(languageMatches(null, 'java')).toBe(false);
    expect(languageMatches(undefined, 'java')).toBe(false);
  });
});

describe('canonical documentation summaries', () => {
  it('skips empty fragments and keeps the first complete body for each heading', () => {
    expect(
      canonicalSections([
        {
          heading: 'Registering Custom Objects',
          content: 'Registering Custom Objects\n\not entry:',
        },
        {
          heading: 'Registering Custom Objects',
          content:
            "Registering Custom Objects\n\nIn addition to vanilla's, you can also register custom conditions.",
        },
      ])
    ).toEqual([
      {
        heading: 'Registering Custom Objects',
        content: "In addition to vanilla's, you can also register custom conditions.",
      },
    ]);
  });

  it('treats periods inside identifiers as part of the sentence', () => {
    expect(
      canonicalSummary(
        ['Call LootTableList.register(value) to register the table. A later sentence.'],
        ['register'],
        200
      )
    ).toBe('Call LootTableList.register(value) to register the table.');
  });

  it('never truncates in the middle of a word', () => {
    const result = truncateAtBoundary(
      'A sentence with SuperLongIdentifierToken and more text.',
      30
    );
    expect(result).toBe('A sentence with...');
  });

  it('formats public relevance on a bounded one-decimal percentage scale', () => {
    expect(formatPublicScore(67.69613042271394)).toBe('33.8%');
    expect(formatPublicScore(500)).toBe('100.0%');
  });
});
