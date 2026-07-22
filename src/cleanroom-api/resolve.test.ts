/**
 * Unit tests for pass-2 resolution: pure fixtures, no parser or database.
 */

import { describe, it, expect } from 'vitest';
import {
  CANCELABLE_FQN,
  EVENT_BASE_FQN,
  loaderForPackage,
  resolveAll,
  resolveName,
} from './resolve.js';
import type { ExtractedFile, ExtractedMember, ExtractedType } from './model.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

function type(overrides: Partial<ExtractedType> & { simpleName: string }): ExtractedType {
  return {
    nestedChain: [overrides.simpleName],
    kind: 'class',
    modifiers: ['public'],
    annotations: [],
    typeParams: null,
    extendsRaw: null,
    implementsRaw: [],
    javadoc: null,
    isDeprecated: false,
    since: null,
    signature: `public class ${overrides.simpleName}`,
    searchText: overrides.simpleName.toLowerCase(),
    members: [],
    children: [],
    ...overrides,
  };
}

function member(overrides: Partial<ExtractedMember> & { name: string }): ExtractedMember {
  return {
    kind: 'method',
    signature: `public void ${overrides.name}()`,
    returnType: 'void',
    params: [],
    modifiers: ['public'],
    annotations: [],
    javadoc: null,
    isDeprecated: false,
    since: null,
    searchText: overrides.name.toLowerCase(),
    ...overrides,
  };
}

function file(overrides: Partial<ExtractedFile> & { packageName: string }): ExtractedFile {
  return {
    path: `${overrides.packageName.replace(/\./g, '/')}/Fixture.java`,
    imports: { explicit: {}, wildcards: [] },
    types: [],
    parseErrors: false,
    ...overrides,
  };
}

const EVENT_PKG = 'net.minecraftforge.fml.common.eventhandler';

/** The Event base class with its nested HasResult annotation, as in Forge. */
function eventBaseFile(): ExtractedFile {
  return file({
    packageName: EVENT_PKG,
    types: [
      type({
        simpleName: 'Event',
        children: [
          type({
            simpleName: 'HasResult',
            nestedChain: ['Event', 'HasResult'],
            kind: 'annotation',
          }),
        ],
      }),
      type({ simpleName: 'Cancelable', kind: 'annotation' }),
      type({ simpleName: 'GenericEvent', extendsRaw: 'Event' }),
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveName
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveName', () => {
  const byFqn = new Set([
    'com.example.Alpha',
    'com.example.Alpha.Inner',
    'com.example.Beta',
    'com.other.Gamma',
    'com.wild.Delta',
    'net.minecraftforge.fml.common.Mod',
    'net.minecraftforge.fml.common.Mod.EventBusSubscriber',
  ]);

  const baseCtx = {
    packageName: 'com.example',
    imports: { explicit: {}, wildcards: [] },
    enclosingFqns: [],
  };

  it('resolves same-package simple names', () => {
    expect(resolveName('Beta', baseCtx, byFqn)).toBe('com.example.Beta');
  });

  it('resolves explicit imports', () => {
    const ctx = { ...baseCtx, imports: { explicit: { Gamma: 'com.other.Gamma' }, wildcards: [] } };
    expect(resolveName('Gamma', ctx, byFqn)).toBe('com.other.Gamma');
  });

  it('terminates on explicit imports pointing outside the corpus', () => {
    const ctx = {
      ...baseCtx,
      // Explicit import wins over the wildcard that WOULD have matched.
      imports: { explicit: { Delta: 'java.util.Delta' }, wildcards: ['com.wild'] },
    };
    expect(resolveName('Delta', ctx, byFqn)).toBeNull();
  });

  it('resolves wildcard imports', () => {
    const ctx = { ...baseCtx, imports: { explicit: {}, wildcards: ['com.wild'] } };
    expect(resolveName('Delta', ctx, byFqn)).toBe('com.wild.Delta');
  });

  it('resolves through the enclosing chain (self, siblings, nested)', () => {
    const ctx = { ...baseCtx, enclosingFqns: ['com.example.Alpha'] };
    expect(resolveName('Alpha', ctx, byFqn)).toBe('com.example.Alpha');
    expect(resolveName('Inner', ctx, byFqn)).toBe('com.example.Alpha.Inner');
  });

  it('resolves corpus-qualified dotted names as-is', () => {
    expect(resolveName('com.other.Gamma', baseCtx, byFqn)).toBe('com.other.Gamma');
  });

  it('resolves dotted names through a resolvable head (Mod.EventBusSubscriber)', () => {
    const ctx = {
      ...baseCtx,
      imports: { explicit: { Mod: 'net.minecraftforge.fml.common.Mod' }, wildcards: [] },
    };
    expect(resolveName('Mod.EventBusSubscriber', ctx, byFqn)).toBe(
      'net.minecraftforge.fml.common.Mod.EventBusSubscriber'
    );
  });

  it('strips generics and arrays before resolving', () => {
    expect(resolveName('Beta<T>', baseCtx, byFqn)).toBe('com.example.Beta');
    expect(resolveName('Beta[]', baseCtx, byFqn)).toBe('com.example.Beta');
  });

  it('returns null for external names', () => {
    expect(resolveName('String', baseCtx, byFqn)).toBeNull();
    expect(resolveName('java.util.List', baseCtx, byFqn)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loaderForPackage
// ─────────────────────────────────────────────────────────────────────────────

describe('loaderForPackage', () => {
  it.each([
    ['com.cleanroommc.hackery', 'cleanroom'],
    ['zone.rong.mixinbooter', 'cleanroom'],
    ['net.minecraftforge.event', 'forge'],
  ])('%s -> %s', (pkg, loader) => {
    expect(loaderForPackage(pkg)).toBe(loader);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveAll
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAll', () => {
  it('assigns dotted FQNs and outer links for nested types', () => {
    const result = resolveAll([
      file({
        packageName: 'com.example',
        types: [
          type({
            simpleName: 'Outer',
            children: [type({ simpleName: 'Inner', nestedChain: ['Outer', 'Inner'] })],
          }),
        ],
      }),
    ]);
    const inner = result.types.find((t) => t.simpleName === 'Inner');
    expect(inner?.fqn).toBe('com.example.Outer.Inner');
    expect(inner?.outerFqn).toBe('com.example.Outer');
    expect(inner?.nestingDepth).toBe(1);
  });

  it('computes the transitive event closure across files, through generics', () => {
    const result = resolveAll([
      eventBaseFile(),
      file({
        packageName: 'net.minecraftforge.event',
        imports: { explicit: {}, wildcards: [EVENT_PKG] },
        types: [
          // Extends a generic base: type args must be stripped for resolution.
          type({ simpleName: 'RegistryEvent', extendsRaw: 'GenericEvent<T>' }),
          type({ simpleName: 'Unrelated' }),
        ],
      }),
      file({
        packageName: 'net.minecraftforge.event.entity',
        imports: {
          explicit: { RegistryEvent: 'net.minecraftforge.event.RegistryEvent' },
          wildcards: [],
        },
        types: [type({ simpleName: 'DeepEvent', extendsRaw: 'RegistryEvent' })],
      }),
    ]);
    const byFqn = new Map(result.types.map((t) => [t.fqn, t]));
    expect(byFqn.get(EVENT_BASE_FQN)?.isEvent).toBe(true);
    expect(byFqn.get(`${EVENT_PKG}.GenericEvent`)?.isEvent).toBe(true);
    expect(byFqn.get('net.minecraftforge.event.RegistryEvent')?.isEvent).toBe(true);
    expect(byFqn.get('net.minecraftforge.event.entity.DeepEvent')?.isEvent).toBe(true);
    expect(byFqn.get('net.minecraftforge.event.Unrelated')?.isEvent).toBe(false);
    expect(result.stats.events).toBe(4);
  });

  it('inherits @Cancelable and @HasResult down the ancestor chain', () => {
    const result = resolveAll([
      eventBaseFile(),
      file({
        packageName: 'net.minecraftforge.event',
        imports: {
          explicit: { Cancelable: CANCELABLE_FQN, Event: EVENT_BASE_FQN },
          wildcards: [],
        },
        types: [
          type({
            simpleName: 'ParentEvent',
            extendsRaw: 'Event',
            annotations: ['Cancelable', 'Event.HasResult'],
          }),
          type({ simpleName: 'ChildEvent', extendsRaw: 'ParentEvent' }),
          type({ simpleName: 'PlainEvent', extendsRaw: 'Event' }),
        ],
      }),
    ]);
    const byFqn = new Map(result.types.map((t) => [t.fqn, t]));
    expect(byFqn.get('net.minecraftforge.event.ParentEvent')?.isCancelable).toBe(true);
    expect(byFqn.get('net.minecraftforge.event.ParentEvent')?.hasResult).toBe(true);
    expect(byFqn.get('net.minecraftforge.event.ChildEvent')?.isCancelable).toBe(true);
    expect(byFqn.get('net.minecraftforge.event.ChildEvent')?.hasResult).toBe(true);
    expect(byFqn.get('net.minecraftforge.event.PlainEvent')?.isCancelable).toBe(false);
  });

  it('accepts an unresolvable bare @HasResult on an event subclass (inherited nested visibility)', () => {
    const result = resolveAll([
      eventBaseFile(),
      file({
        packageName: 'net.minecraftforge.event',
        imports: { explicit: { Event: EVENT_BASE_FQN }, wildcards: [] },
        types: [
          type({ simpleName: 'ResultEvent', extendsRaw: 'Event', annotations: ['HasResult'] }),
        ],
      }),
    ]);
    const resultEvent = result.types.find((t) => t.simpleName === 'ResultEvent');
    expect(resultEvent?.hasResult).toBe(true);
  });

  it('keeps external parents raw-only', () => {
    const result = resolveAll([
      file({
        packageName: 'com.example',
        types: [type({ simpleName: 'Ext', extendsRaw: 'java.util.AbstractList<String>' })],
      }),
    ]);
    const ext = result.types[0];
    expect(ext.extendsRaw).toBe('java.util.AbstractList<String>');
    expect(ext.extendsFqn).toBeNull();
    expect(result.stats.unresolvedParents).toBe(1);
  });

  it('counts usages of corpus-defined annotations only', () => {
    const result = resolveAll([
      file({
        packageName: 'com.example',
        types: [
          type({ simpleName: 'Marker', kind: 'annotation' }),
          type({
            simpleName: 'UserOne',
            annotations: ['Marker', 'Override'],
            members: [member({ name: 'go', annotations: ['Marker'] })],
          }),
          type({ simpleName: 'UserTwo', annotations: ['Marker'] }),
        ],
      }),
    ]);
    expect(result.annotationUsage.get('com.example.Marker')).toBe(3);
    // @Override is external — never counted.
    expect([...result.annotationUsage.keys()]).toEqual(['com.example.Marker']);
    expect(result.stats.annotationTypes).toBe(1);
  });

  it('drops duplicate FQNs, keeping the first occurrence', () => {
    const result = resolveAll([
      file({
        packageName: 'com.example',
        types: [type({ simpleName: 'Dup', modifiers: ['public'] })],
      }),
      file({
        packageName: 'com.example',
        types: [type({ simpleName: 'Dup', modifiers: ['private'] })],
      }),
    ]);
    expect(result.types.filter((t) => t.fqn === 'com.example.Dup')).toHaveLength(1);
    expect(result.types[0].modifiers).toBe('public');
  });

  it('aggregates stats', () => {
    const result = resolveAll([
      eventBaseFile(),
      file({
        packageName: 'com.example',
        types: [
          type({ simpleName: 'Thing', members: [member({ name: 'a' }), member({ name: 'b' })] }),
        ],
      }),
    ]);
    expect(result.stats.totalTypes).toBe(5);
    expect(result.stats.totalMembers).toBe(2);
  });
});
