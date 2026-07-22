/* eslint-disable no-console */
/**
 * Unified database manifest generator.
 *
 * Generates the version manifest for any database in the src/dbs.ts registry.
 * The manifest (and the DB it describes) are uploaded as assets of the main
 * `v{version}` GitHub release — there are no per-database release tags.
 *
 * Usage:
 *   tsx scripts/generate-manifest.ts --db <docs|mappings|examples|cleanroom-api>
 *     --release-tag v1.2.3          (required: the release the assets attach to)
 *     [--db-path ./data/docs.db]    (default: ./data/<fileName>)
 *     [--bump major|minor|patch]    (bump the version found in ./data/<manifestName>)
 *     [--version X.Y.Z]             (set the version explicitly)
 *     [--type full|incremental]     (default: full)
 *     [--changelog "text"]
 */

import fs from 'fs';
import path from 'path';
import { DBS, DB_IDS, type DbId } from '../src/dbs.js';
import { DbVersioning } from '../src/db-versioning.js';
import { bumpVersion } from '../src/version-utils.js';

function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function main(): Promise<void> {
  const args = process.argv.slice(2);

  let dbId: DbId | undefined;
  let dbPathArg: string | undefined;
  let version: string | undefined;
  let bumpType: string | undefined;
  let type: 'incremental' | 'full' = 'full';
  let changelog = 'Database update';
  let releaseTag = '';

  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    switch (args[i]) {
      case '--db':
        if (next) dbId = args[++i] as DbId;
        break;
      case '--db-path':
        if (next) dbPathArg = path.resolve(args[++i]!);
        break;
      case '--version':
        if (next) version = args[++i];
        break;
      case '--bump':
        if (next) bumpType = args[++i];
        break;
      case '--type':
        if (next) type = args[++i] as 'incremental' | 'full';
        break;
      case '--changelog':
        if (next) changelog = args[++i]!;
        break;
      case '--release-tag':
        if (next) releaseTag = args[++i]!;
        break;
    }
  }

  if (!dbId || !DB_IDS.includes(dbId)) {
    fail(`--db is required and must be one of: ${DB_IDS.join(', ')}`);
  }
  if (!releaseTag) {
    fail('--release-tag is required (the v{version} release the assets attach to)');
  }

  const spec = DBS[dbId];
  const dbPath = dbPathArg || path.join(process.cwd(), 'data', spec.fileName);
  if (!fs.existsSync(dbPath)) {
    fail(`Database not found: ${dbPath}`);
  }

  // Previous manifest (alongside the DB) seeds the version for --bump.
  const manifestPath = path.join(path.dirname(dbPath), spec.manifestName);
  if (!version) {
    version = '0.1.0';
    if (fs.existsSync(manifestPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { version: string };
        if (existing.version) version = existing.version;
      } catch {
        console.warn('⚠️  Could not parse existing manifest, starting from 0.1.0');
      }
    }
    if (bumpType) {
      const old = version;
      version = bumpVersion(version, bumpType);
      console.log(`Bumped version: ${old} -> ${version} (${bumpType})`);
    }
  }

  const versioning = new DbVersioning(spec, dbPath);
  return versioning.createManifest(version, type, changelog, releaseTag).then((manifest) => {
    console.log(`\n✅ Manifest for '${spec.id}' created: ${manifestPath}`);
    console.log(`   Version:  ${manifest.version}`);
    console.log(`   Hash:     ${manifest.hash.substring(0, 16)}...`);
    console.log(`   Size:     ${(manifest.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   URL:      ${manifest.downloadUrl}`);
  });
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
