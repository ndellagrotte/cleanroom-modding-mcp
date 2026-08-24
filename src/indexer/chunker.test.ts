import { describe, it, expect } from 'vitest';
import { DocumentChunker } from './chunker.js';
import type { DocumentPage } from './types.js';

/**
 * Beta report S6: `search_docs` returned a result whose entire summary read
 * "ot entry:" — a chunk that opened partway through the word "loot". The
 * damage was in the stored chunk, not the renderer, so these guard the splitter.
 */

/** A page with one long section, so the splitter actually has to split. */
function page(content: string): DocumentPage {
  return {
    url: 'https://docs.example.invalid/docs/1.12.2/items/registering',
    title: 'Registering Custom Objects',
    content,
    rawHtml: '',
    category: 'items',
    loader: 'forge',
    minecraftVersion: '1.12.2',
    hash: 'deadbeef',
    sections: [
      { heading: 'Registering Custom Objects', level: 2, content, codeBlocks: [], order: 0 },
    ],
    codeBlocks: [],
    metadata: { tags: [] },
  } as unknown as DocumentPage;
}

/** Prose with frequent sentence boundaries — the shape that triggered the cascade. */
const PROSE = Array.from(
  { length: 60 },
  (_, i) =>
    `In addition to vanilla's, you can also register your own loot conditions, loot functions, and entity properties number ${i}.`
).join(' ');

function sectionChunks(text: string, options = {}) {
  const chunker = new DocumentChunker(options);
  return chunker
    .chunkDocument(page(text))
    .filter((c) => c.chunkType === 'section')
    .map((c) => c.content.replace(/^Registering Custom Objects\n\n/, ''));
}

describe('DocumentChunker.splitText', () => {
  it('never opens a chunk mid-word', () => {
    for (const chunk of sectionChunks(PROSE)) {
      // A chunk that starts mid-token begins with a word fragment that is not a
      // real word start — "ot entry:" is the shipped example.
      const firstWord = chunk.split(/\s/)[0] ?? '';
      expect(PROSE).toContain(` ${firstWord}`);
    }
  });

  it('never closes a chunk mid-token and prefers sentence endings', () => {
    const chunks = sectionChunks(PROSE, { maxChunkSize: 450 });
    for (const chunk of chunks.slice(0, -1)) {
      expect(/[.!?]$/.test(chunk)).toBe(true);
      expect(PROSE.includes(chunk)).toBe(true);
    }
  });

  it('emits no fragment below minChunkSize', () => {
    const chunks = sectionChunks(PROSE, { minChunkSize: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThanOrEqual(50);
    }
  });

  it('advances by at least minChunkSize per chunk rather than one character', () => {
    // The cascade: a sentence break close to `start` sent the loop into its
    // `prevStart + 1` guard, producing hundreds of near-duplicate chunks that
    // each began one character later than the last.
    const chunks = sectionChunks(PROSE);
    expect(chunks.length).toBeLessThan(Math.ceil(PROSE.length / 100));
    expect(new Set(chunks).size).toBe(chunks.length);
  });

  it('covers the whole section across the chunk set', () => {
    const chunks = sectionChunks(PROSE);
    // Every sentence marker survives somewhere in the output.
    for (const marker of ['number 0.', 'number 30.', 'number 59.']) {
      expect(chunks.some((c) => c.includes(marker))).toBe(true);
    }
  });

  it('returns short text whole rather than splitting it', () => {
    const short = 'A single short section body that fits comfortably in one chunk.';
    expect(sectionChunks(short)).toEqual([short]);
  });

  it('handles an unbroken token without dropping it or looping', () => {
    const blob = 'x'.repeat(2500);
    const chunks = sectionChunks(blob);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('xxxx');
  });
});

describe('DocumentChunker.createTitleChunk', () => {
  it('cuts the intro on a word boundary', () => {
    const chunker = new DocumentChunker({ maxChunkSize: 40 });
    const [title] = chunker.chunkDocument(page(PROSE));
    expect(title?.chunkType).toBe('title');
    const intro = title!.content.replace(/^Registering Custom Objects\n\n/, '');
    // The cut must land at a space in the source, not partway through a token.
    expect(PROSE.startsWith(intro)).toBe(true);
    expect(PROSE[intro.length] === undefined || /\s/.test(PROSE[intro.length]!)).toBe(true);
  });
});
