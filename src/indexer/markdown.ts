/**
 * Markdown → DocumentPage parser for repo-sourced corpora (the Cleanroom wiki
 * ships as VitePress markdown in CleanroomMC/Website).
 *
 * Line-based on purpose: the corpus is small and VitePress markdown is
 * regular, so a full markdown AST dependency buys nothing. Fences are parsed
 * FIRST so `#` or `:::` inside code are never mistaken for structure.
 */

import { createHash } from 'crypto';
import { detectMinecraftVersion } from './sitemap.js';
import type { Loader } from '../loaders.js';
import type { CodeBlock, DocumentPage, DocumentSection } from './types.js';

export interface MarkdownPageInput {
  /** Canonical site route the page is published at. */
  url: string;
  /** Raw markdown file contents. */
  markdown: string;
  loader: Loader;
  /** Defaults to 'general'. */
  category?: string;
}

interface Frontmatter {
  title?: string;
  tags: string[];
  /** Index of the first line after the closing delimiter. */
  bodyStart: number;
}

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})(.*)$/;
const ATX_HEADING = /^(#{1,6})\s+(.*)$/;
const CONTAINER = /^\s*:{3,}/;
// Only strip known layout/UI tags — a generic <[^>]+> strip would eat Java
// generics like List<String> in prose.
const HTML_TAG_ALLOWLIST = /<\/?(?:Badge|img|br|div|span|video|iframe)\b[^>]*\/?>/gi;

/**
 * Extract a minimal YAML frontmatter block (title + tags) without a YAML
 * dependency. Returns bodyStart = 0 when there is no frontmatter.
 */
function parseFrontmatter(lines: string[]): Frontmatter {
  const result: Frontmatter = { tags: [], bodyStart: 0 };
  if (lines[0]?.trim() !== '---') {
    return result;
  }

  let inTags = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') {
      result.bodyStart = i + 1;
      return result;
    }

    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      inTags = false;
      const [, key, rawValue] = kv;
      const value = (rawValue ?? '').trim().replace(/^["']|["']$/g, '');
      if (key === 'title' && value) {
        result.title = value;
      } else if (key === 'tags') {
        if (value.startsWith('[')) {
          result.tags = value
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map((t) => t.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean);
        } else if (!value) {
          inTags = true; // block-style list follows
        }
      }
    } else if (inTags) {
      const item = line.match(/^\s*-\s+(.+)$/);
      if (item?.[1]) {
        result.tags.push(item[1].trim().replace(/^["']|["']$/g, ''));
      } else if (line.trim()) {
        inTags = false;
      }
    }
  }

  // Unclosed frontmatter — treat the file as having none rather than eating it
  return { tags: [], bodyStart: 0 };
}

/** Strip inline markdown syntax from prose/heading text. */
function cleanInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images dropped
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → label
    .replace(HTML_TAG_ALLOWLIST, '')
    .replace(/`([^`]*)`/g, '$1') // inline code keeps its content
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(\*|_)([^*_]+)\1/g, '$2') // italic
    .trim();
}

/** Heading text: inline cleanup plus ATX/anchor decorations. */
function cleanHeading(text: string): string {
  return cleanInline(
    text
      .replace(/\s+#+\s*$/, '') // trailing closing hashes
      .replace(/\s*\{#[^}]*\}\s*$/, '') // {#anchor} suffixes
  );
}

/** Parse a fence info string: first token → language, title="…" → caption. */
function parseFenceInfo(info: string): { language: string; caption?: string } {
  const trimmed = info.trim();
  const language = trimmed.split(/[\s{]/)[0] || 'text';
  const caption = trimmed.match(/title=["']([^"']+)["']/)?.[1];
  return { language, caption };
}

/**
 * Parse one markdown file into the DocumentPage shape the chunker and store
 * consume. Mirrors the crawler's conventions: 16-char sha256 hash for change
 * detection, a single 'Content' section when the page has no headings, and
 * section order indexes.
 */
export function parseMarkdownPage(input: MarkdownPageInput): DocumentPage {
  const markdown = input.markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = markdown.split('\n');
  const frontmatter = parseFrontmatter(lines);

  interface OpenSection {
    heading: string;
    level: number;
    prose: string[];
    codeBlocks: CodeBlock[];
  }

  let firstH1: string | undefined;
  const preamble: OpenSection = { heading: '', level: 1, prose: [], codeBlocks: [] };
  const opened: OpenSection[] = [];
  let current = preamble;

  let fence: { char: string; length: number; language: string; caption?: string } | null = null;
  let fenceLines: string[] = [];

  const closeFence = () => {
    if (!fence) return;
    const code = fenceLines.join('\n').trim();
    if (code) {
      current.codeBlocks.push({
        language: fence.language,
        code,
        caption: fence.caption,
      });
    }
    fence = null;
    fenceLines = [];
  };

  for (let i = frontmatter.bodyStart; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (fence) {
      const closing = line.trim();
      if (
        closing.length >= fence.length &&
        closing === fence.char.repeat(closing.length) &&
        closing.startsWith(fence.char.repeat(fence.length))
      ) {
        closeFence();
      } else {
        fenceLines.push(line);
      }
      continue;
    }

    const fenceOpen = line.match(FENCE_OPEN);
    if (fenceOpen) {
      const marker = fenceOpen[2] ?? '```';
      fence = {
        char: marker[0] ?? '`',
        length: marker.length,
        ...parseFenceInfo(fenceOpen[3] ?? ''),
      };
      continue;
    }

    if (CONTAINER.test(line)) {
      continue; // VitePress ::: container open/close markers carry no prose
    }

    const heading = line.match(ATX_HEADING);
    if (heading) {
      const text = cleanHeading(heading[2] ?? '');
      const level = (heading[1] ?? '#').length;
      if (level === 1 && !firstH1) {
        firstH1 = text;
      }
      current = { heading: text, level, prose: [], codeBlocks: [] };
      opened.push(current);
      continue;
    }

    const prose = cleanInline(line);
    if (prose) {
      current.prose.push(prose);
    }
  }
  // Unclosed fence: keep the rest of the file as code rather than losing it
  closeFence();

  const title =
    frontmatter.title ||
    firstH1 ||
    cleanHeading(
      (input.url.split('/').filter(Boolean).pop() ?? '').replace(/[-_]+/g, ' ').trim()
    ) ||
    'Untitled';

  const sections: DocumentSection[] = [];
  if (preamble.prose.length > 0 || preamble.codeBlocks.length > 0) {
    sections.push({
      heading: title,
      level: 1,
      content: preamble.prose.join('\n\n'),
      codeBlocks: preamble.codeBlocks,
      order: 0,
    });
  }
  for (const section of opened) {
    sections.push({
      heading: section.heading,
      level: section.level,
      content: section.prose.join('\n\n'),
      codeBlocks: section.codeBlocks,
      order: sections.length,
    });
  }
  if (sections.length === 0) {
    // No headings and no content lines at all — mirror the crawler's fallback
    sections.push({ heading: 'Content', level: 1, content: '', codeBlocks: [], order: 0 });
  }

  const contentParts: string[] = [title];
  for (const section of sections) {
    if (section.heading && section.heading !== title) {
      contentParts.push(section.heading);
    }
    if (section.content) {
      contentParts.push(section.content);
    }
    for (const block of section.codeBlocks) {
      contentParts.push(block.code);
    }
  }
  const content = contentParts
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    url: input.url,
    title,
    content,
    rawHtml: markdown, // provenance: the column is never read at runtime
    category: input.category ?? 'general',
    loader: input.loader,
    minecraftVersion: detectMinecraftVersion(input.url, content, input.loader),
    sections,
    metadata: {
      crawledAt: new Date(),
      tags: frontmatter.tags,
    },
    hash: createHash('sha256').update(markdown).digest('hex').substring(0, 16),
  };
}
