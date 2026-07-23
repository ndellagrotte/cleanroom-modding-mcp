import { describe, it, expect } from 'vitest';
import { selectSnippets, extractRegions, detectImports } from './select.js';
import type { RawFile, SelectConfig } from './model.js';

describe('selectSnippets caps', () => {
  it('enforces maxSnippetsPerRepo and logs the dropped files (no silent caps)', () => {
    const logs: string[] = [];
    const files: RawFile[] = Array.from({ length: 10 }, (_, i) => ({
      path: `p${i}.java`,
      bytes: 1000,
    }));
    const cfg: SelectConfig = { repo: 'o/r', maxSnippetsPerRepo: 3, maxFileBytes: 100000 };
    const out = selectSnippets(files, cfg, { log: (m) => logs.push(m) });

    expect(out.length).toBe(3);
    const joined = logs.join('\n');
    expect(joined).toMatch(/o\/r/);
    expect(joined).toMatch(/drop|skip|cap|truncat/i);
    expect(joined).toMatch(/p[3-9]\.java/);
  });

  it('skips oversize files and logs them', () => {
    const logs: string[] = [];
    const files: RawFile[] = [
      { path: 'big.java', bytes: 999999, content: 'class Big {}' },
      { path: 'ok.java', bytes: 100, content: 'class Ok {}' },
    ];
    const cfg: SelectConfig = { repo: 'o/r', maxSnippetsPerRepo: null, maxFileBytes: 1000 };
    const out = selectSnippets(files, cfg, { log: (m) => logs.push(m) });
    expect(out.every((s) => s.filePath !== 'big.java')).toBe(true);
    expect(logs.join('\n')).toMatch(/big\.java/);
  });

  it('applies include/exclude globs', () => {
    const files: RawFile[] = [
      { path: 'src/main/java/pkg/A.java', bytes: 50, content: 'class A {}' },
      { path: 'src/main/java/integration/B.java', bytes: 50, content: 'class B {}' },
    ];
    const cfg: SelectConfig = {
      repo: 'o/r',
      include: ['src/main/java/**/*.java'],
      exclude: ['**/integration/**'],
      maxSnippetsPerRepo: null,
      maxFileBytes: 100000,
    };
    const out = selectSnippets(files, cfg, { log: () => {} });
    expect(out.map((s) => s.filePath)).toEqual(['src/main/java/pkg/A.java']);
  });
});

describe('extractRegions', () => {
  it('extracts each method as its own region with line provenance', () => {
    const code = [
      'public class Foo {',
      '    public void a() {',
      '        System.out.println("a");',
      '    }',
      '    public int b() {',
      '        return 1;',
      '    }',
      '}',
    ].join('\n');
    const regions = extractRegions(code, 60).filter((r) => r.code !== '');
    expect(regions.length).toBe(2);
    expect(regions[0].code).toContain('void a()');
    expect(regions[1].code).toContain('int b()');
    expect(regions[0].startLine).toBe(2);
  });

  it('is not corrupted by braces inside strings and comments', () => {
    const code = [
      'public class Foo {',
      '    public void a() {',
      '        String s = "unbalanced { brace";',
      '        // a stray } in a comment',
      '    }',
      '    public void b() {',
      '        log("}}}");',
      '    }',
      '}',
    ].join('\n');
    const regions = extractRegions(code, 60).filter((r) => r.code !== '');
    expect(regions.length).toBe(2);
    expect(regions[0].code).toContain('void a()');
    expect(regions[1].code).toContain('void b()');
  });

  it('masks Java text-block braces so multi-line blocks do not merge regions', () => {
    const code = [
      'public class Foo {',
      '    public void a() {',
      '        String s = """',
      '            unbalanced {',
      '            """;',
      '    }',
      '    public void b() {',
      '        c();',
      '    }',
      '}',
    ].join('\n');
    const regions = extractRegions(code, 60).filter((r) => r.code !== '');
    expect(regions.length).toBe(2);
    expect(regions[1].code).toContain('void b()');
  });

  it('does not emit a spurious region for a multi-line annotation array', () => {
    const code = [
      'public class Foo {',
      '    @Foo({',
      '        A.class,',
      '        B.class',
      '    })',
      '    public void m() {',
      '        body();',
      '    }',
      '}',
    ].join('\n');
    const regions = extractRegions(code, 60).filter((r) => r.code !== '');
    expect(regions.length).toBe(1);
    expect(regions[0].code).toContain('void m()');
  });

  it('flags over-cap regions with an empty sentinel', () => {
    const body = Array.from({ length: 80 }, (_, i) => `        int x${i} = ${i};`).join('\n');
    const code = `public class Big {\n    public void huge() {\n${body}\n    }\n}`;
    const regions = extractRegions(code, 20);
    expect(regions.some((r) => r.code === '')).toBe(true);
  });
});

describe('detectImports', () => {
  it('collects fully-qualified imports (incl. static)', () => {
    const code = 'import net.minecraft.world.World;\nimport static foo.Bar.baz;\nclass X {}';
    expect(detectImports(code)).toEqual(['net.minecraft.world.World', 'foo.Bar.baz']);
  });
});
