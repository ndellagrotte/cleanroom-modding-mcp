import { describe, it, expect } from 'vitest';
import { detectSymbolKind, extractSrgId, type SymbolKind } from './symbol-kind.js';

describe('detectSymbolKind', () => {
  const cases: Array<[string, SymbolKind]> = [
    // Modern official-mappings intermediary tokens — must NOT be mistaken for SRG
    ['m_46859_', 'modern-intermediary'],
    ['f_46443_', 'modern-intermediary'],
    ['p_46860_', 'modern-intermediary'],
    // 1.12.2 SRG
    ['func_71410_x', 'srg-method'],
    ['func_1_a_', 'srg-method'],
    ['field_78443_a', 'srg-field'],
    ['field_70170_p', 'srg-field'],
    ['p_i46742_2_', 'srg-ctor-param'],
    ['p_70080_1_', 'srg-param'],
    // Notch tokens, including inner classes
    ['a', 'notch'],
    ['aab', 'notch'],
    ['bhy$a', 'notch'],
    ['bhy$1', 'notch'],
    ['ab$cd$e', 'notch'],
    // Readable names
    ['Block', 'readable'],
    ['AABB', 'readable'],
    ['Vec3d', 'readable'],
    ['getStateFromMeta', 'readable'],
    ['net.minecraft.block.Block', 'readable'],
    ['Block#getStateFromMeta', 'readable'],
    ['func_notanumber_x', 'readable'],
  ];

  it.each(cases)('classifies %s as %s', (symbol, expected) => {
    expect(detectSymbolKind(symbol)).toBe(expected);
  });
});

describe('extractSrgId', () => {
  it('extracts the numeric id from SRG names and tokens', () => {
    expect(extractSrgId('func_71410_x')).toBe(71410);
    expect(extractSrgId('field_78443_a')).toBe(78443);
    expect(extractSrgId('p_70080_1_')).toBe(70080);
    expect(extractSrgId('p_i46742_2_')).toBe(46742);
  });

  it('returns null for non-SRG symbols', () => {
    expect(extractSrgId('Block')).toBeNull();
    expect(extractSrgId('aab')).toBeNull();
  });
});
