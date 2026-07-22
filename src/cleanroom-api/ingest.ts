/**
 * Final stage of the Cleanroom API indexing pipeline: write resolved rows into
 * a fresh database file. One transaction for everything; FTS stays in sync via
 * the schema's triggers.
 *
 * Callers own the no-partial-DB guarantee: ingest into a temp path, rename on
 * success (scripts/index-java-api.ts).
 */

import { initializeCleanroomApiDb } from './schema.js';
import type { ResolveResult } from './model.js';

export interface IngestMeta {
  cleanroomVersion: string;
  sourcesJarUrl: string | null;
  sourcesJarSha256: string | null;
  /** e.g. 'web-tree-sitter@0.26.11 + tree-sitter-java@0.23.5'. */
  parserInfo: string;
}

export interface IngestCounts {
  types: number;
  members: number;
  events: number;
  annotationTypes: number;
  deprecatedTypes: number;
  byNamespace: Record<string, number>;
}

const NAMESPACE_ROOTS = ['net.minecraftforge', 'com.cleanroommc', 'zone.rong'];

/** Write a resolved corpus into dbPath (created/overwritten via schema init). */
export function ingest(dbPath: string, result: ResolveResult, meta: IngestMeta): IngestCounts {
  const db = initializeCleanroomApiDb(dbPath);
  try {
    const insertType = db.prepare(`
      INSERT INTO types (
        fqn, simple_name, package_name, outer_fqn, kind, loader, modifiers,
        signature, extends_raw, extends_fqn, implements_raw, implements_fqns,
        annotations, javadoc, javadoc_summary, is_deprecated, deprecation_note,
        since, is_event, is_cancelable, has_result, source_file, search_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMember = db.prepare(`
      INSERT INTO members (
        type_id, kind, name, signature, return_type, params, modifiers,
        annotations, javadoc, javadoc_summary, is_deprecated, since, search_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertUsage = db.prepare(
      `INSERT OR REPLACE INTO annotation_usage (annotation_fqn, usage_count) VALUES (?, ?)`
    );
    const insertMetadata = db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`);

    const counts: IngestCounts = {
      types: 0,
      members: 0,
      events: 0,
      annotationTypes: 0,
      deprecatedTypes: 0,
      byNamespace: {},
    };

    // Parents before children (outer_fqn is informational, but deterministic
    // order keeps rebuilt DBs byte-comparable), then stable by FQN.
    const ordered = [...result.types].sort(
      (a, b) => a.nestingDepth - b.nestingDepth || a.fqn.localeCompare(b.fqn)
    );

    db.transaction(() => {
      for (const type of ordered) {
        const row = insertType.run(
          type.fqn,
          type.simpleName,
          type.packageName,
          type.outerFqn,
          type.kind,
          type.loader,
          type.modifiers || null,
          type.signature,
          type.extendsRaw,
          type.extendsFqn,
          type.implementsRaw.length > 0 ? JSON.stringify(type.implementsRaw) : null,
          type.implementsFqns.length > 0 ? JSON.stringify(type.implementsFqns) : null,
          type.annotations.length > 0 ? JSON.stringify(type.annotations) : null,
          type.javadoc,
          type.javadocSummary,
          type.isDeprecated ? 1 : 0,
          type.deprecationNote,
          type.since,
          type.isEvent ? 1 : 0,
          type.isCancelable ? 1 : 0,
          type.hasResult ? 1 : 0,
          type.sourceFile,
          type.searchText
        );
        const typeId = row.lastInsertRowid as number;

        counts.types++;
        if (type.isEvent) {
          counts.events++;
        }
        if (type.kind === 'annotation') {
          counts.annotationTypes++;
        }
        if (type.isDeprecated) {
          counts.deprecatedTypes++;
        }
        const root = NAMESPACE_ROOTS.find((r) => type.packageName.startsWith(r));
        if (root) {
          counts.byNamespace[root] = (counts.byNamespace[root] ?? 0) + 1;
        }

        for (const member of type.members) {
          insertMember.run(
            typeId,
            member.kind,
            member.name,
            member.signature,
            member.returnType,
            member.params ? JSON.stringify(member.params) : null,
            member.modifiers.join(' ') || null,
            member.annotations.length > 0 ? JSON.stringify(member.annotations) : null,
            member.javadoc?.body || null,
            member.javadoc?.summary || null,
            member.isDeprecated ? 1 : 0,
            member.since,
            member.searchText
          );
          counts.members++;
        }
      }

      for (const [fqn, count] of result.annotationUsage) {
        insertUsage.run(fqn, count);
      }

      insertMetadata.run('indexed_at', new Date().toISOString());
      insertMetadata.run('cleanroom_version', meta.cleanroomVersion);
      if (meta.sourcesJarUrl) {
        insertMetadata.run('sources_jar_url', meta.sourcesJarUrl);
      }
      if (meta.sourcesJarSha256) {
        insertMetadata.run('sources_jar_sha256', meta.sourcesJarSha256);
      }
      insertMetadata.run('parser', meta.parserInfo);
      insertMetadata.run('counts', JSON.stringify(counts));
    })();

    return counts;
  } finally {
    db.close();
  }
}
