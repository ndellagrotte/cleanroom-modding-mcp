import { describe, it, expect } from 'vitest';
import { extractCategoryFromUrl, DOC_CATEGORIES, EXAMPLE_CATEGORIES } from '../categories.js';

/**
 * The crawler is the only writer of `documents.category`, and every tool's
 * `category` filter is the fixed DOC_CATEGORIES enum. A value the crawler emits
 * that is not in that enum is a document no filter can reach: the corpus once
 * held 577 such rows (`resources` 224, `misc` 54, `datastorage` 41,
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

  /**
   * The Fabric wiki is a DokuWiki: its URLs are colon namespaces, not slash
   * paths. Splitting on `/` alone made 224 documents structurally unmatchable —
   * no mapping-table entry could ever reach them — which is why they survived
   * two rounds of remapping sitting in 'general'.
   */
  describe('DokuWiki colon namespaces', () => {
    it('reads past the namespace to the subject', () => {
      expect(extractCategoryFromUrl('https://wiki.fabricmc.net/tutorial:blocks')).toBe('blocks');
      expect(extractCategoryFromUrl('https://wiki.fabricmc.net/tutorial:commands')).toBe(
        'commands'
      );
      expect(extractCategoryFromUrl('https://wiki.fabricmc.net/tutorial:blockstate')).toBe(
        'blocks'
      );
    });

    it('splits underscore-joined slugs', () => {
      expect(
        extractCategoryFromUrl('https://wiki.fabricmc.net/tutorial:blockentity_sync_itemstack')
      ).toBe('tile-entities');
      expect(extractCategoryFromUrl('https://wiki.fabricmc.net/tutorial:mixin_injects')).toBe(
        'coremods-mixins'
      );
      expect(extractCategoryFromUrl('https://wiki.fabricmc.net/tutorial:datagen_loot')).toBe(
        'data-generation'
      );
    });

    it('handles an embedded version segment', () => {
      expect(
        extractCategoryFromUrl('https://wiki.fabricmc.net/tutorial:1.14:blockentityrenderers')
      ).toBe('tile-entities');
    });
  });

  /**
   * Container words name a tree, not a subject. Matching them eagerly hides the
   * segment that carries the real category — the failure `a64e14f` fixed for the
   * versioned-path heuristic, which this generalizes to the segment matcher.
   */
  describe('container segments yield to specific ones', () => {
    it('prefers the subject inside the container', () => {
      expect(
        extractCategoryFromUrl('https://docs.neoforged.net/docs/1.21.1/datastorage/capabilities')
      ).toBe('capabilities');
      expect(
        extractCategoryFromUrl('https://docs.neoforged.net/docs/1.21.1/datastorage/saveddata/')
      ).toBe('storage-systems');
      expect(extractCategoryFromUrl('https://docs.neoforged.net/docs/1.21.1/misc/config')).toBe(
        'config'
      );
      expect(extractCategoryFromUrl('https://docs.neoforged.net/docs/1.20.4/concepts/sides/')).toBe(
        'cross-platform'
      );
      expect(
        extractCategoryFromUrl('https://docs.neoforged.net/docs/1.20.4/concepts/registries')
      ).toBe('registry');
    });

    it('falls back to the container when nothing specific matches', () => {
      expect(
        extractCategoryFromUrl('https://docs.neoforged.net/docs/1.21.1/resources/server')
      ).toBe('resources');
      expect(extractCategoryFromUrl('https://docs.fabricmc.net/develop/loom/')).toBe('toolchain');
      expect(extractCategoryFromUrl('https://docs.neoforged.net/primer/1.21.1/')).toBe('porting');
    });

    it('leaves a container with no subject in general', () => {
      expect(extractCategoryFromUrl('https://docs.neoforged.net/docs/1.21.1/misc/')).toBe(
        'general'
      );
    });
  });

  it('maps stage-1 aliases onto their taxonomy home', () => {
    expect(extractCategoryFromUrl('https://docs.neoforged.net/docs/1.21.1/datagen/recipes/')).toBe(
      'data-generation'
    );
    expect(
      extractCategoryFromUrl('https://docs.neoforged.net/docs/1.21.1/blockentities/ber/')
    ).toBe('tile-entities');
    expect(extractCategoryFromUrl('https://docs.neoforged.net/docs/1.21.1/gui/screens/')).toBe(
      'gui'
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
      'coremods-mixins'
    );
  });

  it('descends past container segments when stage 1 finds no category', () => {
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
    ).toBe('coremods-mixins');
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

  it('falls back to general rather than inventing a category', () => {
    expect(extractCategoryFromUrl('https://docs.fabricmc.net/develop/wildly-unknown-topic')).toBe(
      'general'
    );
    expect(extractCategoryFromUrl('https://example.invalid/')).toBe('general');
    expect(extractCategoryFromUrl('not even a url')).toBe('general');
  });

  /**
   * The cross-corpus contract the tool descriptions depend on: they route agents
   * from `list_mod_categories` into `search_docs`, so every example category has
   * to be a legal doc filter value.
   */
  it('accepts every mod-examples category as a doc category', () => {
    for (const slug of EXAMPLE_CATEGORIES) {
      expect(DOC_CATEGORIES).toContain(slug);
    }
  });
});
