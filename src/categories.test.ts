/**
 * Category taxonomy drift guards: the schema enums published by tools must
 * stay subsets of the central lists, and 1.12.2-era edits must hold.
 */
import { describe, it, expect } from 'vitest';
import {
  DOC_CATEGORIES,
  DOC_CATEGORY_ENUM,
  EXAMPLE_CATEGORIES,
  CONCEPT_CATEGORIES,
  categorizeDocPath,
} from './categories.js';
import { getAvailableCategories } from './tools/searchDocs.js';

describe('doc categories', () => {
  it('DOC_CATEGORY_ENUM is DOC_CATEGORIES plus "all"', () => {
    expect(DOC_CATEGORY_ENUM).toEqual([...DOC_CATEGORIES, 'all']);
  });

  it('includes the crawler fallback category "general"', () => {
    expect(DOC_CATEGORIES).toContain('general');
  });

  it('getAvailableCategories returns the central list', () => {
    expect(getAvailableCategories()).toEqual([...DOC_CATEGORIES]);
  });

  it('has no duplicates', () => {
    expect(new Set(DOC_CATEGORIES).size).toBe(DOC_CATEGORIES.length);
  });
});

describe('example categories (1.12.2 edits)', () => {
  it('drops data-generation (datagen does not exist in 1.12.2)', () => {
    expect(EXAMPLE_CATEGORIES).not.toContain('data-generation');
  });

  it('adds capabilities and coremods-mixins', () => {
    expect(EXAMPLE_CATEGORIES).toContain('capabilities');
    expect(EXAMPLE_CATEGORIES).toContain('coremods-mixins');
  });

  it('has no duplicates', () => {
    expect(new Set(EXAMPLE_CATEGORIES).size).toBe(EXAMPLE_CATEGORIES.length);
  });
});

describe('concept categories', () => {
  it('is a superset of doc categories', () => {
    for (const cat of DOC_CATEGORIES) {
      expect(CONCEPT_CATEGORIES).toContain(cat);
    }
  });
});

describe('categorizeDocPath', () => {
  it('maps RTD 1.12.x segments', () => {
    expect(categorizeDocPath(['concepts', 'registries'])).toBe('general');
    expect(categorizeDocPath(['gettingstarted'])).toBe('getting-started');
    expect(categorizeDocPath(['models', 'files'])).toBe('rendering');
    expect(categorizeDocPath(['tileentities', 'tesr'])).toBe('blocks');
  });

  it('maps Cleanroom wiki route segments (first hit wins)', () => {
    expect(categorizeDocPath(['forge-mod-development', 'event'])).toBe('events');
    expect(categorizeDocPath(['forge-mod-development', 'mixin', 'preface'])).toBe('mixins');
    expect(categorizeDocPath(['modularui', 'json', 'theme'])).toBe('rendering');
    expect(categorizeDocPath(['forge-mod-development', 'sidedness'])).toBe('networking');
  });

  it('always returns a DOC_CATEGORIES value', () => {
    expect(DOC_CATEGORIES).toContain(categorizeDocPath(['end-user-guide', 'introduction']));
    expect(categorizeDocPath([])).toBe('general');
  });
});
