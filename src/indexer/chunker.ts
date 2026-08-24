/**
 * Smart document chunking for better search results
 * Splits documents into searchable chunks while preserving context
 */

import type { DocumentPage, DocumentSection, ChunkOptions } from './types.js';

export interface DocumentChunk {
  id: string;
  documentUrl: string;
  title: string;
  category: string;
  loader: string;
  chunkType: 'title' | 'section' | 'code' | 'full';
  content: string;
  codeLanguage?: string;
  sectionHeading?: string;
  sectionLevel?: number;
  order: number;
  metadata: {
    hasCode: boolean;
    wordCount: number;
    difficulty?: string;
    tags: string[];
  };
}

export class DocumentChunker {
  private options: ChunkOptions;

  constructor(options: Partial<ChunkOptions> = {}) {
    this.options = {
      maxChunkSize: 1000, // characters
      overlapSize: 100, // characters of overlap between chunks
      preserveCodeBlocks: true,
      minChunkSize: 50,
      ...options,
    };
  }

  /**
   * Chunk a document page into searchable pieces
   */
  chunkDocument(doc: DocumentPage): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    let order = 0;

    // Always create a title chunk for context
    chunks.push(this.createTitleChunk(doc, order++));

    // Chunk each section
    for (const section of doc.sections) {
      const sectionChunks = this.chunkSection(doc, section, order);
      chunks.push(...sectionChunks);
      order += sectionChunks.length;
    }

    // If no sections, create a single full-doc chunk
    if (doc.sections.length === 0 && doc.content.length > 0) {
      chunks.push(this.createFullDocChunk(doc, order++));
    }

    return chunks;
  }

  /**
   * Create title/intro chunk
   */
  private createTitleChunk(doc: DocumentPage, order: number): DocumentChunk {
    const intro = this.truncateAtBoundary(doc.content, this.options.maxChunkSize);

    return {
      id: `${this.hashString(doc.url)}-title`,
      documentUrl: doc.url,
      title: doc.title,
      category: doc.category,
      loader: doc.loader,
      chunkType: 'title',
      content: `${doc.title}\n\n${intro}`,
      order,
      metadata: {
        hasCode: false,
        wordCount: this.countWords(intro),
        difficulty: doc.metadata.difficulty,
        tags: doc.metadata.tags,
      },
    };
  }

  /**
   * Create full document chunk for small docs
   */
  private createFullDocChunk(doc: DocumentPage, order: number): DocumentChunk {
    return {
      id: `${this.hashString(doc.url)}-full`,
      documentUrl: doc.url,
      title: doc.title,
      category: doc.category,
      loader: doc.loader,
      chunkType: 'full',
      content: doc.content,
      order,
      metadata: {
        hasCode: false,
        wordCount: this.countWords(doc.content),
        difficulty: doc.metadata.difficulty,
        tags: doc.metadata.tags,
      },
    };
  }

  /**
   * Chunk a section intelligently
   */
  private chunkSection(
    doc: DocumentPage,
    section: DocumentSection,
    startOrder: number
  ): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    let order = startOrder;

    // Create code block chunks first (if preserving)
    if (this.options.preserveCodeBlocks && section.codeBlocks.length > 0) {
      for (const codeBlock of section.codeBlocks) {
        chunks.push({
          id: `${this.hashString(doc.url)}-${order}`,
          documentUrl: doc.url,
          title: doc.title,
          category: doc.category,
          loader: doc.loader,
          chunkType: 'code',
          content: `${section.heading}\n\n${codeBlock.caption || ''}\n\n${codeBlock.code}`,
          codeLanguage: codeBlock.language,
          sectionHeading: section.heading,
          sectionLevel: section.level,
          order: order++,
          metadata: {
            hasCode: true,
            wordCount: this.countWords(codeBlock.code),
            difficulty: doc.metadata.difficulty,
            tags: doc.metadata.tags,
          },
        });
      }
    }

    // Create section text chunks
    if (section.content.trim().length >= this.options.minChunkSize) {
      const textChunks = this.splitText(section.content);

      for (const textChunk of textChunks) {
        chunks.push({
          id: `${this.hashString(doc.url)}-${order}`,
          documentUrl: doc.url,
          title: doc.title,
          category: doc.category,
          loader: doc.loader,
          chunkType: 'section',
          content: `${section.heading}\n\n${textChunk}`,
          sectionHeading: section.heading,
          sectionLevel: section.level,
          order: order++,
          metadata: {
            hasCode: section.codeBlocks.length > 0,
            wordCount: this.countWords(textChunk),
            difficulty: doc.metadata.difficulty,
            tags: doc.metadata.tags,
          },
        });
      }
    }

    return chunks;
  }

  /** Cut at a sentence boundary when possible, otherwise at a whole token. */
  private truncateAtBoundary(text: string, limit: number): string {
    if (text.length <= limit) return text;
    const end = this.findNaturalEnd(text, 0, limit, Math.min(this.options.minChunkSize, limit));
    return text.slice(0, end).trim();
  }

  /**
   * Resolve an exclusive chunk end. Sentence/paragraph boundaries win; a
   * whitespace token boundary is the fallback. One token longer than the limit
   * stays whole rather than being corrupted.
   */
  private findNaturalEnd(text: string, start: number, limit: number, minSize: number): number {
    const hardEnd = Math.min(start + limit, text.length);
    if (hardEnd >= text.length) return text.length;

    const eligibleStart = Math.min(start + minSize, hardEnd);
    const window = text.slice(eligibleStart, hardEnd);
    const boundaries = window.matchAll(/[.!?](?:["')\]]*)?(?=\s|$)|\n{2,}/g);
    let sentenceEnd = -1;
    for (const match of boundaries) {
      sentenceEnd = eligibleStart + (match.index ?? 0) + match[0].length;
    }
    if (sentenceEnd > eligibleStart) {
      return sentenceEnd;
    }

    for (let i = hardEnd; i > eligibleStart; i--) {
      if (/\s/.test(text[i] ?? '')) {
        return i;
      }
    }

    const nextWhitespace = text.slice(hardEnd).search(/\s/);
    return nextWhitespace === -1 ? text.length : hardEnd + nextWhitespace;
  }

  /**
   * Advance an index to the start of the next whole word.
   *
   * Never moves backwards, and never past the end. When the remainder holds no
   * whitespace at all — one unbroken token — the index is returned unchanged:
   * there is no boundary to snap to, and skipping to the end would drop text.
   */
  private snapToWordStart(text: string, index: number): number {
    if (index <= 0) return 0;
    if (index >= text.length) return text.length;
    // The previous character is whitespace, so this already starts a word.
    if (/\s/.test(text[index - 1] ?? '')) return index;

    const offset = text.slice(index).search(/\s/);
    return offset === -1 ? index : index + offset + 1;
  }

  /**
   * Split long text into overlapping chunks.
   *
   * Two defects lived here, and both reached users as garbled `search_docs`
   * summaries (beta report S6):
   *
   *  1. The overlap step (`start = end - overlapSize`) landed mid-word, so a
   *     chunk could open partway through a token — the shipped corpus holds
   *     `"Registering Custom Objects\n\not entry:"`, which `search_docs`
   *     rendered verbatim as a result summary. `start` is now snapped forward
   *     to a word boundary.
   *  2. When the sentence-boundary search pulled `end` back to within
   *     `overlapSize` of `start`, the overlap subtraction went backwards and the
   *     loop fell into its `prevStart + 1` guard — advancing **one character per
   *     pass** and emitting a cascade of near-duplicate mid-word chunks. Each
   *     pass now advances by at least `minChunkSize`.
   *
   * Fragments below `minChunkSize` are dropped rather than shipped. They cannot
   * carry content that the previous chunk missed: a tail is only reached when
   * `start = end - overlapSize`, so the remainder is at least `overlapSize`
   * characters, and anything shorter is whitespace this `trim()` removed.
   */
  private splitText(text: string): string[] {
    if (text.length <= this.options.maxChunkSize) {
      return [text];
    }

    const { maxChunkSize, minChunkSize, overlapSize } = this.options;
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = this.findNaturalEnd(text, start, maxChunkSize, minChunkSize);

      const chunk = text.slice(start, end).trim();
      if (chunk.length >= minChunkSize) {
        chunks.push(chunk);
      }

      if (end >= text.length) break;

      // Step back for the overlap, but never far enough to stall, then forward
      // to a word boundary.
      start = this.snapToWordStart(text, Math.max(start + minChunkSize, end - overlapSize));
    }

    return chunks;
  }

  /**
   * Count words in text
   */
  private countWords(text: string): number {
    return text.trim().split(/\s+/).length;
  }

  /**
   * Simple hash function for IDs
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }
}
