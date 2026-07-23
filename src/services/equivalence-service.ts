/**
 * EquivalenceService — the read side of the Phase 4 porting corpus.
 *
 * Opens docs.db (honoring DB_PATH / DOCS_DB), probes for the equivalence corpus, and runs
 * FTS queries. It never mutates the DB in a way that changes correctness: DocumentStore's
 * schema init is non-destructive to an existing DB's recorded schema_version, and this
 * service treats "schema < 2 / table absent / empty" as a graceful-degrade condition.
 */

import fs from 'fs';
import { DocumentStore, type EquivalenceDbRow } from '../indexer/store.js';
import { DBS } from '../dbs.js';
import { getDefaultDbPath } from '../data-dir.js';
import type { EquivalenceMatch, EquivalenceSource } from '../equivalence/types.js';

function resolveDocsDbPath(dbPath?: string): string {
  return (
    dbPath || process.env.DB_PATH || process.env.DOCS_DB || getDefaultDbPath(DBS.docs.fileName)
  );
}

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** Decode a raw equivalence DB row (JSON columns) into a parsed match. */
export function equivalenceRowToMatch(row: EquivalenceDbRow): EquivalenceMatch {
  return {
    entryKey: row.entry_key,
    topic: row.topic,
    fromVocab: row.from_vocab,
    fromEra: row.from_era,
    fromApi: row.from_api,
    fromApiAlt: parseJsonArray<string>(row.from_api_alt),
    fromVersions: row.from_versions,
    toLoader: row.to_loader,
    toApi: row.to_api,
    kind: row.kind,
    notes: row.notes,
    codeBefore: row.code_before,
    codeAfter: row.code_after,
    caveats: parseJsonArray<string>(row.caveats),
    related: parseJsonArray<string>(row.related),
    sources: parseJsonArray<EquivalenceSource>(row.sources),
    validatedAgainst: row.validated_against,
  };
}

export class EquivalenceService {
  private store: DocumentStore | null;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = resolveDocsDbPath(dbPath);
    // Avoid auto-creating an empty DB when the path is missing (that would masquerade as a
    // present-but-empty corpus). A missing docs.db reads as "corpus not present".
    this.store = fs.existsSync(this.dbPath) ? new DocumentStore(this.dbPath) : null;
  }

  /** True only when this docs.db carries a populated equivalence corpus (schema v2). */
  isCorpusPresent(): boolean {
    if (!this.store) return false;
    const v = this.store.getSchemaVersion();
    return v !== null && v >= 2 && this.store.countEquivalence() > 0;
  }

  search(params: {
    query: string;
    fromVocab: string;
    topic?: string;
    limit: number;
  }): EquivalenceMatch[] {
    if (!this.store) return [];
    const rows = this.store.searchEquivalence(params);
    return rows.map(equivalenceRowToMatch);
  }

  close(): void {
    this.store?.close();
    this.store = null;
  }
}
