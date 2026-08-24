import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DocumentStore } from './store.js';
import type { DocumentPage } from './types.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function page(): DocumentPage {
  const repeated = 'A repeated section body with enough searchable context.';
  return {
    url: 'https://example.invalid/docs',
    title: 'Docs\u200B',
    content: 'A complete document body.\u200B',
    rawHtml: '<main>Body\u200B</main>',
    category: 'items',
    loader: 'fabric',
    sections: [
      { heading: 'First', level: 2, content: repeated, codeBlocks: [], order: 0 },
      { heading: 'Generated copy', level: 2, content: repeated, codeBlocks: [], order: 1 },
      {
        heading: 'Code A',
        level: 2,
        content: '',
        codeBlocks: [{ language: 'java', code: 'class A {}' }],
        order: 2,
      },
      {
        heading: 'Code B',
        level: 2,
        content: '',
        codeBlocks: [{ language: 'java', code: 'class B {}' }],
        order: 3,
      },
    ],
    metadata: { crawledAt: new Date(0), tags: [] },
    hash: 'hash',
  };
}

describe('DocumentStore persistence boundary', () => {
  it('stores sanitized, useful, content-unique sections and explicit unknown provenance', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-store-'));
    temporaryDirectories.push(dir);
    const dbPath = path.join(dir, 'docs.db');
    const store = new DocumentStore(dbPath);
    const { documentId, document } = store.storeDocument(page());
    store.storeChunks([], documentId);
    store.close();

    expect(document.title).toBe('Docs');
    expect(document.sections).toHaveLength(4);

    const db = new Database(dbPath, { readonly: true });
    try {
      const storedDocument = db.prepare('SELECT title, minecraft_version FROM documents').get() as {
        title: string;
        minecraft_version: string;
      };
      expect(storedDocument).toEqual({ title: 'Docs', minecraft_version: 'unknown' });

      const contents = (
        db.prepare('SELECT content FROM sections ORDER BY order_num').all() as Array<{
          content: string;
        }>
      ).map((row) => row.content);
      expect(contents).toEqual([
        'A repeated section body with enough searchable context.',
        'class A {}',
        'class B {}',
      ]);
      expect(new Set(contents).size).toBe(contents.length);
    } finally {
      db.close();
    }
  });
});
