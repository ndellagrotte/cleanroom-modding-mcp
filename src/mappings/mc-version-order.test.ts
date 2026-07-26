import { describe, it, expect } from 'vitest';
import { compareMinecraftVersions, isPreRelease, isSnapshot } from './mc-version-order.js';

describe('compareMinecraftVersions', () => {
  it('orders by numeric segment, not lexically', () => {
    expect(compareMinecraftVersions('1.21.6', '1.21.11')).toBe(-1);
    expect(compareMinecraftVersions('1.21.11', '1.21.6')).toBe(1);
    expect(compareMinecraftVersions('1.9.0', '1.10.0')).toBe(-1);
  });

  it('compares major and minor before patch', () => {
    expect(compareMinecraftVersions('1.20.4', '1.21.0')).toBe(-1);
    expect(compareMinecraftVersions('2.0.0', '1.99.99')).toBe(1);
  });

  it('treats missing trailing segments as zero', () => {
    expect(compareMinecraftVersions('1.21', '1.21.0')).toBe(0);
    expect(compareMinecraftVersions('1', '1.0.0')).toBe(0);
    expect(compareMinecraftVersions('1.21', '1.21.1')).toBe(-1);
    // The padding loops make the `?? 0` reads unreachable; this pins the
    // behaviour they exist to produce.
    expect(compareMinecraftVersions('1.21.1', '1.21')).toBe(1);
  });

  it('treats non-numeric segments as zero', () => {
    expect(compareMinecraftVersions('1.x.3', '1.0.3')).toBe(0);
  });

  it('strips pre-release suffixes before comparing the numeric part', () => {
    expect(compareMinecraftVersions('1.21.6-pre1', '1.21.5')).toBe(1);
    expect(compareMinecraftVersions('1.21.6-pre1', '1.21.7')).toBe(-1);
  });

  it('orders a pre-release before the release it leads up to', () => {
    expect(compareMinecraftVersions('1.21.6-pre1', '1.21.6')).toBe(-1);
    expect(compareMinecraftVersions('1.21.6', '1.21.6-pre1')).toBe(1);
    expect(compareMinecraftVersions('1.20.1-rc1', '1.20.1')).toBe(-1);
  });

  it('is 0 for identical versions', () => {
    expect(compareMinecraftVersions('1.21.6', '1.21.6')).toBe(0);
    expect(compareMinecraftVersions('1.21.6-pre1', '1.21.6-pre1')).toBe(0);
  });

  it('sorts a version listing newest-first the way the indexer does', () => {
    const versions = ['1.20.1', '1.21.11', '1.21.6-pre1', '1.21.6', '1.9.0', '1.10.0'];
    const sorted = [...versions].sort((a, b) => compareMinecraftVersions(b, a));
    expect(sorted).toEqual(['1.21.11', '1.21.6', '1.21.6-pre1', '1.20.1', '1.10.0', '1.9.0']);
  });
});

describe('isPreRelease', () => {
  it('detects pre-releases and release candidates', () => {
    expect(isPreRelease('1.21.6-pre1')).toBe(true);
    expect(isPreRelease('1.21.6-pre')).toBe(true);
    expect(isPreRelease('1.20.1-rc1')).toBe(true);
    expect(isPreRelease('1.21.6 Pre-Release 1')).toBe(true);
  });

  it('leaves plain releases alone', () => {
    expect(isPreRelease('1.21.6')).toBe(false);
    expect(isPreRelease('1.12.2')).toBe(false);
  });
});

describe('isSnapshot', () => {
  it('detects weekly snapshots', () => {
    expect(isSnapshot('24w10a')).toBe(true);
    expect(isSnapshot('23w45b')).toBe(true);
    expect(isSnapshot('1.21-snapshot')).toBe(true);
  });

  it('leaves plain releases alone', () => {
    expect(isSnapshot('1.21.6')).toBe(false);
    expect(isSnapshot('1.12.2')).toBe(false);
  });
});
