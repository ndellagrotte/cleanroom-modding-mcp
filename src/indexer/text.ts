/**
 * Text normalization shared by the ingest and render paths.
 *
 * `cleanText` (crawler), `cleanInline` (markdown) and `cleanContent`
 * (search-service) grew independently and each reimplemented whitespace and
 * noise handling. Only the pieces that must agree across all three live here —
 * a fix applied in one place otherwise reaches only part of the corpus.
 */

/**
 * Zero-width characters: ZWSP, ZWNJ, ZWJ and the BOM.
 *
 * VitePress and Docusaurus render heading permalinks as
 * `<a class="header-anchor">\u200B</a>`, whose text node *is* a zero-width
 * space. `cheerio`'s `.text()` concatenates it into the heading, so it rides
 * into the stored heading, the document content, and every chunk built from
 * that heading — 226,519 occurrences across the shipped corpus.
 *
 * Whitespace normalization does not catch these: JavaScript's `\s` has never
 * matched U+200B, and a `[ \t]+` collapse obviously does not either, so both
 * the collapse and `trim()` leave them in place.
 */
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

/**
 * Strip zero-width characters.
 *
 * Apply this *before* collapsing whitespace, so that a space orphaned by the
 * removal collapses with its neighbour rather than surviving as a double space.
 */
export function stripZeroWidth(text: string): string {
  return text.replace(ZERO_WIDTH, '');
}
