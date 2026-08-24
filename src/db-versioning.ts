/**
 * Database versioning and update system
 * Manages version manifests, downloads, and integrity verification.
 *
 * One DbVersioning instance manages one database from the src/dbs.ts registry.
 * All DB assets live on the main `v{version}` GitHub release (see src/dbs.ts).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  DBS,
  DB_IDS,
  dbPath as registryDbPath,
  getApiBase,
  isInstalled,
  selectRelease,
  REPO_URL,
  USER_AGENT,
  type DbId,
  type DbSpec,
  type GitHubRelease,
} from './dbs.js';
import { compareVersions } from './version-utils.js';
import { readDbSchemaVersion } from './mappings/schema.js';

/** Manifest `source` marking a DB built on-device via `manage` (never auto-updated). */
export const LOCAL_BUILD_SOURCE = 'local-build';

export interface DbVersionManifest {
  version: string;
  schemaVersion: number;
  timestamp: string;
  type: 'incremental' | 'full';
  hash: string;
  size: number;
  downloadUrl: string;
  changelog: string;
  /**
   * Provenance: 'local-build' marks a DB built on-device via `manage`
   * (auto-update leaves those alone — the release DB could carry less data,
   * e.g. a mappings DB without the MCP era if licensing review fails);
   * 'manual-install' marks a download that came without a manifest.
   */
  source?: string;
}

export class DbVersioning {
  private spec: DbSpec;
  private localManifestPath: string;
  private failedMarkerPath: string;
  private dbPath: string;
  private dataDir: string;
  private updateCheckFailed = false;

  constructor(spec: DbSpec = DBS.docs, dbPath?: string) {
    this.spec = spec;
    this.dbPath = dbPath || registryDbPath(spec.id);
    this.dataDir = path.dirname(this.dbPath);
    this.localManifestPath = path.join(this.dataDir, spec.manifestName);
    this.failedMarkerPath = path.join(this.dataDir, `${spec.id}-download-failed.json`);
  }

  /**
   * Get local manifest or null
   */
  getLocalManifest(): DbVersionManifest | null {
    try {
      if (!fs.existsSync(this.localManifestPath)) {
        return null;
      }
      const content = fs.readFileSync(this.localManifestPath, 'utf-8');
      return JSON.parse(content) as DbVersionManifest;
    } catch (error) {
      console.error(`[DbVersioning:${this.spec.id}] Error reading local manifest:`, error);
      return null;
    }
  }

  /**
   * Fetch remote manifest from GitHub releases (newest v-tag release carrying
   * this DB's asset — releases with failed uploads are skipped).
   */
  async getRemoteManifest(): Promise<DbVersionManifest | null> {
    try {
      const response = await fetch(`${getApiBase()}/releases`, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': USER_AGENT,
        },
      });

      if (!response.ok) {
        console.error(
          `[DbVersioning:${this.spec.id}] Failed to fetch releases: ${response.status}`
        );
        return null;
      }

      const releases = (await response.json()) as GitHubRelease[];
      // requireManifest: a partial upload (DB present, manifest missing) must
      // not block updates — keep scanning for an older complete release.
      const selected = selectRelease(releases, this.spec, { requireManifest: true });
      if (!selected || !selected.manifestAsset) {
        console.error(
          `[DbVersioning:${this.spec.id}] No release with database + manifest assets found`
        );
        return null;
      }

      const manifestResponse = await fetch(selected.manifestAsset.browser_download_url);
      if (!manifestResponse.ok) {
        console.error(`[DbVersioning:${this.spec.id}] Failed to fetch manifest from release`);
        return null;
      }

      const manifest = (await manifestResponse.json()) as DbVersionManifest;

      if (manifest.schemaVersion !== this.spec.schemaVersion) {
        console.error(
          `[DbVersioning:${this.spec.id}] Release manifest has schema v${manifest.schemaVersion ?? 'missing'} ` +
            `but this build expects v${this.spec.schemaVersion}`
        );
        return null;
      }

      // The release asset is authoritative for the download URL; the URL baked
      // into the manifest may be outdated or wrong.
      manifest.downloadUrl = selected.dbAsset.browser_download_url;

      return manifest;
    } catch (error) {
      console.error(`[DbVersioning:${this.spec.id}] Error fetching remote manifest:`, error);
      return null;
    }
  }

  /**
   * Compare semantic versions.
   * Returns: -1 if local < remote, 1 if local > remote, 0 if equal
   */
  compareVersions(local: string, remote: string): number {
    return compareVersions(local, remote);
  }

  /**
   * Calculate SHA256 hash of file
   */
  async calculateFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Delete the `-shm`/`-wal` sidecars SQLite creates when the downloaded temp
   * file is opened for the schema check. They are named after the temp path, so
   * renaming the temp file to its final name would orphan them.
   */
  private removeTempSidecars(tempPath: string): void {
    for (const sidecar of [`${tempPath}-shm`, `${tempPath}-wal`]) {
      try {
        if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
      } catch {
        // Best effort: a stray sidecar is untidy, not fatal.
      }
    }
  }

  /** Discard a rejected download: the temp file and any sidecars it produced. */
  private removeTempFiles(tempPath: string): void {
    this.removeTempSidecars(tempPath);
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Best effort.
    }
  }

  /**
   * Check if update is available
   */
  async isUpdateAvailable(): Promise<boolean> {
    try {
      this.updateCheckFailed = false;
      const local = this.getLocalManifest();
      if (!local) {
        console.error(`[DbVersioning:${this.spec.id}] No local manifest found, update available`);
      }

      if (local?.source === LOCAL_BUILD_SOURCE) {
        console.error(
          `[DbVersioning:${this.spec.id}] Skipping auto-update: database was built locally ` +
            `(switch to the prebuilt release DB explicitly via \`manage\`)`
        );
        return false;
      }

      const remote = await this.getRemoteManifest();
      if (!remote) {
        this.updateCheckFailed = true;
        console.error(`[DbVersioning:${this.spec.id}] Could not fetch remote manifest`);
        return false;
      }

      // Schema force-redownload: an installed DB whose schema_version doesn't
      // match this build is unusable regardless of manifest versions.
      if (fs.existsSync(this.dbPath)) {
        const dbSchema = readDbSchemaVersion(this.dbPath);
        if (dbSchema !== this.spec.schemaVersion) {
          console.error(
            `[DbVersioning:${this.spec.id}] Installed DB has schema v${dbSchema ?? 'unknown'} but this build ` +
              `expects v${this.spec.schemaVersion} — forcing update`
          );
          return true;
        }
      }

      const versionChanged = !local || this.compareVersions(local.version, remote.version) < 0;
      if (!versionChanged) {
        return false;
      }

      // Release versions also carry dist/ changes. Before replacing a database
      // solely because its manifest version advanced, compare the bytes that
      // are actually installed. Matching bytes need only new local metadata.
      if (fs.existsSync(this.dbPath)) {
        const installedHash = await this.calculateFileHash(this.dbPath);
        if (installedHash === remote.hash) {
          this.saveManifest(remote);
          if (fs.existsSync(this.failedMarkerPath)) {
            fs.unlinkSync(this.failedMarkerPath);
          }
          console.error(
            `[DbVersioning:${this.spec.id}] ${this.spec.fileName} unchanged (hash match), skipping`
          );
          return false;
        }
      }

      // If we previously tried and failed to download this exact version+hash,
      // skip re-downloading to prevent an infinite loop caused by a broken release.
      if (this.isVersionMarkedFailed(remote)) {
        console.error(
          `[DbVersioning:${this.spec.id}] Skipping update: version ${remote.version} previously failed hash verification (broken release asset)`
        );
        return false;
      }

      console.error(
        `[DbVersioning:${this.spec.id}] Update available: ${local?.version ?? 'not installed'} -> ${remote.version}`
      );
      return true;
    } catch (error) {
      console.error(`[DbVersioning:${this.spec.id}] Error checking for updates:`, error);
      return false;
    }
  }

  /**
   * Check whether the given remote manifest has been marked as a failed download
   * (i.e. its hash did not match the actual file bytes).
   */
  private isVersionMarkedFailed(manifest: DbVersionManifest): boolean {
    if (!fs.existsSync(this.failedMarkerPath)) return false;
    try {
      const failed = JSON.parse(fs.readFileSync(this.failedMarkerPath, 'utf-8')) as {
        version: string;
        hash: string;
      };
      return failed.version === manifest.version && failed.hash === manifest.hash;
    } catch {
      return false;
    }
  }

  /**
   * Download and verify database file
   */
  async downloadDatabase(manifest: DbVersionManifest): Promise<boolean> {
    try {
      // Ensure data directory exists before downloading
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }

      console.error(
        `[DbVersioning:${this.spec.id}] Downloading database version ${manifest.version}...`
      );

      const response = await fetch(manifest.downloadUrl);
      if (!response.ok) {
        console.error(`[DbVersioning:${this.spec.id}] Failed to download: ${response.status}`);
        return false;
      }

      // Create backup of current database
      if (fs.existsSync(this.dbPath)) {
        const backupPath = `${this.dbPath}.backup`;
        fs.copyFileSync(this.dbPath, backupPath);
        console.error(`[DbVersioning:${this.spec.id}] Created backup at ${backupPath}`);
      }

      // Write downloaded file
      const buffer = await response.arrayBuffer();
      const tempPath = `${this.dbPath}.tmp`;
      fs.writeFileSync(tempPath, Buffer.from(buffer));

      // Verify hash
      const downloadedHash = await this.calculateFileHash(tempPath);
      if (downloadedHash !== manifest.hash) {
        console.error(
          `[DbVersioning:${this.spec.id}] Hash mismatch: expected ${manifest.hash}, got ${downloadedHash}`
        );
        this.removeTempFiles(tempPath);

        // Save a "failed download" marker so subsequent startups skip re-downloading
        // the same broken release, preventing an infinite download loop.
        try {
          fs.writeFileSync(
            this.failedMarkerPath,
            JSON.stringify(
              {
                version: manifest.version,
                hash: manifest.hash,
                actualHash: downloadedHash,
                failedAt: new Date().toISOString(),
                reason: `Hash mismatch: expected ${manifest.hash}, got ${downloadedHash}`,
              },
              null,
              2
            )
          );
          console.error(
            `[DbVersioning:${this.spec.id}] Saved failed-download marker (version ${manifest.version}) to prevent re-download loops`
          );
        } catch (markerErr) {
          console.error(
            `[DbVersioning:${this.spec.id}] Could not save failed-download marker:`,
            markerErr
          );
        }

        return false;
      }

      // Verify the downloaded DB actually carries the schema this build expects. A release
      // asset that lags a schema bump (e.g. a carry-forward that never re-indexed) would
      // otherwise re-trigger the force-redownload every startup — an infinite ~25MB loop.
      // Reject it and mark it failed so we stop re-pulling the same broken schema.
      const downloadedSchema = readDbSchemaVersion(tempPath);
      if (downloadedSchema !== this.spec.schemaVersion) {
        console.error(
          `[DbVersioning:${this.spec.id}] Downloaded DB has schema v${downloadedSchema ?? 'unreadable'} but this ` +
            `build expects v${this.spec.schemaVersion} — rejecting the stale asset`
        );
        this.removeTempFiles(tempPath);
        try {
          fs.writeFileSync(
            this.failedMarkerPath,
            JSON.stringify(
              {
                version: manifest.version,
                hash: manifest.hash,
                failedAt: new Date().toISOString(),
                reason: `Schema mismatch: downloaded v${downloadedSchema ?? 'unreadable'}, expected v${this.spec.schemaVersion}`,
              },
              null,
              2
            )
          );
          console.error(
            `[DbVersioning:${this.spec.id}] Saved failed-download marker (version ${manifest.version}) to prevent re-download loops`
          );
        } catch (markerErr) {
          console.error(
            `[DbVersioning:${this.spec.id}] Could not save failed-download marker:`,
            markerErr
          );
        }
        return false;
      }

      // Replace database. The -shm/-wal sidecars the schema check just created
      // are named after the temp path, so they must go before the rename or
      // they are stranded in the data directory forever.
      this.removeTempSidecars(tempPath);
      fs.renameSync(tempPath, this.dbPath);

      // Clear any previous failed-download marker now that we have a good DB
      if (fs.existsSync(this.failedMarkerPath)) {
        fs.unlinkSync(this.failedMarkerPath);
        console.error(
          `[DbVersioning:${this.spec.id}] Cleared failed-download marker after successful update`
        );
      }

      console.error(
        `[DbVersioning:${this.spec.id}] Successfully updated database to version ${manifest.version}`
      );

      return true;
    } catch (error) {
      console.error(`[DbVersioning:${this.spec.id}] Error downloading database:`, error);
      return false;
    }
  }

  /**
   * Save manifest locally
   */
  saveManifest(manifest: DbVersionManifest): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
      fs.writeFileSync(this.localManifestPath, JSON.stringify(manifest, null, 2));
      console.error(`[DbVersioning:${this.spec.id}] Saved manifest version ${manifest.version}`);
    } catch (error) {
      console.error(`[DbVersioning:${this.spec.id}] Error saving manifest:`, error);
    }
  }

  /**
   * Create new manifest after indexing.
   * Called by scripts/generate-manifest.ts.
   */
  async createManifest(
    version: string,
    type: 'incremental' | 'full',
    changelog: string,
    releaseTag?: string
  ): Promise<DbVersionManifest> {
    try {
      if (!fs.existsSync(this.dbPath)) {
        throw new Error(`Database file not found: ${this.dbPath}`);
      }

      const dbSchema = readDbSchemaVersion(this.dbPath);
      if (dbSchema !== this.spec.schemaVersion) {
        throw new Error(
          `Cannot create ${this.spec.manifestName}: database schema v${dbSchema ?? 'unreadable'} ` +
            `does not match required v${this.spec.schemaVersion}`
        );
      }

      const hash = await this.calculateFileHash(this.dbPath);
      const stats = fs.statSync(this.dbPath);

      const tag = releaseTag || `v${version}`;
      const downloadUrl = `${REPO_URL}/releases/download/${tag}/${this.spec.fileName}`;

      const manifest: DbVersionManifest = {
        version,
        schemaVersion: this.spec.schemaVersion,
        timestamp: new Date().toISOString(),
        type,
        hash,
        size: stats.size,
        downloadUrl,
        changelog,
      };

      this.saveManifest(manifest);
      return manifest;
    } catch (error) {
      console.error(`[DbVersioning:${this.spec.id}] Error creating manifest:`, error);
      throw error;
    }
  }

  /**
   * Perform automatic update check and download if needed.
   */
  async autoUpdate(): Promise<'updated' | 'up-to-date' | 'failed'> {
    try {
      const hasUpdate = await this.isUpdateAvailable();
      if (!hasUpdate) {
        // "No update" while the file is still absent means we could not supply
        // it at all — a failure for every DB, not just the required one.
        return this.updateCheckFailed || !isInstalled(this.spec.id) ? 'failed' : 'up-to-date';
      }

      const remote = await this.getRemoteManifest();
      if (!remote) {
        console.error(`[DbVersioning:${this.spec.id}] Could not fetch remote manifest for update`);
        return 'failed';
      }

      const success = await this.downloadDatabase(remote);
      if (success) {
        this.saveManifest(remote);
        return 'updated';
      }

      return 'failed';
    } catch (error) {
      console.error(`[DbVersioning:${this.spec.id}] Error during auto-update:`, error);
      return 'failed';
    }
  }
}

/**
 * Install/update every managed database on MCP startup — required and optional
 * alike. A DB that is absent has no local manifest, so `isUpdateAvailable()`
 * reports an update and the download path installs it; this is what makes the
 * optional tool groups appear without the user ever running `manage`.
 * Returns the IDs that updated successfully and those whose update check or
 * download failed.
 */
export interface AutoUpdateSummary {
  updated: DbId[];
  failed: DbId[];
}

export async function autoUpdateAll(): Promise<AutoUpdateSummary> {
  const summary: AutoUpdateSummary = { updated: [], failed: [] };
  for (const id of DB_IDS) {
    const spec = DBS[id];
    try {
      const result = await new DbVersioning(spec).autoUpdate();
      if (result === 'updated') summary.updated.push(id);
      if (result === 'failed') summary.failed.push(id);
    } catch (error) {
      console.error(`[DbVersioning:${id}] Auto-update failed:`, error);
      summary.failed.push(id);
    }
  }
  return summary;
}
