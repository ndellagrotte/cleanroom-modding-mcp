/**
 * MCP resource enumeration + resolution for the cleanroom:// scheme (DESIGN §7).
 *
 * Every URI is enumerated concretely (no RFC-6570 templates — no surveyed client surfaces
 * them). The resource bodies are the SAME content modules the get_project_template /
 * get_porting_guide tools read, so resource↔tool byte-parity is structural.
 */

import { TEMPLATE_COMPONENTS, getTemplate } from './templates/index.js';
import { GUIDE_NAMES, getGuide } from './guides/index.js';

export const TEMPLATE_URI_PREFIX = 'cleanroom://template/';
export const GUIDE_URI_PREFIX = 'cleanroom://guide/';

export interface ResourceListing {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

/** Concrete list of every cleanroom:// resource (templates + guides). */
export function listCleanroomResources(): ResourceListing[] {
  const out: ResourceListing[] = [];
  for (const c of TEMPLATE_COMPONENTS) {
    out.push({
      uri: `${TEMPLATE_URI_PREFIX}${c}`,
      name: `Template: ${c}`,
      description: `CleanroomModTemplate snapshot (${c}), blossom tokens intact.`,
      mimeType: 'text/plain',
    });
  }
  for (const g of GUIDE_NAMES) {
    out.push({
      uri: `${GUIDE_URI_PREFIX}${g}`,
      name: `Guide: ${g}`,
      description: `Authored Cleanroom porting guide: ${g}.`,
      mimeType: 'text/markdown',
    });
  }
  return out;
}

/** Resolve a cleanroom:// URI to its body text, or null if unknown. */
export function readCleanroomResource(uri: string): { text: string; mimeType: string } | null {
  if (uri.startsWith(TEMPLATE_URI_PREFIX)) {
    const body = getTemplate(uri.slice(TEMPLATE_URI_PREFIX.length));
    return body === undefined ? null : { text: body, mimeType: 'text/plain' };
  }
  if (uri.startsWith(GUIDE_URI_PREFIX)) {
    const body = getGuide(uri.slice(GUIDE_URI_PREFIX.length));
    return body === undefined ? null : { text: body, mimeType: 'text/markdown' };
  }
  return null;
}
