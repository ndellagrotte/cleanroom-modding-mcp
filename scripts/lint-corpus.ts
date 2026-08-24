#!/usr/bin/env tsx
/**
 * Corpus lint for docs.db — the pre-publish gate.
 *
 * The v2.2.3 release rebuilt docs.db and shipped it carrying exactly one of the
 * three fixes that had been scheduled for that rebuild. Every other metric was
 * republished unchanged: 9,867 zero-width contaminations regenerated from
 * scratch, 359 null versions, the phantom `21.9`. Nothing in the pipeline
 * noticed, because nothing in the pipeline looks at the corpus after it is
 * built (beta report V8).
 *
 * That is what this exists to stop. `docs.db` is 818 MiB and whole-file
 * replacement is the only delivery mechanism, so a rebuild that ships a
 * known-zero metric unchanged burns the entire budget for the next one.
 *
 * Deliberately standalone and read-only, so it can gate three different places:
 *  - `scripts/index-docs.ts`, right after a build
 *  - `scripts/release.ts`, which is the one that catches a *carried-forward*
 *    database this run never rebuilt — the actual V8 failure
 *  - the weekly rebuild workflow, before the manifest is written
 *
 * Exit code 0 = every check passed, 1 = at least one failed, 2 = could not run.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DOC_CATEGORIES, DOC_FALLBACK_CATEGORY } from '../src/categories.js';
import { MC_VERSION_PATTERN } from '../src/loaders.js';
import { DBS } from '../src/dbs.js';

/**
 * Ceiling on the share of the corpus allowed to sit in the fallback category.
 *
 * The previous gate sat at 60%, and its own comment conceded that it "would not
 * have caught the 56% state that motivated it". With the categorizer reading
 * DokuWiki colon namespaces and descending past container segments, the corpus
 * sits at 6.5% overall (93/1432) and 17% for the worst loader, so 15% is a real
 * gate rather than a formality — tight enough to catch a regression, loose
 * enough to survive ordinary upstream churn.
 */
const GENERAL_SHARE_LIMIT = 0.15;

/** Per-loader ceiling. Looser: a single small corpus can legitimately drift. */
const GENERAL_SHARE_LIMIT_PER_LOADER = 0.25;

export interface LintCheck {
  name: string;
  passed: boolean;
  /** Human-readable actual value. */
  actual: string;
  /** What was required. */
  expected: string;
  /** Optional extra context printed under a failure. */
  detail?: string;
}

export interface LintReport {
  checks: LintCheck[];
  failed: LintCheck[];
}

interface CountRow {
  c: number;
}

/** `char(8203)` is U+200B; the others are ZWNJ, ZWJ and the BOM. */
const ZERO_WIDTH_SQL = (col: string) =>
  `(instr(${col}, char(8203)) > 0 OR instr(${col}, char(8204)) > 0 ` +
  `OR instr(${col}, char(8205)) > 0 OR instr(${col}, char(65279)) > 0)`;

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as CountRow;
  return row.c > 0;
}

function count(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as CountRow).c;
}

export function lintCorpus(dbPath: string): LintReport {
  const db = new Database(dbPath, { readonly: true });
  const checks: LintCheck[] = [];

  const check = (
    name: string,
    passed: boolean,
    actual: string,
    expected: string,
    detail?: string
  ) => {
    checks.push({ name, passed, actual, expected, detail });
  };

  try {
    const total = count(db, 'SELECT count(*) c FROM documents');
    check('corpus is non-empty', total > 0, `${total} documents`, '> 0');
    if (total === 0) {
      return { checks, failed: checks.filter((c) => !c.passed) };
    }

    // --- S6: zero-width contamination -------------------------------------
    for (const [table, column] of [
      ['sections', 'heading'],
      ['sections', 'content'],
      ['documents', 'content'],
      ['chunks', 'content'],
      ['documents', 'title'],
    ] as const) {
      if (!tableExists(db, table)) continue;
      const n = count(db, `SELECT count(*) c FROM ${table} WHERE ${ZERO_WIDTH_SQL(column)}`);
      check(`no zero-width chars in ${table}.${column}`, n === 0, String(n), '0');
    }

    // --- S6: empty, undersized and duplicated sections ---------------------
    if (tableExists(db, 'sections')) {
      const hasCodeBlocks = tableExists(db, 'code_blocks');
      const withoutCode = hasCodeBlocks
        ? 'AND NOT EXISTS (SELECT 1 FROM code_blocks cb WHERE cb.section_id = sections.id)'
        : '';
      const tooShort = count(
        db,
        `SELECT count(*) c FROM sections WHERE length(trim(content)) < 25 ${withoutCode}`
      );
      check(
        'no body-less or too-short sections',
        tooShort === 0,
        String(tooShort),
        '0',
        'A prose section shorter than 25 characters carries no useful searchable context. ' +
          'Code-only sections remain valid because their body is stored in code_blocks.'
      );

      const codeFingerprint = hasCodeBlocks
        ? `COALESCE((
             SELECT group_concat(parts.part, char(30))
             FROM (
               SELECT cb.language || char(31) || cb.code || char(31) ||
                      COALESCE(cb.caption, '') part
               FROM code_blocks cb
               WHERE cb.section_id = s.id
               ORDER BY cb.id
             ) parts
           ), '')`
        : "''";
      const dupes = count(
        db,
        `WITH fingerprints AS (
           SELECT s.document_id, s.heading, s.content, ${codeFingerprint} code_fingerprint
           FROM sections s
         )
         SELECT count(*) c FROM (
           SELECT document_id, heading, content, code_fingerprint
           FROM fingerprints
           GROUP BY 1, 2, 3, 4
           HAVING count(*) > 1
         )`
      );
      check(
        'no unexpected duplicate section groups',
        dupes === 0,
        String(dupes),
        '0',
        'Distinct headings or code blocks are legitimate repetition. Rows with identical ' +
          'document, heading, prose, and ordered code are duplicate ingest output.'
      );
    }

    // --- S8: the version columns -------------------------------------------
    const nullVersions = count(
      db,
      'SELECT count(*) c FROM documents WHERE minecraft_version IS NULL'
    );
    check(
      'no NULL minecraft_version',
      nullVersions === 0,
      String(nullVersions),
      '0',
      'Every indexed source must resolve to a concrete Minecraft version.'
    );

    const phantomVersions = count(
      db,
      "SELECT count(*) c FROM documents WHERE minecraft_version = '21.9'"
    );
    check(
      'no phantom minecraft_version 21.9',
      phantomVersions === 0,
      String(phantomVersions),
      '0',
      '21.9 is a ModDevGradle version, not a Minecraft release.'
    );
    const badVersions = db
      .prepare(
        'SELECT minecraft_version v, count(*) c FROM documents ' +
          'WHERE minecraft_version IS NOT NULL GROUP BY 1'
      )
      .all() as Array<{ v: string; c: number }>;
    const offending = badVersions.filter((r) => !MC_VERSION_PATTERN.test(r.v));
    check(
      'minecraft_version holds only Minecraft versions',
      offending.length === 0,
      offending.length === 0 ? 'clean' : offending.map((r) => `${r.v} (${r.c})`).join(', '),
      'every value matches /^1.x[.y]$/',
      'Docs-site and loader versions belong in loader_version.'
    );

    // --- V9: the taxonomy ---------------------------------------------------
    const categories = db
      .prepare('SELECT category, count(*) c FROM documents GROUP BY 1')
      .all() as Array<{ category: string; c: number }>;
    const known = new Set<string>(DOC_CATEGORIES);
    const offTaxonomy = categories.filter((r) => !known.has(r.category));
    check(
      'every category is in DOC_CATEGORIES',
      offTaxonomy.length === 0,
      offTaxonomy.length === 0
        ? 'clean'
        : offTaxonomy.map((r) => `${r.category} (${r.c})`).join(', '),
      'no values outside the enum',
      'A category outside the enum is a document no `category` filter can reach. ' +
        'Extend PATH_SEGMENT_CATEGORIES in src/categories.ts.'
    );

    const general = categories.find((r) => r.category === DOC_FALLBACK_CATEGORY)?.c ?? 0;
    const share = general / total;
    check(
      `fallback category under ${Math.round(GENERAL_SHARE_LIMIT * 100)}% of the corpus`,
      share < GENERAL_SHARE_LIMIT,
      `${general}/${total} (${(share * 100).toFixed(1)}%)`,
      `< ${Math.round(GENERAL_SHARE_LIMIT * 100)}%`,
      "'general' is where a categorization regression lands silently — the off-taxonomy " +
        "check above cannot see it, because 'general' is itself a valid enum value."
    );

    const perLoader = db
      .prepare(
        'SELECT loader, ' +
          `sum(CASE WHEN category = '${DOC_FALLBACK_CATEGORY}' THEN 1 ELSE 0 END) g, ` +
          'count(*) t FROM documents GROUP BY 1'
      )
      .all() as Array<{ loader: string; g: number; t: number }>;
    const breached = perLoader.filter((r) => r.t > 0 && r.g / r.t > GENERAL_SHARE_LIMIT_PER_LOADER);
    check(
      `fallback category under ${Math.round(GENERAL_SHARE_LIMIT_PER_LOADER * 100)}% for every loader`,
      breached.length === 0,
      breached.length === 0
        ? perLoader.map((r) => `${r.loader} ${((r.g / r.t) * 100).toFixed(0)}%`).join(', ')
        : breached.map((r) => `${r.loader} ${((r.g / r.t) * 100).toFixed(0)}%`).join(', '),
      `<= ${Math.round(GENERAL_SHARE_LIMIT_PER_LOADER * 100)}% each`,
      'Per loader as well as overall, because an aggregate lets one corpus rot unnoticed.'
    );

    // --- referential integrity ---------------------------------------------
    //
    // docs.db never set `PRAGMA foreign_keys`, so its ON DELETE CASCADEs were
    // inert; combined with INSERT OR REPLACE reassigning document ids, an
    // incremental re-index over an existing file orphaned every child row it
    // thought it was replacing. The corpus is clean today only because the
    // weekly workflow `rm -f`s the database first — which makes this the check
    // that notices if that ever stops being true.
    const ORPHAN_CHECKS: Array<[table: string, sql: string]> = [
      [
        'sections',
        'SELECT count(*) c FROM sections WHERE document_id NOT IN (SELECT id FROM documents)',
      ],
      [
        'chunks',
        'SELECT count(*) c FROM chunks WHERE document_id NOT IN (SELECT id FROM documents)',
      ],
      [
        'code_blocks',
        'SELECT count(*) c FROM code_blocks WHERE section_id NOT IN (SELECT id FROM sections)',
      ],
      [
        'embeddings',
        'SELECT count(*) c FROM embeddings WHERE chunk_id NOT IN (SELECT id FROM chunks)',
      ],
    ];
    for (const [table, sql] of ORPHAN_CHECKS) {
      if (!tableExists(db, table)) continue;
      const orphans = count(db, sql);
      check(`no orphaned ${table} rows`, orphans === 0, String(orphans), '0');
    }

    // --- versioning stamps --------------------------------------------------
    const meta = new Map(
      (
        db.prepare('SELECT key, value FROM metadata').all() as Array<{
          key: string;
          value: string;
        }>
      ).map((r) => [r.key, r.value])
    );
    check(
      'schema_version matches the registry',
      meta.get('schema_version') === String(DBS.docs.schemaVersion),
      meta.get('schema_version') ?? '(absent)',
      String(DBS.docs.schemaVersion),
      'Bump SCHEMA_VERSION in src/indexer/store.ts and DBS.docs.schemaVersion in src/dbs.ts together.'
    );
  } finally {
    db.close();
  }

  return { checks, failed: checks.filter((c) => !c.passed) };
}

/** Render a report. Returns true when everything passed. */
export function reportLint(dbPath: string, report: LintReport, log = console.error): boolean {
  log(`\n[LintCorpus] ${path.basename(dbPath)} — ${report.checks.length} checks`);
  for (const c of report.checks) {
    log(
      `  ${c.passed ? 'PASS' : 'FAIL'}  ${c.name}: ${c.actual}${c.passed ? '' : ` (want ${c.expected})`}`
    );
    if (!c.passed && c.detail) {
      log(`        ${c.detail}`);
    }
  }
  if (report.failed.length > 0) {
    log(
      `\n[LintCorpus] ${report.failed.length} check(s) failed. This database must not be ` +
        'published — every user pays a full download for it, so a known-bad metric here ' +
        'costs the budget for the next fix too.'
    );
    return false;
  }
  log('[LintCorpus] All checks passed.\n');
  return true;
}

function main(): void {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const dbPath = arg ?? path.join('data', DBS.docs.fileName);

  if (!fs.existsSync(dbPath)) {
    console.error(`[LintCorpus] Database not found: ${dbPath}`);
    process.exit(2);
  }

  try {
    const report = lintCorpus(dbPath);
    process.exit(reportLint(dbPath, report) ? 0 : 1);
  } catch (error) {
    console.error(
      `[LintCorpus] Could not lint ${dbPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(2);
  }
}

// Only run as a CLI, so index-docs/release can import lintCorpus directly.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
