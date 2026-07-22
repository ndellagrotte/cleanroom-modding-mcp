/**
 * Markdown → DocumentPage parser tests: the VitePress shapes observed in
 * CleanroomMC/Website (frontmatter, ::: containers, titled/long fences) plus
 * the degenerate cases the corpus will eventually throw at us.
 */
import { describe, it, expect } from 'vitest';
import { parseMarkdownPage } from './markdown.js';

const URL = 'https://cleanroommc.com/wiki/forge-mod-development/event';

function page(markdown: string, overrides: Partial<Parameters<typeof parseMarkdownPage>[0]> = {}) {
  return parseMarkdownPage({ url: URL, markdown, loader: 'cleanroom', ...overrides });
}

describe('frontmatter', () => {
  it('extracts title and inline tags, and excludes the block from content', () => {
    const doc = page('---\ntitle: Events\ntags: [forge, events]\n---\n\nBody text.\n');
    expect(doc.title).toBe('Events');
    expect(doc.metadata.tags).toEqual(['forge', 'events']);
    expect(doc.content).not.toContain('tags:');
    expect(doc.content).toContain('Body text.');
  });

  it('extracts block-style tags', () => {
    const doc = page('---\ntitle: T\ntags:\n  - one\n  - two\n---\ntext\n');
    expect(doc.metadata.tags).toEqual(['one', 'two']);
  });

  it('treats unclosed frontmatter as body', () => {
    const doc = page('---\ntitle: Broken\n\nSome text.\n');
    expect(doc.content).toContain('Some text.');
  });
});

describe('code fences', () => {
  it('extracts language and title= caption from four-backtick fences', () => {
    const md = '# Page\n\n````java title="ExampleClass.java"\nclass A {}\n````\n';
    const doc = page(md);
    expect(doc.sections[0]?.codeBlocks[0]).toMatchObject({
      language: 'java',
      code: 'class A {}',
      caption: 'ExampleClass.java',
    });
  });

  it('supports tilde fences and defaults language to text', () => {
    const doc = page('# P\n\n~~~\nplain\n~~~\n');
    expect(doc.sections[0]?.codeBlocks[0]).toMatchObject({ language: 'text', code: 'plain' });
  });

  it('never treats headings or containers inside a fence as structure', () => {
    const doc = page('# P\n\n```md\n# not a heading\n::: not a container\n```\n');
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0]?.codeBlocks[0]?.code).toContain('# not a heading');
  });

  it('keeps the rest of the file as code when a fence is never closed', () => {
    const doc = page('# P\n\n```java\nclass Unclosed {\n');
    expect(doc.sections[0]?.codeBlocks[0]?.code).toBe('class Unclosed {');
  });

  it('requires the closing fence to be at least as long as the opener', () => {
    const doc = page('# P\n\n````java\ncode with ``` inside\n````\n');
    expect(doc.sections[0]?.codeBlocks[0]?.code).toBe('code with ``` inside');
  });
});

describe('containers and inline syntax', () => {
  it('drops ::: markers (including nested and attributed) but keeps their prose', () => {
    const md =
      '# P\n\n::: info Example {id="example"}\nInside text.\n:::: nested\ndeep\n::::\n:::\n';
    const doc = page(md);
    expect(doc.content).toContain('Inside text.');
    expect(doc.content).toContain('deep');
    expect(doc.content).not.toContain(':::');
  });

  it('converts links to labels, drops images, keeps Java generics', () => {
    const doc = page(
      '# P\n\nSee [the docs](https://x.y) and ![alt](img.png). Use List<String> here.\n'
    );
    expect(doc.content).toContain('See the docs');
    expect(doc.content).not.toContain('https://x.y');
    expect(doc.content).not.toContain('img.png');
    expect(doc.content).toContain('List<String>');
  });
});

describe('sections', () => {
  it('handles heading level jumps and preserves order', () => {
    const doc = page('## First\na\n#### Deep\nb\n## Back\nc\n');
    expect(doc.sections.map((s) => [s.heading, s.level, s.order])).toEqual([
      ['First', 2, 0],
      ['Deep', 4, 1],
      ['Back', 2, 2],
    ]);
  });

  it('puts preamble text before the first heading into a title-named section', () => {
    const doc = page('---\ntitle: Intro\n---\nPreamble line.\n\n## Later\nx\n');
    expect(doc.sections[0]).toMatchObject({ heading: 'Intro', level: 1 });
    expect(doc.sections[0]?.content).toContain('Preamble line.');
  });

  it('falls back to a single Content section for an empty page', () => {
    const doc = page('');
    expect(doc.sections).toEqual([
      { heading: 'Content', level: 1, content: '', codeBlocks: [], order: 0 },
    ]);
  });

  it('strips anchors and closing hashes from headings', () => {
    const doc = page('## `getCapability` explained {#getcap} ##\nx\n');
    expect(doc.sections[0]?.heading).toBe('getCapability explained');
  });
});

describe('page assembly', () => {
  it('derives the title from the first H1 when frontmatter has none', () => {
    expect(page('# Real Title\n\ntext\n').title).toBe('Real Title');
  });

  it('derives the title from the URL as a last resort', () => {
    expect(page('just text\n').title).toBe('event');
  });

  it('labels the page with the loader, category, and fixed 1.12.2 version', () => {
    const doc = page('# T\ntext\n', { category: 'events' });
    expect(doc.loader).toBe('cleanroom');
    expect(doc.category).toBe('events');
    expect(doc.minecraftVersion).toBe('1.12.2');
  });

  it('produces a stable 16-char hash and keeps the raw markdown', () => {
    const md = '# T\n\nSame input.\n';
    const a = page(md);
    const b = page(md);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(a.rawHtml).toBe(md);
    expect(page('# T\n\nDifferent input.\n').hash).not.toBe(a.hash);
  });
});
