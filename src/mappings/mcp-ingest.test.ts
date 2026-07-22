import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { initializeMappingsDb, readDbSchemaVersion, MAPPINGS_SCHEMA_VERSION } from './schema.js';
import { ingestMcpEra, type McpArtifacts } from './mcp-ingest.js';

// Fully synthetic fixture corpus — invented names and ids, no real MCP data.
//
// FakeTimer (obf `a`):
//   field  a -> field_1000_a  (readable timerSpeed)
//   field  b -> notRenamedField
//   method a ()V     -> func_2000_a (readable tick, javadoc)
//   method a (Lb;J)Z -> func_2001_b (readable isDone) — overload of obf `a`
//   method b ()V     -> notRenamed
//   ctor id 5000 (F)V with param p_i5000_1_ (readable speed)
// FakeBlock$1 (obf `b`):
//   method a (DDDFF)V -> func_3000_a (wide-slot params)
//   method c (I)V     -> func_2002_c (static, param at slot 0)
//   method d ()V      -> func_2000_a (override: same SRG id as FakeTimer.a)
const ARTIFACTS: McpArtifacts = {
  tsrgText: [
    'a net/minecraft/util/FakeTimer',
    '\ta field_1000_a',
    '\tb notRenamedField',
    '\ta ()V func_2000_a',
    '\ta (Lb;J)Z func_2001_b',
    '\tb ()V notRenamed',
    'b net/minecraft/block/FakeBlock$1',
    '\ta (DDDFF)V func_3000_a',
    '\tc (I)V func_2002_c',
    '\td ()V func_2000_a',
  ].join('\n'),
  constructorsText: [
    '5000 net/minecraft/util/FakeTimer (F)V',
    '5001 net/missing/Clazz (I)V', // owner not in TSRG -> skipped
  ].join('\n'),
  staticMethodsText: 'func_2002_c\n',
  fieldsCsv: 'searge,name,side,desc\nfield_1000_a,timerSpeed,0,"Speed, in ticks."\n',
  methodsCsv:
    'searge,name,side,desc\nfunc_2000_a,tick,0,Advances the timer.\nfunc_2001_b,isDone,0,\n',
  paramsCsv: [
    'param,name,side',
    'p_2001_1_,other,0',
    'p_2001_2_,time,0',
    'p_2002_0_,level,0',
    'p_3000_1_,x,0',
    'p_3000_3_,y,0',
    'p_3000_5_,z,0',
    'p_3000_7_,yaw,0',
    'p_3000_8_,pitch,0',
    'p_i5000_1_,speed,0',
    'p_9999_1_,orphan,0', // no method with SRG id 9999 -> skipped
  ].join('\n'),
  mcpConfigVersion: '1.12.2-test',
  mcpSource: 'outlands',
};

describe('ingestMcpEra', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initializeMappingsDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('ingests classes with mapping_set, notch names, and package split', () => {
    const stats = ingestMcpEra(db, ARTIFACTS);
    expect(stats.classes).toBe(2);

    const timer = db.prepare(`SELECT * FROM classes WHERE name = 'FakeTimer'`).get() as Record<
      string,
      unknown
    >;
    expect(timer.package_name).toBe('net.minecraft.util');
    expect(timer.notch_name).toBe('a');
    expect(timer.mapping_set).toBe('mcp');
    expect(timer.minecraft_version).toBe('1.12.2');

    const inner = db.prepare(`SELECT * FROM classes WHERE name = 'FakeBlock$1'`).get() as Record<
      string,
      unknown
    >;
    expect(inner.package_name).toBe('net.minecraft.block');
  });

  it('keeps overloads as separate rows and gates srg_name on the SRG pattern', () => {
    ingestMcpEra(db, ARTIFACTS);
    const rows = db
      .prepare(
        `SELECT m.name, m.srg_name, m.notch_name, m.descriptor FROM methods m
         JOIN classes c ON m.class_id = c.id WHERE c.name = 'FakeTimer' AND m.notch_name = 'a'
         ORDER BY m.id`
      )
      .all() as Array<Record<string, unknown>>;
    // Two overloads of obf `a`, structurally distinct via descriptors
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: 'tick', srg_name: 'func_2000_a', descriptor: '()V' });
    // Descriptor remapped through the class map: Lb; -> the named inner class
    expect(rows[1]).toMatchObject({
      name: 'isDone',
      srg_name: 'func_2001_b',
      descriptor: '(Lnet/minecraft/block/FakeBlock$1;J)Z',
    });

    const notRenamed = db
      .prepare(`SELECT srg_name, name FROM methods WHERE name = 'notRenamed'`)
      .get() as Record<string, unknown>;
    expect(notRenamed.srg_name).toBeNull();
  });

  it('resolves readable field names from the CSV and leaves v1 descriptors NULL', () => {
    const stats = ingestMcpEra(db, ARTIFACTS);
    expect(stats.fields).toBe(2);
    const field = db
      .prepare(`SELECT * FROM fields WHERE srg_name = 'field_1000_a'`)
      .get() as Record<string, unknown>;
    expect(field.name).toBe('timerSpeed');
    expect(field.notch_name).toBe('a');
    expect(field.descriptor).toBeNull();
    expect(field.javadoc).toBe('Speed, in ticks.');

    const plain = db
      .prepare(`SELECT srg_name FROM fields WHERE name = 'notRenamedField'`)
      .get() as Record<string, unknown>;
    expect(plain.srg_name).toBeNull();
  });

  it('maps params.csv LVT slots to logical indexes, including wide types and statics', () => {
    ingestMcpEra(db, ARTIFACTS);

    const wide = db
      .prepare(
        `SELECT p.param_index, p.srg_token, p.name FROM parameters p
         JOIN methods m ON p.method_id = m.id WHERE m.srg_name = 'func_3000_a'
         ORDER BY p.param_index`
      )
      .all() as Array<Record<string, unknown>>;
    // (DDDFF) slots 1,3,5,7,8 -> indexes 0..4
    expect(wide.map((r) => [r.param_index, r.srg_token, r.name])).toEqual([
      [0, 'p_3000_1_', 'x'],
      [1, 'p_3000_3_', 'y'],
      [2, 'p_3000_5_', 'z'],
      [3, 'p_3000_7_', 'yaw'],
      [4, 'p_3000_8_', 'pitch'],
    ]);

    // Static method: slot 0 is the first parameter
    const staticParam = db
      .prepare(
        `SELECT p.param_index, p.name FROM parameters p
         JOIN methods m ON p.method_id = m.id WHERE m.srg_name = 'func_2002_c'`
      )
      .get() as Record<string, unknown>;
    expect(staticParam).toMatchObject({ param_index: 0, name: 'level' });

    // Instance method (Lb;J): slots 1,2 -> indexes 0,1
    const instance = db
      .prepare(
        `SELECT p.param_index, p.name FROM parameters p
         JOIN methods m ON p.method_id = m.id WHERE m.srg_name = 'func_2001_b'
         ORDER BY p.param_index`
      )
      .all() as Array<Record<string, unknown>>;
    expect(instance.map((r) => [r.param_index, r.name])).toEqual([
      [0, 'other'],
      [1, 'time'],
    ]);
  });

  it('synthesizes <init> rows with p_i tokens and skips unknown owners', () => {
    const stats = ingestMcpEra(db, ARTIFACTS);
    expect(stats.skippedConstructors).toBe(1);

    const ctor = db
      .prepare(
        `SELECT m.id, m.descriptor, m.srg_name FROM methods m
         JOIN classes c ON m.class_id = c.id WHERE c.name = 'FakeTimer' AND m.name = '<init>'`
      )
      .get() as Record<string, unknown>;
    expect(ctor.descriptor).toBe('(F)V');
    expect(ctor.srg_name).toBeNull();

    const params = db
      .prepare(`SELECT param_index, srg_token, name FROM parameters WHERE method_id = ?`)
      .all(ctor.id) as Array<Record<string, unknown>>;
    expect(params).toEqual([{ param_index: 0, srg_token: 'p_i5000_1_', name: 'speed' }]);
  });

  it('counts orphan params as skipped, writes metadata, and enforces the one-set invariant', () => {
    const stats = ingestMcpEra(db, ARTIFACTS);
    expect(stats.skippedParams).toBeGreaterThanOrEqual(1); // p_9999_1_

    const meta = (key: string): string | undefined => {
      const row = db.prepare(`SELECT value FROM metadata WHERE key = ?`).get(key) as
        | { value: string }
        | undefined;
      return row?.value;
    };
    expect(meta('mcp_config_version')).toBe('1.12.2-test');
    expect(meta('mcp_source')).toBe('outlands');
    expect(meta('schema_version')).toBe(String(MAPPINGS_SCHEMA_VERSION));

    // Re-ingesting the same version must refuse
    expect(() => ingestMcpEra(db, ARTIFACTS)).toThrow(/already indexed/);
  });

  it('shares SRG-id params across override rows in different classes', () => {
    ingestMcpEra(db, ARTIFACTS);
    // func_2000_a exists on FakeTimer (obf a) and FakeBlock$1 (obf d, override).
    const rows = db
      .prepare(`SELECT COUNT(*) as count FROM methods WHERE srg_name = 'func_2000_a'`)
      .get() as { count: number };
    expect(rows.count).toBe(2);
  });
});

describe('readDbSchemaVersion', () => {
  it('reads the version from an initialized database and null for a missing file', () => {
    const tmp = path.join(os.tmpdir(), `mappings-schema-test-${process.pid}.db`);
    const db = initializeMappingsDb(tmp);
    db.close();
    try {
      expect(readDbSchemaVersion(tmp)).toBe(MAPPINGS_SCHEMA_VERSION);
      expect(readDbSchemaVersion(tmp + '.does-not-exist')).toBeNull();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(tmp + suffix, { force: true });
      }
    }
  });
});
