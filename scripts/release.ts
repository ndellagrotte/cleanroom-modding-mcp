#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Maintainer release entry point.
 *
 * Database assets are published before npm so a package version can never
 * become public without a usable documentation database release.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { DBS, DB_IDS, type DbId } from '../src/dbs.js';
import { readDbSchemaVersion } from '../src/mappings/schema.js';
import { lintCorpus, reportLint } from './lint-corpus.js';
import { migrateExampleCategories } from '../src/examples/migrate.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
const args = new Set(process.argv.slice(2));
const assetsOnly = args.has('--assets-only');
const rebuildDocs = args.has('--rebuild-docs');
const version = packageJson.version;
const tag = `v${version}`;
const dataDir = process.env.CLEANROOM_RELEASE_DATA_DIR
  ? path.resolve(process.env.CLEANROOM_RELEASE_DATA_DIR)
  : path.join(repoRoot, 'data');

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function run(command: string, commandArgs: string[], capture = false): string {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : '';
    fail(`${command} ${commandArgs.join(' ')} failed${detail}`);
  }
  return capture ? result.stdout.trim() : '';
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function dbFile(id: DbId): string {
  return path.join(dataDir, DBS[id].fileName);
}

function manifestFile(id: DbId): string {
  return path.join(dataDir, DBS[id].manifestName);
}

function verifyArtifacts(id: DbId): void {
  const spec = DBS[id];
  const database = dbFile(id);
  const manifestPath = manifestFile(id);
  if (!fs.existsSync(database) || !fs.existsSync(manifestPath)) {
    fail(`release artifacts are missing: ${database} and ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    version?: string;
    schemaVersion?: number;
    hash?: string;
    downloadUrl?: string;
  };
  if (manifest.version !== version) {
    fail(
      `${id} manifest version ${manifest.version ?? 'missing'} must equal package version ${version}`
    );
  }
  if (manifest.schemaVersion !== spec.schemaVersion) {
    fail(
      `${id} manifest schema v${manifest.schemaVersion ?? 'missing'} must equal v${spec.schemaVersion}`
    );
  }
  const dbSchema = readDbSchemaVersion(database);
  if (dbSchema !== spec.schemaVersion) {
    fail(`${spec.fileName} schema v${dbSchema ?? 'unreadable'} must equal v${spec.schemaVersion}`);
  }
  const actualHash = sha256(database);
  if (manifest.hash !== actualHash) {
    fail(
      `${id} manifest hash ${manifest.hash ?? 'missing'} does not match ${spec.fileName} ${actualHash}`
    );
  }
  const expectedUrl = `/releases/download/${tag}/${spec.fileName}`;
  if (!manifest.downloadUrl?.endsWith(expectedUrl)) {
    fail(`${id} manifest downloadUrl must end with ${expectedUrl}`);
  }
  console.log(`Verified ${id} assets for ${tag} (${actualHash}).`);
}

function releaseAssets(): string[] | null {
  const result = spawnSync('gh', ['release', 'view', tag, '--json', 'assets'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return null;
  const parsed = JSON.parse(result.stdout) as { assets: Array<{ name: string }> };
  return parsed.assets.map((asset) => asset.name);
}

if (!assetsOnly) {
  const published = spawnSync('npm', ['view', `${packageJson.name}@${version}`, 'version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (published.status === 0 && published.stdout.trim() === version) {
    fail(`${packageJson.name}@${version} already exists; bump package.json before releasing`);
  }
  run('npm', ['run', 'validate']);
}

if (rebuildDocs) {
  run('npm', ['run', 'index-docs:prod']);
}
// Every DB now auto-installs on the client, so a release that omits one makes
// every user's startup report it as a failed download. Ship all or nothing.
const missing = DB_IDS.filter((id) => !fs.existsSync(dbFile(id)));
if (missing.length > 0) {
  fail(
    `databases missing from the release data dir: ${missing.map((id) => dbFile(id)).join(', ')}\n` +
      'Every registry database ships on every release — build the missing ones, or point ' +
      'CLEANROOM_RELEASE_DATA_DIR at a directory that already has them.'
  );
}
// Corpus lint, before a single manifest is written.
//
// This is the check that would have caught V8. The other verification here is
// about *packaging* — hashes, versions, URL suffixes — and never opens a table,
// so v2.2.3 published a docs.db carrying 9,867 known zero-width contaminations,
// 359 null versions and a phantom `21.9`, all of them already diagnosed and
// scheduled for that exact rebuild. It passed every gate because no gate looked.
//
// It runs whether or not this invocation rebuilt anything, because the failure
// mode is a *carried-forward* database that no longer matches the code shipping
// beside it.
{
  // Repair carried-forward category metadata before linting or hashing assets.
  migrateExampleCategories(dbFile('examples'));
  const docsDb = dbFile('docs');
  if (fs.existsSync(docsDb)) {
    const report = lintCorpus(docsDb);
    if (!reportLint(docsDb, report)) {
      fail(
        `docs.db failed ${report.failed.length} corpus check(s); see above.\n` +
          'Every user pays a full download for this file, so publishing a known-bad ' +
          'metric spends the budget for the next fix as well. Rebuild with ' +
          '`npm run index-docs:prod` and release again.'
      );
    }
  }
}

const includedIds = DB_IDS;
for (const id of includedIds) {
  run('npm', [
    'run',
    'manifest',
    '--',
    '--db',
    id,
    '--version',
    version,
    '--changelog',
    `Release ${tag}`,
    '--release-tag',
    tag,
    '--db-path',
    dbFile(id),
  ]);
  verifyArtifacts(id);
}
const artifactPaths = includedIds.flatMap((id) => [dbFile(id), manifestFile(id)]);

run('gh', ['auth', 'status']);
const existingAssets = releaseAssets();
if (existingAssets === null) {
  // gh forwards --target verbatim as the API's target_commitish, which only accepts a branch
  // name or a full SHA. Targeting the branch means GitHub tags the remote tip, so require it
  // to be the commit that was just validated.
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], true);
  if (branch === 'HEAD') {
    fail(`detached HEAD; check out a branch before releasing ${tag}`);
  }
  const lsRemote = run('git', ['ls-remote', 'origin', `refs/heads/${branch}`], true);
  if (!lsRemote) {
    fail(`origin has no branch ${branch}; push it before releasing ${tag}`);
  }
  const remoteSha = lsRemote.split('\t')[0] ?? '';
  const localSha = run('git', ['rev-parse', 'HEAD'], true);
  if (remoteSha !== localSha) {
    fail(
      `origin/${branch} is at ${remoteSha.slice(0, 7)} but HEAD is ${localSha.slice(0, 7)}; ` +
        `push before releasing ${tag}`
    );
  }
  console.log(`Creating ${tag} on ${branch} (${localSha.slice(0, 7)}).`);
  run('gh', [
    'release',
    'create',
    tag,
    ...artifactPaths,
    '--target',
    branch,
    '--title',
    tag,
    '--generate-notes',
  ]);
} else {
  const complete = includedIds.every(
    (id) =>
      existingAssets.includes(DBS[id].fileName) && existingAssets.includes(DBS[id].manifestName)
  );
  if (!complete || assetsOnly) {
    run('gh', ['release', 'upload', tag, ...artifactPaths, '--clobber']);
  }
}

const uploaded = releaseAssets();
const missingUploads = includedIds.flatMap((id) =>
  [DBS[id].fileName, DBS[id].manifestName].filter((name) => !uploaded?.includes(name))
);
if (missingUploads.length > 0) {
  fail(`GitHub release ${tag} is missing assets after upload: ${missingUploads.join(', ')}`);
}
console.log(`GitHub release ${tag} has all ${artifactPaths.length} prepared database assets.`);

if (!assetsOnly) {
  // No --provenance: npm can only generate it from a supported CI provider's OIDC token, and
  // this script releases from a maintainer workstation, where the provider is always null.
  run('npm', ['publish', '--access', 'public']);
  console.log(`Published ${packageJson.name}@${version}.`);
} else {
  console.log('Assets-only repair complete; npm publication skipped.');
}
