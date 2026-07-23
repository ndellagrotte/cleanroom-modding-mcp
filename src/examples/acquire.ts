/**
 * Repo acquisition (pipeline stage 1).
 *
 * Downloads a per-repo zipball at the pinned SHA from codeload.github.com and
 * walks it with AdmZip — the same shape the Phase 3 cleanroom-api indexer uses.
 * This deliberately avoids the trees-API path (cleanroom-wiki.ts) that hard-
 * throws on `tree.truncated` and fetches per-file sequentially — unworkable for
 * GregTech-class trees (DESIGN §6.1).
 *
 * Offline runs pass a previously downloaded zip via `zipPath` (--repo-zip),
 * keeping the golden tests fully network-free.
 */

import fs from 'fs';
import AdmZip from 'adm-zip';
import { USER_AGENT } from '../dbs.js';
import type { RawFile, RosterRepo } from './model.js';

/** codeload zipball URL for a repo at a specific ref/SHA. */
export function repoZipUrl(repo: string, ref: string): string {
  return `https://codeload.github.com/${repo}/zip/${ref}`;
}

async function fetchBuffer(url: string, githubToken: string | undefined): Promise<Buffer> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  if (githubToken) {
    headers.Authorization = `token ${githubToken}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(180_000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Strip the '<repo>-<sha>/' prefix GitHub zipballs prepend to every entry. */
function stripTopLevel(entryName: string): string {
  const slash = entryName.indexOf('/');
  return slash === -1 ? entryName : entryName.slice(slash + 1);
}

/** Walk a zip buffer into repo-relative .java RawFiles (package-info excluded). */
export function walkJavaZip(buffer: Buffer): RawFile[] {
  const zip = new AdmZip(buffer);
  const files: RawFile[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (!entry.entryName.endsWith('.java')) continue;
    if (entry.entryName.endsWith('package-info.java')) continue;
    const content = entry.getData().toString('utf-8');
    files.push({
      path: stripTopLevel(entry.entryName),
      content,
      bytes: Buffer.byteLength(content, 'utf-8'),
    });
  }
  return files;
}

/**
 * Acquire a repo's .java files, either from a local zip (offline) or by
 * downloading the pinned-SHA zipball. The SHA (not the branch) is fetched so
 * builds are reproducible.
 */
export async function acquireRepo(
  repo: RosterRepo,
  opts: { zipPath?: string; githubToken?: string } = {}
): Promise<RawFile[]> {
  let buffer: Buffer;
  if (opts.zipPath) {
    buffer = fs.readFileSync(opts.zipPath);
  } else {
    const ref = repo.sha || repo.ref;
    buffer = await fetchBuffer(repoZipUrl(repo.repo, ref), opts.githubToken);
  }
  return walkJavaZip(buffer);
}
