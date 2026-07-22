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
  type DbSpec,
  type GitHubRelease,
} from './dbs.js';
import { compareVersions } from './version-utils.js';

export interface DbVersionManifest {
  version: string;
  timestamp: string;
  type: 'incremental' | 'full';
  hash: string;
  size: number;
  downloadUrl: string;
  changelog: string;
}

export class DbVersioning {
  private spec: DbSpec;
  private localManifestPath: string;
  private failedMarkerPath: string;
  private dbPath: string;
  private dataDir: string;

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
   * Check if update is available
   */
  async isUpdateAvailable(): Promise<boolean> {
    try {
      const local = this.getLocalManifest();
      if (!local) {
        console.error(`[DbVersioning:${this.spec.id}] No local manifest found, update available`);
      }

      const remote = await this.getRemoteManifest();
      if (!remote) {
        console.error(`[DbVersioning:${this.spec.id}] Could not fetch remote manifest`);
        return false;
      }

      // If we previously tried and failed to download this exact version+hash,
      // skip re-downloading to prevent an infinite loop caused by a broken release.
      if (this.isVersionMarkedFailed(remote)) {
        console.error(
          `[DbVersioning:${this.spec.id}] Skipping update: version ${remote.version} previously failed hash verification (broken release asset)`
        );
        return false;
      }

      if (!local) {
        return true;
      }

      const comparison = this.compareVersions(local.version, remote.version);
      if (comparison < 0) {
        console.error(
          `[DbVersioning:${this.spec.id}] Update available: ${local.version} -> ${remote.version}`
        );
        return true;
      }

      return false;
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
        fs.unlinkSync(tempPath);

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

      // Replace database
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

      const hash = await this.calculateFileHash(this.dbPath);
      const stats = fs.statSync(this.dbPath);

      const tag = releaseTag || `v${version}`;
      const downloadUrl = `${REPO_URL}/releases/download/${tag}/${this.spec.fileName}`;

      const manifest: DbVersionManifest = {
        version,
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
  async autoUpdate(): Promise<boolean> {
    try {
      const hasUpdate = await this.isUpdateAvailable();
      if (!hasUpdate) {
        return false;
      }

      const remote = await this.getRemoteManifest();
      if (!remote) {
        console.error(`[DbVersioning:${this.spec.id}] Could not fetch remote manifest for update`);
        return false;
      }

      const success = await this.downloadDatabase(remote);
      if (success) {
        this.saveManifest(remote);
        return true;
      }

      return false;
    } catch (error) {
      console.error(`[DbVersioning:${this.spec.id}] Error during auto-update:`, error);
      return false;
    }
  }
}

/**
 * Auto-update every managed database on MCP startup: required DBs always,
 * optional DBs only once they have been installed (via `manage`).
 * Returns true if any database was updated.
 */
export async function autoUpdateAll(): Promise<boolean> {
  let anyUpdated = false;
  for (const id of DB_IDS) {
    const spec = DBS[id];
    if (!spec.required && !isInstalled(id)) {
      continue;
    }
    try {
      const updated = await new DbVersioning(spec).autoUpdate();
      anyUpdated = anyUpdated || updated;
    } catch (error) {
      console.error(`[DbVersioning:${id}] Auto-update failed:`, error);
    }
  }
  return anyUpdated;
}
