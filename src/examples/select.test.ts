import { describe, it, expect } from 'vitest';
import { selectSnippets, extractRegions, detectImports, matchMarkers } from './select.js';
import type { RawFile, SelectConfig, Snippet } from './model.js';

const NO_LOG = { log: () => {} };
const CAPABILITY_IMPORT = 'net.minecraftforge.common.capabilities.ICapabilityProvider';

/** A class with `count` four-line methods (four lines = above TRIVIAL_REGION_LINES). */
function javaMethods(className: string, count: number, imports: string[] = []): string {
  const head = imports.map((i) => `import ${i};`).join('\n');
  const body = Array.from({ length: count }, (_, i) =>
    [
      `    public void m${i}(int x) {`,
      `        int y = x + ${i};`,
      `        sink(y);`,
      '    }',
    ].join('\n')
  ).join('\n');
  return `${head === '' ? '' : `${head}\n\n`}public class ${className} {\n${body}\n}\n`;
}

function raw(path: string, content: string): RawFile {
  return { path, content, bytes: content.length };
}

function cfg(over: Partial<SelectConfig> = {}): SelectConfig {
  return { repo: 'o/r', maxSnippetsPerRepo: null, maxFileBytes: 1_000_000, ...over };
}

const dirOf = (s: Snippet): string => s.filePath.slice(0, s.filePath.lastIndexOf('/'));
const idOf = (s: Snippet): string => `${s.filePath}:${s.startLine}-${s.endLine}`;

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

describe('selectSnippets cap spreading (DESIGN §6.2)', () => {
  /** Three packages × 5 files × 4 methods = 60 candidates, in a/b/c tree order. */
  function threePackages(): RawFile[] {
    const files: RawFile[] = [];
    for (const pkg of ['a', 'b', 'c']) {
      for (let i = 0; i < 5; i++) {
        files.push(raw(`pkg/${pkg}/C${i}.java`, javaMethods(`C${i}`, 4)));
      }
    }
    return files;
  }

  it('is byte-identical to the uncapped selection when the cap does not bind', () => {
    const files = threePackages();
    const uncapped = selectSnippets(files, cfg({ maxSnippetsPerRepo: null }), NO_LOG);
    expect(uncapped.length).toBe(60);
    // Exactly at the cap, and one above it — neither may reorder or drop.
    for (const cap of [uncapped.length, uncapped.length + 1]) {
      expect(selectSnippets(files, cfg({ maxSnippetsPerRepo: cap }), NO_LOG)).toEqual(uncapped);
    }
  });

  it('spreads the cap across the package tree instead of head-truncating', () => {
    const files = threePackages();
    const uncapped = selectSnippets(files, cfg({ maxSnippetsPerRepo: null }), NO_LOG);
    // What the old slice(0, cap) would have produced: pkg/a only.
    expect(new Set(uncapped.slice(0, 6).map(dirOf))).toEqual(new Set(['pkg/a']));

    const out = selectSnippets(files, cfg({ maxSnippetsPerRepo: 6 }), NO_LOG);
    expect(out.length).toBe(6);
    expect(new Set(out.map(dirOf))).toEqual(new Set(['pkg/a', 'pkg/b', 'pkg/c']));
    // ...and from distinct files within them, not six regions of one class.
    expect(new Set(out.map((s) => s.filePath)).size).toBe(6);
  });

  it('emits kept snippets in original candidate order', () => {
    const files = threePackages();
    const uncapped = selectSnippets(files, cfg({ maxSnippetsPerRepo: null }), NO_LOG);
    const order = uncapped.map(idOf);
    const out = selectSnippets(files, cfg({ maxSnippetsPerRepo: 11 }), NO_LOG);

    const positions = out.map((s) => order.indexOf(idOf(s)));
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('prefers a marker-bearing region over a trivial one inside the same file', () => {
    const content = [
      `import ${CAPABILITY_IMPORT};`,
      '',
      'public class Holder {',
      '    public int getX() {',
      '        return x;',
      '    }',
      '    public <T> T getCapability(Capability<T> cap, EnumFacing side) {',
      '        if (cap == CAP) {',
      '            return CAP.cast(this);',
      '        }',
      '        if (side == null) {',
      '            return null;',
      '        }',
      '        return super.getCapability(cap, side);',
      '    }',
      '}',
    ].join('\n');
    const files = [raw('pkg/Holder.java', content)];
    expect(selectSnippets(files, cfg(), NO_LOG).length).toBe(2);

    const out = selectSnippets(files, cfg({ maxSnippetsPerRepo: 1 }), NO_LOG);
    expect(out).toHaveLength(1);
    expect(out[0]!.code).toContain('getCapability');
  });

  it('prefers a marker-bearing sibling package at the truncation frontier', () => {
    // alpha/beta sort first; only zeta carries the capability import.
    const files = [
      raw('pkg/alpha/A.java', javaMethods('A', 1)),
      raw('pkg/beta/B.java', javaMethods('B', 1)),
      raw('pkg/zeta/Z.java', javaMethods('Z', 1, [CAPABILITY_IMPORT])),
    ];
    const out = selectSnippets(files, cfg({ maxSnippetsPerRepo: 1 }), NO_LOG);
    expect(out.map((s) => s.filePath)).toEqual(['pkg/zeta/Z.java']);
  });

  it('demotes generated/integration directories but not *Integration files', () => {
    // (i) a demoted directory loses even though it comes first in tree order.
    const demoted = [
      raw('pkg/generated/G.java', javaMethods('G', 1)),
      raw('pkg/core/C.java', javaMethods('C', 1)),
    ];
    expect(
      selectSnippets(demoted, cfg({ maxSnippetsPerRepo: 1 }), NO_LOG).map((s) => s.filePath)
    ).toEqual(['pkg/core/C.java']);

    // (ii) the basename is never inspected — TinkerIntegration.java is a mod's
    // bootstrap class, so with equal keys original order decides.
    const named = [
      raw('pkg/core/TinkerIntegration.java', javaMethods('TinkerIntegration', 1)),
      raw('pkg/core/Other.java', javaMethods('Other', 1)),
    ];
    expect(
      selectSnippets(named, cfg({ maxSnippetsPerRepo: 1 }), NO_LOG).map((s) => s.filePath)
    ).toEqual(['pkg/core/TinkerIntegration.java']);
  });

  it('bounds any one file’s share of the cap', () => {
    const files = [raw('Boot.java', javaMethods('Boot', 50))];
    for (let i = 0; i < 20; i++) {
      files.push(raw(`sub/S${i}.java`, javaMethods(`S${i}`, 1)));
    }
    const out = selectSnippets(files, cfg({ maxSnippetsPerRepo: 20 }), NO_LOG);
    expect(out).toHaveLength(20);
    expect(out.filter((s) => s.filePath === 'Boot.java')).toHaveLength(3);
  });

  it('fills the cap exactly when the per-file quota would leave it short', () => {
    const files = [
      raw('pkg/A.java', javaMethods('A', 10)),
      raw('pkg/B.java', javaMethods('B', 10)),
    ];
    // Quota alone yields 3+3; pass 2 refills the remaining 9 slots.
    const out = selectSnippets(files, cfg({ maxSnippetsPerRepo: 15 }), NO_LOG);
    expect(out).toHaveLength(15);
  });

  it('degenerates to head truncation for a flat directory of equal candidates', () => {
    const files: RawFile[] = Array.from({ length: 20 }, (_, i) => ({
      path: `p${i}.java`,
      bytes: 1000,
    }));
    const run = (): string[] =>
      selectSnippets(files, cfg({ maxSnippetsPerRepo: 7 }), NO_LOG).map((s) => s.filePath);
    expect(run()).toEqual([
      'p0.java',
      'p1.java',
      'p2.java',
      'p3.java',
      'p4.java',
      'p5.java',
      'p6.java',
    ]);
    expect(run()).toEqual(run()); // deterministic across calls
  });

  it('logs the shape of the selection and truncates the starved-file list', () => {
    const logs: string[] = [];
    const files: RawFile[] = Array.from({ length: 220 }, (_, i) =>
      raw(`pkg/p${i}/C.java`, javaMethods('C', 1))
    );
    selectSnippets(files, cfg({ maxSnippetsPerRepo: 5 }), { log: (m) => logs.push(m) });

    const joined = logs.join('\n');
    expect(joined).toMatch(/cap coverage/);
    expect(joined).toMatch(/\d+\/\d+ files/);
    expect(joined).toMatch(/\d+\/\d+ directories/);
    expect(joined).toMatch(/head truncation would have kept/);
    // 215 files contributed nothing; only 15 are named.
    expect(joined).toContain('(+200 more)');
    expect(joined.length).toBeLessThan(4000);
  });
});

describe('matchMarkers', () => {
  it('names the marker groups a text touches, in declaration order', () => {
    expect(matchMarkers(`import ${CAPABILITY_IMPORT};`)).toEqual(['capability']);
    expect(matchMarkers('class Foo { void a() {} }')).toEqual([]);
    expect(matchMarkers('import net.minecraftforge.items.IItemHandler;\n@SubscribeEvent')).toEqual([
      'handlers',
      'events',
    ]);
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
