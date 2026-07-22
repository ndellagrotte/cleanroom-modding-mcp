/**
 * Loader registry tests: scope expansion, URL detection, version defaults —
 * the invariants every consumer of src/loaders.ts relies on.
 */
import { describe, it, expect } from 'vitest';
import {
  LOADERS,
  LOADER_IDS,
  TARGET_FAMILY,
  REFERENCE_FAMILY,
  TARGET_VERSION,
  scopeToLoaders,
  detectLoaderFromUrl,
  defaultVersionFor,
  isLoader,
  perspectiveToLoaders,
} from './loaders.js';

describe('registry shape', () => {
  it('contains exactly the five loaders', () => {
    expect(LOADER_IDS.sort()).toEqual(['cleanroom', 'fabric', 'forge', 'neoforge', 'shared']);
  });

  it('every entry id matches its key', () => {
    for (const id of LOADER_IDS) {
      expect(LOADERS[id].id).toBe(id);
    }
  });

  it('target-family loaders have the fixed 1.12.2 version; reference loaders have none', () => {
    expect(defaultVersionFor('cleanroom')).toBe(TARGET_VERSION);
    expect(defaultVersionFor('forge')).toBe(TARGET_VERSION);
    expect(defaultVersionFor('fabric')).toBeNull();
    expect(defaultVersionFor('neoforge')).toBeNull();
    expect(defaultVersionFor('shared')).toBeNull();
    expect(TARGET_VERSION).toBe('1.12.2');
  });
});

describe('scopeToLoaders', () => {
  it('target = cleanroom + forge + shared', () => {
    expect(scopeToLoaders('target').sort()).toEqual(['cleanroom', 'forge', 'shared']);
    expect(scopeToLoaders('target')).toEqual(TARGET_FAMILY);
  });

  it('reference = fabric + neoforge + shared', () => {
    expect(scopeToLoaders('reference').sort()).toEqual(['fabric', 'neoforge', 'shared']);
    expect(scopeToLoaders('reference')).toEqual(REFERENCE_FAMILY);
  });

  it('all = every loader', () => {
    expect(scopeToLoaders('all')).toEqual(LOADER_IDS);
  });

  it('shared (neutral) belongs to both families', () => {
    expect(TARGET_FAMILY).toContain('shared');
    expect(REFERENCE_FAMILY).toContain('shared');
  });
});

describe('detectLoaderFromUrl', () => {
  it('detects cleanroom from cleanroommc.com', () => {
    expect(detectLoaderFromUrl('https://cleanroommc.com/wiki/installation')).toBe('cleanroom');
  });

  it('detects forge from docs.minecraftforge.net', () => {
    expect(detectLoaderFromUrl('https://docs.minecraftforge.net/en/1.12.x/gettingstarted/')).toBe(
      'forge'
    );
  });

  it('detects forge from the ReadTheDocs host the 1.12.x sitemap emits', () => {
    expect(
      detectLoaderFromUrl('https://mcforge.readthedocs.io/en/1.12.x/concepts/registries/')
    ).toBe('forge');
  });

  it('detects fabric from fabricmc.net and subdomains', () => {
    expect(detectLoaderFromUrl('https://docs.fabricmc.net/develop/items')).toBe('fabric');
    expect(detectLoaderFromUrl('https://wiki.fabricmc.net/tutorial/setup')).toBe('fabric');
  });

  it('detects neoforge from neoforged.net subdomains', () => {
    expect(detectLoaderFromUrl('https://docs.neoforged.net/docs/gettingstarted/')).toBe('neoforge');
  });

  it('does not treat lookalike hosts as loader hosts', () => {
    expect(detectLoaderFromUrl('https://notfabricmc.net/develop')).toBe('shared');
  });

  it('falls back to path hints for relative URLs', () => {
    expect(detectLoaderFromUrl('/fabric/items')).toBe('fabric');
    expect(detectLoaderFromUrl('/neoforge/blocks')).toBe('neoforge');
  });

  it('returns shared for unknown hosts', () => {
    expect(detectLoaderFromUrl('https://example.com/modding')).toBe('shared');
  });
});

describe('perspectiveToLoaders', () => {
  it('target perspectives expand to the whole target family', () => {
    expect(perspectiveToLoaders('cleanroom')).toEqual(TARGET_FAMILY);
    expect(perspectiveToLoaders('forge')).toEqual(TARGET_FAMILY);
  });

  it('reference perspectives keep their own corpus plus neutral content', () => {
    expect(perspectiveToLoaders('fabric')).toEqual(['fabric', 'shared']);
    expect(perspectiveToLoaders('neoforge')).toEqual(['neoforge', 'shared']);
  });

  it('the neutral perspective applies no filter', () => {
    expect(perspectiveToLoaders('shared')).toBeUndefined();
  });
});

describe('isLoader', () => {
  it('accepts registry ids and rejects everything else', () => {
    for (const id of LOADER_IDS) {
      expect(isLoader(id)).toBe(true);
    }
    expect(isLoader('quilt')).toBe(false);
    expect(isLoader('')).toBe(false);
  });
});
