import { describe, it, expect } from 'vitest';
import { extractCategoryFromUrl } from './crawler.js';
import { DOC_CATEGORIES } from '../categories.js';

/**
 * The crawler is the only writer of `documents.category`, and every tool's
 * `category` filter is the fixed DOC_CATEGORIES enum. A value the crawler emits
 * that is not in that enum is a document no filter can reach: the shipped
 * corpus holds 577 such rows (`resources` 224, `misc` 54, `datastorage` 41,
 * `gettingstarted` 36, …) because stage 1 of the URL heuristic returned raw
 * path segments. These tests pin the invariant that used to be only a comment.
 */
describe('extractCategoryFromUrl', () => {
  it('only ever emits a DOC_CATEGORIES value', () => {
    const urls = [
      'https://docs.neoforged.net/docs/1.21.1/resources/',
      'https://docs.neoforged.net/docs/1.21.1/misc/',
      'https://docs.neoforged.net/docs/1.21.1/datastorage/saveddata/',
      'https://docs.neoforged.net/docs/1.20.4/concepts/sides/',
      'https://docs.fabricmc.net/develop/loom/',
      'https://docs.fabricmc.net/1.21.4/develop/automatic-testing',
      'https://wiki.fabricmc.net/tutorial:blockstate',
      'https://docs.minecraftforge.net/en/1.12.x/items/loot_tables/',
      'https://cleanroommc.com/wiki/forge-mod-development/event',
      'https://example.invalid/no/version/here',
      'not even a url',
      '',
    ];

    for (const url of urls) {
      expect(DOC_CATEGORIES).toContain(extractCategoryFromUrl(url));
    }
  });

  it('normalizes stage-1 segments that used to pass through raw', () => {
    // Previously returned 'resources' / 'misc' / 'datastorage' verbatim.
    expect(extractCategoryFromUrl('https://docs.neoforged.net/docs/1.21.1/resources/')).toBe(
      'general'
    );
    expect(extractCategoryFromUrl('https://docs.neoforged.net/docs/1.21.1/misc/')).toBe('general');
  });

  it('maps stage-1 aliases onto their taxonomy home', () => {
    expect(extractCategoryFromUrl('https://docs.neoforged.net/docs/1.21.1/datagen/recipes/')).toBe(
      'data-generation'
    );
    expect(
      extractCategoryFromUrl('https://docs.neoforged.net/docs/1.21.1/blockentities/ber/')
    ).toBe('blocks');
    expect(extractCategoryFromUrl('https://docs.neoforged.net/docs/1.21.1/gui/screens/')).toBe(
      'rendering'
    );
    expect(
      extractCategoryFromUrl('https://docs.fabricmc.net/develop/1.21.4/entities/damage-types')
    ).toBe('entities');
  });

  it('leaves the stage-2 path unchanged', () => {
    // The Forge 1.12.x RTD tree: "1.12.x" defeats the stage-1 version match, so
    // these have always gone through categorizeDocPath.
    expect(extractCategoryFromUrl('https://docs.minecraftforge.net/en/1.12.x/items/items/')).toBe(
      'items'
    );
    expect(
      extractCategoryFromUrl('https://docs.minecraftforge.net/en/1.12.x/networking/simpleimpl/')
    ).toBe('networking');
    expect(extractCategoryFromUrl('https://cleanroommc.com/wiki/mixin/getting-started')).toBe(
      'mixins'
    );
  });

  it('falls back to general rather than inventing a category', () => {
    expect(extractCategoryFromUrl('https://docs.fabricmc.net/develop/wildly-unknown-topic')).toBe(
      'general'
    );
    expect(extractCategoryFromUrl('https://example.invalid/')).toBe('general');
  });
});
