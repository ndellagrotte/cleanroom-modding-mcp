/**
 * Guide content registry — the single source both the `get_porting_guide` tool and the
 * `cleanroom://guide/*` resource read from (structural byte-parity, DESIGN §7.2).
 *
 * All four guides are ORIGINAL AUTHORSHIP — no upstream porting-from-Fabric/NeoForge or
 * backporting source exists (RESEARCH §3.2). They do not adapt the CleanroomMC wiki.
 */

import portingFromFabric from './porting-from-fabric.js';
import portingFromNeoforge from './porting-from-neoforge.js';
import backporting from './backporting.js';
import mixinSetup from './mixin-setup.js';

/** Frozen list of guide names (matches BLIND_SPEC §0.2). */
export const GUIDE_NAMES = [
  'porting-from-fabric',
  'porting-from-neoforge',
  'backporting',
  'mixin-setup',
] as const;

export type GuideName = (typeof GUIDE_NAMES)[number];

export const GUIDES: Record<GuideName, string> = {
  'porting-from-fabric': portingFromFabric,
  'porting-from-neoforge': portingFromNeoforge,
  backporting,
  'mixin-setup': mixinSetup,
};

export function getGuide(name: string): string | undefined {
  return (GUIDES as Record<string, string>)[name];
}
