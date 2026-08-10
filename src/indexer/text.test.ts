import { describe, it, expect } from 'vitest';
import { stripZeroWidth } from './text.js';

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
