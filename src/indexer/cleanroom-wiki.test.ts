/**
 * Route-mapping invariants for the Cleanroom wiki ingester. Network-dependent
 * fetchers are exercised by the indexing pipeline, not unit tests.
 */
import { describe, it, expect } from 'vitest';
import { wikiPathToRoute, hashmapKeyToRoute } from './cleanroom-wiki.js';

describe('wikiPathToRoute', () => {
  it('maps a nested wiki file to its published route', () => {
    expect(wikiPathToRoute('docs/wiki/forge-mod-development/event.md')).toBe(
      'https://cleanroommc.com/wiki/forge-mod-development/event'
    );
  });

  it('collapses index.md to the directory route', () => {
    expect(wikiPathToRoute('docs/wiki/index.md')).toBe('https://cleanroommc.com/wiki');
    expect(wikiPathToRoute('docs/wiki/modularui/index.md')).toBe(
      'https://cleanroommc.com/wiki/modularui'
    );
  });

  it('preserves underscores in real filenames', () => {
    expect(wikiPathToRoute('docs/wiki/modularui/json/theme_ref.md')).toBe(
      'https://cleanroommc.com/wiki/modularui/json/theme_ref'
    );
  });
});

describe('hashmapKeyToRoute', () => {
  it('maps a VitePress hashmap key to a live route', () => {
    expect(hashmapKeyToRoute('wiki_forge-mod-development_event.md')).toBe(
      'https://cleanroommc.com/wiki/forge-mod-development/event'
    );
  });

  it('maps the wiki root key', () => {
    expect(hashmapKeyToRoute('wiki.md')).toBe('https://cleanroommc.com/wiki');
  });
});
