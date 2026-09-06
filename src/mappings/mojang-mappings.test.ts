import { describe, it, expect } from 'vitest';
import {
  javaMethodToJvmDescriptor,
  javaTypeToJvmDescriptor,
  mergeModernFields,
  parseMojangMappings,
} from './mojang-mappings.js';

const SAMPLE = [
  '# compiled from: Player.java',
  '',
  'net.minecraft.world.entity.player.Player -> bfp:',
  '    int attackStrengthTicker -> bC',
  '    net.minecraft.world.food.FoodData foodData -> bD',
  '    12:15:net.minecraft.world.phys.Vec3 getEyePosition(float) -> a',
  '    boolean isCreative() -> b',
  '    20:24:void hurt(net.minecraft.world.damagesource.DamageSource,float) -> c',
  'net.minecraft.world.level.block.Block -> ded:',
  '    boolean isRandomlyTicking -> f',
  '    3:3:void randomTick(net.minecraft.world.level.block.state.BlockState) -> a',
].join('\n');

describe('parseMojangMappings', () => {
  it('parses class deobfuscated/obfuscated names and keys by deobfuscated name', () => {
    const { classes } = parseMojangMappings(SAMPLE);

    expect(classes.size).toBe(2);
    const player = classes.get('net.minecraft.world.entity.player.Player');
    expect(player).toBeDefined();
    expect(player?.deobfuscated).toBe('net.minecraft.world.entity.player.Player');
    expect(player?.obfuscated).toBe('bfp');
    expect(classes.get('net.minecraft.world.level.block.Block')?.obfuscated).toBe('ded');
  });

  it('parses fields with their type, keyed by deobfuscated name', () => {
    const player = parseMojangMappings(SAMPLE).classes.get(
      'net.minecraft.world.entity.player.Player'
    );

    expect(player?.fields.size).toBe(2);
    expect(player?.fields.get('attackStrengthTicker')).toEqual({
      deobfuscated: 'attackStrengthTicker',
      obfuscated: 'bC',
      type: 'int',
    });
    expect(player?.fields.get('foodData')).toEqual({
      deobfuscated: 'foodData',
      obfuscated: 'bD',
      type: 'net.minecraft.world.food.FoodData',
    });
  });

  it('strips the line:line: prefix and keys methods by name + args', () => {
    const player = parseMojangMappings(SAMPLE).classes.get(
      'net.minecraft.world.entity.player.Player'
    );

    expect(player?.methods.get('getEyePosition(float)')).toEqual({
      deobfuscated: 'getEyePosition',
      obfuscated: 'a',
      args: 'float',
      returnType: 'net.minecraft.world.phys.Vec3',
    });
  });

  it('handles methods with no line prefix and no arguments', () => {
    const player = parseMojangMappings(SAMPLE).classes.get(
      'net.minecraft.world.entity.player.Player'
    );

    expect(player?.methods.get('isCreative()')).toEqual({
      deobfuscated: 'isCreative',
      obfuscated: 'b',
      args: '',
      returnType: 'boolean',
    });
  });

  it('keeps overloads distinct rather than collapsing them', () => {
    const text = [
      'net.minecraft.Foo -> a:',
      '    1:1:void bar(int) -> a',
      '    2:2:void bar(int,java.lang.String) -> b',
      '    3:3:void bar() -> c',
    ].join('\n');

    const methods = parseMojangMappings(text).classes.get('net.minecraft.Foo')?.methods;
    expect(methods?.size).toBe(3);
    expect(methods?.get('bar(int)')?.obfuscated).toBe('a');
    expect(methods?.get('bar(int,java.lang.String)')?.obfuscated).toBe('b');
    expect(methods?.get('bar()')?.obfuscated).toBe('c');
  });

  it('associates members with the most recent class', () => {
    const block = parseMojangMappings(SAMPLE).classes.get('net.minecraft.world.level.block.Block');

    expect(block?.fields.size).toBe(1);
    expect(block?.fields.get('isRandomlyTicking')?.obfuscated).toBe('f');
    expect(block?.methods.size).toBe(1);
    expect(
      block?.methods.get('randomTick(net.minecraft.world.level.block.state.BlockState)')?.obfuscated
    ).toBe('a');
  });

  it('skips comments, blank lines, and members with no preceding class', () => {
    const text = [
      '# a comment',
      '',
      '    int orphaned -> a',
      'net.minecraft.Foo -> a:',
      '    int kept -> b',
    ].join('\n');

    const { classes } = parseMojangMappings(text);
    expect(classes.size).toBe(1);
    expect(classes.get('net.minecraft.Foo')?.fields.size).toBe(1);
    expect(classes.get('net.minecraft.Foo')?.fields.has('kept')).toBe(true);
  });

  it('returns an empty map for input with no mappings', () => {
    expect(parseMojangMappings('').classes.size).toBe(0);
    expect(parseMojangMappings('# header only\n').classes.size).toBe(0);
  });
});

describe('modern field ingestion', () => {
  it('converts Mojang Java types and method signatures to JVM descriptors', () => {
    expect(javaTypeToJvmDescriptor('int')).toBe('I');
    expect(javaTypeToJvmDescriptor('net.minecraft.world.level.Level[][]')).toBe(
      '[[Lnet/minecraft/world/level/Level;'
    );
    expect(javaMethodToJvmDescriptor('net.minecraft.world.level.Level,int[]', 'boolean')).toBe(
      '(Lnet/minecraft/world/level/Level;[I)Z'
    );
  });

  it('unions documented Parchment fields with Mojang-only fields', () => {
    const player = parseMojangMappings(SAMPLE).classes.get(
      'net.minecraft.world.entity.player.Player'
    );
    const fields = mergeModernFields(
      [
        {
          name: 'attackStrengthTicker',
          descriptor: 'I',
          javadoc: ['Ticks since the last attack.'],
        },
        {
          name: 'parchmentOnly',
          descriptor: 'Ljava/lang/String;',
        },
      ],
      player
    );

    expect(fields).toEqual([
      {
        name: 'attackStrengthTicker',
        notchName: 'bC',
        descriptor: 'I',
        javadoc: 'Ticks since the last attack.',
      },
      {
        name: 'parchmentOnly',
        notchName: null,
        descriptor: 'Ljava/lang/String;',
        javadoc: null,
      },
      {
        name: 'foodData',
        notchName: 'bD',
        descriptor: 'Lnet/minecraft/world/food/FoodData;',
        javadoc: null,
      },
    ]);
  });
});
