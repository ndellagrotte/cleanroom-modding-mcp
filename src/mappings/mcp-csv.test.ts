import { describe, it, expect } from 'vitest';
import {
  parseCsv,
  parseMcpNamesCsv,
  parseParamsCsv,
  parseConstructors,
  parseStaticMethods,
} from './mcp-csv.js';

// Synthetic fixtures — invented names and ids, no real MCP data.

describe('parseCsv', () => {
  it('handles quoted fields with commas and escaped quotes', () => {
    const rows = parseCsv('a,"b, c","say ""hi""",d\r\ne,f,g,h\n');
    expect(rows).toEqual([
      ['a', 'b, c', 'say "hi"', 'd'],
      ['e', 'f', 'g', 'h'],
    ]);
  });

  it('handles a file without a trailing newline', () => {
    expect(parseCsv('a,b')).toEqual([['a', 'b']]);
  });

  it('preserves newlines inside quoted fields', () => {
    expect(parseCsv('a,"line1\nline2",c\n')).toEqual([['a', 'line1\nline2', 'c']]);
  });
});

describe('parseMcpNamesCsv', () => {
  const CSV = [
    'searge,name,side,desc',
    'func_2000_a,tick,0,"Ticks the timer, advancing partial ticks."',
    'func_2001_b,isDone,0,',
    'field_1000_a,timerSpeed,2,Speed with ""quotes"" inside',
  ].join('\n');

  it('maps SRG names to readable names with javadoc', () => {
    const map = parseMcpNamesCsv(CSV);
    expect(map.get('func_2000_a')).toEqual({
      name: 'tick',
      javadoc: 'Ticks the timer, advancing partial ticks.',
    });
    expect(map.get('func_2001_b')).toEqual({ name: 'isDone', javadoc: null });
    expect(map.get('field_1000_a')?.name).toBe('timerSpeed');
    expect(map.has('searge')).toBe(false); // header skipped
  });
});

describe('parseParamsCsv', () => {
  it('maps SRG param tokens to readable names', () => {
    const map = parseParamsCsv('param,name,side\np_2001_1_,other,0\np_i5000_1_,speed,0\n');
    expect(map.get('p_2001_1_')).toBe('other');
    expect(map.get('p_i5000_1_')).toBe('speed');
    expect(map.has('param')).toBe(false);
  });
});

describe('parseConstructors', () => {
  it('parses id, owner, and descriptor; skips malformed lines', () => {
    const ctors = parseConstructors(
      ['5000 net/minecraft/util/FakeTimer (F)V', 'garbage line without descriptor', ''].join('\n')
    );
    expect(ctors).toEqual([
      { id: 5000, owner: 'net/minecraft/util/FakeTimer', descriptor: '(F)V' },
    ]);
  });
});

describe('parseStaticMethods', () => {
  it('collects one SRG name per line', () => {
    const set = parseStaticMethods('func_2002_c\n\nfunc_2003_d\n');
    expect(set).toEqual(new Set(['func_2002_c', 'func_2003_d']));
  });
});
