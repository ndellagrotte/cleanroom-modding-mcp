import { describe, it, expect } from 'vitest';
import { sanitizeDocumentPage, stripZeroWidth } from './text.js';
import type { DocumentPage } from './types.js';

const ZWSP = '\u200B';

describe('stripZeroWidth', () => {
  it('removes the anchor artefact that contaminated 9,867 headings', () => {
    // What cheerio's .text() produces for `<h2>Block States<a class="header-anchor">\u200B</a></h2>`
    expect(stripZeroWidth(`Block States 1.20.4 ${ZWSP}`)).toBe('Block States 1.20.4 ');
  });

  it('removes ZWNJ, ZWJ and the BOM as well', () => {
    expect(stripZeroWidth('a\u200Cb\u200Dc\uFEFFd')).toBe('abcd');
  });

  it('leaves ordinary whitespace alone for the caller to collapse', () => {
    expect(stripZeroWidth('a \t\nb')).toBe('a \t\nb');
  });

  it('is a no-op on clean text', () => {
    expect(stripZeroWidth('Registering Custom Objects')).toBe('Registering Custom Objects');
  });

  /**
   * The reason this is not simply folded into a whitespace collapse: JS `\s`
   * has never matched U+200B, so `trim()` and `[ \t]+` both leave it behind.
   */
  it('catches what trim() and a whitespace collapse miss', () => {
    const contaminated = `${ZWSP}heading${ZWSP}`;
    expect(contaminated.trim()).toBe(contaminated);
    expect(contaminated.replace(/[ \t]+/g, ' ')).toBe(contaminated);
    expect(stripZeroWidth(contaminated)).toBe('heading');
  });
});

describe('sanitizeDocumentPage', () => {
  function page(): DocumentPage {
    return {
      url: `https://example.invalid/${ZWSP}page`,
      title: `Title${ZWSP}`,
      content: `Document${ZWSP} content`,
      rawHtml: `<main>${ZWSP}body</main>`,
      category: 'items',
      loader: 'forge',
      minecraftVersion: '1.12.2',
      sections: [
        { heading: 'Empty', level: 2, content: '', codeBlocks: [], order: 0 },
        { heading: 'Short', level: 2, content: 'Coming Soon', codeBlocks: [], order: 1 },
        {
          heading: `Useful${ZWSP}`,
          level: 2,
          content: `A useful section body${ZWSP} with searchable context.`,
          codeBlocks: [],
          order: 2,
        },
        {
          heading: `Code${ZWSP}`,
          level: 2,
          content: '',
          codeBlocks: [{ language: 'java', code: `class${ZWSP} Example {}` }],
          order: 3,
        },
        {
          heading: `Useful${ZWSP}`,
          level: 2,
          content: `A useful section body${ZWSP} with searchable context.`,
          codeBlocks: [],
          order: 4,
        },
      ],
      metadata: { crawledAt: new Date(0), tags: [`tag${ZWSP}`] },
      hash: 'hash',
    };
  }

  it('strips zero-width characters from every persisted text surface', () => {
    const clean = sanitizeDocumentPage(page());
    expect(JSON.stringify(clean)).not.toContain(ZWSP);
  });

  it('drops empty, short, and exact duplicate generated sections but keeps code', () => {
    const clean = sanitizeDocumentPage(page());
    expect(clean.sections.map((section) => section.heading)).toEqual(['Useful', 'Code']);
  });
});
