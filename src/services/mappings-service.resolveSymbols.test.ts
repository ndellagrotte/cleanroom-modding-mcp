import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildFixtureMappingsDb } from '../examples/golden-fixture.js';
import { MappingsService } from './mappings-service.js';

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mappings-batch-'));
  dbPath = path.join(dir, 'mappings.db');
  buildFixtureMappingsDb(dbPath);
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('MappingsService.resolveSymbols (batch)', () => {
  it('resolves each SRG token under one connection and dedupes input', () => {
    const svc = new MappingsService(dbPath);
    try {
      const out = svc.resolveSymbols(['func_180495_p', 'func_180495_p', 'func_999999_z'], '1.12.2');
      expect(out.size).toBe(2); // deduped
      expect(out.get('func_180495_p')?.result?.name).toBe('getBlockState');
      expect(out.get('func_999999_z')?.resolution).toBe('none');
    } finally {
      svc.close();
    }
  });
});
