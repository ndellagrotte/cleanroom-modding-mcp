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

  it('descends past container segments when stage 1 finds no category', () => {
    // NeoForge files whole trees under words that map to nothing. Stopping at
    // the first segment hid the one that does carry a category.
    expect(extractCategoryFromUrl('https://docs.neoforged.net/docs/1.20.4/concepts/events')).toBe(
      'events'
    );
    expect(
      extractCategoryFromUrl(
        'https://docs.neoforged.net/docs/1.20.4/resources/client/models/bakedmodel'
      )
    ).toBe('rendering');
    expect(
      extractCategoryFromUrl('https://docs.neoforged.net/docs/1.21.1/advanced/accesstransformers')
    ).toBe('mixins');
  });

  it('categorizes a versioned URL the same as its unversioned twin', () => {
    // The regression that motivated the fall-through: nine versioned copies of
    // NeoForge's Events page were 'general' while the unversioned tenth, which
    // stage 1 never matches, was 'events'.
    const unversioned = extractCategoryFromUrl('https://docs.neoforged.net/docs/concepts/events');
    expect(unversioned).toBe('events');
    for (const version of ['1.20.4', '1.21.1', '1.21.11']) {
      expect(
        extractCategoryFromUrl(`https://docs.neoforged.net/docs/${version}/concepts/events`)
      ).toBe(unversioned);
    }
  });

  it('still settles on general when no segment carries a category', () => {
    // Container segments whose subtrees have no home in the 12-value taxonomy
    // must not acquire one just because stage 2 now gets to look.
    expect(
      extractCategoryFromUrl('https://docs.neoforged.net/docs/1.21.1/datastorage/saveddata/')
    ).toBe('general');
    expect(extractCategoryFromUrl('https://docs.neoforged.net/docs/1.20.4/concepts/sides/')).toBe(
      'general'
    );
    expect(extractCategoryFromUrl('https://docs.neoforged.net/docs/1.21.1/misc/config')).toBe(
      'general'
    );
  });

  it('falls back to general rather than inventing a category', () => {
    expect(extractCategoryFromUrl('https://docs.fabricmc.net/develop/wildly-unknown-topic')).toBe(
      'general'
    );
    expect(extractCategoryFromUrl('https://example.invalid/')).toBe('general');
  });
});
