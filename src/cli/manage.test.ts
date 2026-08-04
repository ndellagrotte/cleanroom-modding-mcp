/* eslint-disable no-control-regex */
/**
 * Tests for the manage CLI.
 *
 * These tests import the REAL registry (src/dbs.ts) and the REAL helper
 * functions — never local copies — so any drift between the installer's
 * configuration and the distribution convention fails here.
 */
import { describe, it, expect } from 'vitest';
import { DBS, DB_IDS, selectRelease, type GitHubRelease } from '../dbs.js';
import { compareVersions, bumpVersion, extractVersionFromTag } from '../version-utils.js';
import {
  formatBytes,
  formatSpeed,
  formatTime,
  centerText,
  padLine,
  runInstaller,
} from './manage.js';

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE REGISTRY
// ═══════════════════════════════════════════════════════════════════════════════

describe('Database Registry (src/dbs.ts)', () => {
  it('should have exactly 4 databases', () => {
    expect(DB_IDS).toHaveLength(4);
    expect(DB_IDS).toEqual(['docs', 'mappings', 'examples', 'cleanroom-api']);
  });

  it('should have docs as the only required database', () => {
    expect(DBS.docs.required).toBe(true);
    for (const id of DB_IDS.filter((i) => i !== 'docs')) {
      expect(DBS[id].required).toBe(false);
    }
  });

  it('should follow the <id>-manifest.json naming convention', () => {
    for (const id of DB_IDS) {
      expect(DBS[id].manifestName).toBe(`${id}-manifest.json`);
    }
  });

  it('should declare mappings schema v2 (notch/srg/mapping_set era)', () => {
    expect(DBS.mappings.schemaVersion).toBe(2);
  });

  it('should have valid file names for all databases', () => {
    for (const id of DB_IDS) {
      expect(DBS[id].fileName).toMatch(/\.db$/);
      expect(DBS[id].manifestName).toMatch(/\.json$/);
      expect(DBS[id].id).toBe(id);
    }
  });

  it('should have unique file names across databases', () => {
    const files = DB_IDS.map((id) => DBS[id].fileName);
    expect(new Set(files).size).toBe(files.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RELEASE SELECTION (single v-tag convention)
// ═══════════════════════════════════════════════════════════════════════════════

describe('selectRelease', () => {
  const asset = (name: string) => ({
    name,
    browser_download_url: `https://example.com/download/${name}`,
    size: 1000,
  });

  const release = (id: number, tag: string, assetNames: string[]): GitHubRelease => ({
    id,
    tag_name: tag,
    published_at: '2026-01-01T00:00:00Z',
    assets: assetNames.map(asset),
  });

  it('picks the newest v-tag release that carries the DB asset', () => {
    const releases = [
      release(3, 'v0.5.0', ['docs.db', 'docs-manifest.json']),
      release(2, 'v0.4.0', ['docs.db', 'docs-manifest.json']),
    ];
    const selected = selectRelease(releases, DBS.docs);
    expect(selected?.release.id).toBe(3);
    expect(selected?.dbAsset.name).toBe('docs.db');
    expect(selected?.manifestAsset?.name).toBe('docs-manifest.json');
  });

  it('skips releases whose asset upload failed', () => {
    const releases = [
      release(3, 'v0.5.0', []), // broken release: no assets
      release(2, 'v0.4.0', ['docs.db', 'docs-manifest.json']),
    ];
    expect(selectRelease(releases, DBS.docs)?.release.id).toBe(2);
  });

  it('ignores non-v tags', () => {
    const releases = [
      release(3, 'examples-v9.9.9', ['docs.db', 'docs-manifest.json']),
      release(2, 'v0.4.0', ['docs.db', 'docs-manifest.json']),
    ];
    expect(selectRelease(releases, DBS.docs)?.release.id).toBe(2);
  });

  it('ignores drafts and prereleases', () => {
    const draft = { ...release(4, 'v0.6.0', ['docs.db', 'docs-manifest.json']), draft: true };
    const prerelease = {
      ...release(3, 'v0.5.0-beta.1', ['docs.db', 'docs-manifest.json']),
      prerelease: true,
    };
    const stable = release(2, 'v0.4.0', ['docs.db', 'docs-manifest.json']);
    expect(selectRelease([draft, prerelease, stable], DBS.docs)?.release.id).toBe(2);
  });

  it('treats the manifest asset as optional', () => {
    const releases = [release(1, 'v0.4.0', ['mappings.db'])];
    const selected = selectRelease(releases, DBS.mappings);
    expect(selected?.dbAsset.name).toBe('mappings.db');
    expect(selected?.manifestAsset).toBeNull();
  });

  it('with requireManifest, scans past partial uploads to an older complete release', () => {
    const releases = [
      release(3, 'v0.5.0', ['docs.db']), // partial upload: manifest missing
      release(2, 'v0.4.0', ['docs.db', 'docs-manifest.json']),
    ];
    expect(selectRelease(releases, DBS.docs, { requireManifest: true })?.release.id).toBe(2);
    // Default behavior still returns the newest DB-carrying release.
    expect(selectRelease(releases, DBS.docs)?.release.id).toBe(3);
  });

  it('returns null when no release has the asset', () => {
    const releases = [release(1, 'v0.4.0', ['docs.db', 'docs-manifest.json'])];
    expect(selectRelease(releases, DBS.examples)).toBeNull();
  });

  it('selects per database from the same release list', () => {
    const releases = [
      release(3, 'v0.5.0', ['docs.db', 'docs-manifest.json']),
      release(2, 'v0.4.0', [
        'docs.db',
        'docs-manifest.json',
        'mappings.db',
        'mappings-manifest.json',
      ]),
    ];
    expect(selectRelease(releases, DBS.docs)?.release.id).toBe(3);
    expect(selectRelease(releases, DBS.mappings)?.release.id).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VERSION UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

describe('compareVersions', () => {
  it('should return 0 for equal versions', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('2.1.3', '2.1.3')).toBe(0);
  });

  it('should return 1 when first version is greater', () => {
    expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
    expect(compareVersions('1.1.0', '1.0.0')).toBe(1);
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
  });

  it('should return -1 when first version is smaller', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.1.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
  });

  it('should handle versions with different segment counts', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.1')).toBe(-1);
    expect(compareVersions('1.0.1', '1.0')).toBe(1);
  });

  it('should handle single segment versions', () => {
    expect(compareVersions('1', '1')).toBe(0);
    expect(compareVersions('2', '1')).toBe(1);
    expect(compareVersions('1', '2')).toBe(-1);
  });
});

describe('bumpVersion', () => {
  it('bumps each segment correctly', () => {
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4');
  });

  it('defaults unknown types to patch', () => {
    expect(bumpVersion('1.2.3', 'nonsense')).toBe('1.2.4');
  });

  it('resets unparseable versions to 0.1.0', () => {
    expect(bumpVersion('not-a-version', 'patch')).toBe('0.1.0');
    expect(bumpVersion('1.2', 'patch')).toBe('0.1.0');
  });
});

describe('extractVersionFromTag', () => {
  it('strips the leading v', () => {
    expect(extractVersionFromTag('v0.2.0')).toBe('0.2.0');
    expect(extractVersionFromTag('v1.2.3-beta.4')).toBe('1.2.3-beta.4');
  });

  it('leaves tags without the prefix unchanged', () => {
    expect(extractVersionFromTag('0.2.0')).toBe('0.2.0');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FORMATTING HELPERS (real implementations, imported from manage.ts)
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatBytes', () => {
  it('should format 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('should format bytes (< 1KB)', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('should format kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('should format megabytes and gigabytes', () => {
    expect(formatBytes(1048576)).toBe('1 MB');
    expect(formatBytes(52428800)).toBe('50 MB');
    expect(formatBytes(1073741824)).toBe('1 GB');
  });
});

describe('formatSpeed', () => {
  it('should format speed with /s suffix', () => {
    expect(formatSpeed(0)).toBe('0 B/s');
    expect(formatSpeed(1024)).toBe('1 KB/s');
    expect(formatSpeed(1048576)).toBe('1 MB/s');
  });
});

describe('formatTime', () => {
  it('should return --:-- for invalid input', () => {
    expect(formatTime(0)).toBe('--:--');
    expect(formatTime(-1)).toBe('--:--');
    expect(formatTime(Infinity)).toBe('--:--');
    expect(formatTime(NaN)).toBe('--:--');
  });

  it('should format seconds (< 60)', () => {
    expect(formatTime(30)).toBe('30s');
    expect(formatTime(59)).toBe('59s');
  });

  it('should format minutes and seconds', () => {
    expect(formatTime(60)).toBe('1m 00s');
    expect(formatTime(90)).toBe('1m 30s');
    expect(formatTime(125)).toBe('2m 05s');
  });
});

describe('centerText', () => {
  it('should center text in given width', () => {
    expect(centerText('hi', 10)).toBe('    hi    ');
    expect(centerText('test', 10)).toBe('   test   ');
  });

  it('should handle text longer than width', () => {
    expect(centerText('hello world', 5)).toBe('hello world');
  });

  it('should strip ANSI codes when calculating width', () => {
    const ansiText = '\x1b[31mred\x1b[0m';
    const result = centerText(ansiText, 10);
    expect(result.replace(/\x1b\[[0-9;]*m/g, '').length).toBe(10);
  });
});

describe('padLine', () => {
  it('should pad text to specified width', () => {
    expect(padLine('hello', 10)).toBe('hello     ');
  });

  it('should not truncate text longer than width', () => {
    expect(padLine('hello world', 5)).toBe('hello world');
  });

  it('should handle ANSI codes when padding', () => {
    const ansiText = '\x1b[32mgreen\x1b[0m';
    expect(padLine(ansiText, 10)).toBe(ansiText + '     ');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLI ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

describe('CLI Installer', () => {
  it('should export runInstaller as an async function', () => {
    expect(typeof runInstaller).toBe('function');
  });
});
