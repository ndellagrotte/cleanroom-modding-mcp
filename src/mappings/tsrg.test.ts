import { describe, it, expect } from 'vitest';
import {
  parseTsrg,
  remapDescriptor,
  splitInternalName,
  parseDescriptorParams,
  paramSlots,
  slotToParamIndex,
} from './tsrg.js';

// Synthetic fixture — invented names and ids, no real MCP data.
const TSRG_V1 = [
  'a net/minecraft/util/FakeTimer',
  '\ta field_1000_a',
  '\tb notRenamedField',
  '\ta ()V func_2000_a',
  '\ta (Lb;J)Z func_2001_b',
  '\tb ()V notRenamed',
  'b net/minecraft/block/FakeBlock$1',
  '\ta (DDDFF)V func_3000_a',
].join('\n');

const TSRG_V2 = [
  'tsrg2 obf srg',
  'a net/minecraft/util/FakeTimer',
  '\tf I field_1000_a',
  '\tg simpleField',
  '\ta (IJ)V func_2000_a',
  '\t\tstatic',
  '\t\t0 o p_2000_0_',
  '\t\t1 t p_2000_1_',
].join('\n');

describe('parseTsrg', () => {
  it('parses v1 classes, fields, and methods', () => {
    const data = parseTsrg(TSRG_V1);
    expect(data.format).toBe('v1');
    expect(data.classes).toHaveLength(2);

    const timer = data.classes[0]!;
    expect(timer.obfName).toBe('a');
    expect(timer.name).toBe('net/minecraft/util/FakeTimer');
    expect(timer.fields).toEqual([
      { obfName: 'a', srgName: 'field_1000_a', obfDescriptor: null },
      { obfName: 'b', srgName: 'notRenamedField', obfDescriptor: null },
    ]);
    expect(timer.methods).toHaveLength(3);
    expect(timer.methods[0]).toMatchObject({
      obfName: 'a',
      obfDescriptor: '()V',
      srgName: 'func_2000_a',
      isStatic: false,
    });
    // Overloads keep separate rows via their descriptors
    expect(timer.methods[1]).toMatchObject({ obfDescriptor: '(Lb;J)Z', srgName: 'func_2001_b' });
    expect(timer.methods[2]).toMatchObject({ srgName: 'notRenamed' });

    expect(data.classes[1]!.name).toBe('net/minecraft/block/FakeBlock$1');
  });

  it('parses v2 headers, field descriptors, static markers, and parameter sub-lines', () => {
    const data = parseTsrg(TSRG_V2);
    expect(data.format).toBe('v2');
    const timer = data.classes[0]!;
    expect(timer.fields).toEqual([
      { obfName: 'f', srgName: 'field_1000_a', obfDescriptor: 'I' },
      { obfName: 'g', srgName: 'simpleField', obfDescriptor: null },
    ]);
    const method = timer.methods.find((m) => m.srgName === 'func_2000_a')!;
    expect(method.isStatic).toBe(true);
    expect(method.params).toEqual([
      { slot: 0, name: 'p_2000_0_' },
      { slot: 1, name: 'p_2000_1_' },
    ]);
  });

  it('ignores blank lines and comments', () => {
    const data = parseTsrg('# comment\n\na x/Y\n');
    expect(data.classes).toHaveLength(1);
  });
});

describe('remapDescriptor', () => {
  it('rewrites known class references and passes unknown ones through', () => {
    const map = new Map([
      ['a', 'x/FakeA'],
      ['b', 'y/FakeB'],
    ]);
    expect(remapDescriptor('(La;Lnet/unknown/K;J)Lb;', map)).toBe(
      '(Lx/FakeA;Lnet/unknown/K;J)Ly/FakeB;'
    );
  });

  it('leaves primitive-only descriptors untouched', () => {
    expect(remapDescriptor('(IJZ)V', new Map())).toBe('(IJZ)V');
  });
});

describe('splitInternalName', () => {
  it('splits package and simple name', () => {
    expect(splitInternalName('net/minecraft/block/FakeBlock$1')).toEqual({
      packageName: 'net.minecraft.block',
      simpleName: 'FakeBlock$1',
    });
  });

  it('handles the default package', () => {
    expect(splitInternalName('TopLevel')).toEqual({ packageName: '', simpleName: 'TopLevel' });
  });
});

describe('parseDescriptorParams', () => {
  it('parses primitives, objects, and arrays', () => {
    expect(parseDescriptorParams('(I[JLjava/lang/String;[[La;D)V')).toEqual([
      'I',
      '[J',
      'Ljava/lang/String;',
      '[[La;',
      'D',
    ]);
  });

  it('returns empty for no-arg and malformed descriptors', () => {
    expect(parseDescriptorParams('()V')).toEqual([]);
    expect(parseDescriptorParams('not-a-descriptor')).toEqual([]);
  });
});

describe('LVT slot math', () => {
  it('numbers instance-method slots from 1 with wide types taking two', () => {
    // The canonical (DDDFF) case: slots 1, 3, 5, 7, 8
    expect(paramSlots('(DDDFF)V', false)).toEqual([
      { index: 0, slot: 1 },
      { index: 1, slot: 3 },
      { index: 2, slot: 5 },
      { index: 3, slot: 7 },
      { index: 4, slot: 8 },
    ]);
  });

  it('numbers static-method slots from 0', () => {
    expect(paramSlots('(JI)V', true)).toEqual([
      { index: 0, slot: 0 },
      { index: 1, slot: 2 },
    ]);
  });

  it('treats arrays of wide types as single-slot references', () => {
    expect(paramSlots('([JLa;D)V', false)).toEqual([
      { index: 0, slot: 1 },
      { index: 1, slot: 2 },
      { index: 2, slot: 3 },
    ]);
  });

  it('maps slots back to logical indexes, rejecting mid-wide slots', () => {
    expect(slotToParamIndex('(DDDFF)V', 5, false)).toBe(2);
    expect(slotToParamIndex('(DDDFF)V', 8, false)).toBe(4);
    expect(slotToParamIndex('(DDDFF)V', 2, false)).toBeNull(); // middle of a double
    expect(slotToParamIndex('(DDDFF)V', 0, false)).toBeNull(); // `this`
    expect(slotToParamIndex('(I)V', 0, true)).toBe(0);
  });
});
