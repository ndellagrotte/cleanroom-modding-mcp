/**
 * Maintainer-local analysis cache (Phase 5 Revision 1, §4.5).
 *
 * Keys each analysis by a sha256 over the prompt-visible snippet payload and
 * gates reads on `analysis_version`: a hit costs nothing, and a prompt/model/
 * PIPELINE_REV change invalidates every entry with zero extra logic (the
 * stored `analysis_version` no longer matches — DESIGN §6.4 semantics exactly).
 *
 * The cache DB (default data/examples-analysis-cache.db) is gitignored and
 * NEVER shipped: not in the npm tarball, not in examples.db, not uploaded by
 * CI. The golden path never touches this module. Pure, injectable, offline.
 */

import crypto from 'crypto';
import Database from 'better-sqlite3';
import type { Analysis, CompletionUsage, Snippet } from './model.js';

const CACHE_DDL = `
CREATE TABLE IF NOT EXISTS analysis_cache (
  snippet_hash      TEXT PRIMARY KEY,   -- sha256 over the canonical payload
  analysis_version  TEXT NOT NULL,      -- read gate; mismatch = miss
  analysis_json     TEXT NOT NULL,      -- normalized Analysis (model.ts)
  usage_json        TEXT,               -- nullable Completion.usage
  created_at        TEXT NOT NULL
);`;

/**
 * sha256 over the JSON of { repo, modName, filePath, startLine, endLine, code }
 * — the prompt-visible payload (buildPrompt, analyze.ts). Deliberately NOT the
 * roster SHA (a pin bump whose files didn't change still hits) and NOT
 * `analysis_version` (stored as a column and required to match on read).
 */
export function hashSnippet(
  snippet: Pick<Snippet, 'repo' | 'modName' | 'filePath' | 'startLine' | 'endLine' | 'code'>
): string {
  const payload = {
    repo: snippet.repo,
    modName: snippet.modName,
    filePath: snippet.filePath,
    startLine: snippet.startLine,
    endLine: snippet.endLine,
    code: snippet.code,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export interface CachedAnalysis {
  analysis: Analysis;
  usage: CompletionUsage | null;
}

export interface AnalysisCache {
  /** A hit only when the stored analysis_version matches; otherwise a miss. */
  getCached(hash: string, analysisVersion: string): CachedAnalysis | null;
  /** Write-through store of a fresh analysis (+ its usage) under the version. */
  putCached(
    hash: string,
    analysisVersion: string,
    analysis: Analysis,
    usage: CompletionUsage | null
  ): void;
  close(): void;
}

/**
 * Open the cache at dbPath, creating it (with the DDL) unless `readonly` is
 * set. Readonly mode never creates or mutates the file — `--estimate` uses it
 * so the projection performs zero cache writes (the caller must still guard
 * with fs.existsSync, since better-sqlite3 cannot open a missing file).
 */
export function openAnalysisCache(dbPath: string, opts?: { readonly?: boolean }): AnalysisCache {
  const db = new Database(dbPath, opts?.readonly ? { readonly: true } : {});
  if (!opts?.readonly) {
    db.pragma('journal_mode = WAL');
    db.exec(CACHE_DDL);
  }
  const getStmt = db.prepare(
    `SELECT analysis_json, usage_json FROM analysis_cache
     WHERE snippet_hash = ? AND analysis_version = ?`
  );
  const putStmt = db.prepare(
    `INSERT OR REPLACE INTO analysis_cache
       (snippet_hash, analysis_version, analysis_json, usage_json, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  return {
    getCached(hash, analysisVersion) {
      const row = getStmt.get(hash, analysisVersion) as
        | { analysis_json: string; usage_json: string | null }
        | undefined;
      if (!row) return null;
      return {
        analysis: JSON.parse(row.analysis_json) as Analysis,
        usage: row.usage_json ? (JSON.parse(row.usage_json) as CompletionUsage) : null,
      };
    },
    putCached(hash, analysisVersion, analysis, usage) {
      putStmt.run(
        hash,
        analysisVersion,
        JSON.stringify(analysis),
        usage ? JSON.stringify(usage) : null,
        new Date().toISOString()
      );
    },
    close() {
      db.close();
    },
  };
}
