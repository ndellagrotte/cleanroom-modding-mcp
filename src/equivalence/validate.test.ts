import { describe, it, expect } from 'vitest';
import {
  validateTopicFile,
  crossValidate,
  deriveEntryKey,
  deriveKeywords,
  slug,
  type AuthoredTopicFile,
} from './validate.js';

function goodEntry(overrides: Record<string, unknown> = {}) {
  return {
    from: { vocab: 'fabric', era: 'fabric-pre-1.20.5', api: 'Some.Api(call)' },
    to: { loader: 'cleanroom', api: 'Target.api()' },
    kind: 'analog',
    sources: [{ url: 'https://example.com', license: 'MIT-docs' }],
    ...overrides,
  };
}

describe('equivalence validate', () => {
  it('accepts a well-formed topic file and compiles entries', () => {
    const file: AuthoredTopicFile = { topic: 'networking', entries: [goodEntry()] };
    const { errors, entries } = validateTopicFile(file, 'networking.yaml');
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry_key).toBe(deriveEntryKey('networking', 'fabric', 'Some.Api(call)'));
    expect(entries[0]!.keywords.length).toBeGreaterThan(0);
  });

  it('rejects an unknown topic', () => {
    const { errors } = validateTopicFile({ topic: 'nope', entries: [goodEntry()] }, 'x.yaml');
    expect(errors.some((e) => /taxonomy/.test(e))).toBe(true);
  });

  it('rejects a bad from.vocab and a bad kind', () => {
    const { errors } = validateTopicFile(
      {
        topic: 'events',
        entries: [goodEntry({ from: { vocab: 'forge', api: 'x' }, kind: 'weird' })],
      },
      'x.yaml'
    );
    expect(errors.some((e) => /from\.vocab/.test(e))).toBe(true);
    expect(errors.some((e) => /kind/.test(e))).toBe(true);
  });

  it('requires to.api unless kind is missing', () => {
    const bad = validateTopicFile(
      { topic: 'events', entries: [goodEntry({ to: { loader: 'cleanroom' }, kind: 'analog' })] },
      'x.yaml'
    );
    expect(bad.errors.some((e) => /to\.api is required/.test(e))).toBe(true);

    const ok = validateTopicFile(
      {
        topic: 'resources-datagen',
        entries: [goodEntry({ to: { loader: 'cleanroom' }, kind: 'missing' })],
      },
      'x.yaml'
    );
    expect(ok.errors).toEqual([]);
    expect(ok.entries[0]!.to_api).toBeNull();
  });

  it('rejects LGPL sources', () => {
    const { errors } = validateTopicFile(
      {
        topic: 'events',
        entries: [goodEntry({ sources: [{ url: 'https://x', license: 'LGPL-2.1' }] })],
      },
      'x.yaml'
    );
    expect(errors.some((e) => /LGPL/.test(e))).toBe(true);
  });

  it('rejects an unrecognised related scheme', () => {
    const { errors } = validateTopicFile(
      { topic: 'events', entries: [goodEntry({ related: ['http://not-blessed'] })] },
      'x.yaml'
    );
    expect(errors.some((e) => /scheme/.test(e))).toBe(true);
  });

  it('crossValidate flags duplicate entry_keys and unresolved links', () => {
    const file: AuthoredTopicFile = {
      topic: 'events',
      entries: [
        goodEntry({ related: ['cleanroom://equivalence/events/fabric/nonexistent'] }),
        goodEntry(),
      ],
    };
    const { entries } = validateTopicFile(file, 'events.yaml');
    const errors = crossValidate(entries);
    expect(errors.some((e) => /duplicate entry_key/.test(e))).toBe(true);
    expect(errors.some((e) => /does not resolve/.test(e))).toBe(true);
  });

  it('slug and keywords are stable and non-empty', () => {
    expect(slug('Foo.Bar(Baz, Qux)')).toBe('foo-bar-baz-qux');
    expect(
      deriveKeywords({ topic: 'events', from_api: 'A.b', from_api_alt: [], to_api: null }).length
    ).toBeGreaterThan(0);
  });
});
