/**
 * Minecraft version ordering and channel detection for the Parchment era.
 *
 * Extracted from scripts/index-mappings.ts so the ordering rules are testable
 * without running the network indexer. Used to sort the Parchment version
 * listing discovered from Maven (newest first) and to decide which entries the
 * pre-release/snapshot filters drop.
 *
 * NOT the same as `compareVersions` in src/version-utils.ts. That one is a
 * plain dotted-numeric comparison for package/DB semver; this one strips
 * `-pre`/`rc` suffixes before comparing and orders pre-releases *before* the
 * release they lead up to. They are deliberately separate — swapping either for
 * the other reorders its caller's output.
 */

const PRE_RELEASE = /pre\d*|rc\d*/i;
const SNAPSHOT = /snapshot|w\d{2}[a-z]/i;
const SNAPSHOT_PREFIX = /^\d{2}w\d{2}/;

/** `1.21.6-pre1`, `1.20.1-rc1` — a release candidate or pre-release. */
export function isPreRelease(mcVersion: string): boolean {
  return PRE_RELEASE.test(mcVersion) || mcVersion.includes('-pre') || mcVersion.includes('-rc');
}

/** `24w10a`, `1.21-snapshot` — a weekly snapshot. */
export function isSnapshot(mcVersion: string): boolean {
  return (
    SNAPSHOT.test(mcVersion) || mcVersion.includes('snapshot') || SNAPSHOT_PREFIX.test(mcVersion)
  );
}

/**
 * Compare Minecraft version strings semantically.
 * Handles versions like 1.21.11, 1.21.6-pre1, 24w10a etc.
 *
 * Returns -1 if a < b, 1 if a > b, 0 if equal.
 */
export function compareMinecraftVersions(a: string, b: string): number {
  // Extract main version parts (remove pre-release suffixes for comparison)
  const cleanA = a
    .replace(/-.*$/, '')
    .replace(/pre.*$/i, '')
    .replace(/rc.*$/i, '');
  const cleanB = b
    .replace(/-.*$/, '')
    .replace(/pre.*$/i, '')
    .replace(/rc.*$/i, '');

  const partsA = cleanA.split('.').map((p) => parseInt(p, 10) || 0);
  const partsB = cleanB.split('.').map((p) => parseInt(p, 10) || 0);

  // Pad arrays to same length
  const maxLen = Math.max(partsA.length, partsB.length);
  while (partsA.length < maxLen) partsA.push(0);
  while (partsB.length < maxLen) partsB.push(0);

  // Compare each part. The `?? 0` is unreachable after the padding above, but
  // keeps the read total rather than asserting the index is in range.
  for (let i = 0; i < maxLen; i++) {
    const av = partsA[i] ?? 0;
    const bv = partsB[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }

  // If main versions are equal, pre-releases come before releases
  const aIsPre = /pre|rc|-/i.test(a);
  const bIsPre = /pre|rc|-/i.test(b);

  if (aIsPre && !bIsPre) return -1;
  if (!aIsPre && bIsPre) return 1;

  return 0;
}
