/**
 * Symbol-count regression test for cleanroom-api.db (DESIGN.md §8, Phase 3).
 *
 * The mitigation for tree-sitter parser edge cases on modern Java syntax:
 * if extraction silently loses declarations, these lower bounds fail. Floors
 * are measured on Cleanroom 0.6.3-alpha with ~15-30% headroom, tight enough
 * that a targeted loss (one namespace, one member kind, the deep event
 * levels) trips them while ordinary corpus drift across Cleanroom releases
 * does not; sentinel symbols pin the load-bearing API surface an agent
 * relies on. Measured 0.6.3-alpha: 1643 types (forge 1219 / cleanroommc 413
 * / zone.rong 11), 14105 members (7163 methods, 5127 fields, 1266 ctors),
 * 315 events, 42 annotation types, 18 usage rows, 22 deprecated types,
 * 571 javadoc'd types.
 *
 * Runs only when the real database is installed at the default data-dir path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { DBS } from '../dbs.js';
import { getDefaultDbPath } from '../data-dir.js';
import { readDbSchemaVersion } from './schema.js';

const DB_PATH = getDefaultDbPath(DBS['cleanroom-api'].fileName);
const DB_OK = readDbSchemaVersion(DB_PATH) === DBS['cleanroom-api'].schemaVersion;

describe.runIf(DB_OK)('cleanroom-api.db symbol counts', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(DB_PATH, { readonly: true });
  });

  afterAll(() => {
    db.close();
  });

  const count = (sql: string, ...params: unknown[]): number =>
    (db.prepare(sql).get(...params) as { c: number }).c;

  const typeRow = (fqn: string): Record<string, unknown> | undefined =>
    db.prepare(`SELECT * FROM types WHERE fqn = ?`).get(fqn) as Record<string, unknown> | undefined;

  // ── Corpus-size floors ──────────────────────────────────────────────────────

  it('indexes the forked Forge API (>= 1000 types)', () => {
    expect(
      count(`SELECT COUNT(*) c FROM types WHERE package_name LIKE 'net.minecraftforge%'`)
    ).toBeGreaterThanOrEqual(1000);
  });

  it('indexes the Cleanroom namespaces (>= 300 com.cleanroommc types)', () => {
    expect(
      count(`SELECT COUNT(*) c FROM types WHERE package_name LIKE 'com.cleanroommc%'`)
    ).toBeGreaterThanOrEqual(300);
  });

  it('indexes the MixinBooter API (>= 8 zone.rong types)', () => {
    expect(
      count(`SELECT COUNT(*) c FROM types WHERE package_name LIKE 'zone.rong%'`)
    ).toBeGreaterThanOrEqual(8);
  });

  it('indexes >= 1500 types and >= 13000 members overall', () => {
    expect(count(`SELECT COUNT(*) c FROM types`)).toBeGreaterThanOrEqual(1500);
    expect(count(`SELECT COUNT(*) c FROM members`)).toBeGreaterThanOrEqual(13000);
  });

  it('keeps every member kind populated (methods >= 6500, fields >= 4600)', () => {
    expect(count(`SELECT COUNT(*) c FROM members WHERE kind = 'method'`)).toBeGreaterThanOrEqual(
      6500
    );
    expect(count(`SELECT COUNT(*) c FROM members WHERE kind = 'field'`)).toBeGreaterThanOrEqual(
      4600
    );
  });

  it('derives the events catalog (>= 250 events)', () => {
    expect(count(`SELECT COUNT(*) c FROM types WHERE is_event = 1`)).toBeGreaterThanOrEqual(250);
  });

  it('derives the annotations catalog (>= 35 annotation types, with usage rows)', () => {
    expect(count(`SELECT COUNT(*) c FROM types WHERE kind = 'annotation'`)).toBeGreaterThanOrEqual(
      35
    );
    expect(count(`SELECT COUNT(*) c FROM annotation_usage`)).toBeGreaterThanOrEqual(14);
  });

  it('captures deprecation (>= 15 deprecated types) and javadoc coverage', () => {
    expect(count(`SELECT COUNT(*) c FROM types WHERE is_deprecated = 1`)).toBeGreaterThanOrEqual(
      15
    );
    expect(count(`SELECT COUNT(*) c FROM types WHERE javadoc IS NOT NULL`)).toBeGreaterThanOrEqual(
      400
    );
  });

  it('records provenance metadata', () => {
    const version = db
      .prepare(`SELECT value FROM metadata WHERE key = 'cleanroom_version'`)
      .get() as { value: string } | undefined;
    expect(version?.value).toBeTruthy();
    const counts = db.prepare(`SELECT value FROM metadata WHERE key = 'counts'`).get() as
      | { value: string }
      | undefined;
    expect(() => JSON.parse(counts?.value ?? '') as unknown).not.toThrow();
  });

  // ── Sentinel symbols (the load-bearing API surface) ─────────────────────────

  it('sentinel: Event base class is itself an event', () => {
    const event = typeRow('net.minecraftforge.fml.common.eventhandler.Event');
    expect(event).toBeDefined();
    expect(event?.kind).toBe('class');
    expect(event?.is_event).toBe(1);
  });

  it('sentinel: @SubscribeEvent annotation', () => {
    const row = typeRow('net.minecraftforge.fml.common.eventhandler.SubscribeEvent');
    expect(row?.kind).toBe('annotation');
  });

  it('sentinel: @Mod with nested Mod.EventHandler', () => {
    expect(typeRow('net.minecraftforge.fml.common.Mod')?.kind).toBe('annotation');
    const nested = typeRow('net.minecraftforge.fml.common.Mod.EventHandler');
    expect(nested?.kind).toBe('annotation');
    expect(nested?.outer_fqn).toBe('net.minecraftforge.fml.common.Mod');
  });

  it('sentinel: Event.HasResult nested annotation', () => {
    const row = typeRow('net.minecraftforge.fml.common.eventhandler.Event.HasResult');
    expect(row?.kind).toBe('annotation');
    expect(row?.outer_fqn).toBe('net.minecraftforge.fml.common.eventhandler.Event');
  });

  it('sentinel: PlayerInteractEvent.RightClickBlock is a cancelable event', () => {
    const row = typeRow(
      'net.minecraftforge.event.entity.player.PlayerInteractEvent.RightClickBlock'
    );
    expect(row).toBeDefined();
    expect(row?.is_event).toBe(1);
    expect(row?.is_cancelable).toBe(1);
  });

  it('sentinel: EnumHackery.addEnumEntry (Cleanroom modern-Java shim)', () => {
    const row = typeRow('com.cleanroommc.hackery.enums.EnumHackery');
    expect(row).toBeDefined();
    expect(row?.loader).toBe('cleanroom');
    expect(
      count(
        `SELECT COUNT(*) c FROM members m JOIN types t ON t.id = m.type_id
         WHERE t.fqn = 'com.cleanroommc.hackery.enums.EnumHackery' AND m.name = 'addEnumEntry'`
      )
    ).toBeGreaterThanOrEqual(1);
  });

  it('sentinel: ConfigAnytime.register', () => {
    expect(
      count(
        `SELECT COUNT(*) c FROM members m JOIN types t ON t.id = m.type_id
         WHERE t.fqn = 'com.cleanroommc.configanytime.ConfigAnytime' AND m.name = 'register'`
      )
    ).toBeGreaterThanOrEqual(1);
  });

  it('sentinel: deprecated MixinBooter legacy interfaces', () => {
    const row = typeRow('zone.rong.mixinbooter.IEarlyMixinLoader');
    expect(row).toBeDefined();
    expect(row?.is_deprecated).toBe(1);
    expect(row?.loader).toBe('cleanroom');
  });

  it('sentinel: GameRegistry (the registration workhorse)', () => {
    const row = typeRow('net.minecraftforge.fml.common.registry.GameRegistry');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('class');
    expect(
      count(
        `SELECT COUNT(*) c FROM members m JOIN types t ON t.id = m.type_id
         WHERE t.fqn = 'net.minecraftforge.fml.common.registry.GameRegistry'`
      )
    ).toBeGreaterThanOrEqual(10);
  });

  // ── Structural invariants ───────────────────────────────────────────────────

  it('every nested type has a resolvable outer_fqn', () => {
    expect(
      count(
        `SELECT COUNT(*) c FROM types nested
         WHERE nested.outer_fqn IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM types outer_t WHERE outer_t.fqn = nested.outer_fqn)`
      )
    ).toBe(0);
  });

  it('FTS tables are consistent with their content tables', () => {
    expect(count(`SELECT COUNT(*) c FROM types_fts`)).toBe(count(`SELECT COUNT(*) c FROM types`));
    expect(count(`SELECT COUNT(*) c FROM members_fts`)).toBe(
      count(`SELECT COUNT(*) c FROM members`)
    );
  });

  it('loader attribution matches namespaces', () => {
    expect(
      count(
        `SELECT COUNT(*) c FROM types
         WHERE (package_name LIKE 'net.minecraftforge%' AND loader != 'forge')
            OR (package_name LIKE 'com.cleanroommc%' AND loader != 'cleanroom')
            OR (package_name LIKE 'zone.rong%' AND loader != 'cleanroom')`
      )
    ).toBe(0);
  });

  it('contains no vanilla net.minecraft.* types (mappings DB owns those)', () => {
    expect(
      count(
        `SELECT COUNT(*) c FROM types
         WHERE package_name = 'net.minecraft' OR package_name LIKE 'net.minecraft.%'`
      )
    ).toBe(0);
  });
});
