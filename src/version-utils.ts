/**
 * Shared semantic-version helpers.
 *
 * Single home for version comparison and bumping, used by the DB auto-updater
 * (src/db-versioning.ts), the manage CLI (src/cli/manage.ts), and the manifest
 * generator (scripts/generate-manifest.ts).
 */

/**
 * Compare two dotted numeric versions.
 * Returns -1 if a < b, 1 if a > b, 0 if equal.
 * Missing or non-numeric segments are treated as 0.
 */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i] || 0;
    const y = partsB[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export type BumpType = 'major' | 'minor' | 'patch';

/**
 * Bump a semantic version. Unparseable versions reset to 0.1.0.
 */
export function bumpVersion(version: string, type: string): string {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    return '0.1.0';
  }

  let [major, minor, patch] = parts as [number, number, number];

  switch (type.toLowerCase()) {
    case 'major':
      major++;
      minor = 0;
      patch = 0;
      break;
    case 'minor':
      minor++;
      patch = 0;
      break;
    case 'patch':
    default:
      patch++;
      break;
  }

  return `${major}.${minor}.${patch}`;
}

/**
 * Extract the version from a release tag following the single `v{version}`
 * tag convention (e.g. `v0.5.0` -> `0.5.0`).
 */
export function extractVersionFromTag(tag: string): string {
  return tag.replace(/^v/, '');
}
