import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DocumentStore } from '../indexer/store.js';
import { EquivalenceService } from './equivalence-service.js';
import type { CompiledEquivalenceEntry } from '../equivalence/types.js';

function entry(overrides: Partial<CompiledEquivalenceEntry> = {}): CompiledEquivalenceEntry {
  return {
    entry_key: 'networking/fabric/serverplaynetworking-send',
    topic: 'networking',
    from_vocab: 'fabric',
    from_era: 'fabric-pre-1.20.5',
    from_api: 'ServerPlayNetworking.send(player, id, buf)',
    from_api_alt: ['ClientPlayNetworking.send(id, buf)'],
    from_versions: '1.16–1.20.4',
    to_loader: 'cleanroom',
    to_api: 'SimpleNetworkWrapper.sendTo(msg, player)',
    kind: 'pattern-change',
    notes: 'Network thread caveat applies.',
    code_before: null,
    code_after: 'CHANNEL.sendTo(msg, player);',
    caveats: ['runs on the network thread'],
    related: [],
    keywords: ['serverplaynetworking', 'send', 'simplenetworkwrapper', 'networking'],
    sources: [{ url: 'https://example.com', license: 'MIT-docs' }],
    validated_against: 'cleanroom 0.6.3-alpha',
    ...overrides,
  };
}

describe('EquivalenceService (fixture DB)', () => {
  let tempDir: string;
  let dbPath: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'equiv-test-'));
    dbPath = path.join(tempDir, 'docs.db');
    const store = new DocumentStore(dbPath);
    store.stampSchemaVersion();
    store.replaceEquivalence([
      entry(),
      entry({
        entry_key: 'registration/neoforge/deferredregister',
        topic: 'registration',
        from_vocab: 'neoforge',
        from_api: 'DeferredRegister.create(ForgeRegistries.ITEMS, MODID)',
        from_api_alt: [],
        to_api: 'RegistryEvent.Register<Item>',
        kind: 'analog',
        keywords: ['deferredregister', 'registration', 'registryevent'],
      }),
      entry({
        entry_key: 'resources-datagen/fabric/fabricdatagenerator',
        topic: 'resources-datagen',
        from_api: 'FabricDataGenerator',
        from_api_alt: [],
        to_api: null,
        kind: 'missing',
        keywords: ['fabricdatagenerator', 'datagen', 'resources'],
      }),
    ]);
    store.close();
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports the corpus present for a v2 fixture', () => {
    const svc = new EquivalenceService(dbPath);
    expect(svc.isCorpusPresent()).toBe(true);
    svc.close();
  });

  it('finds an entry by its from_api and filters by vocab', () => {
    const svc = new EquivalenceService(dbPath);
    const hits = svc.search({ query: 'ServerPlayNetworking send', fromVocab: 'fabric', limit: 15 });
    expect(hits.some((h) => h.entryKey === 'networking/fabric/serverplaynetworking-send')).toBe(
      true
    );
    // neoforge-only rows must not surface under a fabric query
    expect(hits.every((h) => h.fromVocab === 'fabric')).toBe(true);
    svc.close();
  });

  it('filters by topic', () => {
    const svc = new EquivalenceService(dbPath);
    const hits = svc.search({
      query: '',
      fromVocab: 'fabric',
      topic: 'resources-datagen',
      limit: 15,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe('missing');
    expect(hits[0]!.toApi).toBeNull();
    svc.close();
  });

  it('degrades on a v1 db (schema < 2)', async () => {
    const v1 = path.join(tempDir, 'v1.db');
    fs.copyFileSync(dbPath, v1);
    // Simulate an old shipped db: drop the table and downgrade the recorded version.
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(v1);
    raw.exec('DROP TABLE IF EXISTS equivalence_fts; DROP TABLE IF EXISTS equivalence;');
    raw.prepare("UPDATE metadata SET value='1' WHERE key='schema_version'").run();
    raw.close();

    const svc = new EquivalenceService(v1);
    expect(svc.isCorpusPresent()).toBe(false);
    svc.close();
  });

  it('reports not-present when the db file is missing', () => {
    const svc = new EquivalenceService(path.join(tempDir, 'does-not-exist.db'));
    expect(svc.isCorpusPresent()).toBe(false);
    svc.close();
  });

  it('a rebuild-over-existing corpus leaves no phantom FTS hits (external-content delete)', () => {
    const rb = path.join(tempDir, 'rebuild.db');
    const store = new DocumentStore(rb);
    store.stampSchemaVersion();
    store.replaceEquivalence([
      entry({
        entry_key: 'networking/fabric/alphaword',
        from_api: 'AlphaWordUniqueApi',
        from_api_alt: [],
        keywords: ['alphaworduniqueapi'],
      }),
    ]);
    // Rebuild with the entry renamed — the old token must NOT survive in the FTS index.
    store.replaceEquivalence([
      entry({
        entry_key: 'networking/fabric/betaword',
        from_api: 'BetaWordUniqueApi',
        from_api_alt: [],
        keywords: ['betaworduniqueapi'],
      }),
    ]);
    const stale = store.searchEquivalence({
      query: 'AlphaWordUniqueApi',
      fromVocab: 'fabric',
      limit: 15,
    });
    const fresh = store.searchEquivalence({
      query: 'BetaWordUniqueApi',
      fromVocab: 'fabric',
      limit: 15,
    });
    store.close();
    expect(stale).toHaveLength(0); // no phantom hit for the removed API
    expect(fresh.length).toBeGreaterThanOrEqual(1);
  });
});
