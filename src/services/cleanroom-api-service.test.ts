/**
 * CleanroomApiService tests.
 *
 * Two layers:
 *  - Fixture-backed unit tests (always run): a tiny corpus is pushed through
 *    the real resolve + ingest pipeline into a temp DB, then queried.
 *  - Integration tests gated on the real cleanroom-api.db being installed at
 *    the default data-dir path with the expected schema version.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { DBS } from '../dbs.js';
import { getDefaultDbPath } from '../data-dir.js';
import { initializeCleanroomApiDb, readDbSchemaVersion } from '../cleanroom-api/schema.js';
import { ingest } from '../cleanroom-api/ingest.js';
import { resolveAll } from '../cleanroom-api/resolve.js';
import type { ExtractedFile, ExtractedMember, ExtractedType } from '../cleanroom-api/model.js';
import { CleanroomApiService } from './cleanroom-api-service.js';

const INTEGRATION_DB_PATH = getDefaultDbPath(DBS['cleanroom-api'].fileName);
const DB_OK = readDbSchemaVersion(INTEGRATION_DB_PATH) === DBS['cleanroom-api'].schemaVersion;

// ─────────────────────────────────────────────────────────────────────────────
// Fixture corpus
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

const EVENT_PKG = 'net.minecraftforge.fml.common.eventhandler';

function fixtureFiles(): ExtractedFile[] {
  return [
    {
      path: 'net/minecraftforge/fml/common/eventhandler/Event.java',
      packageName: EVENT_PKG,
      imports: { explicit: {}, wildcards: [] },
      parseErrors: false,
      types: [
        type({
          simpleName: 'Event',
          searchText: 'event',
          members: [
            member({
              name: 'isCanceled',
              returnType: 'boolean',
              // as the extractor builds it: name + declaring type + return type
              searchText: 'iscanceled is canceled event boolean',
            }),
          ],
          children: [
            type({
              simpleName: 'HasResult',
              nestedChain: ['Event', 'HasResult'],
              kind: 'annotation',
              searchText: 'hasresult has result',
            }),
          ],
        }),
        type({ simpleName: 'Cancelable', kind: 'annotation', searchText: 'cancelable' }),
        type({
          simpleName: 'SubscribeEvent',
          kind: 'annotation',
          searchText: 'subscribeevent subscribe event',
        }),
      ],
    },
    {
      path: 'net/minecraftforge/event/entity/player/PlayerInteractEvent.java',
      packageName: 'net.minecraftforge.event.entity.player',
      imports: {
        explicit: {
          Event: `${EVENT_PKG}.Event`,
          Cancelable: `${EVENT_PKG}.Cancelable`,
        },
        wildcards: [],
      },
      parseErrors: false,
      types: [
        type({
          simpleName: 'PlayerInteractEvent',
          extendsRaw: 'Event',
          searchText: 'playerinteractevent player interact event',
          javadoc: {
            body: 'Fired on player interaction.',
            summary: 'Fired on player interaction.',
            deprecatedNote: null,
            since: null,
          },
          children: [
            // Mirrors the real corpus: PlayerInteractEvent is NOT @Cancelable;
            // RightClickBlock carries the annotation directly.
            type({
              simpleName: 'RightClickBlock',
              nestedChain: ['PlayerInteractEvent', 'RightClickBlock'],
              extendsRaw: 'PlayerInteractEvent',
              annotations: ['Cancelable'],
              searchText: 'rightclickblock right click block',
              children: [
                type({
                  simpleName: 'RightClickBlockExtended',
                  nestedChain: [
                    'PlayerInteractEvent',
                    'RightClickBlock',
                    'RightClickBlockExtended',
                  ],
                  extendsRaw: 'RightClickBlock',
                  searchText: 'rightclickblockextended right click block extended',
                }),
              ],
            }),
          ],
        }),
      ],
    },
    {
      path: 'com/cleanroommc/configanytime/ConfigAnytime.java',
      packageName: 'com.cleanroommc.configanytime',
      imports: { explicit: {}, wildcards: [] },
      parseErrors: false,
      types: [
        type({
          simpleName: 'ConfigAnytime',
          searchText: 'configanytime config anytime',
          members: [
            member({
              name: 'register',
              signature: 'public static void register(Class<?> clazz)',
              searchText: 'register configanytime config anytime',
            }),
          ],
        }),
      ],
    },
    {
      path: 'com/example/Underscored.java',
      packageName: 'com.example',
      imports: { explicit: {}, wildcards: [] },
      parseErrors: false,
      types: [
        type({
          simpleName: 'Under_Scored',
          searchText: 'under_scored under scored',
        }),
      ],
    },
    {
      path: 'zone/rong/mixinbooter/IEarlyMixinLoader.java',
      packageName: 'zone.rong.mixinbooter',
      imports: { explicit: {}, wildcards: [] },
      parseErrors: false,
      types: [
        type({
          simpleName: 'IEarlyMixinLoader',
          kind: 'interface',
          annotations: ['Deprecated'],
          isDeprecated: true,
          searchText: 'iearlymixinloader early mixin loader',
          javadoc: {
            body: 'Legacy early mixin loader.',
            summary: 'Legacy early mixin loader.',
            deprecatedNote: 'use the MixinConfigs manifest attribute',
            since: null,
          },
        }),
      ],
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixture-backed unit tests (always run)
// ─────────────────────────────────────────────────────────────────────────────

describe('CleanroomApiService (fixture DB)', () => {
  let tempDir: string;
  let dbPath: string;
  let service: CleanroomApiService;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanroom-api-test-'));
    dbPath = path.join(tempDir, 'cleanroom-api.db');
    ingest(dbPath, resolveAll(fixtureFiles()), {
      cleanroomVersion: '0.0.0-test',
      sourcesJarUrl: null,
      sourcesJarSha256: null,
      parserInfo: 'fixtures',
    });
    service = new CleanroomApiService(dbPath);
  });

  afterAll(() => {
    service.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds types via camel-split FTS ("right click block")', () => {
    const results = service.search({ query: 'right click block' });
    expect(results.length).toBeGreaterThan(0);
    const hit = results.find(
      (r) =>
        r.resultKind === 'type' &&
        r.fqn === 'net.minecraftforge.event.entity.player.PlayerInteractEvent.RightClickBlock'
    );
    expect(hit).toBeDefined();
  });

  it('finds types by camel-case query ("RightClickBlock")', () => {
    const results = service.search({ query: 'RightClickBlock' });
    expect(results.some((r) => r.resultKind === 'type' && r.simpleName === 'RightClickBlock')).toBe(
      true
    );
  });

  it('filters the events catalog with kind:"event" and carries flags', () => {
    const results = service.search({ query: 'interact', kind: 'event' });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.resultKind).toBe('type');
      if (result.resultKind === 'type') {
        expect(result.isEvent).toBe(true);
      }
    }
    const parent = results.find(
      (r) => r.resultKind === 'type' && r.simpleName === 'PlayerInteractEvent'
    );
    // Real corpus semantics: the parent is NOT cancelable, the child is.
    expect(parent && parent.resultKind === 'type' && parent.isCancelable).toBe(false);
  });

  it('direct and inherited cancelable flags reach nested subclass events', () => {
    const results = service.search({ query: 'RightClickBlock', kind: 'event', limit: 25 });
    const direct = results.find(
      (r) => r.resultKind === 'type' && r.simpleName === 'RightClickBlock'
    );
    expect(direct && direct.resultKind === 'type' && direct.isCancelable).toBe(true);
    // Inherited one level down from the directly-annotated event.
    const inherited = results.find(
      (r) => r.resultKind === 'type' && r.simpleName === 'RightClickBlockExtended'
    );
    expect(inherited && inherited.resultKind === 'type' && inherited.isCancelable).toBe(true);
  });

  it('browses by package_filter with an empty query', () => {
    const results = service.search({ query: '', packageFilter: 'zone.rong.mixinbooter' });
    expect(results).toHaveLength(1);
    expect(results[0].resultKind === 'type' && results[0].fqn).toBe(
      'zone.rong.mixinbooter.IEarlyMixinLoader'
    );
  });

  it('finds members and reports the declaring type', () => {
    const results = service.search({ query: 'register', kind: 'method' });
    expect(results.length).toBeGreaterThan(0);
    const hit = results[0];
    expect(hit.resultKind).toBe('member');
    if (hit.resultKind === 'member') {
      expect(hit.name).toBe('register');
      expect(hit.declaringFqn).toBe('com.cleanroommc.configanytime.ConfigAnytime');
    }
  });

  it('reaches the LIKE fallback for FTS-hostile queries', () => {
    // '(((' yields no alphanumerics, so buildFtsQuery returns null and the
    // LIKE branch actually executes (a '"a(' query still goes through FTS).
    for (const hostile of ['(((', '"a(']) {
      let results: ReturnType<CleanroomApiService['search']> | null = null;
      expect(() => {
        results = service.search({ query: hostile });
      }).not.toThrow();
      expect(Array.isArray(results)).toBe(true);
    }
  });

  it('counts corpus annotation usage (annotations catalog popularity)', () => {
    const results = service.search({ query: 'Cancelable', kind: 'annotation' });
    const hit = results.find((r) => r.resultKind === 'type' && r.fqn === `${EVENT_PKG}.Cancelable`);
    expect(hit).toBeDefined();
    expect(hit && hit.resultKind === 'type' && hit.usageCount).toBe(1);
  });

  it('browses members with an empty query and an explicit member kind', () => {
    const results = service.search({ query: '', kind: 'method' });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.resultKind).toBe('member');
    }
    expect(results.some((r) => r.resultKind === 'member' && r.name === 'register')).toBe(true);
  });

  it('normalizes wildcard-only queries to browse', () => {
    const browse = service.search({ query: '', kind: 'class' });
    const wildcard = service.search({ query: '%', kind: 'class' });
    expect(wildcard.map((r) => (r.resultKind === 'type' ? r.fqn : r.name))).toEqual(
      browse.map((r) => (r.resultKind === 'type' ? r.fqn : r.name))
    );
  });

  it('kind "all" splits the limit between types and members', () => {
    const results = service.search({ query: 'event', kind: 'all', limit: 15 });
    expect(results.some((r) => r.resultKind === 'type')).toBe(true);
    expect(results.some((r) => r.resultKind === 'member')).toBe(true);
  });

  it('reports deprecation with the note', () => {
    const results = service.search({ query: 'IEarlyMixinLoader' });
    const hit = results.find((r) => r.resultKind === 'type');
    expect(hit && hit.resultKind === 'type' && hit.isDeprecated).toBe(true);
    expect(hit && hit.resultKind === 'type' && hit.deprecationNote).toBe(
      'use the MixinConfigs manifest attribute'
    );
  });

  it('getTypeByName resolves FQN, unique simple name, and dotted suffix', () => {
    expect(service.getTypeByName(`${EVENT_PKG}.Event`).match?.fqn).toBe(`${EVENT_PKG}.Event`);
    expect(service.getTypeByName('ConfigAnytime').match?.fqn).toBe(
      'com.cleanroommc.configanytime.ConfigAnytime'
    );
    expect(service.getTypeByName('PlayerInteractEvent.RightClickBlock').match?.fqn).toBe(
      'net.minecraftforge.event.entity.player.PlayerInteractEvent.RightClickBlock'
    );
  });

  it('getTypeByName reports candidates for unknown names', () => {
    const lookup = service.getTypeByName('DoesNotExist');
    expect(lookup.match).toBeNull();
    expect(lookup.candidates).toEqual([]);
  });

  it('getTypeByName escapes LIKE wildcards in the input', () => {
    // '%' must not degenerate into a match-all candidate list.
    const wildcard = service.getTypeByName('%');
    expect(wildcard.match).toBeNull();
    expect(wildcard.candidates).toEqual([]);
    // Underscores in real names still resolve (not treated as wildcards).
    expect(service.getTypeByName('Under_Scored').match?.fqn).toBe('com.example.Under_Scored');
  });

  it('reports direct-subclass totals alongside the capped list', () => {
    const eventDetails = service.getTypeByName(`${EVENT_PKG}.Event`).match;
    expect(eventDetails?.subclassCount).toBe(1);
    expect(eventDetails?.knownSubclasses).toEqual([
      'net.minecraftforge.event.entity.player.PlayerInteractEvent',
    ]);
    const block = service.getTypeByName(
      'net.minecraftforge.event.entity.player.PlayerInteractEvent.RightClickBlock'
    ).match;
    expect(block?.subclassCount).toBe(1);
    expect(block?.knownSubclasses[0]?.endsWith('RightClickBlockExtended')).toBe(true);
  });

  it('getClassDetails walks the ancestor chain and lists nested types + subclasses', () => {
    const details = service.getTypeByName('RightClickBlock').match;
    expect(details).not.toBeNull();
    expect(details?.ancestors.map((a) => a.fqn)).toEqual([
      'net.minecraftforge.event.entity.player.PlayerInteractEvent',
      `${EVENT_PKG}.Event`,
    ]);
    expect(details?.isEvent).toBe(true);

    const eventDetails = service.getTypeByName(`${EVENT_PKG}.Event`).match;
    expect(eventDetails?.nestedTypes).toContain(`${EVENT_PKG}.Event.HasResult`);
    expect(eventDetails?.knownSubclasses).toContain(
      'net.minecraftforge.event.entity.player.PlayerInteractEvent'
    );
  });

  it('getStats echoes counts and the indexed Cleanroom version', () => {
    const stats = service.getStats();
    expect(stats.totalTypes).toBeGreaterThan(0);
    expect(stats.events).toBe(4); // Event, PlayerInteractEvent, RightClickBlock, RightClickBlockExtended
    expect(stats.cleanroomVersion).toBe('0.0.0-test');
  });
});

describe('CleanroomApiService availability gate', () => {
  it('treats a schema-mismatched DB as unavailable via readDbSchemaVersion', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanroom-api-schema-'));
    const dbPath = path.join(tempDir, 'cleanroom-api.db');
    try {
      initializeCleanroomApiDb(dbPath).close();
      expect(readDbSchemaVersion(dbPath)).toBe(DBS['cleanroom-api'].schemaVersion);

      const db = new Database(dbPath);
      db.prepare(`UPDATE metadata SET value = '999' WHERE key = 'schema_version'`).run();
      db.close();
      expect(readDbSchemaVersion(dbPath)).toBe(999);
      expect(readDbSchemaVersion(dbPath)).not.toBe(DBS['cleanroom-api'].schemaVersion);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports not-available for a missing default DB without throwing', () => {
    // Whatever the machine state, the static gate must never throw.
    expect(() => CleanroomApiService.isAvailable()).not.toThrow();
    expect(() => CleanroomApiService.isSchemaOutdated()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests (require the real installed DB)
// ─────────────────────────────────────────────────────────────────────────────

describe.runIf(DB_OK)('CleanroomApiService (installed cleanroom-api.db)', () => {
  let service: CleanroomApiService;

  beforeAll(() => {
    service = new CleanroomApiService(INTEGRATION_DB_PATH);
  });

  afterAll(() => {
    service.close();
  });

  it('finds the SubscribeEvent annotation', () => {
    const results = service.search({ query: 'SubscribeEvent', kind: 'annotation' });
    expect(
      results.some(
        (r) =>
          r.resultKind === 'type' &&
          r.fqn === 'net.minecraftforge.fml.common.eventhandler.SubscribeEvent'
      )
    ).toBe(true);
  });

  it('finds RightClickBlock through the events catalog with the cancelable flag', () => {
    const results = service.search({ query: 'right click block', kind: 'event', limit: 25 });
    const hit = results.find((r) => r.resultKind === 'type' && r.simpleName === 'RightClickBlock');
    expect(hit).toBeDefined();
    expect(hit && hit.resultKind === 'type' && hit.isCancelable).toBe(true);
  });

  it('browses a package', () => {
    const results = service.search({
      query: '',
      packageFilter: 'zone.rong.mixinbooter',
      limit: 50,
    });
    expect(results.length).toBeGreaterThanOrEqual(8);
  });

  it('walks a real ancestor chain for a nested event', () => {
    const details = service.getTypeByName(
      'net.minecraftforge.event.entity.player.PlayerInteractEvent.RightClickBlock'
    ).match;
    expect(details).not.toBeNull();
    expect(details?.ancestors.some((a) => a.fqn.endsWith('.Event'))).toBe(true);
  });
});
