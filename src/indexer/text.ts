/**
 * Text normalization shared by the ingest and render paths.
 *
 * `cleanText` (crawler), `cleanInline` (markdown) and `cleanContent`
 * (search-service) grew independently and each reimplemented whitespace and
 * noise handling. Only the pieces that must agree across all three live here —
 * a fix applied in one place otherwise reaches only part of the corpus.
 */

import type { DocumentPage, DocumentSection } from './types.js';

/** Prose below this length is navigation residue, not searchable documentation. */
export const MIN_USEFUL_SECTION_LENGTH = 25;

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

/**
 * Normalize a page once at the persistence boundary.
 *
 * Crawlers clean their own output for readability, but the store is the final
 * invariant boundary: repo-markdown pages and future source adapters must not
 * be able to bypass zero-width stripping or reintroduce empty generated
 * sections. Code gives an otherwise prose-less section a real body, so those
 * sections remain useful.
 */
export function sanitizeDocumentPage(doc: DocumentPage): DocumentPage {
  const seenSections = new Set<string>();
  const sections: DocumentSection[] = [];

  for (const section of doc.sections) {
    const codeBlocks = section.codeBlocks.map((block) => ({
      ...block,
      language: stripZeroWidth(block.language),
      code: stripZeroWidth(block.code),
      caption: block.caption === undefined ? undefined : stripZeroWidth(block.caption),
    }));
    const normalized: DocumentSection = {
      ...section,
      heading: stripZeroWidth(section.heading),
      content: stripZeroWidth(section.content),
      codeBlocks,
    };

    if (
      normalized.content.trim().length < MIN_USEFUL_SECTION_LENGTH &&
      normalized.codeBlocks.length === 0
    ) {
      continue;
    }

    const fingerprint = JSON.stringify([
      normalized.heading,
      normalized.content,
      normalized.codeBlocks.map((block) => [block.language, block.code, block.caption ?? '']),
    ]);
    if (seenSections.has(fingerprint)) {
      continue;
    }
    seenSections.add(fingerprint);
    sections.push(normalized);
  }

  return {
    ...doc,
    url: stripZeroWidth(doc.url),
    title: stripZeroWidth(doc.title),
    content: stripZeroWidth(doc.content),
    rawHtml: stripZeroWidth(doc.rawHtml),
    sections,
    metadata: {
      ...doc.metadata,
      author: doc.metadata.author === undefined ? undefined : stripZeroWidth(doc.metadata.author),
      tags: doc.metadata.tags.map(stripZeroWidth),
    },
  };
}
